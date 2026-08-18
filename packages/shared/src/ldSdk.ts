/**
 * Native LaunchDarkly SDK bootstrap for the Phase 1 runtime.
 *
 * This is the LaunchDarkly-native foundation the prototype runs on:
 *   - the Node *server SDK* (`@launchdarkly/node-server-sdk`) evaluates flags
 *     (e.g. the AI-provider selector), and
 *   - the Node *AI SDK* (`@launchdarkly/server-sdk-ai`) resolves agent configs
 *     and agent graphs (interpolated instructions + model + generation tracking).
 *
 * Both share one server-SDK client, created from the `LD_SDK_KEY` (the `sdk-`
 * key — distinct from the `api-` PAT used for REST writes like flag creation).
 * The client is environment-scoped to the FACTORY/control-plane project that
 * holds the AI configs, graph, and operational flags.
 */

import { randomUUID } from "node:crypto";
import { type LDClient, type LDContext, type LDOptions, init } from "@launchdarkly/node-server-sdk";
import { type LDAIClient, initAi } from "@launchdarkly/server-sdk-ai";
import { loadDotEnv } from "./env.js";

/**
 * Build the LaunchDarkly LLM Observability plugin, if available. Lazy + defensive
 * on purpose: `@launchdarkly/observability-node` is heavy (OTel + instrumentation)
 * and is marked external in the action bundle, so loading it can't be a hard
 * dependency of every provider path. If the package is absent or init fails, we
 * continue WITHOUT observability rather than break the run. The plugin sets up the
 * global OTel tracer + an exporter to LD's OTLP endpoint; the per-node gen_ai spans
 * are emitted in the runners (see observability.ts).
 *
 * Set DISABLE_LD_OBSERVABILITY=true to opt out.
 */
async function observabilityPlugins(): Promise<NonNullable<LDOptions["plugins"]>> {
  if (process.env.DISABLE_LD_OBSERVABILITY === "true") return [];
  try {
    const { Observability } = await import("@launchdarkly/observability-node");
    const plugin = new Observability({
      serviceName: process.env.LD_OBSERVABILITY_SERVICE ?? "auto-factory-phase1",
      serviceVersion: process.env.GITHUB_SHA ?? "dev",
      environment: "production",
    });
    // The plugin's type is from the external package; the SDK accepts it structurally.
    return [plugin as unknown as NonNullable<LDOptions["plugins"]>[number]];
  } catch (e) {
    console.warn(`[observability] LLM observability unavailable (${e instanceof Error ? e.message : e}); continuing without it.`);
    return [];
  }
}

export interface LdSdk {
  /** Server SDK client — flag evaluation. */
  ldClient: LDClient;
  /** AI SDK client — agent configs + agent graphs + tracking. */
  aiClient: LDAIClient;
}

let cached: LdSdk | null = null;

/** Initialize (once) and return the shared LaunchDarkly server + AI SDK clients. */
export async function getLdSdk(): Promise<LdSdk> {
  if (cached) return cached;
  loadDotEnv();
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) {
    throw new Error("LD_SDK_KEY not set — the server SDK key for flag evaluation and AI config/graph resolution");
  }
  const ldClient = init(sdkKey, { plugins: await observabilityPlugins() });
  await ldClient.waitForInitialization({ timeout: 15 });
  const aiClient = initAi(ldClient);
  cached = { ldClient, aiClient };
  return cached;
}

/** Flush and close the SDK so the process can exit (the client holds the event loop open). */
export async function closeLdSdk(): Promise<void> {
  if (!cached) {
    // Still flush Sentry if it was initialized without an LD client cache hit.
    try {
      const { flushFactorySentry } = await import("./sentryInit.js");
      await flushFactorySentry();
    } catch {
      /* ignore */
    }
    return;
  }
  // Flush LLM-observability spans before the (short-lived CI) process exits, or
  // they may never reach LaunchDarkly. Best-effort and only if the plugin loaded.
  try {
    const { LDObserve } = await import("@launchdarkly/observability-node");
    await LDObserve.flush();
  } catch {
    /* observability not enabled / not installed — nothing to flush */
  }
  try {
    const { flushFactorySentry } = await import("./sentryInit.js");
    await flushFactorySentry();
  } catch {
    /* ignore */
  }
  try {
    await cached.ldClient.flush();
  } catch {
    /* best-effort */
  }
  await cached.ldClient.close();
  cached = null;
}

/**
 * The id for THIS pipeline run: the `run` multi-context key (the experiment
 * randomization unit) AND a correlation id stamped on the LLM-observability spans
 * so a run's agent spans group together. Set when the run's context is built.
 */
let currentRunId: string | undefined;

/** The current pipeline run's id (see pipelineContext). Lazily minted if unset. */
export function pipelineRunId(): string {
  if (!currentRunId) currentRunId = randomUUID();
  return currentRunId;
}

/**
 * Return a copy of the pipeline context with the RESOLVED execution provider
 * stamped on the `run` kind (same run key — bucketing is untouched). The
 * runtime resolves the provider flag first (it picks the runner), then tells
 * targeting what it decided: AI config rules can match `run.provider` to serve
 * only models the executing provider can actually run (e.g. a Cursor-catalog
 * model must not be served to an Anthropic-runner run). Contexts without a
 * `run` kind pass through unchanged, and projects with no provider rules fall
 * through exactly as before — the attribute is additive.
 */
export function withProvider(context: LDContext, provider: string): LDContext {
  const multi = context as { kind?: string; run?: Record<string, unknown> };
  if (multi.kind !== "multi" || !multi.run) return context;
  return { ...multi, run: { ...multi.run, provider } } as unknown as LDContext;
}

/**
 * The LaunchDarkly targeting context for a pipeline run. A MULTI-context:
 *
 *  - `service` (static): stable across runs — flag evaluation, env scoping, and
 *    AI-config/graph resolution target this. The operational flags
 *    (auto-factory-ai-provider, auto-factory-approval-gates) should keep their
 *    targeting on `service` so they stay consistent run-to-run.
 *  - `run` (fresh UUID per run): the per-run randomization unit. Point a coding
 *    agent's percentage rollout / experiment at the `run` context kind to A/B its
 *    model (e.g. Composer vs Sonnet) independently per run. Because each AI config
 *    has its own salt, the agents bucket INDEPENDENTLY off this one key — so the
 *    per-node A/Bs are decorrelated without needing a per-node key.
 *
 * Call once per run (action.ts and the extension do); each call mints a new run id.
 */
export function pipelineContext(extra: Record<string, unknown> = {}): LDContext {
  currentRunId = randomUUID();
  return {
    kind: "multi",
    service: {
      key: process.env.LD_PIPELINE_CONTEXT_KEY ?? "auto-factory-phase1",
      name: "AutoFactory Phase 1",
      ...extra,
    },
    run: { key: currentRunId },
  } as LDContext;
}
