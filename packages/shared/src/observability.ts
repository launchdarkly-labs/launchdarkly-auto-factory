/**
 * LaunchDarkly LLM Observability + Sentry AI agent monitoring helpers (ADR 0014).
 *
 * Spans use OpenTelemetry GenAI semantic conventions (`gen_ai.*`). When the LD
 * Observability plugin is registered (ldSdk.ts), the global OTel tracer exports
 * to LaunchDarkly. When SENTRY_DSN is set (sentryInit.ts), the same attributes
 * are also written onto a Sentry span so agent runs show up in Sentry AI
 * monitoring. Dual-write until DISABLE_LD_OBSERVABILITY cuts over LD export.
 *
 * The Cursor provider needs MANUAL spans: inference happens inside Cursor's
 * hosted service. Anthropic may also be auto-instrumented by Sentry when the
 * integration is present — manual spans still carry AgentControl correlation.
 *
 * All helpers are defensive: telemetry must never break a run.
 */

import * as nodeModule from "node:module";
import type { LDAIConfigTracker } from "@launchdarkly/server-sdk-ai";
import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { pipelineRunId } from "./ldSdk.js";
import { sentryEnabled } from "./sentryInit.js";

const TRACER_NAME = "launchdarkly-auto-factory";
/** Cap prompt/completion content recorded on a span so spans stay bounded. */
const MAX_CONTENT = 8000;

/**
 * `@opentelemetry/api` is loaded LAZILY with a no-op fallback, and stays
 * `--external` in the action bundle. Both halves matter:
 *
 *  - External because the OTel API is a SINGLETON: the (also-external, lazily
 *    loaded) `@launchdarkly/observability-node` plugin registers the global
 *    tracer on the node_modules copy of the API — bundling our own inline copy
 *    would read a different global registry and silently drop every span on
 *    the checkout+`npm ci` workflow variants.
 *  - Lazy because the bare `uses:` action form runs the bundle with NO
 *    node_modules at all. A static import of an external package is eager in
 *    ESM — the bundle couldn't even load (ERR_MODULE_NOT_FOUND). In that mode
 *    the observability plugin is absent anyway, so a no-op tracer loses
 *    nothing: telemetry must never be the reason a run can't start.
 */
type OtelApi = {
  trace: { getTracer(name: string): Tracer };
  SpanKind: typeof import("@opentelemetry/api").SpanKind;
  SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
};

const NOOP_SPAN = {
  setAttribute() { return NOOP_SPAN; },
  setAttributes() { return NOOP_SPAN; },
  setStatus() { return NOOP_SPAN; },
  recordException() {},
  addEvent() { return NOOP_SPAN; },
  updateName() { return NOOP_SPAN; },
  end() {},
  isRecording() { return false; },
  spanContext() { return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }; },
} as unknown as Span;

function loadOtelApi(): OtelApi {
  try {
    // Namespace import: the action bundle's banner already declares a
    // top-level `createRequire` binding; a named import would collide.
    return nodeModule.createRequire(import.meta.url)("@opentelemetry/api") as OtelApi;
  } catch {
    return {
      trace: { getTracer: () => ({ startSpan: () => NOOP_SPAN }) as unknown as Tracer },
      // Values mirror the OTel API enums so recorded constants stay comparable.
      SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 } as OtelApi["SpanKind"],
      SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 } as OtelApi["SpanStatusCode"],
    };
  }
}

const otel = loadOtelApi();
export const SpanKind = otel.SpanKind;
export const SpanStatusCode = otel.SpanStatusCode;

/**
 * The AutoFactory OTel tracer. When the Observability plugin is registered this
 * is backed by LD's exporter; otherwise it's the OTel no-op tracer (or our shim
 * when the API package itself is absent), so callers can always create spans
 * without checking whether observability is enabled.
 */
export function aiTracer(): Tracer {
  return otel.trace.getTracer(TRACER_NAME);
}

function truncate(s: string): string {
  return s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…[truncated]` : s;
}

export interface GenAiSpanData {
  /** gen_ai.system / gen_ai.provider — the execution backend, e.g. "cursor". */
  provider: string;
  /** gen_ai.request.model — the model actually run (e.g. the resolved Cursor model id). */
  requestModel: string;
  /** The node's AI-config tracker, for correlating the span to the AgentControl config. */
  tracker?: LDAIConfigTracker;
  /** The rendered prompt sent to the model (recorded as gen_ai.input, truncated). */
  prompt?: string;
  /** The model's final output (recorded as gen_ai.output, truncated). */
  output?: string;
  /** Token usage from the provider, if reported. */
  usage?: { input: number; output: number; total: number };
  /** Agent / config key for gen_ai.agent.name (defaults to tracker config key). */
  agentName?: string;
  /** Override gen_ai.operation.name (default "chat"). */
  operationName?: string;
}

/**
 * Build GenAI + LD correlation attributes (shared by OTel and Sentry).
 *
 * `includeContent` controls whether the prompt/output land on the span. The LD
 * span always records them (pre-Sentry behavior — LD LLM Observability is the
 * operator's own account); the Sentry copy only includes them when the operator
 * opts in with SENTRY_AI_RECORD_PROMPTS=true (CI prompts carry PR diffs).
 */
function buildGenAiAttributes(d: GenAiSpanData, includeContent: boolean): Attributes {
  const attrs: Attributes = {
    "gen_ai.operation.name": d.operationName ?? "chat",
    "gen_ai.system": d.provider,
    "gen_ai.provider": d.provider,
    "gen_ai.request.model": d.requestModel,
    "gen_ai.model": d.requestModel,
    // Groups the whole Phase 1 chain in Sentry Conversations / LD views.
    "gen_ai.conversation.id": pipelineRunId(),
  };
  const agentName = d.agentName ?? d.tracker?.getTrackData?.()?.configKey;
  if (agentName) attrs["gen_ai.agent.name"] = agentName;

  if (d.usage) {
    attrs["gen_ai.usage.input_tokens"] = d.usage.input;
    attrs["gen_ai.usage.output_tokens"] = d.usage.output;
    attrs["gen_ai.usage.total_tokens"] = d.usage.total;
    attrs["gen_ai.usage.prompt_tokens"] = d.usage.input;
    attrs["gen_ai.usage.completion_tokens"] = d.usage.output;
  }
  if (includeContent) {
    if (d.prompt) attrs["gen_ai.input"] = truncate(d.prompt);
    if (d.output) attrs["gen_ai.output"] = truncate(d.output);
  }

  attrs["launchdarkly.run.id"] = pipelineRunId();

  const td = d.tracker?.getTrackData?.();
  if (td) {
    attrs["launchdarkly.ai.config.key"] = td.configKey;
    attrs["launchdarkly.ai.config.variation"] = td.variationKey;
    attrs["launchdarkly.ai.config.version"] = td.version;
    attrs["launchdarkly.ai.config.model"] = td.modelName;
    attrs["launchdarkly.ai.provider"] = td.providerName;
    attrs["launchdarkly.ai.run.id"] = td.runId;
    if (td.graphKey) attrs["launchdarkly.ai.graph.key"] = td.graphKey;
  }
  return attrs;
}

/**
 * Set GenAI + LaunchDarkly-AI-config attributes on a span. Both the OTel GenAI
 * convention keys and flatter aliases are set so LD LLM Observability and
 * Sentry AI monitoring pick them up. Never throws.
 */
export function setGenAiAttributes(span: Span, d: GenAiSpanData): void {
  try {
    span.setAttributes(buildGenAiAttributes(d, true));
  } catch {
    /* telemetry must never break the run */
  }
}

/** Optional Sentry span handle (duck-typed so @sentry/node stays lazy). */
interface SentrySpanLike {
  setAttributes(attrs: Record<string, unknown>): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

export interface AiSpanHandle {
  /** OTel span (LD exporter when plugin is loaded). */
  otel: Span;
  end(status?: "ok" | "error", message?: string): void;
  setGenAi(d: GenAiSpanData): void;
  recordException(err: unknown): void;
}

/**
 * Start a dual-write AI span: OTel (LD) + Sentry when enabled.
 * Prefer this over bare `aiTracer().startSpan` for agent/LLM/handoff spans.
 */
export function startAiSpan(
  name: string,
  opts: { kind?: number; op?: string } = {},
): AiSpanHandle {
  const otelSpan = aiTracer().startSpan(name, { kind: opts.kind ?? SpanKind.CLIENT });
  let sentrySpan: SentrySpanLike | null = null;

  if (sentryEnabled()) {
    try {
      // Synchronous require via createRequire so we don't force a top-level import
      // when Sentry isn't installed (bare action bundle).
      const Sentry = nodeModule.createRequire(import.meta.url)("@sentry/node") as {
        startInactiveSpan?: (args: { name: string; op?: string }) => SentrySpanLike;
      };
      if (typeof Sentry.startInactiveSpan === "function") {
        sentrySpan = Sentry.startInactiveSpan({
          name,
          op: opts.op ?? "gen_ai.chat",
        });
      }
    } catch {
      /* Sentry optional */
    }
  }

  return {
    otel: otelSpan,
    setGenAi(d: GenAiSpanData) {
      setGenAiAttributes(otelSpan, d);
      if (sentrySpan) {
        try {
          // Prompt/output content goes to Sentry only on explicit opt-in.
          const recordPrompts = process.env.SENTRY_AI_RECORD_PROMPTS === "true";
          sentrySpan.setAttributes(buildGenAiAttributes(d, recordPrompts) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
      }
    },
    recordException(err: unknown) {
      if (err instanceof Error) otelSpan.recordException(err);
    },
    end(status = "ok", message?: string) {
      try {
        otelSpan.setStatus({
          code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          ...(message ? { message } : {}),
        });
        otelSpan.end();
      } catch {
        /* ignore */
      }
      if (sentrySpan) {
        try {
          // Sentry span status: 1 = ok, 2 = error (OTel-aligned in recent SDKs).
          sentrySpan.setStatus({
            code: status === "ok" ? 1 : 2,
            ...(message ? { message } : {}),
          });
          sentrySpan.end();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Start an invoke_agent span for a graph node. */
export function startAgentNodeSpan(configKey: string): AiSpanHandle {
  return startAiSpan(`invoke_agent ${configKey}`, {
    kind: SpanKind.INTERNAL,
    op: "gen_ai.invoke_agent",
  });
}

/** Start a handoff span between graph nodes. */
export function startHandoffSpan(fromKey: string, toKey: string): AiSpanHandle {
  return startAiSpan(`handoff from ${fromKey} to ${toKey}`, {
    kind: SpanKind.INTERNAL,
    op: "gen_ai.handoff",
  });
}
