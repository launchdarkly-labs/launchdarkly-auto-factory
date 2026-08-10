import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import type { AgentNodeRequest, AgentNodeResult, AgentRunner } from "@auto-factory/shared";
import { walkGraph, type NodeRun } from "@auto-factory/shared";
import {
  buildResumeInput,
  carryUnconsumedFeedback,
  readWalkState,
  writeWalkState,
  type WalkState,
} from "@auto-factory/phase1-cli";

// ---------------------------------------------------------------------------
// Round seven, finding 3: a granted resume's --feedback must survive the
// approval gate. The default sequence is exactly this: the reviewer loop
// exhausts (its target, flag-implementer, is the DEFAULT gated step), the human
// re-runs with --resume --grant-visits ... --feedback "...", the gate halts the
// walk before ANY live node runs, and the next resume (--approve) used to run
// the implementer with a rework preamble and ZERO human guidance — silently
// defeating args.ts's rule that a grant must not travel without feedback.
//
// The fix persists unconsumed feedback in the walk state and re-injects it on
// resume until a live node consumes it. This test drives the walker through the
// same three rounds run.ts does, using the same persistence helpers.
// ---------------------------------------------------------------------------

const fakeConfigTracker = () => ({}) as unknown as LDAIConfigTracker;
function agentConfig(key: string): LDAIAgentConfig {
  return {
    key,
    enabled: true,
    instructions: `instructions for ${key}`,
    model: { name: "m" },
    createTracker: fakeConfigTracker,
  } as LDAIAgentConfig;
}

/** implementer → reviewer; reviewer loops back on review_approved=false (max_visits 1). */
function buildGraph(): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = {
    root: "implementer",
    edges: {
      implementer: [{ key: "reviewer" }],
      reviewer: [{ key: "implementer", handoff: { require_tags: { review_approved: "false" }, max_visits: 1 } }],
    },
  };
  const configs = { implementer: agentConfig("implementer"), reviewer: agentConfig("reviewer") };
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(flagValue, nodes, true, () => ({}) as unknown as LDGraphTracker);
}

class RecordingRunner implements AgentRunner {
  prompts: Array<{ key: string; prompt: string }> = [];
  constructor(private readonly tags: Record<string, Record<string, string>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    this.prompts.push({ key: req.configKey, prompt: req.prompt });
    return {
      status: "completed",
      messages: [{ role: "assistant", content: `done: ${req.configKey}`, isFinal: true }],
      tags: this.tags[req.configKey] ?? {},
    };
  }
}

const tmps: string[] = [];
after(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway git repo, for the walk-state file (it lives in .git). */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-feedback-"));
  tmps.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

const FEEDBACK = "REUSE THE EXISTING FLAG";

describe("resume feedback survives an approval-gate halt", () => {
  it("persists unconsumed feedback at the gate halt and delivers it on the next resume", async () => {
    const dir = repo();

    // ROUND 1: fresh walk; the reviewer rejects, the loop budget (1) exhausts.
    const r1 = await walkGraph(buildGraph(), new RecordingRunner({ reviewer: { review_approved: "false" } }), {});
    assert.equal(r1.loopExhausted?.reason, "budget");
    const journal: NodeRun[] = r1.runs;
    // max_visits 1 = one rework: impl#1, rev#1, impl#2, rev#2, then budget-blocked.
    assert.equal(journal.length, 4);
    // The grant a resume issues takes effect after the replayed journal (run.ts).
    const GRANT = [{ edge: "reviewer→implementer", visits: 1, effectiveAfterRuns: journal.length }];

    // ROUND 2: --resume --grant-visits reviewer:implementer=1 --feedback "...",
    // but the loop target is gated and the human did not pass --approve (the old
    // loop-exhausted hint never mentioned it). The gate halts BEFORE any live node.
    const r2runner = new RecordingRunner({});
    const r2 = await walkGraph(buildGraph(), r2runner, {}, {
      gate: { steps: ["implementer"], resolve: () => false },
      resume: { journal, grants: GRANT, humanFeedback: FEEDBACK },
    });
    assert.equal(r2.pendingApproval?.node, "implementer");
    assert.equal(r2runner.prompts.length, 0, "no live node ran, so nobody consumed the feedback");

    // Persist the halt. The carry is NOT re-implemented here — writeWalkState applies it
    // from these three numbers, which is the same code path run.ts drives. An earlier
    // version of this test spread `carryUnconsumedFeedback(...)` in itself, so removing the
    // production call site left every test green.
    writeWalkState(
      dir,
      {
        graphKey: "g",
        configStamp: "cfg",
        head: "sha",
        policyMode: "always",
        base: "main",
        grants: GRANT,
        haltedAt: { kind: "pending-approval", node: "implementer" },
        runs: r2.runs,
      },
      { inForce: FEEDBACK, totalRuns: r2.runs.length, replayedRuns: journal.length },
    );
    const saved = readWalkState(dir);
    assert.equal(saved?.humanFeedback, FEEDBACK, "the walk state must carry the undelivered feedback");

    // ROUND 3: --resume --approve implementer, with NO --feedback on the command
    // line (the pending-approval hint doesn't ask for one). run.ts falls back to
    // the saved feedback: opts.feedback ?? state.humanFeedback.
    // Built by the SAME function run.ts calls, with no --feedback in opts — so this
    // asserts the production re-injection path, not a copy of it.
    const round3Resume = buildResumeInput(saved!, {});
    const round3Feedback = round3Resume.humanFeedback;
    assert.equal(round3Feedback, FEEDBACK, "the saved feedback is what a bare --resume picks up");
    const r3runner = new RecordingRunner({ reviewer: { review_approved: "true" } });
    const r3 = await walkGraph(buildGraph(), r3runner, {}, {
      gate: { steps: ["implementer"], resolve: () => true },
      resume: round3Resume,
    });
    const impl = r3runner.prompts.find((p) => p.key === "implementer");
    assert.ok(impl, "the granted implementer iteration ran live");
    assert.match(impl!.prompt, /REWORK ITERATION/, "it is a rework prompt");
    assert.ok(impl!.prompt.includes(FEEDBACK), "the human's guidance reached the agent at last");
    assert.match(impl!.prompt, /HUMAN GUIDANCE/, "delivered as the authoritative feedback block");

    // And once consumed, it must NOT be persisted again: a live node ran.
    assert.deepEqual(carryUnconsumedFeedback(round3Feedback, r3.runs.length, saved!.runs.length), {});
  });

  it("feedback consumed by a live node is not carried forward", () => {
    // 3 runs total, 2 replayed → the frontier ran live and consumed the feedback.
    assert.deepEqual(carryUnconsumedFeedback(FEEDBACK, 3, 2), {});
    // 2 runs total, 2 replayed → pure replay; nobody consumed it.
    assert.deepEqual(carryUnconsumedFeedback(FEEDBACK, 2, 2), { humanFeedback: FEEDBACK });
    // No feedback in force → nothing to carry.
    assert.deepEqual(carryUnconsumedFeedback(undefined, 2, 2), {});
  });

  it("humanFeedback round-trips through the walk-state file", () => {
    const dir = repo();
    // humanFeedback cannot be set directly — it is excluded from the state parameter so a
    // caller cannot bypass the carry decision. It arrives only via the third argument.
    writeWalkState(
      dir,
      {
        graphKey: "g",
        configStamp: "cfg",
        head: "sha",
        policyMode: "always",
        base: "main",
        haltedAt: { kind: "pending-approval", node: "implementer" },
        runs: [{ configKey: "implementer", status: "completed", output: "done", tags: {}, iteration: 1 }],
      },
      { inForce: FEEDBACK, totalRuns: 1, replayedRuns: 1 },
    );
    assert.equal(readWalkState(dir)?.humanFeedback, FEEDBACK);
  });
});

// ---------------------------------------------------------------------------
// The RE-INJECTION half, which had no test at all: run.ts used to decide
// `opts.feedback ?? state.humanFeedback` inline, so deleting the fallback left
// every test green while a granted resume silently ran with no guidance. The
// decision now lives in buildResumeInput, where it can be pinned.
// ---------------------------------------------------------------------------
describe("buildResumeInput", () => {
  const journal: NodeRun[] = [
    { configKey: "reviewer", status: "completed", output: "no", tags: { review_approved: "false" }, iteration: 1 },
    { configKey: "implementer", status: "completed", output: "fix", tags: {}, iteration: 2 },
  ];
  const state = (extra: Partial<WalkState> = {}): WalkState =>
    ({
      version: 5,
      graphKey: "g",
      at: "2026-01-01T00:00:00.000Z",
      haltedAt: { kind: "loop-exhausted", node: "reviewer" },
      runs: journal,
      ...extra,
    }) as WalkState;

  it("re-injects saved feedback when the command line carries none", () => {
    const r = buildResumeInput(state({ humanFeedback: "the metrics miss error rate" }), {});
    assert.equal(r.humanFeedback, "the metrics miss error rate");
    assert.deepEqual(r.journal, journal, "the journal still replays");
  });

  it("a newly passed --feedback WINS over the saved one", () => {
    // The human is looking at the failure again; their new words supersede the old.
    const r = buildResumeInput(state({ humanFeedback: "stale guidance" }), { feedback: "fresh guidance" });
    assert.equal(r.humanFeedback, "fresh guidance");
  });

  it("omits humanFeedback entirely when there is none in play", () => {
    const r = buildResumeInput(state(), {});
    assert.ok(!("humanFeedback" in r), "an absent key, not an empty string — the walker checks presence");
  });

  it("positions a new grant after the replayed journal, keeping prior grants", () => {
    // The grant/feedback assembly is one function precisely because these two numbers
    // are the same number: the journal length IS where a new grant takes effect.
    const prior = [{ edge: "reviewer:implementer", visits: 1, effectiveAfterRuns: 0 }];
    const r = buildResumeInput(state({ grants: prior }), { grantVisits: { "reviewer:implementer": 1 } });
    assert.equal(r.grants?.length, 2);
    assert.equal(r.grants?.[0]?.effectiveAfterRuns, 0, "prior grant keeps its position");
    assert.equal(r.grants?.[1]?.effectiveAfterRuns, journal.length, "new grant takes effect at the frontier");
  });
});
