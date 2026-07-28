import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type JudgeCompletion, type JudgeCompletionRequest, createJudgeHook, extractJsonObject } from "@auto-factory/shared";
import type { LDAIAgentConfig, LDAIConfigTracker, LDAIJudgeConfig, LDJudgeResult } from "@launchdarkly/server-sdk-ai";

/** Minimal judge AI config the SDK Judge class accepts. */
function stubJudgeConfig(overrides: Partial<LDAIJudgeConfig> = {}): LDAIJudgeConfig {
  return {
    key: "autofactory-judge-implementation-quality",
    enabled: true,
    evaluationMetricKey: "$ld:ai:judge:autofactory-judge-implementation-quality",
    messages: [{ role: "system", content: "You judge flag implementations." }],
    model: { name: "Anthropic.claude-sonnet-4-6" },
    // Judge.evaluate creates the judge's own tracker and wraps the runner call.
    createTracker: () =>
      ({
        trackMetricsOf: async (_extract: unknown, fn: () => Promise<unknown>) => fn(),
        getTrackData: () => ({}),
      }) as unknown as LDAIConfigTracker,
    ...overrides,
  } as unknown as LDAIJudgeConfig;
}

/** The evaluated node's config with a judge attached. */
function stubAgentConfig(judges: Array<Record<string, unknown>>): LDAIAgentConfig {
  return { key: "autofactory-flag-implementer", enabled: true, judgeConfiguration: { judges } } as unknown as LDAIAgentConfig;
}

/** Tracker for the evaluated node — captures trackJudgeResult calls. */
function captureTracker(): { tracker: LDAIConfigTracker; tracked: LDJudgeResult[] } {
  const tracked: LDJudgeResult[] = [];
  return { tracker: { trackJudgeResult: (r: LDJudgeResult) => tracked.push(r) } as unknown as LDAIConfigTracker, tracked };
}

function makeHook(opts: {
  judgeCfg?: LDAIJudgeConfig;
  completion?: JudgeCompletion;
  requests?: JudgeCompletionRequest[];
}) {
  const requests: JudgeCompletionRequest[] = opts.requests ?? [];
  const completion: JudgeCompletion =
    opts.completion ??
    (async (req) => {
      requests.push(req);
      return { parsed: { score: 0.85, reasoning: "solid wiring" }, content: "{}", success: true };
    });
  const aiClient = {
    judgeConfig: async () => opts.judgeCfg ?? stubJudgeConfig(),
  };
  return createJudgeHook({
    aiClient: aiClient as never,
    ldContext: { kind: "service", key: "test" },
    completion,
  });
}

describe("createJudgeHook", () => {
  it("no judgeConfiguration → no evaluations, no tracking", async () => {
    const { tracker, tracked } = captureTracker();
    const requests: JudgeCompletionRequest[] = [];
    const hook = makeHook({ requests });
    const results = await hook({
      configKey: "autofactory-flag-implementer",
      iteration: 1,
      cfg: { key: "x", enabled: true } as unknown as LDAIAgentConfig,
      input: "prompt",
      output: "output",
      tracker,
    });
    assert.deepEqual(results, []);
    assert.equal(requests.length, 0);
    assert.equal(tracked.length, 0);
  });

  it("attached judge scores the output and records on the node tracker", async () => {
    const { tracker, tracked } = captureTracker();
    const requests: JudgeCompletionRequest[] = [];
    const hook = makeHook({ requests });
    const results = await hook({
      configKey: "autofactory-flag-implementer",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "autofactory-judge-implementation-quality", samplingRate: 1 }]),
      input: "the node prompt",
      output: "the node output",
      tracker,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sampled, true);
    assert.equal(results[0]?.score, 0.85);
    assert.equal(results[0]?.metricKey, "$ld:ai:judge:autofactory-judge-implementation-quality");
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0]?.score, 0.85);
    // The judge's LD-authored messages became the system prompt, and the SDK's
    // evaluation-input format carried both the prompt and the output.
    assert.match(requests[0]?.system ?? "", /judge flag implementations/);
    assert.match(requests[0]?.input ?? "", /MESSAGE HISTORY:\nthe node prompt/);
    assert.match(requests[0]?.input ?? "", /RESPONSE TO EVALUATE:\nthe node output/);
  });

  it("accepts the management-API field name judgeConfigKey", async () => {
    const { tracker, tracked } = captureTracker();
    const hook = makeHook({});
    const results = await hook({
      configKey: "autofactory-flag-implementer",
      iteration: 1,
      cfg: stubAgentConfig([{ judgeConfigKey: "autofactory-judge-implementation-quality", samplingRate: 1 }]),
      input: "p",
      output: "o",
      tracker,
    });
    assert.equal(results.length, 1);
    assert.equal(tracked.length, 1);
  });

  it("normalizes percentage sampling rates (100 → always sampled)", async () => {
    const { tracker, tracked } = captureTracker();
    const hook = makeHook({});
    await hook({
      configKey: "k",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "j", samplingRate: 100 }]),
      input: "p",
      output: "o",
      tracker,
    });
    assert.equal(tracked.length, 1);
  });

  it("samplingRate 0 → skipped (not sampled, not tracked)", async () => {
    const { tracker, tracked } = captureTracker();
    const requests: JudgeCompletionRequest[] = [];
    const hook = makeHook({ requests });
    const results = await hook({
      configKey: "k",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "j", samplingRate: 0 }]),
      input: "p",
      output: "o",
      tracker,
    });
    assert.equal(results[0]?.sampled, false);
    assert.equal(requests.length, 0);
    assert.equal(tracked.length, 0);
  });

  it("disabled judge config is skipped", async () => {
    const { tracker, tracked } = captureTracker();
    const hook = makeHook({ judgeCfg: stubJudgeConfig({ enabled: false } as Partial<LDAIJudgeConfig>) });
    const results = await hook({
      configKey: "k",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "j", samplingRate: 1 }]),
      input: "p",
      output: "o",
      tracker,
    });
    assert.deepEqual(results, []);
    assert.equal(tracked.length, 0);
  });

  it("completion failure records a failed (but sampled) evaluation and never throws", async () => {
    const { tracker, tracked } = captureTracker();
    const hook = makeHook({
      completion: async () => {
        throw new Error("provider down");
      },
    });
    const results = await hook({
      configKey: "k",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "j", samplingRate: 1 }]),
      input: "p",
      output: "o",
      tracker,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sampled, true);
    assert.equal(results[0]?.success, false);
    assert.match(results[0]?.errorMessage ?? "", /provider down/);
    assert.equal(tracked.length, 1); // failed evals still record
  });
});

describe("extractJsonObject (cursor judge parsing)", () => {
  it("parses fenced JSON", () => {
    assert.deepEqual(extractJsonObject('```json\n{"score": 0.7, "reasoning": "ok"}\n```'), { score: 0.7, reasoning: "ok" });
  });
  it("parses JSON embedded in prose", () => {
    assert.deepEqual(extractJsonObject('Here you go: {"score": 1, "reasoning": "x"} hope that helps'), {
      score: 1,
      reasoning: "x",
    });
  });
  it("returns undefined for non-JSON", () => {
    assert.equal(extractJsonObject("no json here"), undefined);
  });
});

describe("judge evidence", () => {
  it("appends evidence to the judge input when the collector yields", async () => {
    const requests: JudgeCompletionRequest[] = [];
    const completion: JudgeCompletion = async (req) => {
      requests.push(req);
      return { parsed: { score: 0.9, reasoning: "verified" }, content: "{}", success: true };
    };
    const hook = createJudgeHook({
      aiClient: { judgeConfig: async () => stubJudgeConfig() } as never,
      ldContext: { kind: "service", key: "test" },
      completion,
      evidence: async () => "Commits landed by this step: abc123 wire the flag",
    });
    const { tracker, tracked } = captureTracker();
    await hook({
      configKey: "autofactory-flag-implementer",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "j", samplingRate: 1 }]),
      input: "the brief",
      output: "the report",
      tracker,
    });
    assert.equal(tracked.length, 1);
    assert.match(requests[0]?.input ?? "", /VERIFIED EVIDENCE \(gathered by the pipeline, NOT claimed by the agent\)/);
    assert.match(requests[0]?.input ?? "", /Commits landed by this step: abc123/);
    // Evidence goes into the judge INPUT, never into the artifact being scored.
    assert.match(requests[0]?.input ?? "", /RESPONSE TO EVALUATE:\nthe report$/);
  });

  it("a failing evidence collector never blocks the evaluation", async () => {
    const hook = makeHook({});
    const failing = createJudgeHook({
      aiClient: { judgeConfig: async () => stubJudgeConfig() } as never,
      ldContext: { kind: "service", key: "test" },
      completion: async () => ({ parsed: { score: 0.5, reasoning: "r" }, content: "{}", success: true }),
      evidence: async () => {
        throw new Error("git exploded");
      },
    });
    const { tracker, tracked } = captureTracker();
    const results = await failing({
      configKey: "k",
      iteration: 1,
      cfg: stubAgentConfig([{ key: "j", samplingRate: 1 }]),
      input: "p",
      output: "o",
      tracker,
    });
    assert.equal(results.length, 1);
    assert.equal(tracked.length, 1);
    void hook;
  });

  it("createGitDiffEvidence: node-scoped diffs + no-commit detection", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "evidence-test-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(repo, "a.txt"), "one\n");
      g("add", "-A");
      g("commit", "-qm", "base");

      const { createGitDiffEvidence } = await import("@auto-factory/shared");
      const collect = createGitDiffEvidence(repo);

      // No commits since creation → explicit no-commit evidence.
      assert.match((await collect("node-a")) ?? "", /NO new commits/);

      // Agent commit → node-scoped diff.
      writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
      g("add", "-A");
      g("commit", "-qm", "wire flag");
      const ev = (await collect("node-b")) ?? "";
      assert.match(ev, /wire flag/);
      assert.match(ev, /\+two/);

      // Next call is scoped to NEW commits only.
      assert.match((await collect("node-c")) ?? "", /NO new commits/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
