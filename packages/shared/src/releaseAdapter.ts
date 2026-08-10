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

import type { LdClient, LdResponse } from "./ldClient.js";
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

const TERMINAL: ReadonlySet<string> = new Set(["completed", "reverted", "monitoring_stopped"]);

/**
 * Statuses we positively recognise as "still running". Deliberately an allowlist, and
 * deliberately asymmetric with TERMINAL — an UNKNOWN status must be handled differently
 * by the two callers, and both directions fail safe:
 *
 *  - monitoring KEEPS POLLING an unrecognised state rather than stopping on it. A release
 *    PAUSED awaiting human intervention — reachable now that `rollbackOnRegression: false`
 *    is honoured — must still be watched, because a human resuming it produces the
 *    `completed` that repoints child flags. An earlier revision stopped on unknown, which
 *    was a reporting fix that silently cost that observation.
 *  - the idempotency check treats anything not known-TERMINAL as active, so a re-delivered
 *    deploy webhook cannot start a SECOND release on a flag that already has one.
 */
const KNOWN_RUNNING: ReadonlySet<string> = new Set(["in_progress"]);

/** Is this release still running, as far as we can positively tell? */
export function isReleaseRunning(status: string): boolean {
  return KNOWN_RUNNING.has(status);
}

/** Is this release definitely finished? Unknown statuses are NOT finished. */
export function isReleaseFinished(status: string): boolean {
  return TERMINAL.has(status);
}

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

/**
 * The outcome of reading a flag's release policy. THREE states, not two, because
 * "no policy is configured" and "we could not find out" must not be confused:
 * both previously collapsed to `null`, and the caller then silently dropped the org's
 * metric baseline AND flipped auto-rollback on — overriding a policy configured to pause
 * and wait for a human, invisibly.
 *
 * Note which HTTP shape means what, from observing a live project: an environment with no
 * policy returns **200 with empty strings**, not 404. So a 404 much more likely means the
 * path or flag is wrong — including the rename this file's header predicts — and is
 * reported as `unreadable`, not as "no policy".
 */
export type PolicyRead =
  | { status: "ok"; policy: ReleasePolicy; note?: string }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

/**
 * Read a flag's configured release policy, distinguishing absent from unreadable.
 *
 * Never throws: a caller deciding how to release should get a state it can report, not
 * an exception to swallow.
 */
export async function readReleasePolicy(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
): Promise<PolicyRead> {
  // Retried for the same reason status polling is, only more so: a missed poll is picked
  // up on the next tick, whereas a missed policy read DISCARDS the org's configured policy
  // for this release and forces auto-rollback on.
  let res: LdResponse<RawReleaseSettings> | undefined;
  let lastError = "";
  for (let attempt = 0; attempt <= POLL_ERROR_RETRIES; attempt++) {
    try {
      res = await ld.request<RawReleaseSettings>({
        path: releaseSettingsPath(ld.projectKey, flagKey, environmentKey),
        headers: BETA_HEADER,
        okStatuses: [404],
      });
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === POLL_ERROR_RETRIES) return { status: "unreadable", reason: lastError };
    }
  }
  if (!res) return { status: "unreadable", reason: lastError || "no response" };
  if (res.status === 404) {
    return {
      status: "unreadable",
      reason:
        `release-settings returned 404 for '${flagKey}' in '${environmentKey}'. An environment with no ` +
        `policy returns 200 with empty fields, so this is more likely a wrong path (the beta ` +
        `/internal endpoint is mid-rename) or an unknown flag.`,
    };
  }
  const policy = normalizeReleasePolicy(res.data);
  // A POLICY WE PARSED IS NEVER DISCARDED. `unreadable` makes the caller fall back to
  // manifest metrics with auto-rollback forced on, so treating an unfamiliar field as a
  // reason to throw away a policy we successfully read would cause the exact failure this
  // tri-state exists to prevent — and would do it org-wide the moment LaunchDarkly ships
  // any additive field on an endpoint documented as mid-rename. Drift can only ever
  // downgrade an otherwise-EMPTY result; against a parsed one it is a note.
  const drift = describePolicyDrift(res.data, policy);
  if (Object.keys(policy).length > 0) {
    return { status: "ok", policy, ...(drift ? { note: drift } : {}) };
  }
  if (drift) return { status: "unreadable", reason: drift };
  return { status: "absent" };
}

/**
 * Fields the no-policy response is known to carry, so their presence never reads as drift.
 * Extend this as LaunchDarkly adds boilerplate — otherwise `absent` rots into noise.
 */
const KNOWN_SETTINGS_KEYS = new Set([
  "releaseMethod",
  "releasePolicyKey",
  "releasePolicyName",
  "guardedReleaseConfig",
  "progressiveReleaseConfig",
  "_links",
]);

/**
 * Positive evidence that the response shape drifted, or undefined if it looks intact.
 *
 * This endpoint is documented as mid-rename, and total drift is not the dangerous case —
 * PARTIAL drift is: a recognised `releaseMethod` alongside a renamed `guardedReleaseConfig`
 * yields a non-empty policy with the metrics silently gone, which no emptiness check can
 * see.
 */
function describePolicyDrift(raw: RawReleaseSettings, normalized: ReleasePolicy): string | undefined {
  const asRecord = (raw ?? {}) as unknown as Record<string, unknown>;
  // (1) A method we cannot map. Positive signal, no guessing: the field is populated and
  // normalizeMethod returned nothing.
  if (raw.releaseMethod && !normalized.releaseMethod) {
    return `release-settings reported an unrecognized releaseMethod '${raw.releaseMethod}'`;
  }
  // (2) A config block with content from which nothing was recovered — an inner rename.
  for (const key of ["guardedReleaseConfig", "progressiveReleaseConfig"] as const) {
    const cfg = asRecord[key];
    // Non-empty VALUES, not merely present keys: the no-policy body carries empty strings,
    // and rule 3 below already exempts them. Requiring the same here keeps a policy-free
    // environment silent even if LaunchDarkly starts sending an empty config block.
    const hasContent =
      cfg !== null &&
      typeof cfg === "object" &&
      Object.values(cfg as Record<string, unknown>).some(
        (x) => x !== "" && x !== null && x !== undefined && !(Array.isArray(x) && x.length === 0),
      );
    if (hasContent) {
      const recovered =
        normalized.randomizationUnit !== undefined ||
        normalized.stages !== undefined ||
        normalized.metricKeys !== undefined ||
        normalized.metricGroupKeys !== undefined ||
        normalized.rollbackOnRegression !== undefined;
      if (!recovered) return `release-settings ${key} had content but nothing in it was recognized`;
    }
  }
  // (3) Populated fields we have never seen. Only non-empty values count, so the
  // empty-string no-policy body stays silent.
  const unknown = Object.entries(asRecord)
    .filter(([k, v]) => !KNOWN_SETTINGS_KEYS.has(k) && v !== "" && v !== null && v !== undefined)
    .map(([k]) => k);
  if (unknown.length > 0) return `release-settings carried unrecognized field(s): ${unknown.join(", ")}`;
  return undefined;
}

/** Path for listing a flag's automated releases across environments (beta/internal). */
function flagAutomatedReleasesPath(projectKey: string, flagKey: string): string {
  return `/internal/projects/${projectKey}/flags/${flagKey}/automated-releases`;
}

/**
 * Find the active automated release for a flag in an environment, or null.
 * `startRelease` doesn't return the release id (the semantic patch responds with
 * the flag), so this is how a caller obtains the id to monitor.
 *
 * "Active" is everything NOT known-terminal, not `status:in_progress`. The old
 * server-side filter was an allowlist of one, so a release in any other non-terminal
 * state — notably one PAUSED on a regression, which `rollbackOnRegression: false` makes
 * reachable — read as "no active release". For the caller that uses this as a
 * re-delivery guard, that means a retried deploy webhook would start a SECOND release on
 * a flag that already has one. Filtering client-side against the terminal set fails safe
 * for any status LaunchDarkly adds.
 */
export async function findActiveRelease(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
): Promise<AutomatedRelease | null> {
  const filter = encodeURIComponent(`environmentKey:${environmentKey}`);
  const res = await ld.request<{ items?: AutomatedRelease[] }>({
    // No limit=1: the newest release may be terminal while an older one is still active,
    // and a server-side limit would hide it.
    path: `${flagAutomatedReleasesPath(ld.projectKey, flagKey)}?filter=${filter}&limit=20`,
    headers: BETA_HEADER,
  });
  return res.data.items?.find((r) => !isReleaseFinished(r.status)) ?? null;
}

/** Consecutive poll failures tolerated before monitoring gives up. */
const POLL_ERROR_RETRIES = 5;

/**
 * Poll an automated release until it finishes or the deadline passes.
 *
 * Returns the last observation rather than throwing on timeout, and keeps polling states
 * it does not recognise (a paused release resumed by a human must still be seen to
 * complete — that is what repoints child flags).
 */
export async function monitorRelease(
  ld: LdClient,
  environmentKey: string,
  releaseId: string,
  opts: { pollMillis?: number; timeoutMillis?: number } = {},
): Promise<AutomatedRelease> {
  const pollMillis = opts.pollMillis ?? 10_000;
  const deadline = Date.now() + (opts.timeoutMillis ?? 60 * 60 * 1000);
  let consecutiveErrors = 0;
  let lastSeen: AutomatedRelease | undefined;
  let reportedUnknown: string | undefined;
  for (;;) {
    let release: AutomatedRelease;
    try {
      release = await getReleaseStatus(ld, environmentKey, releaseId);
      consecutiveErrors = 0;
    } catch (e) {
      // A single transient read must not end monitoring for good: dying here strands the
      // completion, and with it the child-flag repointing that only runs on `completed`.
      if (++consecutiveErrors > POLL_ERROR_RETRIES) throw e;
      console.warn(
        `[release] poll ${consecutiveErrors}/${POLL_ERROR_RETRIES} failed for ${releaseId} ` +
          `(retrying): ${e instanceof Error ? e.message : e}`,
      );
      await new Promise((r) => setTimeout(r, pollMillis));
      continue;
    }
    lastSeen = release;
    if (isReleaseFinished(release.status)) return release;
    // Not finished and not recognised as running — most plausibly PAUSED on a regression,
    // which `rollbackOnRegression: false` asks for. KEEP POLLING: a human resuming it in
    // LaunchDarkly must be observed, because completion is what triggers child-flag
    // repointing. Announce the transition once so the wait is explained rather than silent.
    if (!isReleaseRunning(release.status) && reportedUnknown !== release.status) {
      reportedUnknown = release.status;
      console.warn(
        `[release] ${releaseId} is '${release.status}' — neither running nor finished, most likely ` +
          `PAUSED awaiting a human. Still watching for it to resume or end.`,
      );
    }
    // Timeout returns the last observation instead of throwing: "still paused after N
    // hours" is a state to report, not an error to swallow.
    if (Date.now() > deadline) return lastSeen;
    await new Promise((r) => setTimeout(r, pollMillis));
  }
}
