import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
  NODE_REQUIRED_TAGS,
  type WalkResult,
  decideApproval,
  interpretWalk,
  walkGraph,
} from "@auto-factory/shared";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p: string) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));

// ---------------------------------------------------------------------------
// Fixture: the real 5-node chain (real config keys + real handoff conditions),
// so these tests double as executable documentation of the routing contract.
// ---------------------------------------------------------------------------
const KEYS = {
  research: "autofactory-research-planner",
  flag: "autofactory-flag-implementer",
  metrics: "autofactory-metrics-author",
  test: "autofactory-flag-testing",
  review: "autofactory-code-reviewer",
};

/**
 * `scriptByKey[key]` is either one result reused on every call, or an array
 * consumed one-per-call (clamped to the last entry) so a node can return e.g.
 * "false" then "true" across rework iterations. Prompts are captured so loop
 * tests can assert what iteration 2 was actually told.
 */
class FakeRunner implements AgentRunner {
  readonly promptsByKey: Record<string, string[]> = {};
  private readonly calls: Record<string, number> = {};
  constructor(
    private readonly scriptByKey: Record<
      string,
      Partial<AgentNodeResult> | Array<Partial<AgentNodeResult>>
    >,
  ) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    const n = this.calls[req.configKey] ?? 0;
    this.calls[req.configKey] = n + 1;
    (this.promptsByKey[req.configKey] ??= []).push(req.prompt);
    const entry = this.scriptByKey[req.configKey];
    const s: Partial<AgentNodeResult> = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] ?? {} : entry ?? {};
    return {
      status: s.status ?? "completed",
      messages: s.messages ?? [{ role: "assistant", content: `done: ${req.configKey} #${n + 1}`, isFinal: true }],
      tags: s.tags ?? {},
    };
  }
}

function buildChain(): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = {
    root: KEYS.research,
    edges: {
      [KEYS.research]: [{ key: KEYS.flag, handoff: { skip_if_tags: { skip_flagging: "true" } } }],
      [KEYS.flag]: [{ key: KEYS.metrics, handoff: { require_tags: { flag_ready: "true" } } }],
      [KEYS.metrics]: [{ key: KEYS.test, handoff: { require_tags: { needs_tests: "true" } } }],
      [KEYS.test]: [{ key: KEYS.review }],
      // Phase 4 Step 1a: bounded rework loop on the reviewer's verdict. Mirrors
      // the committed graph edge — kept honest by the parity test below.
      [KEYS.review]: [{ key: KEYS.flag, handoff: { max_visits: 2, require_tags: { review_approved: "false" } } }],
    },
  };
  const cfg = (key: string): LDAIAgentConfig =>
    ({
      key,
      enabled: true,
      instructions: `instructions for ${key}`,
      model: { name: "Anthropic.claude-sonnet-4-6" },
      createTracker: () => ({}) as unknown as LDAIConfigTracker,
    }) as LDAIAgentConfig;
  const configs = Object.fromEntries(Object.values(KEYS).map((k) => [k, cfg(k)]));
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(flagValue, nodes, true, () => ({}) as unknown as LDGraphTracker);
}

async function runShape(
  script: Record<string, Partial<AgentNodeResult> | Array<Partial<AgentNodeResult>>>,
): Promise<WalkResult> {
  return walkGraph(buildChain(), new FakeRunner(script), { PR_NUMBER: "1" });
}
const path = (w: WalkResult) => w.runs.map((r) => r.configKey);
const decide = (w: WalkResult) => decideApproval(interpretWalk(w.tags));

// ---------------------------------------------------------------------------
describe("routing contract: PR-shape fixtures (walk → interpret → decide)", () => {
  it("flag-worthy PR runs the full chain and APPROVES", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
      [KEYS.metrics]: { tags: { metrics_created: "true", metric_keys: "k-error-rate", needs_tests: "true" } },
      [KEYS.review]: { tags: { review_approved: "approve", risk_level: "low" } },
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review]);
    assert.equal(w.stalledAt, undefined);
    const d = decide(w);
    assert.equal(d.apply, true);
    assert.equal(d.incomplete, false);
  });

  it("no-flag PR (skip_flagging) short-circuits to a clean no-op", async () => {
    const w = await runShape({ [KEYS.research]: { tags: { skip_flagging: "true", flag_worthy: "false" } } });
    assert.deepEqual(path(w), [KEYS.research]);
    assert.equal(w.stalledAt, undefined);
    const d = decide(w);
    assert.equal(d.noop, true);
    assert.equal(d.incomplete, false);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("rejected PR runs the full chain and REJECTS (not incomplete)", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
      [KEYS.metrics]: { tags: { needs_tests: "true" } },
      [KEYS.review]: { tags: { review_approved: "reject", risk_level: "high" } },
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review]);
    const d = decide(w);
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /reject/i);
  });

  it("stall at metrics-author (needs_tests never set) → INCOMPLETE, not REJECTED (issue #9 failure mode #2)", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
      [KEYS.metrics]: { tags: { metrics_created: "true" } }, // forgot needs_tests
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics]);
    assert.equal(w.stalledAt?.node, KEYS.metrics);
    assert.deepEqual(w.stalledAt?.unmet, [{ target: KEYS.test, requireMissing: { needs_tests: "true" } }]);
    const d = decide(w);
    assert.equal(d.incomplete, true);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("stall at flag-implementer (no verified flag outcome — no tool set flag_ready) → INCOMPLETE", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: {} }, // ran but no flag tool succeeded (create/add_variation/use_existing)
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag]);
    assert.equal(w.stalledAt?.node, KEYS.flag);
    assert.equal(decide(w).incomplete, true);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Step 1a — the verdict-driven rework loop, on the real config keys.
// The reviewer's `review_approved` was previously routed on by nothing; the
// loop edge review → implementer (max_visits: 2) makes a rejection actionable.
// ---------------------------------------------------------------------------
describe("routing contract: verdict-driven rework loop", () => {
  /** A flag-worthy PR whose reviewer verdict is scripted per iteration. */
  const reworkScript = (
    verdicts: Array<Record<string, string>>,
    flagTags: Array<Record<string, string>> = [{ flag_ready: "true", flag_created: "true", flag_key: "enable-x" }],
  ): Record<string, Partial<AgentNodeResult> | Array<Partial<AgentNodeResult>>> => ({
    [KEYS.research]: { tags: { flag_worthy: "true", risk_score: "0.4" } },
    [KEYS.flag]: flagTags.map((tags) => ({ tags })),
    [KEYS.metrics]: { tags: { metrics_created: "true", needs_tests: "true" } },
    [KEYS.review]: verdicts.map((tags) => ({ tags })),
  });

  const countOf = (w: WalkResult, key: string) => w.runs.filter((r) => r.configKey === key).length;

  it("1. a rejection re-runs the implementer; an approval on iteration 2 converges", async () => {
    const w = await runShape(
      reworkScript([
        { review_approved: "false", risk_level: "medium" },
        { review_approved: "true", risk_level: "low" },
      ]),
    );
    assert.deepEqual(path(w), [
      KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review,
      KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review,
    ]);
    assert.equal(countOf(w, KEYS.flag), 2, "the implementer re-ran exactly once");
    assert.equal(w.loopExhausted, undefined);
    assert.equal(w.stalledAt, undefined);
    // Iterations are labelled, so reporting can distinguish the two passes.
    assert.deepEqual(
      w.runs.filter((r) => r.configKey === KEYS.flag).map((r) => r.iteration),
      [1, 2],
    );
    const d = decide(w);
    assert.equal(d.apply, true);
    assert.equal(d.incomplete, false);
  });

  it("2. an approval on the first pass never enters the loop", async () => {
    const w = await runShape(reworkScript([{ review_approved: "true", risk_level: "low" }]));
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review]);
    assert.equal(countOf(w, KEYS.flag), 1);
    assert.equal(w.loopExhausted, undefined);
    assert.equal(decide(w).apply, true);
  });

  it("3. KNOWN GAP: a drifted verdict ('rejected') does NOT loop, but still reports REJECTED", async () => {
    // require_tags is exact equality; approval.ts normalizes. So a reviewer that
    // says "rejected" instead of "false" skips the rework but is still read as a
    // rejection — no wasted iteration, and nothing reports success. Fails safe.
    const w = await runShape(reworkScript([{ review_approved: "rejected", risk_level: "high" }]));
    assert.equal(countOf(w, KEYS.flag), 1, "no rework attempted");
    assert.equal(w.loopExhausted, undefined);
    const d = decide(w);
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /reject/i);
  });

  it("4. a verdict that never converges exhausts the budget instead of looping forever", async () => {
    const w = await runShape(reworkScript([{ review_approved: "false", risk_level: "high" }]));
    assert.equal(countOf(w, KEYS.flag), 3, "1 initial + max_visits(2) reworks");
    assert.equal(w.stalledAt, undefined);
    assert.equal(w.loopExhausted?.reason, "budget");
    assert.deepEqual(w.loopExhausted?.exhausted, [
      // `trigger` names the condition that kept firing, so the report says WHY the
      // budget ran out rather than only that it did.
      { source: KEYS.review, target: KEYS.flag, traversals: 2, maxVisits: 2, trigger: "review_approved=false" },
    ]);
  });

  it("5. a reviewer that emits no verdict on iteration 2 exhausts rather than passing silently", async () => {
    // The rejection overlaid onto the loop target survives (accumulatedTags is
    // only rewound ON traversal), so a silent reviewer re-fires the loop and
    // burns the budget. The failure direction is exhaustion, never false success.
    const w = await runShape(reworkScript([{ review_approved: "false" }, {}]));
    assert.equal(w.loopExhausted?.reason, "budget");
    assert.equal(countOf(w, KEYS.flag), 3);
    assert.notEqual(decide(w).apply, true);
  });

  it("6. the approval gate is re-asked on loop re-entry and can halt mid-rework", async () => {
    // DEFAULT_GATED_STEPS gates the implementer, and the walker re-evaluates the
    // gate on every re-entry by design (a re-run can create new side effects).
    // Approving iteration 1 does not carry to iteration 2.
    let asked = 0;
    const gate = {
      steps: [KEYS.flag],
      resolve: async () => {
        asked++;
        return asked === 1; // approved once, then withheld
      },
    };
    const w = await walkGraph(
      buildChain(),
      new FakeRunner(reworkScript([{ review_approved: "false", risk_level: "medium" }])),
      { PR_NUMBER: "1" },
      undefined,
      undefined,
      gate,
    );
    assert.equal(asked, 2, "the gate was consulted again on re-entry");
    assert.equal(w.pendingApproval?.node, KEYS.flag);
    assert.equal(countOf(w, KEYS.flag), 1, "iteration 2 never ran — no new side effects");
    assert.equal(w.loopExhausted, undefined, "halted by the gate, not by the budget");
  });

  it("7. the re-run is told WHO sent it back and WHY, and that the brief is a change request", async () => {
    // Without this the reviewer's report arrives as an undifferentiated brief and
    // reads like a fresh task. Note the critique itself is NOT duplicated into the
    // preamble — ctx.PREVIOUS_STEP_OUTPUT already carries the reviewer's full text.
    const runner = new FakeRunner(
      reworkScript([
        { review_approved: "false", risk_level: "medium" },
        { review_approved: "true", risk_level: "low" },
      ]),
    );
    await walkGraph(buildChain(), runner, { PR_NUMBER: "1" });
    const prompts = runner.promptsByKey[KEYS.flag] ?? [];
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0] ?? "", /REWORK ITERATION/, "the first pass is not a rework");
    const rework = prompts[1] ?? "";
    assert.match(rework, /=== REWORK ITERATION 2 ===/);
    assert.match(rework, /Sent back by 'autofactory-code-reviewer' because review_approved=false/);
    assert.match(rework, /treat it as the change request, not a new task/);
    // The inbound brief (the reviewer's own report) is still present alongside it.
    assert.match(rework, /done: autofactory-code-reviewer #1/);
    // And the inventory facts survive the rewind, so it amends rather than recreates.
    assert.match(rework, /flag_key: enable-x/);
  });

  it("8. a loop trigger does not leak into the next node's preamble", async () => {
    // The trigger is consumed once, by the node the loop edge re-entered. The
    // metrics author also runs twice, but via a FORWARD edge — it must not be told
    // the reviewer sent it back.
    const runner = new FakeRunner(
      reworkScript([{ review_approved: "false" }, { review_approved: "true", risk_level: "low" }]),
    );
    await walkGraph(buildChain(), runner, { PR_NUMBER: "1" });
    const metricsRework = (runner.promptsByKey[KEYS.metrics] ?? [])[1] ?? "";
    assert.match(metricsRework, /=== REWORK ITERATION 2 ===/, "it is still iteration 2");
    assert.doesNotMatch(metricsRework, /Sent back by/, "but nothing sent it back");
    assert.match(metricsRework, /The brief below explains what to change/, "generic wording instead");
  });

  it("9. a rework that creates a DIFFERENT flag is caught by the orphan guard", async () => {
    // Phase 3 instructs the implementer to amend (use_existing_flag/add_variation)
    // on a rework. If it creates a second flag instead, the never-rewound
    // inventory exposes the orphan and the run reports INCOMPLETE, not success.
    const w = await runShape(
      reworkScript(
        [{ review_approved: "false" }, { review_approved: "true", risk_level: "low" }],
        [
          { flag_ready: "true", flag_created: "true", flag_key: "enable-x" },
          { flag_ready: "true", flag_created: "true", flag_key: "enable-y" },
        ],
      ),
    );
    assert.equal(countOf(w, KEYS.flag), 2);
    assert.equal(w.inventory.flag_key, "enable-y", "inventory tracks the latest created resource");
    const d = decideApproval(interpretWalk(w.tags, w.inventory, w.runs));
    assert.equal(d.incomplete, true, "an orphaned earlier flag must not report success");
    assert.equal(d.apply, false);
  });
});

// ---------------------------------------------------------------------------
describe("routing contract: deterministic handoff shims halt the walk", () => {
  it("a failed verification stops downstream nodes and reports the failure", async () => {
    const verifier = async (run: { configKey: string; tags: Record<string, string> }) =>
      run.tags.flag_ready === "true"
        ? {
            node: run.configKey,
            ok: false,
            passed: [],
            failures: [{ name: "flag-wired-in-code", detail: "'enable-x' is not referenced anywhere in the code" }],
          }
        : null;
    const w = await walkGraph(
      buildChain(),
      new FakeRunner({
        [KEYS.research]: { tags: { flag_worthy: "true" } },
        [KEYS.flag]: { tags: { flag_ready: "true", flag_key: "enable-x" } },
      }),
      { PR_NUMBER: "1" },
      undefined,
      undefined,
      undefined,
      undefined,
      verifier,
    );
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag]); // halted at the implementer
    assert.equal(w.verificationFailed?.node, KEYS.flag);
    assert.match(w.verificationFailed?.failures[0]?.detail ?? "", /not referenced/);
    // Downstream never ran.
    assert.ok(w.skipped.includes(KEYS.metrics));
  });

  it("a passing verification lets the chain continue; a shim crash never halts", async () => {
    let crashed = 0;
    const verifier = async (run: { configKey: string; tags: Record<string, string> }) => {
      if (run.configKey === KEYS.metrics) {
        crashed++;
        throw new Error("shim bug");
      }
      return run.tags.flag_ready === "true"
        ? { node: run.configKey, ok: true, passed: [{ name: "flag-wired-in-code", detail: "ok" }], failures: [] }
        : null;
    };
    const w = await walkGraph(
      buildChain(),
      new FakeRunner({
        [KEYS.research]: { tags: { flag_worthy: "true" } },
        [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
        [KEYS.metrics]: { tags: { needs_tests: "true" } },
        [KEYS.review]: { tags: { review_approved: "approve", risk_level: "low" } },
      }),
      { PR_NUMBER: "1" },
      undefined,
      undefined,
      undefined,
      undefined,
      verifier,
    );
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review]);
    assert.equal(w.verificationFailed, undefined);
    assert.equal(crashed, 1);
  });
});

// ---------------------------------------------------------------------------
describe("routing contract: registry ⟷ runtime + graph consistency", () => {
  const registry = readJson("config/agentcontrol/tags.json").tags as Record<string, unknown>;
  const registryKeys = new Set(Object.keys(registry));

  it("every NODE_REQUIRED_TAGS entry is a registry tag (the .mjs guard can't see this TS map)", () => {
    for (const [node, tags] of Object.entries(NODE_REQUIRED_TAGS)) {
      for (const t of tags) {
        assert.ok(registryKeys.has(t), `${node} forces '${t}', which is not in tags.json`);
      }
    }
  });

  it("every graph edge condition tag is a registry tag", () => {
    const graph = readJson("config/agentcontrol/graphs/auto-factory.json");
    for (const edge of graph.edges ?? []) {
      const h = edge.handoff ?? {};
      for (const kind of ["require_tags", "skip_if_tags"]) {
        for (const t of Object.keys(h[kind] ?? {})) {
          assert.ok(registryKeys.has(t), `edge ${edge.sourceConfig}→${edge.targetConfig} gates on '${t}', not in tags.json`);
        }
      }
    }
  });

  it("the committed graph carries the rework loop edge this file's fixture mirrors", () => {
    // buildChain() is a deliberate simplification of the real graph (it omits the
    // manifest steward), so the loop edge is the one part that MUST stay in step
    // with config — otherwise these loop tests would pass against a shape that no
    // longer ships.
    const graph = readJson("config/agentcontrol/graphs/auto-factory.json");
    const loop = (graph.edges ?? []).find(
      (e: { sourceConfig: string; targetConfig: string }) =>
        e.sourceConfig === KEYS.review && e.targetConfig === KEYS.flag,
    );
    assert.ok(loop, "no code-reviewer → flag-implementer rework edge in the committed graph");
    assert.equal(loop.handoff?.max_visits, 2);
    assert.deepEqual(loop.handoff?.require_tags, { review_approved: "false" });
  });

  it("the verdict/routing tags interpretWalk reads are registry tags", () => {
    for (const t of ["review_approved", "risk_level", "skip_flagging"]) {
      assert.ok(registryKeys.has(t), `interpretWalk reads '${t}', which is not in tags.json`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("routing contract: tag_conversation examples in committed instructions", () => {
  const configFiles = [
    "autofactory-research-planner",
    "autofactory-flag-implementer",
    "autofactory-metrics-author",
    "autofactory-flag-testing",
    "autofactory-code-reviewer",
  ].map((k) => `config/agentcontrol/ai-configs/${k}.json`);

  it("every tag_conversation example uses the valid {tags:{…}} object form (never key=…, value=…)", () => {
    for (const file of configFiles) {
      const instr: string = readJson(file).variations?.[0]?.instructions ?? "";
      // No invalid positional/keyword form.
      assert.equal(
        /tag_conversation\(\s*key\b/.test(instr),
        false,
        `${file}: uses the invalid tag_conversation(key=…) form`,
      );
      // Every explicit call example contains a tags object.
      for (const call of instr.match(/tag_conversation\([^)]*\)/g) ?? []) {
        assert.match(call, /\{\s*"?tags"?\s*:/, `${file}: example is not a tags object: ${call}`);
      }
    }
  });
});
