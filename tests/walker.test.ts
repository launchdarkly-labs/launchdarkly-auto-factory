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

/**
 * Minimal LDAIConfigTracker stub — the fake runner never reads it, but the
 * walker reads getSummary().tokens to aggregate graph-level token usage.
 */
const fakeConfigTracker = () =>
  ({ getSummary: () => ({ tokens: { total: 10, input: 6, output: 4 } }) }) as unknown as LDAIConfigTracker;

/** Recording LDGraphTracker stub: captures every graph-level tracking call. */
function recordingGraphTracker() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      calls.push({ method, args });
  const tracker = {
    trackInvocationSuccess: record("trackInvocationSuccess"),
    trackInvocationFailure: record("trackInvocationFailure"),
    trackDuration: record("trackDuration"),
    trackTotalTokens: record("trackTotalTokens"),
    trackPath: record("trackPath"),
    trackHandoffSuccess: record("trackHandoffSuccess"),
    trackHandoffFailure: record("trackHandoffFailure"),
    trackRedirect: record("trackRedirect"),
  } as unknown as LDGraphTracker;
  return { tracker, calls, methods: () => calls.map((c) => c.method) };
}

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

describe("walkGraph — graph-level (global) metrics", () => {
  const fullScript = {
    flag: { tags: { flag_created: "true" } },
    review: { tags: { review_approved: "approve" } },
  };

  it("a clean full run emits invocation success, path, duration, and aggregate tokens", async () => {
    const g = recordingGraphTracker();
    await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, g.tracker);
    assert.ok(g.methods().includes("trackInvocationSuccess"), `got: ${g.methods().join(", ")}`);
    assert.ok(!g.methods().includes("trackInvocationFailure"));
    assert.ok(g.methods().includes("trackDuration"));
    const path = g.calls.find((c) => c.method === "trackPath")?.args[0];
    assert.deepEqual(path, ["research", "flag", "test", "review"]);
    // 4 nodes × the stub tracker's {total:10, input:6, output:4} each.
    const tokens = g.calls.find((c) => c.method === "trackTotalTokens")?.args[0];
    assert.deepEqual(tokens, { total: 40, input: 24, output: 16 });
    // One handoff per traversed edge.
    assert.equal(g.calls.filter((c) => c.method === "trackHandoffSuccess").length, 3);
  });

  it("a stall emits invocation failure and a handoff failure for the blocked edge", async () => {
    const g = recordingGraphTracker();
    await walkGraph(buildGraph(), new FakeRunner({ flag: { tags: {} } }), { PR_NUMBER: "1" }, g.tracker);
    assert.ok(g.methods().includes("trackInvocationFailure"), `got: ${g.methods().join(", ")}`);
    assert.ok(!g.methods().includes("trackInvocationSuccess"));
    const hf = g.calls.find((c) => c.method === "trackHandoffFailure");
    assert.deepEqual(hf?.args, ["flag", "test"]);
  });

  it("a failed node emits invocation failure", async () => {
    const g = recordingGraphTracker();
    await walkGraph(
      buildGraph(),
      new FakeRunner({ ...fullScript, test: { status: "failed" } }),
      { PR_NUMBER: "1" },
      g.tracker,
    );
    assert.ok(g.methods().includes("trackInvocationFailure"), `got: ${g.methods().join(", ")}`);
  });

  it("an intentional skip_if short-circuit is an invocation SUCCESS (not a failure)", async () => {
    const g = recordingGraphTracker();
    await walkGraph(buildGraph(), new FakeRunner({ research: { tags: { skip_flagging: "true" } } }), { PR_NUMBER: "1" }, g.tracker);
    assert.ok(g.methods().includes("trackInvocationSuccess"), `got: ${g.methods().join(", ")}`);
    assert.ok(!g.methods().includes("trackHandoffFailure"));
    assert.deepEqual(g.calls.find((c) => c.method === "trackPath")?.args[0], ["research"]);
  });

  it("a pause at an approval gate emits NO graph-level metrics (run is unfinished)", async () => {
    const g = recordingGraphTracker();
    await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, g.tracker, undefined, {
      steps: ["flag"],
      resolve: () => false,
    });
    const global = g
      .methods()
      .filter((m) => ["trackInvocationSuccess", "trackInvocationFailure", "trackDuration", "trackTotalTokens", "trackPath"].includes(m));
    assert.deepEqual(global, [], `expected no global metrics, got: ${global.join(", ")}`);
  });

  it("node trackers without getSummary don't break the walk (tokens simply unreported)", async () => {
    const g = recordingGraphTracker();
    const flagValue: LDAgentGraphFlagValue = { root: "research", edges: {} };
    const bareTracker = () => ({}) as unknown as LDAIConfigTracker;
    const configs = {
      research: { key: "research", enabled: true, createTracker: bareTracker } as unknown as LDAIAgentConfig,
    };
    const graph = new AgentGraphDefinition(flagValue, AgentGraphDefinition.buildNodes(flagValue, configs), true, () => g.tracker);
    const r = await walkGraph(graph, new FakeRunner({}), { PR_NUMBER: "1" }, g.tracker);
    assert.equal(r.runs.length, 1);
    assert.ok(g.methods().includes("trackInvocationSuccess"));
    assert.ok(!g.methods().includes("trackTotalTokens"));
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
