/**
 * Release adapter — the ONE place that knows how to start/stop/monitor an
 * automated release on LaunchDarkly.
 *
 * ⚠️  The automated-release read endpoints are currently a beta/internal surface
 * (they require `LD-API-Version: beta` and live under an `/internal/...` path
 * that is mid-rename and WILL change / go public). They are quarantined here so
 * that when the public API lands, only this file changes. The trigger itself is
 * a standard semantic-patch instruction on the flag PATCH endpoint.
 *
 * Concrete request/response shapes: reference-private/internal-apis/.
 */

import type { LdClient } from "./ldClient.js";
import type { MetricRef, ReleaseKind, Stage } from "./types.js";

/** Beta header required by the automated-release endpoints (subject to change). */
const BETA_HEADER = { "LD-API-Version": "beta" };

/** Placeholder for the in-flux automated-release read path. Centralized on purpose. */
function automatedReleasesPath(projectKey: string, environmentKey: string, id: string): string {
  // TODO(beta): confirm/replace when the public automated-releases API ships.
  return `/internal/projects/${projectKey}/environments/${environmentKey}/automated-releases/${id}`;
}

/** Path for reading a flag's configured release policy (beta/internal). */
function releaseSettingsPath(projectKey: string, flagKey: string, environmentKey: string): string {
  return `/internal/projects/${projectKey}/flags/${flagKey}/environments/${environmentKey}/release-settings`;
}

/** Where to place the release on the flag. Omit for fallthrough. */
export interface ReleasePlacement {
  ruleId?: string;
  ref?: string;
  /** Provide clauses to create a new rule instead of targeting an existing one. */
  clauses?: unknown[];
  description?: string;
  beforeRuleId?: string;
}

export interface StartReleaseParams {
  flagKey: string;
  environmentKey: string;
  /** Turn targeting on in the same semantic patch (releases can't start on an
   *  off flag, and auto-factory flags are created dark). The release
   *  instruction owns the fallthrough, so no traffic shifts except via stages. */
  turnFlagOn?: boolean;
  releaseKind: Exclude<ReleaseKind, "immediate">; // "guarded" | "progressive"
  originalVariationId: string;
  targetVariationId: string;
  randomizationUnit?: string;
  stages: Stage[];
  /** Guarded-only; extends the final stage's monitoring window. */
  extensionDurationMillis?: number;
  /** Guarded-only. */
  metrics?: MetricRef[];
  /** Guarded-only; per-metric auto-rollback preference. */
  metricMonitoringPreferences?: Record<string, { autoRollback: boolean }>;
  placement?: ReleasePlacement;
}

/**
 * Build the `startAutomatedRelease` semantic-patch instruction.
 * One instruction kind covers guarded + progressive and all placements.
 */
export function buildStartAutomatedRelease(params: StartReleaseParams): Record<string, unknown> {
  const instr: Record<string, unknown> = {
    kind: "startAutomatedRelease",
    releaseKind: params.releaseKind,
    originalVariationId: params.originalVariationId,
    targetVariationId: params.targetVariationId,
    stages: params.stages,
  };
  if (params.randomizationUnit) instr.randomizationUnit = params.randomizationUnit;

  // Placement: omit for fallthrough; ruleId/ref for existing rule; clauses for new rule.
  const p = params.placement;
  if (p?.ruleId) instr.ruleId = p.ruleId;
  if (p?.ref) instr.ref = p.ref;
  if (p?.clauses) {
    instr.clauses = p.clauses;
    if (p.description) instr.description = p.description;
    if (p.beforeRuleId) instr.beforeRuleId = p.beforeRuleId;
  }

  if (params.releaseKind === "guarded") {
    if (params.extensionDurationMillis !== undefined) {
      instr.extensionDurationMillis = params.extensionDurationMillis;
    }
    if (params.metrics?.length) instr.metrics = params.metrics;
    if (params.metricMonitoringPreferences) {
      instr.metricMonitoringPreferences = params.metricMonitoringPreferences;
    }
  }
  return instr;
}

/** Start an automated (guarded/progressive) release on a flag. */
export async function startRelease(ld: LdClient, params: StartReleaseParams): Promise<void> {
  const instructions: Record<string, unknown>[] = [];
  if (params.turnFlagOn) instructions.push({ kind: "turnFlagOn" });
  instructions.push(buildStartAutomatedRelease(params));
  await ld.patchFlagSemantic(
    params.flagKey,
    params.environmentKey,
    instructions,
    "auto-factory: start automated release",
  );
}

/** Stop an in-progress automated release, settling on `finalVariationId`. */
export async function stopRelease(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
  finalVariationId: string,
  ruleId?: string,
): Promise<void> {
  const instr: Record<string, unknown> = { kind: "stopAutomatedRelease", finalVariationId };
  if (ruleId) instr.ruleId = ruleId;
  await ld.patchFlagSemantic(flagKey, environmentKey, [instr], "auto-factory: stop automated release");
}

/** Terminal states for an automated release. */
export type ReleaseStatus =
  | "in_progress"
  | "completed"
  | "reverted"
  | "monitoring_stopped";

export interface AutomatedRelease {
  id: string;
  kind: ReleaseKind;
  status: ReleaseStatus;
  latestStageIndex: number;
  stages: Array<Stage & { stageIndex: number; startedAtMillis?: number; safeRollForward?: boolean }>;
  metricConfigurations?: Array<{
    metricKey: string;
    autoRollback: boolean;
    status: string;
  }>;
}

const TERMINAL: ReadonlySet<ReleaseStatus> = new Set(["completed", "reverted", "monitoring_stopped"]);

/** Read the current state of an automated release. */
export async function getReleaseStatus(
  ld: LdClient,
  environmentKey: string,
  releaseId: string,
): Promise<AutomatedRelease> {
  const res = await ld.request<AutomatedRelease>({
    path: automatedReleasesPath(ld.projectKey, environmentKey, releaseId),
    headers: BETA_HEADER,
  });
  return res.data;
}

// ----------------------------------------------------------------------------
// Release policy (defaults configured on the flag; overrides take precedence)
// ----------------------------------------------------------------------------

/** Normalized release policy read from a flag's release-settings. */
export interface ReleasePolicy {
  releaseMethod?: ReleaseKind;
  randomizationUnit?: string;
  stages?: Stage[];
  metricKeys?: string[];
  metricGroupKeys?: string[];
  /**
   * The policy's rollback choice: `true` = roll back automatically on a metric
   * regression, `false` = pause the release and wait for a human. ONE value for the
   * whole metric set — the release API is per-metric
   * (`metricMonitoringPreferences`), so a caller fans this out across the metrics.
   * Undefined when the policy doesn't state it.
   */
  rollbackOnRegression?: boolean;
  /** Policy identity, for reporting ("guarded by policy 'Prod policy'"). */
  policyKey?: string;
  policyName?: string;
}

interface RawReleaseSettings {
  releaseMethod?: string;
  releasePolicyKey?: string;
  releasePolicyName?: string;
  guardedReleaseConfig?: {
    rolloutContextKindKey?: string;
    metricKeys?: string[];
    metricGroupKeys?: string[];
    stages?: Stage[];
    /** Roll back automatically vs pause and wait for a human. */
    rollbackOnRegression?: boolean;
  };
  progressiveReleaseConfig?: {
    rolloutContextKindKey?: string;
    stages?: Stage[];
  };
}

function normalizeMethod(m?: string): ReleaseKind | undefined {
  if (!m) return undefined;
  const s = m.toLowerCase();
  if (s.includes("guarded")) return "guarded";
  if (s.includes("progressive")) return "progressive";
  if (s.includes("immediate")) return "immediate";
  return undefined;
}

/** Map a raw release-settings response to the normalized policy shape. */
export function normalizeReleasePolicy(raw: RawReleaseSettings): ReleasePolicy {
  const cfg = raw.guardedReleaseConfig ?? raw.progressiveReleaseConfig ?? {};
  const out: ReleasePolicy = {};
  const method = normalizeMethod(raw.releaseMethod);
  if (method) out.releaseMethod = method;
  if (cfg.rolloutContextKindKey) out.randomizationUnit = cfg.rolloutContextKindKey;
  if (cfg.stages?.length) out.stages = cfg.stages;
  const g = raw.guardedReleaseConfig;
  if (g?.metricKeys?.length) out.metricKeys = g.metricKeys;
  if (g?.metricGroupKeys?.length) out.metricGroupKeys = g.metricGroupKeys;
  if (typeof g?.rollbackOnRegression === "boolean") out.rollbackOnRegression = g.rollbackOnRegression;
  // Empty strings are what a non-policy environment returns; treat them as absent.
  if (raw.releasePolicyKey) out.policyKey = raw.releasePolicyKey;
  if (raw.releasePolicyName) out.policyName = raw.releasePolicyName;
  return out;
}

/** Read a flag's configured release policy. Returns null if none is set (404). */
export async function getReleasePolicy(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
): Promise<ReleasePolicy | null> {
  const res = await ld.request<RawReleaseSettings>({
    path: releaseSettingsPath(ld.projectKey, flagKey, environmentKey),
    headers: BETA_HEADER,
    okStatuses: [404],
  });
  if (res.status === 404) return null;
  return normalizeReleasePolicy(res.data);
}

/** Path for listing a flag's automated releases across environments (beta/internal). */
function flagAutomatedReleasesPath(projectKey: string, flagKey: string): string {
  return `/internal/projects/${projectKey}/flags/${flagKey}/automated-releases`;
}

/**
 * Find the in-progress automated release for a flag in an environment, or null.
 * `startRelease` doesn't return the release id (the semantic patch responds with
 * the flag), so this is how a caller obtains the id to monitor.
 */
export async function findActiveRelease(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
): Promise<AutomatedRelease | null> {
  const filter = encodeURIComponent(`environmentKey:${environmentKey},status:in_progress`);
  const res = await ld.request<{ items?: AutomatedRelease[] }>({
    path: `${flagAutomatedReleasesPath(ld.projectKey, flagKey)}?filter=${filter}&limit=1`,
    headers: BETA_HEADER,
  });
  return res.data.items?.[0] ?? null;
}

/** Poll an automated release until it reaches a terminal state or times out. */
export async function monitorRelease(
  ld: LdClient,
  environmentKey: string,
  releaseId: string,
  opts: { pollMillis?: number; timeoutMillis?: number } = {},
): Promise<AutomatedRelease> {
  const pollMillis = opts.pollMillis ?? 10_000;
  const deadline = Date.now() + (opts.timeoutMillis ?? 60 * 60 * 1000);
  for (;;) {
    const release = await getReleaseStatus(ld, environmentKey, releaseId);
    if (TERMINAL.has(release.status)) return release;
    if (Date.now() > deadline) {
      throw new Error(`Timed out monitoring release ${releaseId} (last status: ${release.status})`);
    }
    await new Promise((r) => setTimeout(r, pollMillis));
  }
}
