/**
 * LaunchDarkly AgentControl judges, executed through the provider seam.
 *
 * Judges are AI Configs (mode "judge") attached in LaunchDarkly to another AI
 * config's variation (`judgeConfiguration: { judges: [{ key, samplingRate }] }`).
 * They score a node's output 0..1 with reasoning, and the score records against
 * the judge's `evaluationMetricKey` ON THE EVALUATED NODE'S TRACKER — so scores
 * surface per-variation in AI Config monitoring (the quality dimension of the
 * Composer-vs-Sonnet A/B).
 *
 * LaunchDarkly does not execute judges for an external runtime like ours: the
 * SDK's managed path only auto-runs judges for its built-in providers (openai/
 * langchain/vercel). We therefore reuse the SDK's exported `Judge` class — which
 * owns sampling, the evaluation-input format, the {score, reasoning} structured-
 * output schema, and result parsing — and supply the one piece it needs from us:
 * a `Runner` that executes a single structured completion on OUR provider
 * (Anthropic direct or Cursor). The judge's LD-authored `messages` become the
 * system prompt; the Judge class builds the user input.
 *
 * Everything here is defensive: a judge failure records a failed evaluation but
 * never fails the chain.
 */

import type { LDContext, LDLogger } from "@launchdarkly/node-server-sdk";
import {
  Judge,
  type LDAIAgentConfig,
  type LDAIClient,
  type LDAIConfigTracker,
  type LDAIJudgeConfig,
  type LDJudgeResult,
  type Runner,
  type RunnerResult,
} from "@launchdarkly/server-sdk-ai";
import { startAiSpan } from "./observability.js";

/** One structured single-shot completion, supplied per provider. */
export interface JudgeCompletionRequest {
  /** LD model name from the judge's AI config (e.g. "Anthropic.claude-sonnet-4-6"). */
  model?: string;
  /** The judge's LD-authored instructions (its config `messages`, joined). */
  system: string;
  /** The evaluation input the SDK Judge built (message history + response). */
  input: string;
  /** JSON schema the response must match ({score, reasoning}). */
  schema: Record<string, unknown>;
}

export interface JudgeCompletionResult {
  /** Structured output matching the schema. The SDK Judge reads THIS, not content. */
  parsed?: Record<string, unknown>;
  /** Raw text of the response (fallback/diagnostics). */
  content: string;
  /** Whether the provider call succeeded. */
  success: boolean;
  tokens?: { input: number; output: number; total: number };
}

export type JudgeCompletion = (req: JudgeCompletionRequest) => Promise<JudgeCompletionResult>;

/** Span context for the judge's own LLM call (gen_ai trace, see observability.ts). */
interface JudgeSpanMeta {
  /** The judge config's key (span name + config attribution). */
  judgeKey: string;
  /** The evaluated node's config key (what this judge is scoring). */
  judgedConfigKey: string;
  /** Execution backend for the judge completion ("anthropic" | "cursor"). */
  provider?: string;
}

/**
 * Console logger handed to the SDK's Judge class. Without one, its diagnostics
 * are silent — most importantly "Could not parse evaluation response: {...}",
 * the ONLY place the offending payload surfaces when an eval fails without an
 * error message (that path otherwise logs as "eval FAILED: unknown").
 */
const judgeSdkLogger: LDLogger = {
  error: (...args: unknown[]) => console.error("[judge-sdk]", ...args),
  warn: (...args: unknown[]) => console.warn("[judge-sdk]", ...args),
  info: (...args: unknown[]) => console.log("[judge-sdk]", ...args),
  debug: () => {},
};

/** Adapts a JudgeCompletion to the SDK's Runner interface for one judge config. */
class CompletionJudgeRunner implements Runner {
  constructor(
    private readonly judgeCfg: LDAIJudgeConfig,
    private readonly completion: JudgeCompletion,
    private readonly spanMeta: JudgeSpanMeta,
  ) {}

  async run(input: string, outputType?: Record<string, unknown>): Promise<RunnerResult> {
    const system = (this.judgeCfg.messages ?? []).map((m) => m.content).join("\n\n");
    // Judge LLM call — dual-write gen_ai span (LD + Sentry), correlated by
    // launchdarkly.run.id / gen_ai.conversation.id. Only runs when sampled.
    const span = startAiSpan(`judge ${this.spanMeta.judgeKey}`, { op: "gen_ai.chat" });
    try {
      const r = await this.completion({
        ...(this.judgeCfg.model?.name ? { model: this.judgeCfg.model.name } : {}),
        system,
        input,
        schema: outputType ?? {},
      });
      span.setGenAi({
        provider: this.spanMeta.provider ?? "unknown",
        requestModel: this.judgeCfg.model?.name ?? "unknown",
        agentName: this.spanMeta.judgeKey,
        prompt: `${system}\n\n${input}`,
        output: r.content,
        ...(r.tokens ? { usage: r.tokens } : {}),
      });
      // NOTE: no bare `launchdarkly.ai.judge` boolean — LD nests dotted keys,
      // so a scalar at `…ai.judge` collides with `…ai.judge.of` (verified live).
      span.otel.setAttributes({
        "launchdarkly.ai.config.key": this.spanMeta.judgeKey,
        "launchdarkly.ai.judge.of": this.spanMeta.judgedConfigKey,
      });
      span.end(r.success ? "ok" : "error", r.success ? undefined : "judge completion failed");
      return {
        content: r.content,
        ...(r.parsed ? { parsed: r.parsed } : {}),
        metrics: { success: r.success, ...(r.tokens ? { tokens: r.tokens } : {}) },
      };
    } catch (e) {
      span.end("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}

export interface JudgeHookArgs {
  /** The evaluated node's config key (for logs). */
  configKey: string;
  /** The evaluated node's resolved agent config (carries judgeConfiguration). */
  cfg: LDAIAgentConfig;
  /** The prompt the node received. */
  input: string;
  /** The node's final output (what the judges score). */
  output: string;
  /** The evaluated node's tracker — judge results record here (per-variation). */
  tracker: LDAIConfigTracker;
}

/** Runs every judge attached to a node; returns all results (sampled or not). */
export type JudgeHook = (args: JudgeHookArgs) => Promise<LDJudgeResult[]>;

export interface CreateJudgeHookOptions {
  aiClient: Pick<LDAIClient, "judgeConfig">;
  ldContext: LDContext;
  /** Variables for judge-instruction interpolation (same set the agents get). */
  variables?: Record<string, unknown>;
  /** Provider-specific structured completion that executes the judge model. */
  completion: JudgeCompletion;
  /** Execution backend name recorded on judge gen_ai spans ("anthropic" | "cursor"). */
  provider?: string;
  /**
   * Optional ground-truth gatherer (see judgeEvidence.ts). When set, its output
   * is appended to the judge's input as a VERIFIED EVIDENCE section — the
   * agent's actual commits/diff — so judges verify the agent's report instead
   * of taking it at its word. Gathered once per judged node.
   */
  evidence?: (nodeKey: string) => Promise<string | undefined>;
}

/**
 * A judge attachment's config key. The SDK type says `key`; the management-API
 * patch shape uses `judgeConfigKey`. Accept either so we don't silently skip
 * judges over a field-name mismatch in the flag payload.
 */
function judgeKeyOf(j: Record<string, unknown>): string | undefined {
  const k = j.key ?? j.judgeConfigKey;
  return typeof k === "string" && k ? k : undefined;
}

/**
 * A sampling rate on the SDK's 0..1 scale. The UI talks percentages, so
 * normalize anything > 1 (e.g. 100) down; the SDK samples with
 * `Math.random() > rate`.
 */
function samplingRateOf(j: Record<string, unknown>): number {
  const raw = typeof j.samplingRate === "number" ? j.samplingRate : 1;
  return raw > 1 ? raw / 100 : raw;
}

export function createJudgeHook(opts: CreateJudgeHookOptions): JudgeHook {
  return async ({ configKey, cfg, input, output, tracker }) => {
    const attachments = cfg.judgeConfiguration?.judges ?? [];
    const results: LDJudgeResult[] = [];
    if (attachments.length === 0) return results;

    // Ground truth for the judges (the agent's actual commits/diff). Appended to
    // the judge input — it lands inside the MESSAGE HISTORY block the SDK Judge
    // builds, clearly delimited as pipeline-gathered rather than agent-claimed.
    let judgeInput = input;
    if (opts.evidence) {
      try {
        const evidence = await opts.evidence(configKey);
        if (evidence) {
          judgeInput =
            `${input}\n\n--- VERIFIED EVIDENCE (gathered by the pipeline, NOT claimed by the agent) ---\n${evidence}`;
        }
      } catch (e) {
        console.warn(`[judge] ${configKey}: evidence gathering failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    for (const attachment of attachments) {
      const judgeKey = judgeKeyOf(attachment as unknown as Record<string, unknown>);
      if (!judgeKey) {
        console.warn(`[judge] ${configKey}: attachment missing a judge config key — skipped`);
        continue;
      }
      try {
        const judgeCfg = await opts.aiClient.judgeConfig(judgeKey, opts.ldContext, undefined, opts.variables);
        if (!judgeCfg.enabled) {
          console.log(`[judge] ${configKey}: judge '${judgeKey}' is disabled — skipped`);
          continue;
        }
        const rate = samplingRateOf(attachment as unknown as Record<string, unknown>);
        const runner = new CompletionJudgeRunner(judgeCfg, opts.completion, {
          judgeKey,
          judgedConfigKey: configKey,
          ...(opts.provider ? { provider: opts.provider } : {}),
        });
        const judge = new Judge(judgeCfg, runner, rate, judgeSdkLogger);
        const result = await judge.evaluate(judgeInput, output);
        results.push(result);
        if (result.sampled) {
          // Record on the EVALUATED node's tracker so the score lands on that
          // config+variation in AI Config monitoring.
          tracker.trackJudgeResult(result);
          const score = result.score !== undefined ? result.score.toFixed(2) : "n/a";
          console.log(
            `[judge] ${configKey} ← '${judgeKey}' score=${score}` +
              (result.success ? "" : ` (eval FAILED: ${result.errorMessage ?? "unknown"})`) +
              (result.reasoning ? ` — ${result.reasoning.slice(0, 160)}` : ""),
          );
        } else {
          console.log(`[judge] ${configKey}: judge '${judgeKey}' not sampled this run (rate ${rate})`);
        }
      } catch (e) {
        console.warn(`[judge] ${configKey}: judge '${judgeKey}' errored (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }
    return results;
  };
}
