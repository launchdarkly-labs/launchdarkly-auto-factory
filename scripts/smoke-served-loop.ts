/**
 * smoke-served-loop — the one thing this branch has never done: walk the graph
 * LaunchDarkly SERVES, not a fixture.
 *
 * Every loop test on `loopback-support` builds its own AgentGraphDefinition in
 * process. So the walker's loop handling is well covered against fixtures and
 * completely unexercised against the SDK's resolution of a real served graph —
 * `max_visits` could arrive as a string, an edge could be reordered, a handoff
 * key could be dropped, and no test would notice.
 *
 * It uses a SCRIPTED runner, so it costs no Anthropic tokens: the point is edge
 * resolution and budget accounting, not agent quality.
 *
 * Run against a TEST BED project only (LD_PROJECT_KEY), never the control plane:
 *   npm run smoke:loop
 *
 * Expectations, derived from the committed graph (6 nodes, both loop edges
 * `max_visits: 1`) and a reviewer that never approves:
 *   - 10 node runs: the 6-node chain, then one loop back through
 *     implementer → metrics → testing → reviewer.
 *   - loopExhausted.reason === "budget" at autofactory-code-reviewer.
 *   - the reviewer → implementer loop edge recorded in loopBudgetSpent,
 *     1 traversal of 1 allowed, trigger review_approved=false.
 * A served graph that resolves differently fails this script with a diff.
 */

import type { AgentNodeRequest, AgentNodeResult, AgentRunner } from "@auto-factory/shared";
import { closeLdSdk, getLdSdk, loadDotEnv, pipelineContext, withProvider, walkGraph } from "@auto-factory/shared";

/** The routing tags each node emits. The reviewer never approves, so the loop always fires. */
const SCRIPT: Record<string, Record<string, string>> = {
  "autofactory-research-planner": { flag_worthy: "true", flag_action: "create", risk_level: "low" },
  "autofactory-manifest-steward": {},
  "autofactory-flag-implementer": { flag_ready: "true" },
  "autofactory-metrics-author": { needs_tests: "true" },
  "autofactory-flag-testing": {},
  "autofactory-code-reviewer": { review_approved: "false" },
};

const EXPECTED_RUNS = [
  "autofactory-research-planner",
  "autofactory-manifest-steward",
  "autofactory-flag-implementer",
  "autofactory-metrics-author",
  "autofactory-flag-testing",
  "autofactory-code-reviewer",
  "autofactory-flag-implementer",
  "autofactory-metrics-author",
  "autofactory-flag-testing",
  "autofactory-code-reviewer",
];

class ScriptedRunner implements AgentRunner {
  readonly seen: Array<{ configKey: string; maxTurns?: number; capabilities?: string[] }> = [];
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    this.seen.push({ configKey: req.configKey, maxTurns: req.maxTurns, capabilities: req.capabilities });
    return {
      status: "completed",
      messages: [{ role: "assistant", content: `scripted output: ${req.configKey}`, isFinal: true }],
      tags: SCRIPT[req.configKey] ?? {},
    };
  }
}

const failures: string[] = [];
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}: ${a}`);
  } else {
    failures.push(`${label}\n      expected: ${e}\n      actual:   ${a}`);
    console.log(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const graphKey = process.env.GRAPH_KEY || "gha-auto-factory";
  const projectKey = process.env.LD_PROJECT_KEY;
  if (!process.env.LD_SDK_KEY) throw new Error("LD_SDK_KEY is not set (the test bed project's server SDK key)");
  if (!projectKey) throw new Error("LD_PROJECT_KEY is not set");
  console.log(`Smoke test: served graph '${graphKey}' in project '${projectKey}'\n`);

  const { aiClient } = await getLdSdk();
  const ldContext = withProvider(pipelineContext(), "anthropic");
  // Interpolation variables. A scripted runner ignores instructions, so these
  // only need to exist; unresolved {{VARS}} would not change routing.
  const variables = { REPO: "smoke/test-bed", PR_NUMBER: "0", PR_BRANCH: "smoke", PR_TITLE: "smoke", PR_BODY: "" };

  const graphDef = await aiClient.agentGraph(graphKey, ldContext, variables);
  if (!graphDef.enabled) {
    throw new Error(
      `Agent graph '${graphKey}' is disabled or unavailable. Either it is not provisioned in ` +
        `'${projectKey}' yet, or LD_SDK_KEY belongs to a different project/environment.`,
    );
  }

  // What LaunchDarkly actually served — print it before walking, because a
  // surprise here explains any walk result below. Edge ORDER is load-bearing:
  // the walker takes the first passing edge and breaks, and `bridge upgrade`
  // sorts edges before comparing, so a served reorder is invisible to it.
  // The SDK serves edges as a Record<sourceKey, edges[]>, NOT the flat array the
  // committed file uses — so "edge order" is the order WITHIN each source's array,
  // and that is what the walker's first-passing-edge rule reads.
  const served = graphDef.getConfig();
  console.log("Served graph, as resolved by the SDK:");
  console.log(`  root: ${served.root ?? "(none)"}`);
  console.log("  edges, per source, in served order:");
  for (const [source, edges] of Object.entries(served.edges ?? {})) {
    for (const [i, edge] of edges.entries()) {
      const handoff = (edge as { handoff?: Record<string, unknown> }).handoff ?? {};
      const loop = handoff.max_visits;
      // A served max_visits of "1" (string) is the class of defect this whole
      // script exists to catch, so print the type, not just the value.
      const loopNote = loop === undefined ? "" : `  max_visits=${JSON.stringify(loop)} (${typeof loop})`;
      // On a served edge, `key` IS the target config key (there is no edge key
      // in the flag value, unlike the committed JSON's `key`/`targetConfig`).
      console.log(`   ${source} [${i + 1}] → ${edge.key}${loopNote}`);
    }
  }
  console.log();

  const runner = new ScriptedRunner();
  const walk = await walkGraph(graphDef, runner, { REPO: "smoke/test-bed" }, {});

  console.log("Assertions:");
  check(
    "node run order",
    walk.runs.map((r) => r.configKey),
    EXPECTED_RUNS,
  );
  check("run count", walk.runs.length, EXPECTED_RUNS.length);
  check("loopExhausted.reason", walk.loopExhausted?.reason, "budget");
  check("loopExhausted.node", walk.loopExhausted?.node, "autofactory-code-reviewer");
  check(
    "loopBudgetSpent",
    walk.loopBudgetSpent?.map((s) => ({ source: s.source, target: s.target, traversals: s.traversals, maxVisits: s.maxVisits })),
    [
      {
        source: "autofactory-code-reviewer",
        target: "autofactory-flag-implementer",
        traversals: 1,
        maxVisits: 1,
      },
    ],
  );
  check("stalledAt", walk.stalledAt, undefined);
  check("replayDiverged", walk.replayDiverged, undefined);
  // The re-entered node must inherit the loop edge's envelope, not the original
  // forward edge's — a served handoff that dropped max_turns would show here.
  check(
    "flag-implementer maxTurns per entry",
    runner.seen.filter((s) => s.configKey === "autofactory-flag-implementer").map((s) => s.maxTurns),
    [20, 20],
  );

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed against the SERVED graph:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll assertions passed: the served graph loops, bounds, and reports exactly as the fixtures do.");
}

// The SDK client holds the event loop open, so it must be closed on EVERY path.
// Without the finally, the "graph not provisioned yet" failure — the most likely
// first outcome of this script — hangs instead of reporting.
main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeLdSdk());
