/**
 * A loop edge declared AFTER a forward edge from the same source may never fire:
 * edge selection takes the first passing edge and breaks. `check-configs` 6e rejects
 * that ordering in the COMMITTED graph, so what remains is a served-vs-committed
 * divergence — a dashboard edit, or a seed from another project — which `bridge
 * upgrade` cannot see, because REST GET's edge order is not faithful
 * (docs/loopback-handoff.md 7a).
 *
 * The failure it produces is the quiet one: no extra runs, no loopBudgetSpent, no
 * loopExhausted. A walk that looks perfect, with the quality retry silently gone.
 * So the walker records it on the result, not just in a log.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphEdge,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import type { AgentNodeRequest, AgentNodeResult, AgentRunner } from "@auto-factory/shared";
import { describeLoopEdgeShadowed, walkGraph } from "@auto-factory/shared";

class TagRunner implements AgentRunner {
  constructor(private readonly tagsByKey: Record<string, Record<string, string>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    return {
      status: "completed",
      messages: [{ role: "assistant", content: `done: ${req.configKey}`, isFinal: true }],
      tags: this.tagsByKey[req.configKey] ?? {},
    };
  }
}

const agentConfig = (key: string): LDAIAgentConfig =>
  ({
    key,
    enabled: true,
    instructions: `instructions for ${key}`,
    model: { name: "Anthropic.claude-sonnet-4-6" },
    createTracker: () => ({}) as unknown as LDAIConfigTracker,
  }) as LDAIAgentConfig;

/**
 * `worker` has a self-loop gated on `needs_rework` plus a forward edge to `done`.
 * `edgeOrder` decides which is declared first — the only difference between a
 * working quality loop and dead config.
 */
function graphWithOrder(edgeOrder: "loop-first" | "forward-first"): AgentGraphDefinition {
  const loop: LDGraphEdge = { key: "worker", handoff: { max_visits: 1, require_tags: { needs_rework: "true" } } };
  const forward: LDGraphEdge = { key: "done", handoff: {} };
  const flagValue: LDAgentGraphFlagValue = {
    root: "worker",
    edges: { worker: edgeOrder === "loop-first" ? [loop, forward] : [forward, loop] },
  };
  const configs: Record<string, LDAIAgentConfig> = { worker: agentConfig("worker"), done: agentConfig("done") };
  return new AgentGraphDefinition(
    flagValue,
    AgentGraphDefinition.buildNodes(flagValue, configs),
    true,
    () => ({}) as unknown as LDGraphTracker,
  );
}

/** The worker always asks for rework, so the loop fires whenever it is reachable. */
const alwaysRework = () => new TagRunner({ worker: { needs_rework: "true" } });

describe("served-graph loop edge order", () => {
  it("loop declared first: the loop fires, and nothing is flagged", async () => {
    const r = await walkGraph(graphWithOrder("loop-first"), alwaysRework(), {});
    assert.deepEqual(r.runs.map((x) => x.configKey), ["worker", "worker", "done"]);
    assert.equal(r.loopEdgeShadowed, undefined);
    // The loop ran and spent its budget — the signal that says a retry happened.
    assert.equal(r.loopBudgetSpent?.length, 1);
  });

  it("loop declared after the forward edge: recorded, because nothing else would say so", async () => {
    const r = await walkGraph(graphWithOrder("forward-first"), alwaysRework(), {});

    // The quiet failure: a clean-looking walk with the retry silently missing.
    assert.deepEqual(r.runs.map((x) => x.configKey), ["worker", "done"]);
    assert.equal(r.loopBudgetSpent, undefined);
    assert.equal(r.loopExhausted, undefined);
    assert.equal(r.stalledAt, undefined);

    // ...which is exactly why the ordering has to be reported on the result.
    assert.deepEqual(r.loopEdgeShadowed, [{ source: "worker", target: "worker", precededBy: "done" }]);
    const [line] = describeLoopEdgeShadowed(r.loopEdgeShadowed!);
    assert.match(String(line), /declared AFTER the forward edge to done/);
    assert.match(String(line), /may never fire/);
  });

  it("a GATED forward edge ahead of the loop: the loop still fires, and it is still recorded", async () => {
    // The record is an ORDERING violation, not a proof the loop is dead. When the
    // forward edge declared ahead of it fails its own conditions, selection falls
    // through and the loop fires — so `precededBy` names an edge that did NOT win.
    //
    // This is pinned deliberately, because narrowing the check to UNCONDITIONAL forward
    // edges is the obvious-looking fix for the "false positive" and it would break the
    // real graph: the committed `metrics-author → flag-testing` edge is gated on
    // `needs_tests`, which its source always emits, so narrowing would make the guard
    // skip the only shadowable edge in the graph.
    const gatedForward: LDGraphEdge = { key: "done", handoff: { require_tags: { ship: "true" } } };
    const loop: LDGraphEdge = { key: "worker", handoff: { max_visits: 1, require_tags: { needs_rework: "true" } } };
    const flagValue: LDAgentGraphFlagValue = { root: "worker", edges: { worker: [gatedForward, loop] } };
    const configs: Record<string, LDAIAgentConfig> = { worker: agentConfig("worker"), done: agentConfig("done") };
    const graph = new AgentGraphDefinition(
      flagValue,
      AgentGraphDefinition.buildNodes(flagValue, configs),
      true,
      () => ({}) as unknown as LDGraphTracker,
    );

    // `ship` is never emitted, so the forward edge cannot pass and the loop is reachable.
    const r = await walkGraph(graph, alwaysRework(), {});
    assert.deepEqual(r.runs.map((x) => x.configKey), ["worker", "worker"]);
    assert.equal(r.loopBudgetSpent?.length, 1, "the loop really did fire and spend its budget");
    // Recorded anyway: the ordering is what 6e rejects, unconditionally.
    assert.deepEqual(r.loopEdgeShadowed, [{ source: "worker", target: "worker", precededBy: "done" }]);
    // ...and the wording must not claim a loss that did not happen.
    const [line] = describeLoopEdgeShadowed(r.loopEdgeShadowed!);
    assert.match(String(line), /may never fire/);
    assert.doesNotMatch(String(line), /bridge upgrade' will repair|re-provision with/);
  });

  it("records once per edge, not once per traversal", async () => {
    // `worker` is re-entered by the forward-first graph only once, so use a graph
    // where the mis-ordered source runs twice: rework via a SECOND loop edge that is
    // correctly ordered, with the offending one behind the forward edge.
    const wellOrderedLoop: LDGraphEdge = { key: "worker", handoff: { max_visits: 2, require_tags: { needs_rework: "true" } } };
    const forward: LDGraphEdge = { key: "done", handoff: {} };
    const shadowedLoop: LDGraphEdge = { key: "worker", handoff: { max_visits: 1, require_tags: { other: "true" } } };
    const flagValue: LDAgentGraphFlagValue = {
      root: "worker",
      edges: { worker: [wellOrderedLoop, forward, shadowedLoop] },
    };
    const configs: Record<string, LDAIAgentConfig> = { worker: agentConfig("worker"), done: agentConfig("done") };
    const graph = new AgentGraphDefinition(
      flagValue,
      AgentGraphDefinition.buildNodes(flagValue, configs),
      true,
      () => ({}) as unknown as LDGraphTracker,
    );

    const r = await walkGraph(graph, alwaysRework(), {});
    // Three visits to `worker` (initial + 2 loop traversals), one record.
    assert.equal(r.runs.filter((x) => x.configKey === "worker").length, 3);
    assert.equal(r.loopEdgeShadowed?.length, 1);
  });
});
