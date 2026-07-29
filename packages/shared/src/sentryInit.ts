/**
 * Factory-runner Sentry bootstrap (ADR 0014).
 *
 * When SENTRY_DSN is set, initializes @sentry/node with tracing so Phase 1
 * agent/LLM spans appear in Sentry AI agent monitoring. All providers use the
 * manual dual-write gen_ai spans in observability.ts — @sentry/node 9.x has no
 * Anthropic auto-instrumentation, so no LLM data reaches Sentry outside those
 * spans.
 *
 * PII: prompt/completion capture defaults OFF (CI carries PR diffs). Opt in
 * with SENTRY_AI_RECORD_PROMPTS=true — enforced where the span attributes are
 * built (observability.ts), which is the only path that carries prompt content.
 *
 * Telemetry must never break a run — all failures are swallowed.
 */

import { loadDotEnv } from "./env.js";

let initialized = false;

/** True after a successful init (or when DSN absent — callers treat as no-op). */
export function sentryEnabled(): boolean {
  return initialized && Boolean(process.env.SENTRY_DSN);
}

/**
 * Initialize Sentry once for this process. Safe to call multiple times.
 * No-op when SENTRY_DSN is unset.
 */
export async function initFactorySentry(opts: {
  /** OTel / Sentry service name. */
  serviceName?: string;
} = {}): Promise<void> {
  if (initialized) return;
  loadDotEnv();
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  try {
    const Sentry = await import("@sentry/node");
    const serviceName =
      opts.serviceName ??
      process.env.SENTRY_SERVICE_NAME ??
      process.env.LD_OBSERVABILITY_SERVICE ??
      "auto-factory-phase1";

    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      release: process.env.GITHUB_SHA ?? process.env.SENTRY_RELEASE,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1"),
      // Keep AI traces even if other traffic is sampled down later.
      tracesSampler: (ctx) => {
        const name = ctx.name ?? "";
        const op = ctx.attributes?.["sentry.op"] ?? ctx.attributes?.["gen_ai.operation.name"];
        if (
          typeof name === "string" &&
          (name.startsWith("chat ") ||
            name.startsWith("judge ") ||
            name.startsWith("invoke_agent ") ||
            name.startsWith("handoff "))
        ) {
          return 1;
        }
        if (op === "gen_ai.chat" || op === "gen_ai.invoke_agent" || op === "gen_ai.handoff") return 1;
        return Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1");
      },
      serverName: serviceName,
      // Prompt capture is gated in observability.ts (SENTRY_AI_RECORD_PROMPTS);
      // keep default-PII off so nothing else leaks CI content either.
      sendDefaultPii: false,
    });

    initialized = true;
    console.log(`[sentry] factory AI monitoring enabled (service=${serviceName})`);
  } catch (e) {
    console.warn(`[sentry] init failed (${e instanceof Error ? e.message : e}); continuing without it.`);
  }
}

/** Flush Sentry before a short-lived CI process exits. Never throws. */
export async function flushFactorySentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    const Sentry = await import("@sentry/node");
    await Sentry.flush(timeoutMs);
  } catch {
    /* best-effort */
  }
}
