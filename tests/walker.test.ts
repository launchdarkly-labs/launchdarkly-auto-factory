import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  AgentRunner,
} from "@auto-factory/shared";
import { walkGraph } from "@auto-factory/shared";

/**
 * Fake runner: returns a scripted `{status, tags}` per config key (no network,
 * no Anthropic/Vega plumbing). The final assistant message is synthesized so the
 * walker has something to carry forward as PREVIOUS_STEP_OUTPUT.
 */
class FakeRunner implements AgentRunner {
  constructor(private readonly scriptByKey: Record<string, Partial<AgentNodeResult>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    const scripted = this.scriptByKey[req.configKey] ?? {};
    return {
      status: scripted.status ?? "completed",
      messages: scripted.messages ?? [
        { role: "assistant", content: `done: ${req.configKey}`, isFinal: true },
      ],
      tags: scripted.tags ?? {},
    };
  }
}

/** Minimal LDAIConfigTracker stub — the fake runner never reads it. */
const fakeConfigTracker = () => ({}) as unknown as LDAIConfigTracker;

/** Build an LDAIAgentConfig for a node key. */
function agentConfig(key: string): LDAIAgentConfig {
  return {
    key,
    enabled: true,
    instructions: `instructions for ${key}`,
    model: { name: "Anthropic.claude-sonnet-4-6" },
    createTracker: fakeConfigTracker,
  } as LDAIAgentConfig;
}

/**
 * Build a real `AgentGraphDefinition` for the linear research → flag → test →
 * review chain the walker traverses, with the same handoff conditions the
 * canonical graph uses.
 */
function buildGraph(): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = {
    root: "research",
    edges: {
      research: [{ key: "flag", handoff: { skip_if_tags: { skip_flagging: "true" } } }],
      flag: [{ key: "test", handoff: { require_tags: { flag_created: "true" } } }],
      test: [{ key: "review" }],
    },
  };
  const configs: Record<string, LDAIAgentConfig> = {
    research: agentConfig("research"),
    flag: agentConfig("flag"),
    test: agentConfig("test"),
    review: agentConfig("review"),
  };
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(
    flagValue,
    nodes,
    true,
    () => ({}) as unknown as LDGraphTracker,
  );
}

const run = (script: Record<string, Partial<AgentNodeResult>>) =>
  walkGraph(buildGraph(), new FakeRunner(script), { PR_NUMBER: "1" });

describe("walkGraph", () => {
  it("runs the full chain when conditions pass", async () => {
    const r = await run({
      flag: { tags: { flag_created: "true" } },
      review: { tags: { review_approved: "approve" } },
    });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
    assert.equal(r.skipped.length, 0);
  });

  it("short-circuits when research sets skip_flagging (no flag needed) — NOT a stall", async () => {
    const r = await run({ research: { tags: { skip_flagging: "true" } } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.skipped.sort(), ["flag", "review", "test"]);
    // An intentional skip_if short-circuit is a clean stop, not a stall.
    assert.equal(r.stalledAt, undefined);
  });

  it("stalls observably at flag when require_tags(flag_created) is unmet", async () => {
    const r = await run({ flag: { tags: {} } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag"],
    );
    assert.ok(r.skipped.includes("test") && r.skipped.includes("review"));
    // The stall is surfaced with the node and the missing required tag.
    assert.equal(r.stalledAt?.node, "flag");
    assert.deepEqual(r.stalledAt?.unmet, [{ target: "test", requireMissing: { flag_created: "true" } }]);
  });

  it("a clean full run has no stall", async () => {
    const r = await run({
      flag: { tags: { flag_created: "true" } },
      review: { tags: { review_approved: "approve" } },
    });
    assert.equal(r.stalledAt, undefined);
  });

  it("emits a 'stalled' walk event for live UIs", async () => {
    const events: string[] = [];
    await walkGraph(buildGraph(), new FakeRunner({ flag: { tags: {} } }), { PR_NUMBER: "1" }, undefined, (e) =>
      events.push(e.type),
    );
    assert.ok(events.includes("stalled"), `expected a stalled event, got: ${events.join(", ")}`);
  });
});

describe("walkGraph — approval gates", () => {
  const fullScript = {
    flag: { tags: { flag_created: "true" } },
    review: { tags: { review_approved: "approve" } },
  };

  it("halts BEFORE a gated node when approval is not granted", async () => {
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, undefined, {
      steps: ["flag"],
      resolve: () => false, // not approved
    });
    // Only research ran; the gated flag node and everything after did not.
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.pendingApproval, { node: "flag" });
    assert.ok(r.skipped.includes("flag"));
  });

  it("runs the gated node (and continues) once approval is granted", async () => {
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, undefined, {
      steps: ["flag"],
      resolve: () => true, // approved
    });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
    assert.equal(r.pendingApproval, undefined);
  });

  it("only consults the gate for gated nodes, and supports async resolve", async () => {
    const asked: string[] = [];
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, undefined, {
      steps: ["test"],
      resolve: async (node) => {
        asked.push(node);
        return true;
      },
    });
    assert.deepEqual(asked, ["test"]); // never asked about research/flag/review
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
  });

  it("emits an 'awaiting-approval' event when it halts", async () => {
    const events: string[] = [];
    await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, (e) => events.push(e.type), {
      steps: ["flag"],
      resolve: () => false,
    });
    assert.ok(events.includes("awaiting-approval"), `got: ${events.join(", ")}`);
  });

  it("no gate config → unchanged behavior (full chain)", async () => {
    const r = await run(fullScript);
    assert.equal(r.pendingApproval, undefined);
    assert.equal(r.runs.length, 4);
  });
});

/**
 * Per-call scripted runner: `scriptByKey[key]` may be a single result (reused on
 * every call) OR an array consumed one-per-call (clamped to the last entry), so a
 * node can return e.g. reject then approve across loop iterations. Records the
 * prompt each node received.
 */
class ScriptedRunner implements AgentRunner {
  private readonly calls: Record<string, number> = {};
  readonly promptsByKey: Record<string, string[]> = {};
  readonly envByKey: Record<string, Array<{ maxTurns?: number; capabilities?: string[] }>> = {};
  constructor(private readonly scriptByKey: Record<string, Partial<AgentNodeResult> | Array<Partial<AgentNodeResult>>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    const n = this.calls[req.configKey] ?? 0;
    this.calls[req.configKey] = n + 1;
    (this.promptsByKey[req.configKey] ??= []).push(req.prompt);
    (this.envByKey[req.configKey] ??= []).push({ maxTurns: req.maxTurns, capabilities: req.capabilities });
    const entry = this.scriptByKey[req.configKey];
    const scripted: Partial<AgentNodeResult> = Array.isArray(entry)
      ? entry[Math.min(n, entry.length - 1)] ?? {}
      : entry ?? {};
    return {
      status: scripted.status ?? "completed",
      messages: scripted.messages ?? [
        { role: "assistant", content: `done: ${req.configKey} #${n + 1}`, isFinal: true },
      ],
      tags: scripted.tags ?? {},
    };
  }
  countFor(key: string): number {
    return this.calls[key] ?? 0;
  }
}

/** Records trackHandoffSuccess(from, to) calls for assertions. */
class RecordingTracker {
  readonly handoffs: Array<[string, string]> = [];
  trackHandoffSuccess(from: string, to: string): void {
    this.handoffs.push([from, to]);
  }
}

/** Build an AgentGraphDefinition from an arbitrary flag value (any topology). */
function graphFrom(flagValue: LDAgentGraphFlagValue): AgentGraphDefinition {
  const keys = new Set<string>();
  if (flagValue.root) keys.add(flagValue.root);
  for (const [src, edges] of Object.entries(flagValue.edges ?? {})) {
    keys.add(src);
    for (const e of edges) keys.add(e.key);
  }
  const configs: Record<string, LDAIAgentConfig> = {};
  for (const k of keys) configs[k] = agentConfig(k);
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(flagValue, nodes, true, () => ({}) as unknown as LDGraphTracker);
}

const countOf = (r: { runs: Array<{ configKey: string }> }, key: string) =>
  r.runs.filter((x) => x.configKey === key).length;

describe("walkGraph — loop-back edges", () => {
  // research → flag → test → review, with a tagged loop edge review → flag that
  // fires unless the review approved. Facts (flag_key) set by flag; verdict
  // (review_approved) set by review.
  const loopGraph = (maxVisits: number): LDAgentGraphFlagValue => ({
    root: "research",
    edges: {
      research: [{ key: "flag" }],
      flag: [{ key: "test" }],
      test: [{ key: "review" }],
      review: [{ key: "flag", handoff: { max_visits: maxVisits, skip_if_tags: { review_approved: "approve" } } }],
    },
  });

  it("1. converges after one loop; loop edge tracked; forward edges uncapped", async () => {
    const runner = new ScriptedRunner({
      flag: { tags: { flag_key: "flag-abc" } },
      review: [{ tags: { review_approved: "reject" } }, { tags: { review_approved: "approve" } }],
    });
    const tracker = new RecordingTracker();
    const r = await walkGraph(graphFrom(loopGraph(2)), runner, { PR_NUMBER: "1" }, tracker as unknown as LDGraphTracker);
    assert.equal(countOf(r, "flag"), 2, "flag re-ran once");
    assert.equal(countOf(r, "review"), 2);
    assert.equal(r.loopExhausted, undefined);
    assert.equal(r.stalledAt, undefined);
    // The loop-back handoff was recorded (never a dropped/phantom hop).
    assert.ok(tracker.handoffs.some(([f, t]) => f === "review" && t === "flag"));
  });

  it("2. never converges → loopExhausted(reason=budget), not a stall", async () => {
    const runner = new ScriptedRunner({
      review: { tags: { review_approved: "reject" } }, // always reject
    });
    const r = await walkGraph(graphFrom(loopGraph(2)), runner, { PR_NUMBER: "1" });
    assert.equal(r.stalledAt, undefined);
    assert.equal(r.loopExhausted?.reason, "budget");
    assert.deepEqual(r.loopExhausted?.exhausted, [
      { source: "review", target: "flag", traversals: 2, maxVisits: 2 },
    ]);
    // max_visits:2 → the loop edge fired exactly twice (flag ran 1 + 2 = 3 times).
    assert.equal(countOf(r, "flag"), 3);
  });

  it("3. untagged cycle → run-cap backstop", async () => {
    // a ⇄ b with no max_visits and no exit condition — bounded only by the run cap.
    const g = graphFrom({ root: "a", edges: { a: [{ key: "b" }], b: [{ key: "a" }] } });
    const r = await walkGraph(g, new ScriptedRunner({}), { PR_NUMBER: "1" });
    assert.equal(r.loopExhausted?.reason, "run-cap");
    // nodeCount(2) × (hardCap 10 + 1) = 22.
    assert.equal(r.runs.length, 22);
  });

  it("3b. branch-rejoin immunity (CONFIRMED-A): untagged rejoin edge is never capped", async () => {
    // Iteration ≥2 the planner routes through a remediator R that rejoins at
    // `test` (already visited). R→test is untagged, so it must never be budget-
    // blocked even though its target was first-seen earlier.
    const g = graphFrom({
      root: "planner",
      edges: {
        planner: [
          { key: "remediator", handoff: { require_tags: { needs_fix: "true" } } },
          { key: "flag" },
        ],
        remediator: [{ key: "test" }],
        flag: [{ key: "test" }],
        test: [{ key: "review" }],
        review: [{ key: "planner", handoff: { max_visits: 3, skip_if_tags: { review_approved: "approve" } } }],
      },
    });
    const runner = new ScriptedRunner({
      planner: [{}, { tags: { needs_fix: "true" } }], // iteration 2+ needs a fix → routes via remediator
      review: [{ tags: { review_approved: "reject" } }, { tags: { review_approved: "reject" } }, { tags: { review_approved: "approve" } }],
    });
    const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    // It converged (no exhaustion) — proving the rejoin edge kept advancing.
    assert.equal(r.loopExhausted, undefined);
    assert.equal(r.stalledAt, undefined);
    assert.ok(countOf(r, "remediator") >= 2, "remediator (rejoin path) ran on multiple iterations");
    assert.ok(countOf(r, "test") >= 3, "test kept being reached via the untagged rejoin edge");
  });

  it("6/6b/8. rewind is routing-only, loop-edge-only; facts persist", async () => {
    // flag sets a fact (flag_key) and a routing tag (risk_score) each iteration.
    const runner = new ScriptedRunner({
      flag: [
        { tags: { flag_key: "flag-v1", risk_score: "0.2" } },
        { tags: { flag_key: "flag-v1", risk_score: "0.9" } },
      ],
      review: [{ tags: { review_approved: "reject" } }, { tags: { review_approved: "approve" } }],
    });
    const r = await walkGraph(graphFrom(loopGraph(2)), runner, { PR_NUMBER: "1" });
    // Fact survives the rewind and is exposed via inventory (review #6/#8).
    assert.equal(r.inventory.flag_key, "flag-v1");
    // A routing tag set early in the FINAL iteration survives a forward re-entry
    // to `test`/`review` (rewind only fires on the loop edge — CONFIRMED-B).
    assert.equal(r.tags.risk_score, "0.9");
  });

  it("5. retry-then-fallback: exhausted loop edge falls through to a fallback edge", async () => {
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "flag" }],
        flag: [{ key: "test" }],
        test: [{ key: "review" }],
        review: [
          { key: "flag", handoff: { max_visits: 1, skip_if_tags: { review_approved: "approve" } } }, // loop
          { key: "done" }, // fallback terminal, taken once the loop budget is spent
        ],
      },
    });
    const runner = new ScriptedRunner({ review: { tags: { review_approved: "reject" } } }); // never approves
    const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    assert.equal(r.loopExhausted, undefined, "fallback taken, so not exhausted");
    assert.equal(r.stalledAt, undefined);
    assert.equal(countOf(r, "done"), 1, "fallback terminal ran");
    assert.equal(countOf(r, "flag"), 2, "loop fired once (max_visits:1), then fell through");
  });

  // Phase 4 Step 1a discovered this: giving a previously-terminal node a loop-back
  // edge made every clean run report `stalledAt`, because an unmet require_tags was
  // read as "the chain can't advance". For a LOOP edge, unmet means the rework
  // trigger didn't fire — convergence, not a stall.
  describe("5b. an unmet loop edge is convergence, not a stall", () => {
    it("a node whose only edge is an unmet loop edge terminates cleanly", async () => {
      const g = graphFrom({
        root: "research",
        edges: {
          research: [{ key: "flag" }],
          flag: [{ key: "test" }],
          test: [{ key: "review" }],
          review: [{ key: "flag", handoff: { max_visits: 2, require_tags: { review_approved: "false" } } }],
        },
      });
      const runner = new ScriptedRunner({ review: { tags: { review_approved: "true" } } }); // approves
      const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
      assert.equal(r.stalledAt, undefined, "an approved run must not look stalled");
      assert.equal(r.loopExhausted, undefined);
      assert.equal(countOf(r, "flag"), 1, "the loop never fired");
      assert.deepEqual(r.skipped, []);
    });

    it("an unmet FORWARD edge still stalls, and the stall names only that edge", async () => {
      // Discriminating: the suppression must be scoped to max_visits edges, or a
      // genuinely blocked chain would go silent — the exact failure mode issue #9
      // asked to surface.
      const g = graphFrom({
        root: "research",
        edges: {
          research: [{ key: "flag" }],
          flag: [{ key: "test" }],
          test: [{ key: "review" }],
          review: [
            { key: "flag", handoff: { max_visits: 2, require_tags: { review_approved: "false" } } }, // loop, unmet
            { key: "done", handoff: { require_tags: { ship: "true" } } }, // forward, unmet
          ],
        },
      });
      const runner = new ScriptedRunner({ review: { tags: { review_approved: "true" } } });
      const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
      assert.equal(r.stalledAt?.node, "review");
      assert.deepEqual(
        r.stalledAt?.unmet,
        [{ target: "done", requireMissing: { ship: "true" } }],
        "the unmet loop edge is not reported as a cause of the stall",
      );
    });

    it("a budget-SPENT loop edge still reports loopExhausted (suppression is only for unmet)", async () => {
      const g = graphFrom({
        root: "research",
        edges: {
          research: [{ key: "flag" }],
          flag: [{ key: "test" }],
          test: [{ key: "review" }],
          review: [{ key: "flag", handoff: { max_visits: 1, require_tags: { review_approved: "false" } } }],
        },
      });
      const runner = new ScriptedRunner({ review: { tags: { review_approved: "false" } } }); // never converges
      const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
      assert.equal(r.stalledAt, undefined);
      assert.equal(r.loopExhausted?.reason, "budget");
      assert.deepEqual(r.loopExhausted?.exhausted, [
        { source: "review", target: "flag", traversals: 1, maxVisits: 1 },
      ]);
    });
  });

  it("9. envelope inheritance: a re-run inherits the first-entry max_turns/capabilities", async () => {
    const g = graphFrom({
      root: "research",
      edges: {
        // The forward edge into flag carries the execution envelope...
        research: [{ key: "flag", handoff: { max_turns: 20, capabilities: ["edit_files"] } }],
        flag: [{ key: "test" }],
        test: [{ key: "review" }],
        // ...the loop edge omits it; the re-run must inherit, not fall to defaults.
        review: [{ key: "flag", handoff: { max_visits: 2, skip_if_tags: { review_approved: "approve" } } }],
      },
    });
    const runner = new ScriptedRunner({
      review: [{ tags: { review_approved: "reject" } }, { tags: { review_approved: "approve" } }],
    });
    await walkGraph(g, runner, { PR_NUMBER: "1" });
    const flagEnvs = runner.envByKey.flag ?? [];
    assert.equal(flagEnvs.length, 2, "flag ran twice");
    assert.deepEqual(flagEnvs[0], { maxTurns: 20, capabilities: ["edit_files"] });
    assert.deepEqual(flagEnvs[1], { maxTurns: 20, capabilities: ["edit_files"] }, "re-run inherited the envelope");
  });

  it("10. a re-entered root keeps PR_BODY and gets the rework preamble + brief", async () => {
    const g = graphFrom({
      root: "planner",
      edges: {
        planner: [{ key: "review" }],
        review: [{ key: "planner", handoff: { max_visits: 2, skip_if_tags: { review_approved: "approve" } } }],
      },
    });
    const runner = new ScriptedRunner({
      review: [{ tags: { review_approved: "reject" } }, { tags: { review_approved: "approve" } }],
    });
    await walkGraph(g, runner, { PR_NUMBER: "7", PR_BODY: "THE-PR-BODY-TEXT" });
    const secondPlannerPrompt = runner.promptsByKey.planner?.[1] ?? "";
    assert.ok(secondPlannerPrompt.includes("THE-PR-BODY-TEXT"), "re-entered root kept PR_BODY");
    assert.ok(secondPlannerPrompt.includes("REWORK ITERATION 2"), "rework preamble present");
    assert.ok(secondPlannerPrompt.includes("done: review"), "loop-source brief carried in");
  });

  it("6a. rewind DROPS a stale iteration-1 routing tag on the loop edge (proves the rewind)", async () => {
    // flag sets risk_score ONLY on iteration 1. If the loop-edge rewind works,
    // that stale routing value is gone by the end; a fact (flag_key) persists.
    // This assertion FAILS if the rewind is removed (risk_score would survive).
    const runner = new ScriptedRunner({
      flag: [
        { tags: { flag_key: "flag-v1", risk_score: "0.2" } },
        { tags: { flag_key: "flag-v1" } }, // iteration 2: no risk_score
      ],
      review: [{ tags: { review_approved: "reject" } }, { tags: { review_approved: "approve" } }],
    });
    const r = await walkGraph(graphFrom(loopGraph(2)), runner, { PR_NUMBER: "1" });
    assert.equal(r.tags.risk_score, undefined, "stale iteration-1 routing tag was rewound away");
    assert.equal(r.inventory.flag_key, "flag-v1", "fact survived the rewind");
    assert.equal(r.tags.review_approved, "approve");
  });

  it("4. self-loop with max_visits converges and is a rewind no-op for the node's own tags", async () => {
    const g = graphFrom({
      root: "a",
      edges: { a: [{ key: "a", handoff: { max_visits: 2, skip_if_tags: { done: "true" } } }] },
    });
    const runner = new ScriptedRunner({
      a: [{ tags: { risk_score: "0.1" } }, { tags: { risk_score: "0.2" } }, { tags: { done: "true", risk_score: "0.3" } }],
    });
    const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    assert.equal(countOf(r, "a"), 3, "ran 3× (1 + 2 self-loops), then skip_if exited");
    assert.equal(r.loopExhausted, undefined);
    assert.equal(r.stalledAt, undefined);
    // The node's own latest routing tag is preserved across its self-loops.
    assert.equal(r.tags.risk_score, "0.3");
  });

  it("7. per-edge independence: two loop edges to different targets keep separate budgets", async () => {
    // review has two loop edges (evaluated in order): →flag (budget 1) then →test
    // (budget 2). Never satisfies either skip condition, so each exhausts at its
    // own budget, independently.
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "flag" }],
        flag: [{ key: "test" }],
        test: [{ key: "review" }],
        review: [
          { key: "flag", handoff: { max_visits: 1, skip_if_tags: { d1: "true" } } },
          { key: "test", handoff: { max_visits: 2, skip_if_tags: { d2: "true" } } },
        ],
      },
    });
    const r = await walkGraph(g, new ScriptedRunner({}), { PR_NUMBER: "1" });
    assert.equal(r.loopExhausted?.reason, "budget");
    assert.deepEqual(r.loopExhausted?.exhausted, [
      { source: "review", target: "flag", traversals: 1, maxVisits: 1 },
      { source: "review", target: "test", traversals: 2, maxVisits: 2 },
    ]);
  });

  it("3c. nested loops: an inner and an outer loop edge each fire and the walk converges", async () => {
    // Inner loop test→flag and outer loop review→plan, each with a fallthrough
    // edge. Both budgets are honored (per-walk) and the walk finishes cleanly.
    const g = graphFrom({
      root: "plan",
      edges: {
        plan: [{ key: "flag" }],
        flag: [{ key: "test" }],
        test: [
          { key: "flag", handoff: { max_visits: 1 } }, // inner loop, then fall through
          { key: "review" },
        ],
        review: [
          { key: "plan", handoff: { max_visits: 1 } }, // outer loop, then fall through
          { key: "done" },
        ],
      },
    });
    const tracker = new RecordingTracker();
    const r = await walkGraph(g, new ScriptedRunner({}), { PR_NUMBER: "1" }, tracker as unknown as LDGraphTracker);
    assert.equal(r.loopExhausted, undefined, "both loops fell through cleanly");
    assert.equal(r.stalledAt, undefined);
    assert.equal(countOf(r, "done"), 1, "reached the terminal via fallthroughs");
    assert.ok(tracker.handoffs.some(([f, t]) => f === "test" && t === "flag"), "inner loop edge fired");
    assert.ok(tracker.handoffs.some(([f, t]) => f === "review" && t === "plan"), "outer loop edge fired");
  });
});
