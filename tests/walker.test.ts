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
import { describeLoopExhausted, walkGraph } from "@auto-factory/shared";

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
    await walkGraph(buildGraph(), new FakeRunner({ flag: { tags: {} } }), { PR_NUMBER: "1" }, { onEvent: (e) =>
      events.push(e.type) },
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
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, { gate: {
      steps: ["flag"],
      resolve: () => false, // not approved
    } });
    // Only research ran; the gated flag node and everything after did not.
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.pendingApproval, { node: "flag" });
    assert.ok(r.skipped.includes("flag"));
  });

  it("runs the gated node (and continues) once approval is granted", async () => {
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, { gate: {
      steps: ["flag"],
      resolve: () => true, // approved
    } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
    assert.equal(r.pendingApproval, undefined);
  });

  it("only consults the gate for gated nodes, and supports async resolve", async () => {
    const asked: string[] = [];
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, { gate: {
      steps: ["test"],
      resolve: async (node) => {
        asked.push(node);
        return true;
      },
    } });
    assert.deepEqual(asked, ["test"]); // never asked about research/flag/review
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
  });

  it("emits an 'awaiting-approval' event when it halts", async () => {
    const events: string[] = [];
    await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, { onEvent: (e) => events.push(e.type), gate: {
      steps: ["flag"],
      resolve: () => false,
    } });
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
    const r = await walkGraph(graphFrom(loopGraph(2)), runner, { PR_NUMBER: "1" }, { graphTracker: tracker as unknown as LDGraphTracker });
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
      // A skip_if loop edge fires on the ABSENCE of its exit condition, so the
      // trigger is phrased as the exit that never happened.
      { source: "review", target: "flag", traversals: 2, maxVisits: 2, trigger: "review_approved never became approve" },
    ]);
    // max_visits:2 → the loop edge fired exactly twice (flag ran 1 + 2 = 3 times).
    assert.equal(countOf(r, "flag"), 3);
    // The human-facing one-liner names the condition, not just the spent counter:
    // "budget exhausted" alone tells a reader nothing about what to fix.
    const msg = describeLoopExhausted(r.loopExhausted!);
    assert.match(msg, /trigger: review_approved never became approve/);
    assert.match(msg, /2\/2 traversals/);
  });

  it("2b. describeLoopExhausted omits the trigger clause when there is no condition", async () => {
    // An unconditional loop edge (max_visits only) has nothing to name, and the
    // message must not grow a dangling "trigger:".
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "flag" }],
        flag: [{ key: "test" }],
        test: [{ key: "review" }],
        review: [{ key: "flag", handoff: { max_visits: 1 } }],
      },
    });
    const r = await walkGraph(g, new ScriptedRunner({}), { PR_NUMBER: "1" });
    assert.equal(r.loopExhausted?.reason, "budget");
    assert.equal(r.loopExhausted?.exhausted[0]?.trigger, undefined);
    assert.doesNotMatch(describeLoopExhausted(r.loopExhausted!), /trigger:/);
  });

  it("2c. run-cap exhaustion keeps its own message (no trigger clause)", async () => {
    // a ⇄ b with no max_visits — the run-level backstop, not a per-edge budget.
    const g = graphFrom({ root: "a", edges: { a: [{ key: "b" }], b: [{ key: "a" }] } });
    const r = await walkGraph(g, new ScriptedRunner({}), { PR_NUMBER: "1" });
    assert.equal(r.loopExhausted?.reason, "run-cap");
    assert.match(describeLoopExhausted(r.loopExhausted!), /total-node-run cap/);
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
        { source: "review", target: "flag", traversals: 1, maxVisits: 1, trigger: "review_approved=false" },
      ]);
    });
  });

  it("5c. warns when a loop edge gates on a routing tag its source cannot emit", async () => {
    // check-configs catches this in the COMMITTED graph, but the walker executes the
    // graph LaunchDarkly serves — a dashboard edit can introduce it with no build in
    // between. Without the warning the loop is simply dead: no stall, no exhaustion,
    // nothing in the report.
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "flag" }],
        flag: [{ key: "review" }],
        // `flag_worthy` is the planner's routing tag; the reviewer never emits it.
        review: [{ key: "flag", handoff: { max_visits: 2, require_tags: { flag_worthy: "true" } } }],
      },
    });
    const runner = new ScriptedRunner({ research: { tags: { flag_worthy: "true" } } });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    let r;
    try {
      r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    } finally {
      console.warn = realWarn;
    }
    assert.equal(countOf(r, "flag"), 1, "the loop cannot fire — that is the point");
    assert.equal(r.loopExhausted, undefined);
    assert.equal(r.stalledAt, undefined);
    assert.ok(
      warnings.some((w) => w.includes("can never fire") && w.includes("flag_worthy")),
      `expected a dead-loop-edge warning, got: ${warnings.join(" | ")}`,
    );
  });

  it("5d. inventory ACCUMULATES metric_keys across iterations; other facts are last-write-wins", async () => {
    // The tool executor is per node run, so a re-run's metric_keys lists only what THAT
    // run created. Last-write-wins would hide iteration 1's metrics as soon as a rework
    // created another — the links would go missing and the run would look like it created
    // less than it did. flag_key must NOT accumulate: it is a single resource identity,
    // and the orphan guard compares against the final one.
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "metrics" }],
        metrics: [{ key: "metrics", handoff: { max_visits: 1, require_tags: { retry: "yes" } } }],
      },
    });
    const runner = new ScriptedRunner({
      metrics: [
        { tags: { metric_keys: "m1, m2", flag_key: "enable-x", retry: "yes" } },
        { tags: { metric_keys: "m3,m1", flag_key: "enable-y" } }, // m1 repeated, flag changed
      ],
    });
    const r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    assert.equal(countOf(r, "metrics"), 2);
    assert.equal(r.inventory.metric_keys, "m1,m2,m3", "union, deduped, whitespace-trimmed");
    assert.equal(r.inventory.flag_key, "enable-y", "still last-write-wins");
  });

  it("5e. an unreachable loop EXIT is reported per-iteration, then asserted at exhaustion", async () => {
    // Two strengths, both evidence-based. Per pass: "this iteration was taken while the
    // exit tag went unemitted" — factual, and conditional about the future, because a tag
    // emitted only on affirmative passes is legitimate. At exhaustion: "never satisfiable
    // across N iterations" — now a record, so it can name the served graph.
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "flag" }],
        flag: [{ key: "review" }],
        // `needs_tests` belongs to the metrics author; the reviewer never emits it.
        review: [{ key: "flag", handoff: { max_visits: 2, skip_if_tags: { needs_tests: "true" } } }],
      },
    });
    const runner = new ScriptedRunner({ research: { tags: { needs_tests: "true" } } });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    let r;
    try {
      r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    } finally {
      console.warn = realWarn;
    }
    assert.equal(countOf(r, "flag"), 3, "it really does burn the whole budget");
    assert.equal(r.loopExhausted?.reason, "budget");

    const perPass = warnings.filter((w) => w.includes("iteration taken while its exit named"));
    assert.equal(perPass.length, 1, "deduped: once per edge per walk, not once per pass");
    assert.match(perPass[0]!, /needs_tests/);
    assert.match(perPass[0]!, /If it never emits them/, "conditional, not a categorical claim");

    const earned = warnings.find((w) => w.includes("never satisfiable"));
    assert.ok(earned, `expected the exhaustion claim, got: ${warnings.join(" | ")}`);
    assert.match(earned!, /exhausted 2 iteration\(s\)/, "the claim cites the record");
    assert.match(earned!, /SERVED graph/);
  });

  it("5f. an exit tag the source DOES emit draws neither warning", async () => {
    // Discriminating against over-warning: this is a healthy loop that exits normally, and
    // the previous design would have flagged it on the passes before the exit fired.
    const g = graphFrom({
      root: "research",
      edges: {
        research: [{ key: "flag" }],
        flag: [{ key: "review" }],
        review: [{ key: "flag", handoff: { max_visits: 3, skip_if_tags: { review_approved: "true" } } }],
      },
    });
    // Omits the tag on pass 1 (still not approved), emits it on pass 2 — the intermittent
    // emitter pattern that a static "can never exit" claim would libel.
    const runner = new ScriptedRunner({ review: [{ tags: {} }, { tags: { review_approved: "true" } }] });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    let r;
    try {
      r = await walkGraph(g, runner, { PR_NUMBER: "1" });
    } finally {
      console.warn = realWarn;
    }
    assert.equal(r.loopExhausted, undefined, "it exited normally on pass 2");
    assert.equal(countOf(r, "flag"), 2);
    assert.ok(
      !warnings.some((w) => w.includes("never satisfiable")),
      `no categorical claim for a loop that exited: ${warnings.join(" | ")}`,
    );
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
      { source: "review", target: "flag", traversals: 1, maxVisits: 1, trigger: "d1 never became true" },
      { source: "review", target: "test", traversals: 2, maxVisits: 2, trigger: "d2 never became true" },
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
    const r = await walkGraph(g, new ScriptedRunner({}), { PR_NUMBER: "1" }, { graphTracker: tracker as unknown as LDGraphTracker });
    assert.equal(r.loopExhausted, undefined, "both loops fell through cleanly");
    assert.equal(r.stalledAt, undefined);
    assert.equal(countOf(r, "done"), 1, "reached the terminal via fallthroughs");
    assert.ok(tracker.handoffs.some(([f, t]) => f === "test" && t === "flag"), "inner loop edge fired");
    assert.ok(tracker.handoffs.some(([f, t]) => f === "review" && t === "plan"), "outer loop edge fired");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Step 2 — resume as event-log replay.
//
// The walk loop is pure: every value it accumulates (tags, inventory, edgeCounts,
// routingSnapshots, envelope inheritance) is a function of the ordered node results
// plus the graph. So a resume replays the recorded results through the SAME loop and
// lets it rebuild its own internals, rather than serialising and restoring them.
// ---------------------------------------------------------------------------
describe("walkGraph — resume (event-log replay)", () => {
  /** Fails loudly if the runner is reached; a full replay must not execute anything. */
  class NeverRunner implements AgentRunner {
    calls = 0;
    async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
      this.calls++;
      throw new Error(`runner must not be called during replay (reached '${req.configKey}')`);
    }
  }

  /** research → flag → test → review, with a rework loop on a rejected review. */
  const reworkGraphValue = (maxVisits: number): LDAgentGraphFlagValue => ({
    root: "research",
    edges: {
      research: [{ key: "flag" }],
      flag: [{ key: "test" }],
      test: [{ key: "review" }],
      review: [{ key: "flag", handoff: { max_visits: maxVisits, require_tags: { review_approved: "false" } } }],
    },
  });

  /** A graph whose configs count createTracker() calls (one per LIVE node run). */
  function countingGraph(value: LDAgentGraphFlagValue): { graph: AgentGraphDefinition; trackers: () => number } {
    let made = 0;
    const keys = new Set<string>([value.root ?? ""]);
    for (const [src, edges] of Object.entries(value.edges ?? {})) {
      keys.add(src);
      for (const e of edges) keys.add(e.key);
    }
    const configs: Record<string, LDAIAgentConfig> = {};
    for (const k of keys) {
      configs[k] = {
        key: k,
        enabled: true,
        instructions: `instructions for ${k}`,
        model: { name: "Anthropic.claude-sonnet-4-6" },
        createTracker: () => {
          made++;
          return {} as unknown as LDAIConfigTracker;
        },
      } as LDAIAgentConfig;
    }
    const nodes = AgentGraphDefinition.buildNodes(value, configs);
    return {
      graph: new AgentGraphDefinition(value, nodes, true, () => ({}) as unknown as LDGraphTracker),
      trackers: () => made,
    };
  }

  it("1. PROPERTY: replaying a completed walk reproduces it exactly, executing nothing", async () => {
    // The correctness guarantee snapshot-restore cannot have. If this ever fails,
    // some input the walk branches on is not in the journal.
    const script = {
      flag: { tags: { flag_ready: "true", flag_key: "enable-x" } },
      review: [{ tags: { review_approved: "false" } }, { tags: { review_approved: "true" } }],
    };
    const first = await walkGraph(graphFrom(reworkGraphValue(2)), new ScriptedRunner(script), { PR_NUMBER: "1" });
    assert.equal(countOf(first, "flag"), 2, "the fixture actually looped");

    const never = new NeverRunner();
    const replayed = await walkGraph(graphFrom(reworkGraphValue(2)), never, { PR_NUMBER: "1" }, {
      resume: { journal: first.runs },
    });
    assert.equal(never.calls, 0, "a fully-journalled walk executes no nodes");
    assert.equal(replayed.replayDiverged, undefined);
    assert.deepEqual(replayed, first, "replay must be indistinguishable from the original walk");
  });

  it("2. replayed nodes create no trackers, record no handoffs, and run no judges", async () => {
    // Replaying LD side effects would double-count the per-variation AI Config
    // monitoring data that the model A/B depends on.
    const script = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "true" } } };
    const seed = countingGraph(reworkGraphValue(2));
    const first = await walkGraph(seed.graph, new ScriptedRunner(script), { PR_NUMBER: "1" });
    const liveTrackers = seed.trackers();
    assert.equal(liveTrackers, first.runs.length, "one tracker per live node run");

    const replay = countingGraph(reworkGraphValue(2));
    const handoffs = new RecordingTracker();
    let judged = 0;
    await walkGraph(replay.graph, new NeverRunner(), { PR_NUMBER: "1" }, {
      graphTracker: handoffs as unknown as LDGraphTracker,
      judgeHook: async () => {
        judged++;
        return [];
      },
      resume: { journal: first.runs },
    });
    assert.equal(replay.trackers(), 0, "no trackers for replayed nodes");
    assert.deepEqual(handoffs.handoffs, [], "no handoff metrics re-recorded");
    assert.equal(judged, 0, "no judges re-run");
  });

  it("3. resume past a gate halt: replayed nodes are not re-gated, the frontier is", async () => {
    const g = () => graphFrom(reworkGraphValue(2));
    const script = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "true" } } };
    // Gate BOTH research and flag, approving research but withholding flag.
    const first = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      gate: { steps: ["research", "flag"], resolve: async (n) => n === "research" },
    });
    assert.deepEqual(first.pendingApproval, { node: "flag" });
    assert.deepEqual(first.runs.map((r) => r.configKey), ["research"]);

    const asked: string[] = [];
    const resumed = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      gate: {
        steps: ["research", "flag"],
        resolve: async (n) => {
          asked.push(n);
          return true;
        },
      },
      resume: { journal: first.runs },
    });
    // The whole point: 'research' already ran, so it is not re-asked — otherwise a
    // resume would re-prompt for every approval already given.
    assert.deepEqual(asked, ["flag"], "only the frontier node was gated");
    assert.deepEqual(resumed.runs.map((r) => r.configKey), ["research", "flag", "test", "review"]);
    assert.equal(resumed.pendingApproval, undefined);
    assert.equal(resumed.replayDiverged, undefined);
  });

  it("4. resume a loop-exhausted walk with an extraVisits grant, and converge", async () => {
    const g = () => graphFrom(reworkGraphValue(1));
    const rejecting = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "false" } } };
    const first = await walkGraph(g(), new ScriptedRunner(rejecting), { PR_NUMBER: "1" });
    assert.equal(first.loopExhausted?.reason, "budget");
    assert.equal(countOf(first, "flag"), 2, "1 initial + max_visits(1)");

    // The human grants one more pass AND the reviewer now approves.
    const resumed = await walkGraph(g(), new ScriptedRunner({
      flag: { tags: { flag_ready: "true" } },
      review: { tags: { review_approved: "true" } },
    }), { PR_NUMBER: "1" }, {
      resume: {
        journal: first.runs,
        grants: [{ edge: "review→flag", visits: 1, effectiveAfterRuns: first.runs.length }],
        humanFeedback: "scope the flag to the checkout path only",
      },
    });
    assert.equal(resumed.loopExhausted, undefined, "the grant let it converge");
    assert.equal(resumed.replayDiverged, undefined);
    assert.equal(countOf(resumed, "flag"), 3, "one more rework pass than before");
  });

  it("5. humanFeedback reaches the first LIVE node only", async () => {
    const g = () => graphFrom(reworkGraphValue(2));
    const script = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "true" } } };
    const first = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      gate: { steps: ["flag"], resolve: async () => false },
    });
    assert.deepEqual(first.runs.map((r) => r.configKey), ["research"]);

    const runner = new ScriptedRunner(script);
    await walkGraph(g(), runner, { PR_NUMBER: "1" }, {
      gate: { steps: ["flag"], resolve: async () => true },
      resume: { journal: first.runs, humanFeedback: "USE-THE-EXISTING-FLAG" },
    });
    const flagPrompt = (runner.promptsByKey.flag ?? [])[0] ?? "";
    assert.match(flagPrompt, /=== HUMAN GUIDANCE \(authoritative/);
    assert.match(flagPrompt, /USE-THE-EXISTING-FLAG/);
    // Delivered once: the next live node must not inherit it.
    const testPrompt = (runner.promptsByKey.test ?? [])[0] ?? "";
    assert.doesNotMatch(testPrompt, /HUMAN GUIDANCE/);
  });

  it("6. DIVERGENCE: a journal naming a different node fails closed", async () => {
    const script = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "true" } } };
    const first = await walkGraph(graphFrom(reworkGraphValue(2)), new ScriptedRunner(script), { PR_NUMBER: "1" });
    // Corrupt entry 1 as if the graph had been reordered under the journal.
    const tampered = first.runs.map((r, i) => (i === 1 ? { ...r, configKey: "review" } : r));
    const never = new NeverRunner();
    const r = await walkGraph(graphFrom(reworkGraphValue(2)), never, { PR_NUMBER: "1" }, {
      resume: { journal: tampered },
    });
    assert.equal(r.replayDiverged?.atIndex, 1);
    assert.equal(r.replayDiverged?.expected, "review#1");
    assert.equal(r.replayDiverged?.actual, "flag#1");
    assert.match(r.replayDiverged?.detail ?? "", /fresh run is required/);
    assert.equal(never.calls, 0, "it stops before executing anything");
  });

  it("7. DIVERGENCE: an unconsumed journal fails closed too", async () => {
    const script = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "true" } } };
    const first = await walkGraph(graphFrom(reworkGraphValue(2)), new ScriptedRunner(script), { PR_NUMBER: "1" });
    // Resume against a graph that now terminates at the root — the rest of the
    // journal can never be reached, which must not read as a clean short run.
    const truncated = graphFrom({ root: "research", edges: { research: [] } });
    const r = await walkGraph(truncated, new NeverRunner(), { PR_NUMBER: "1" }, { resume: { journal: first.runs } });
    assert.equal(r.replayDiverged?.actual, "(walk ended)");
    assert.equal(r.replayDiverged?.atIndex, 1);
    assert.match(r.replayDiverged?.detail ?? "", /before consuming the whole journal/);
  });

  it("8b. a grant on a MID-JOURNAL edge does not rewrite replayed history", async () => {
    // The grant must apply only at the frontier. Applied during replay it lets a
    // replayed step take a loop the original walk fell through, which surfaces as a
    // bogus "the graph changed" divergence — and granting the edge named in a
    // "quality loop used all attempts" warning is the natural human response.
    //
    // The fall-through must be MID-journal for this to bite: at the LAST journalled
    // step the journal is already consumed, so the grant applies either way.
    const g = (): AgentGraphDefinition =>
      graphFrom({
        root: "metrics",
        edges: {
          metrics: [
            { key: "metrics", handoff: { max_visits: 1, require_tags: { retry: "yes" } } },
            { key: "mid", handoff: {} },
          ],
          mid: [{ key: "gated", handoff: {} }],
          gated: [],
        },
      });
    const script = { metrics: { tags: { retry: "yes" } } };
    // Loop fires once, budget spent, falls through to `mid`, then halts at `gated`.
    // Journal: [metrics#1, metrics#2, mid#1] — the fall-through is at index 1.
    const first = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      gate: { steps: ["gated"], resolve: async () => false },
    });
    assert.deepEqual(first.runs.map((r) => r.configKey), ["metrics", "metrics", "mid"]);
    assert.equal(first.pendingApproval?.node, "gated");
    assert.ok(first.loopBudgetSpent, "the advisory loop spent its budget mid-walk");

    const resumed = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      gate: { steps: ["gated"], resolve: async () => true },
      resume: {
        journal: first.runs,
        grants: [{ edge: "metrics→metrics", visits: 1, effectiveAfterRuns: first.runs.length }],
        humanFeedback: "try again",
      },
    });
    assert.equal(resumed.replayDiverged, undefined, "replayed steps must re-derive the ORIGINAL budget decision");
    assert.deepEqual(resumed.runs.map((r) => r.configKey), ["metrics", "metrics", "mid", "gated"]);
  });

  it("8c. grants ITERATE: a second grant round replays the first one's traversals", async () => {
    // Grants must be journalled, because the walk branches on them. Without
    // `priorExtraVisits`, round 3 replays a traversal the round-2 grant paid for,
    // budget-blocks it, ends mid-journal, and reports divergence — blaming "the
    // graph changed" and capping grant-and-feedback at exactly one round.
    const g = () => graphFrom(reworkGraphValue(1));
    const rejecting = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "false" } } };
    const EDGE = "review→flag";

    // Round 1: budget spent, exhausted.
    const r1 = await walkGraph(g(), new ScriptedRunner(rejecting), { PR_NUMBER: "1" });
    assert.equal(r1.loopExhausted?.reason, "budget");
    assert.equal(countOf(r1, "flag"), 2);

    // Round 2: grant one more pass; still rejected, so exhausted again.
    const r2 = await walkGraph(g(), new ScriptedRunner(rejecting), { PR_NUMBER: "1" }, {
      resume: { journal: r1.runs, grants: [{ edge: EDGE, visits: 1, effectiveAfterRuns: r1.runs.length }], humanFeedback: "first attempt" },
    });
    assert.equal(r2.replayDiverged, undefined);
    assert.equal(r2.loopExhausted?.reason, "budget", "the granted pass also failed");
    assert.equal(countOf(r2, "flag"), 3);

    // Round 3: the caller carries round 2's grant forward as PRIOR and adds a new
    // one. Replay must reproduce round 2 exactly, then the new grant fires live.
    const r3 = await walkGraph(g(), new ScriptedRunner({
      flag: { tags: { flag_ready: "true" } },
      review: { tags: { review_approved: "true" } }, // this time it converges
    }), { PR_NUMBER: "1" }, {
      resume: {
        journal: r2.runs,
        // Round 2's grant keeps the position it took effect at; round 3's applies at the
        // new frontier. Flattening these is what diverged.
        grants: [
          { edge: EDGE, visits: 1, effectiveAfterRuns: r1.runs.length },
          { edge: EDGE, visits: 1, effectiveAfterRuns: r2.runs.length },
        ],
        humanFeedback: "second attempt",
      },
    });
    assert.equal(r3.replayDiverged, undefined, "round 2's granted traversal must replay, not diverge");
    assert.equal(r3.loopExhausted, undefined, "the second grant let it converge");
    assert.equal(countOf(r3, "flag"), 4, "3 replayed + 1 live rework");
  });

  it("8d. TWO loop edges on the halting node: a grant does not un-block the earlier position", async () => {
    // The case that broke the flat-total model. `x` has two loop edges; the first spends
    // its budget mid-journal while the second keeps the walk moving, so BOTH end up
    // recorded as exhausted at the halt. A flat grant on the first then un-blocked its
    // mid-journal position on replay and diverged — permanently, since the journal is kept.
    const g = () =>
      graphFrom({
        root: "x",
        edges: {
          x: [
            { key: "a", handoff: { max_visits: 1, require_tags: { go: "yes" } } },
            { key: "b", handoff: { max_visits: 2, require_tags: { go: "yes" } } },
          ],
          a: [{ key: "x" }],
          b: [{ key: "x" }],
        },
      });
    const script = { x: { tags: { go: "yes" } } };
    const first = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" });
    assert.equal(first.loopExhausted?.reason, "budget");
    const spentEdges = (first.loopExhausted?.exhausted ?? []).map((e) => `${e.source}→${e.target}`);
    assert.ok(spentEdges.includes("x→a"), `expected x→a among ${spentEdges.join(", ")}`);
    assert.ok(spentEdges.includes("x→b"), "both edges are recorded as exhausted at the halt");

    // Grant the edge whose FIRST block was mid-journal, not at the halt.
    const resumed = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      resume: {
        journal: first.runs,
        grants: [{ edge: "x→a", visits: 1, effectiveAfterRuns: first.runs.length }],
        humanFeedback: "one more",
      },
    });
    assert.equal(
      resumed.replayDiverged,
      undefined,
      `replay must reproduce the journal; diverged: ${JSON.stringify(resumed.replayDiverged)}`,
    );
    // The journal replays verbatim, and the grant fires only at the frontier.
    assert.deepEqual(
      resumed.runs.slice(0, first.runs.length).map((r) => `${r.configKey}#${r.iteration}`),
      first.runs.map((r) => `${r.configKey}#${r.iteration}`),
    );
    assert.ok(resumed.runs.length > first.runs.length, "the grant did unlock further work");

    // THE DISCRIMINATING STEP. The flat-total model didn't break on the first granted
    // resume — it broke on the NEXT one, replaying a journal that already contains a
    // granted traversal. Round 1 alone passes under the old frontier-gated shape too, so
    // without this a regression to uniform application would go unnoticed.
    const third = await walkGraph(g(), new ScriptedRunner(script), { PR_NUMBER: "1" }, {
      resume: {
        journal: resumed.runs,
        // Round 2's grant keeps the position it was issued at; nothing new is added.
        grants: [{ edge: "x→a", visits: 1, effectiveAfterRuns: first.runs.length }],
      },
    });
    assert.equal(
      third.replayDiverged,
      undefined,
      `replaying an already-granted journal must not diverge; got ${JSON.stringify(third.replayDiverged)}`,
    );
    assert.deepEqual(
      third.runs.slice(0, resumed.runs.length).map((r) => `${r.configKey}#${r.iteration}`),
      resumed.runs.map((r) => `${r.configKey}#${r.iteration}`),
      "the granted traversal replays at the position it happened",
    );
  });

  it("8. an extraVisits grant cannot exceed the hard cap", async () => {
    // A grant raises a ceiling; it can never remove one.
    const g = () => graphFrom(reworkGraphValue(2));
    const rejecting = { flag: { tags: { flag_ready: "true" } }, review: { tags: { review_approved: "false" } } };
    const first = await walkGraph(g(), new ScriptedRunner(rejecting), { PR_NUMBER: "1" });
    const resumed = await walkGraph(g(), new ScriptedRunner(rejecting), { PR_NUMBER: "1" }, {
      resume: { journal: first.runs, grants: [{ edge: "review→flag", visits: 1000, effectiveAfterRuns: first.runs.length }] },
    });
    assert.equal(resumed.loopExhausted?.reason, "budget");
    assert.equal(resumed.loopExhausted?.exhausted[0]?.maxVisits, 10, "clamped to MAX_VISITS_HARD_CAP");
    assert.equal(countOf(resumed, "flag"), 11, "1 initial + 10 reworks, not 1002");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Step 3 — judge-driven self-loops.
//
// A judge scores the output of the node it is attached to, so a judge-triggered
// edge means "THIS node did poorly" and the remedy is re-running that node. And
// because every such node also has a forward edge, these loops are ADVISORY: when
// the budget runs out the walk falls through and finishes normally.
// ---------------------------------------------------------------------------
describe("walkGraph — judge-driven loops", () => {
  /** metrics → (self-loop, declared first) → testing. Mirrors the committed shape. */
  const judgeGraph = (below: number, maxVisits = 1): LDAgentGraphFlagValue => ({
    root: "metrics",
    edges: {
      metrics: [
        { key: "metrics", handoff: { max_visits: maxVisits, loop_if_judge_below: below } },
        { key: "testing", handoff: { require_tags: { needs_tests: "true" } } },
      ],
      testing: [],
    },
  });

  /** A judge hook returning scripted results per call (one per node run). */
  const judgeReturning = (
    perCall: Array<Array<{ judgeConfigKey?: string; sampled: boolean; success: boolean; score?: number; reasoning?: string }>>,
  ) => {
    let n = 0;
    const hook = async () => {
      const r = perCall[Math.min(n, perCall.length - 1)] ?? [];
      n++;
      return r as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof walkGraph>[3]>["judgeHook"] & object>>;
    };
    return hook as unknown as NonNullable<NonNullable<Parameters<typeof walkGraph>[3]>["judgeHook"]>;
  };

  const usable = (score: number, reasoning?: string) => [
    { judgeConfigKey: "metrics-quality", sampled: true, success: true, score, ...(reasoning ? { reasoning } : {}) },
  ];
  const script = { metrics: { tags: { needs_tests: "true" } } };
  const runWith = (value: LDAgentGraphFlagValue, judgeHook?: NonNullable<Parameters<typeof walkGraph>[3]>["judgeHook"]) =>
    walkGraph(graphFrom(value), new ScriptedRunner(script), { PR_NUMBER: "1" }, { ...(judgeHook ? { judgeHook } : {}) });

  // --- fail-open contract: every absence mode means "no signal" ---------------
  it("1. no judge attached → no loop (fail-open)", async () => {
    const r = await runWith(judgeGraph(0.7));
    assert.equal(countOf(r, "metrics"), 1);
    assert.deepEqual(r.runs.map((x) => x.configKey), ["metrics", "testing"]);
  });

  it("2. judge not sampled → no loop", async () => {
    const r = await runWith(judgeGraph(0.7), judgeReturning([[{ judgeConfigKey: "j", sampled: false, success: true, score: 0.1 }]]));
    assert.equal(countOf(r, "metrics"), 1, "an unsampled judge must not trigger rework");
    assert.equal(r.runs[0]?.judgeScores, undefined);
  });

  it("3. evaluation failed → no loop", async () => {
    const r = await runWith(judgeGraph(0.7), judgeReturning([[{ judgeConfigKey: "j", sampled: true, success: false, score: 0.1 }]]));
    assert.equal(countOf(r, "metrics"), 1);
  });

  it("4. score missing or non-finite → no loop", async () => {
    const r = await runWith(judgeGraph(0.7), judgeReturning([[{ judgeConfigKey: "j", sampled: true, success: true }]]));
    assert.equal(countOf(r, "metrics"), 1);
    const nan = await runWith(judgeGraph(0.7), judgeReturning([[{ judgeConfigKey: "j", sampled: true, success: true, score: Number.NaN }]]));
    assert.equal(countOf(nan, "metrics"), 1);
  });

  it("5. judge hook throws → non-fatal, no loop, walk continues", async () => {
    const boom = (async () => {
      throw new Error("judge exploded");
    }) as unknown as NonNullable<NonNullable<Parameters<typeof walkGraph>[3]>["judgeHook"]>;
    const r = await runWith(judgeGraph(0.7), boom);
    assert.deepEqual(r.runs.map((x) => x.configKey), ["metrics", "testing"]);
  });

  // --- the loop itself -------------------------------------------------------
  it("6. score below threshold re-runs the node; a good score on the retry converges", async () => {
    const r = await runWith(judgeGraph(0.7), judgeReturning([usable(0.4, "events are too coarse"), usable(0.9)]));
    assert.deepEqual(r.runs.map((x) => x.configKey), ["metrics", "metrics", "testing"]);
    assert.deepEqual(r.runs[0]?.judgeScores, { "metrics-quality": 0.4 });
    assert.equal(r.runs[0]?.judgeReasoning, "events are too coarse");
    assert.equal(r.loopExhausted, undefined);
    assert.equal(r.loopBudgetSpent, undefined, "budget was never spent — it converged");
  });

  it("7. score at or above the threshold takes the forward edge immediately", async () => {
    const r = await runWith(judgeGraph(0.7), judgeReturning([usable(0.7)]));
    assert.equal(countOf(r, "metrics"), 1, "0.7 is not BELOW 0.7");
    assert.deepEqual(r.runs.map((x) => x.configKey), ["metrics", "testing"]);
  });

  it("8. ADVISORY: a persistently low score falls through and is recorded, not failed", async () => {
    // The finding that reshaped this step. Because `metrics` also has a forward
    // edge, a spent budget does NOT produce loopExhausted — the walk proceeds. Only
    // loopBudgetSpent preserves the fact that quality never got there.
    const r = await runWith(judgeGraph(0.7), judgeReturning([usable(0.2), usable(0.2), usable(0.2)]));
    assert.deepEqual(r.runs.map((x) => x.configKey), ["metrics", "metrics", "testing"]);
    assert.equal(r.loopExhausted, undefined, "advisory loops do not fail the run");
    assert.deepEqual(r.loopBudgetSpent, [
      { source: "metrics", target: "metrics", traversals: 1, maxVisits: 1, trigger: "metrics-quality scored 0.20, below 0.7" },
    ]);
  });

  it("9. the minimum score across judges decides, so a high scorer can't mask a low one", async () => {
    const r = await runWith(
      judgeGraph(0.7),
      judgeReturning([
        [
          { judgeConfigKey: "strict", sampled: true, success: true, score: 0.3, reasoning: "thin coverage" },
          { judgeConfigKey: "lenient", sampled: true, success: true, score: 0.95 },
        ],
        usable(0.9),
      ]),
    );
    assert.equal(countOf(r, "metrics"), 2, "the 0.3 triggered rework");
    assert.equal(r.runs[0]?.judgeReasoning, "thin coverage", "reasoning follows the LOWEST score");
  });

  it("10. the rework prompt carries the score and the judge's reasoning", async () => {
    const runner = new ScriptedRunner(script);
    await walkGraph(graphFrom(judgeGraph(0.7)), runner, { PR_NUMBER: "1" }, {
      judgeHook: judgeReturning([usable(0.55, "pick an event the checkout path actually emits"), usable(0.9)]),
    });
    const rework = (runner.promptsByKey.metrics ?? [])[1] ?? "";
    assert.match(rework, /=== REWORK ITERATION 2 ===/);
    assert.match(rework, /Sent back by 'metrics' because metrics-quality scored 0\.55, below 0\.7/);
    // detail: guidance that is genuinely NOT in the inbound brief.
    assert.match(rework, /Additional guidance for this iteration:/);
    assert.match(rework, /pick an event the checkout path actually emits/);
  });

  it("11. edge order is load-bearing: a forward edge declared first wins forever", async () => {
    const wrong: LDAgentGraphFlagValue = {
      root: "metrics",
      edges: {
        metrics: [
          { key: "testing", handoff: { require_tags: { needs_tests: "true" } } },
          { key: "metrics", handoff: { max_visits: 1, loop_if_judge_below: 0.7 } },
        ],
        testing: [],
      },
    };
    const r = await runWith(wrong, judgeReturning([usable(0.1)]));
    assert.equal(countOf(r, "metrics"), 1, "the loop never evaluated — this is what check-configs 6e prevents");
  });

  // --- resume interaction ----------------------------------------------------
  it("12. scores and reasoning survive a resume, so replay routes identically", async () => {
    const first = await runWith(judgeGraph(0.7), judgeReturning([usable(0.4, "too coarse"), usable(0.9)]));
    assert.equal(countOf(first, "metrics"), 2);

    // No judge hook at all on the resume: routing must come from the journal.
    const replayed = await walkGraph(graphFrom(judgeGraph(0.7)), new NeverRunnerForJudges(), { PR_NUMBER: "1" }, {
      resume: { journal: first.runs },
    });
    assert.equal(replayed.replayDiverged, undefined, "the journalled score reproduced the loop decision");
    assert.deepEqual(replayed, first);
  });

  it("13. a journal WITHOUT scores diverges instead of silently failing open", async () => {
    // The obligation the WalkInputs bundle exists to enforce: if a routing input is
    // not journalled, replay takes a different edge — and that is caught, loudly.
    const first = await runWith(judgeGraph(0.7), judgeReturning([usable(0.4), usable(0.9)]));
    const stripped = first.runs.map((r) => {
      const { judgeScores: _s, judgeReasoning: _r, ...rest } = r;
      return rest;
    });
    const r = await walkGraph(graphFrom(judgeGraph(0.7)), new NeverRunnerForJudges(), { PR_NUMBER: "1" }, {
      resume: { journal: stripped },
    });
    assert.ok(r.replayDiverged, "an unjournalled routing input must not pass silently");
    assert.equal(r.replayDiverged?.expected, "metrics#2");
  });
});

/** Replay-only runner: reaching it means the journal was not honoured. */
class NeverRunnerForJudges implements AgentRunner {
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    throw new Error(`runner must not be called during replay (reached '${req.configKey}')`);
  }
}
