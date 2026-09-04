import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import {
  type AgentNodeRequest,
  type AgentNodeResult,
  type AgentRunner,
  SandboxToolExecutor,
  buildIntentMarker,
  defaultEntryNode,
  intakeNodeKeys,
  intentTicketId,
  issueBranchName,
  issueIntentId,
  parseIntentMarker,
  walkGraph,
  withRunAttributes,
} from "@auto-factory/shared";

const CODER = "autofactory-issue-coder";
const PLANNER = "autofactory-research-planner";
const IMPL = "autofactory-flag-implementer";

function graph(withIntake: boolean): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = withIntake
    ? {
        root: CODER,
        edges: {
          [CODER]: [{ key: PLANNER, handoff: { intake: true } }],
          [PLANNER]: [{ key: IMPL }],
        },
      }
    : { root: PLANNER, edges: { [PLANNER]: [{ key: IMPL }] } };
  const cfg = (key: string): LDAIAgentConfig =>
    ({
      key,
      enabled: true,
      instructions: `instructions for ${key}`,
      model: { name: "Anthropic.claude-sonnet-4-6" },
      createTracker: () => ({}) as unknown as LDAIConfigTracker,
    }) as LDAIAgentConfig;
  const keys = withIntake ? [CODER, PLANNER, IMPL] : [PLANNER, IMPL];
  const nodes = AgentGraphDefinition.buildNodes(flagValue, Object.fromEntries(keys.map((k) => [k, cfg(k)])));
  return new AgentGraphDefinition(flagValue, nodes, true, () => ({}) as unknown as LDGraphTracker);
}

class RecordingRunner implements AgentRunner {
  readonly prompts: Record<string, string> = {};
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    this.prompts[req.configKey] = req.prompt;
    return { status: "completed", messages: [{ role: "assistant", content: `done: ${req.configKey}`, isFinal: true }], tags: {} };
  }
}

describe("intake entry point (ADR 0019): graph entry selection", () => {
  it("intakeNodeKeys finds sources of handoff.intake edges; none on a plain graph", () => {
    assert.deepEqual([...intakeNodeKeys(graph(true))], [CODER]);
    assert.deepEqual([...intakeNodeKeys(graph(false))], []);
  });

  it("defaultEntryNode skips past an intake root to the first regular node", () => {
    assert.equal(defaultEntryNode(graph(true)).getKey(), PLANNER);
    assert.equal(defaultEntryNode(graph(false)).getKey(), PLANNER);
  });

  it("a regular walk enters at the planner and does not report the coder as skipped", async () => {
    const runner = new RecordingRunner();
    const w = await walkGraph(graph(true), runner, { PR_NUMBER: "7", REPO: "o/r" });
    assert.deepEqual(w.runs.map((r) => r.configKey), [PLANNER, IMPL]);
    assert.deepEqual(w.skipped, []);
    assert.equal(w.stalledAt, undefined);
    assert.match(runner.prompts[PLANNER] as string, /Pull request: #7/);
  });

  it("an intake walk starts at the coder, stops after it, and prompts with the issue", async () => {
    const runner = new RecordingRunner();
    const w = await walkGraph(
      graph(true),
      runner,
      { REPO: "o/r", ISSUE_NUMBER: "12", PR_TITLE: "Add sort", PR_BODY: "body", PR_BRANCH: "autofactory/issue-12" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { startAt: CODER, stopAfter: [CODER] },
    );
    assert.deepEqual(w.runs.map((r) => r.configKey), [CODER]);
    assert.equal(w.stalledAt, undefined);
    const prompt = runner.prompts[CODER] as string;
    assert.match(prompt, /Issue: #12/);
    assert.match(prompt, /Working branch: autofactory\/issue-12/);
    assert.doesNotMatch(prompt, /Pull request/);
  });

  it("startAt on an unknown node throws", async () => {
    await assert.rejects(
      walkGraph(graph(true), new RecordingRunner(), {}, undefined, undefined, undefined, undefined, undefined, { startAt: "nope" }),
      /start node 'nope'/,
    );
  });
});

describe("intake entry point: intent marker + run attributes", () => {
  it("round-trips through a PR body and yields the ticket id", () => {
    const marker = buildIntentMarker({ intent: issueIntentId(42), issue: 42, repo: "o/r", intakeRun: "run-1", graph: "g", node: CODER });
    const body = `## Summary\nstuff\n\nCloses #42\n\n---\n_note_\n${marker}\n`;
    assert.deepEqual(parseIntentMarker(body), { intent: "issue-42", issue: 42, repo: "o/r", intakeRun: "run-1", graph: "g", node: CODER });
    assert.equal(intentTicketId(body), "issue-42");
    assert.equal(issueBranchName(42), "autofactory/issue-42");
  });

  it("is absent/undefined on bodies without a valid marker", () => {
    assert.equal(parseIntentMarker(undefined), undefined);
    assert.equal(parseIntentMarker("no marker here"), undefined);
    assert.equal(parseIntentMarker("<!-- autofactory-intent {not json} -->"), undefined);
    assert.equal(parseIntentMarker('<!-- autofactory-intent {"issue": 1} -->'), undefined);
  });

  it("withRunAttributes adds join keys to the run kind, never the key, dropping empties", () => {
    const ctx = { kind: "multi", service: { key: "s" }, run: { key: "r", surface: "cli" } } as never;
    const out = withRunAttributes(ctx, { ticket: "issue-1", pr: "", repo: undefined, key: "evil", entry: "issue" }) as unknown as {
      run: Record<string, unknown>;
    };
    assert.deepEqual(out.run, { key: "r", surface: "cli", ticket: "issue-1", entry: "issue" });
    const single = { kind: "user", key: "u" } as never;
    assert.equal(withRunAttributes(single, { ticket: "x" }), single);
  });
});

describe("intake entry point: commit_and_push without [skip ci]", () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "af-intake-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    // A bare remote so `push` succeeds.
    const bare = mkdtempSync(join(tmpdir(), "af-intake-remote-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    g("remote", "add", "origin", bare);
    return dir;
  }

  it("default executor appends [skip ci]; skipCi=false leaves the message alone", async () => {
    for (const [skipCi, expectSkip] of [
      [true, true],
      [false, false],
    ] as const) {
      const dir = repo();
      writeFileSync(join(dir, "b.txt"), "2\n");
      const ex = new SandboxToolExecutor(dir, undefined, true, "autofactory/issue-9", "main", "push", false, false, skipCi);
      const r = await ex.execute("commit_and_push", { message: "feat: thing (#9)" });
      assert.equal(r.isError, undefined, r.content);
      const msg = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" });
      assert.equal(/\[skip ci\]/.test(msg), expectSkip, msg);
      const remote = execFileSync("git", ["rev-parse", "--verify", "origin/autofactory/issue-9"], { cwd: dir, encoding: "utf8" }).trim();
      assert.ok(remote.length > 0);
    }
  });
});
