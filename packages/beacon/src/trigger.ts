/**
 * Release trigger. Resolves the flag's variations, picks the release method
 * (override → sensible default), and executes via the shared release adapter.
 *
 * Handles both flag shapes:
 *  - BOOLEAN (legacy): off=false → on=true, whole-flag release.
 *  - MULTIVARIATE (AutoFactory lineage control/v1/v2…): releases the manifest's
 *    `targetVariation` (else the lineage tip) FROM whatever the environment
 *    serves today — a first release moves control→v1; an iteration release
 *    moves v1→v2 on an already-on flag, and a guarded rollback returns users
 *    to v1, not to off.
 *
 * Precedence for the rollout shape is overrides > the flag's configured
 * release policy (read via getReleasePolicy) > the demo defaults below.
 */

import {
  readReleasePolicy,
  latestVariationValue,
  variationLineageIndex,
  normalizeReleaseIntent,
  notBeforeHolds,
  startRelease,
  type DiscoveredFlag,
  type LdClient,
  type MetricRef,
  type ReleaseKind,
  type ReleasePolicy,
  type Stage,
} from "@auto-factory/shared";

/** Demo default rollouts when neither overrides nor a configured policy provide stages. */
const DEFAULT_PROGRESSIVE_STAGES: Stage[] = [
  { allocation: 20000, durationMillis: 300000 },
  { allocation: 50000, durationMillis: 300000 },
  { allocation: 100000, durationMillis: 300000 },
];
// Guarded stages are capped at 50% by LaunchDarkly (the metric comparison
// needs a control group at least as large as the treatment); the release
// completes to 100% after the final monitored stage passes. Confirmed live:
// a 100% stage is rejected with "stage allocation must not exceed 50%".
const DEFAULT_GUARDED_STAGES: Stage[] = [
  { allocation: 20000, durationMillis: 300000 },
  { allocation: 50000, durationMillis: 300000 },
];
const DEFAULT_RANDOMIZATION_UNIT = "user";

/**
 * Union of two key lists, deduped, order-stable. Merges the release policy's metric set
 * with the manifest's additions.
 */
function unionKeys(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

interface FlagEnvConfig {
  on?: boolean;
  offVariation?: number;
  fallthrough?: { variation?: number; rollout?: { variations?: Array<{ variation?: number; weight?: number }> } };
}

interface FlagVariations {
  variations?: Array<{ _id: string; value: unknown }>;
  defaults?: { onVariation?: number; offVariation?: number };
  /** Present when the flag is fetched with `?env=<key>`. */
  environments?: Record<string, FlagEnvConfig>;
}

export interface TriggerResult {
  flagKey: string;
  /**
   * The release method used, or an intent outcome: "held" (releaseIntent said
   * hold/manual, a future notBefore, a not-yet-executable ask like segments, or
   * an unintelligible intent — fail-closed) / "prerequisites" (flag turned on
   * behind LD prerequisites; it releases when its parents do) / "noop" (the
   * target variation is already what the environment serves — e.g. a re-deploy
   * after the release completed).
   */
  method: ReleaseKind | "held" | "prerequisites" | "noop";
  note?: string;
}

type Variation = { _id: string; value: unknown };

/**
 * The variation an environment currently serves to real traffic: fallthrough
 * (single, else the heaviest rollout arm) when on; the off-variation when off.
 */
function servedVariation(variations: Variation[], cfg: FlagEnvConfig | undefined): Variation | undefined {
  const at = (idx: number | undefined) => (idx === undefined ? undefined : variations[idx]);
  if (cfg?.on === true) {
    const single = at(cfg.fallthrough?.variation);
    if (single) return single;
    const arms = [...(cfg.fallthrough?.rollout?.variations ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const heaviest = at(arms[0]?.variation);
    if (heaviest) return heaviest;
  }
  return at(cfg?.offVariation);
}

/**
 * The parent variation a prerequisite should pin. Boolean parents: on→true /
 * off→false. Multivariate parents: "on" → what the parent's targeting points
 * at in this environment (what it serves, or will serve, when live); "off" →
 * its off-variation. Mirrors the wire-time resolution in shared/ldWriter.
 */
function parentPinVariation(parent: FlagVariations, environmentKey: string, want: "on" | "off"): Variation | undefined {
  const variations = parent.variations ?? [];
  const isBoolean = variations.some((v) => typeof v.value === "boolean");
  if (isBoolean) return variations.find((v) => v.value === (want === "on"));
  const cfg = parent.environments?.[environmentKey];
  const at = (idx: number | undefined) => (idx === undefined ? undefined : variations[idx]);
  if (want === "off") return at(cfg?.offVariation) ?? at(parent.defaults?.offVariation);
  const single = at(cfg?.fallthrough?.variation);
  if (single) return single;
  const arms = [...(cfg?.fallthrough?.rollout?.variations ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return at(arms[0]?.variation) ?? at(parent.defaults?.onVariation);
}

export async function triggerRelease(
  ld: LdClient,
  flag: DiscoveredFlag,
  environmentKey: string,
): Promise<TriggerResult> {
  // HUMAN release intent (manifest releaseIntent, schema 1.1) is checked FIRST —
  // it directs everything below. Deterministic normalization only at deploy
  // time; anything unintelligible or not yet executable fails closed to "held".
  const { intent, issues } = normalizeReleaseIntent(flag.releaseIntent);
  const intentContext = [
    intent.reference ? `ref: ${intent.reference}` : "",
    intent.approvedBy ? `approved by: ${intent.approvedBy}` : "",
    intent.notes ? `notes: ${intent.notes.slice(0, 200)}` : "",
    issues.length ? `intent issues: ${issues.join("; ")}` : "",
  ].filter(Boolean).join(" | ");

  if (intent.action === "hold" || intent.action === "manual") {
    return {
      flagKey: flag.flagKey,
      method: "held",
      note: `releaseIntent action=${intent.action} — not auto-released${intentContext ? ` (${intentContext})` : ""}`,
    };
  }
  // Anywhere-on-Earth: opens at notBefore T12:00Z, once the stated date has begun in the
  // last timezone. See notBeforeHolds — comparing instants opened at 00:00 UTC, which
  // released a day early for every author west of UTC.
  if (intent.notBefore && notBeforeHolds(intent.notBefore)) {
    return {
      flagKey: flag.flagKey,
      method: "held",
      note: `releaseIntent notBefore=${intent.notBefore} is in the future — not auto-released${intentContext ? ` (${intentContext})` : ""}`,
    };
  }
  if (intent.segments && intent.segments.length > 0) {
    // Segment-first serving is recorded but not yet executed (LD-native
    // multi-phase releases will own this) — fail closed rather than guess.
    return {
      flagKey: flag.flagKey,
      method: "held",
      note: `releaseIntent asks for segment serving [${intent.segments.join(", ")}] — not yet auto-executable${intentContext ? ` (${intentContext})` : ""}`,
    };
  }

  const { data } = await ld.getFlag<FlagVariations>(flag.flagKey, `?env=${encodeURIComponent(environmentKey)}`);
  const variations = data.variations ?? [];
  const envCfg = data.environments?.[environmentKey];
  const isBoolean = variations.some((v) => typeof v.value === "boolean");

  // Resolve WHAT this release moves users FROM and TO.
  let originalVar: Variation;
  let targetVar: Variation;
  if (isBoolean) {
    // Legacy boolean: whole-flag release, off(false) → on(true).
    const onVar = variations.find((v) => v.value === true);
    const offVar = variations.find((v) => v.value === false);
    if (!onVar || !offVar) {
      throw new Error(`boolean flag '${flag.flagKey}' has no true/false variations`);
    }
    originalVar = offVar;
    targetVar = onVar;
    // The noop guard, which for a long time existed ONLY in the multivariate branch below.
    // A boolean flag already serving `true` has nothing to release, and re-releasing it is
    // not harmless: a progressive/guarded release restarts at stage 1, which yanks ~80% of
    // users back to `false`. Reachable via a re-POST after a completed boolean rollout.
    const servedNow = servedVariation(variations, envCfg);
    if (servedNow && servedNow._id === targetVar._id) {
      return {
        flagKey: flag.flagKey,
        method: "noop",
        note: `'${environmentKey}' already serves true — nothing to release (re-deploy after completion?)`,
      };
    }
  } else {
    // Multivariate lineage: target = manifest targetVariation, else the tip.
    const targetValue = flag.targetVariation ?? latestVariationValue(variations.map((v) => v.value));
    if (!targetValue) {
      throw new Error(`multivariate flag '${flag.flagKey}' has no vN lineage variation to release`);
    }
    const t = variations.find((v) => v.value === targetValue);
    if (!t) {
      throw new Error(`'${flag.flagKey}' has no variation '${targetValue}' (manifest targetVariation?)`);
    }
    targetVar = t;
    // Original = what the environment serves today (control on a dark flag;
    // vN-1 on an iteration) — also what a guarded rollback returns users to.
    const served = servedVariation(variations, envCfg) ?? variations.find((v) => v.value === "control");
    if (!served) {
      throw new Error(`'${flag.flagKey}' has no resolvable current variation in '${environmentKey}'`);
    }
    originalVar = served;
    // NEVER MOVE THE LINEAGE BACKWARDS.
    //
    // A release whose target is OLDER than what the environment already serves is a
    // regression dressed as a rollout, and every other guard misses it: the noop guard only
    // fires on served === target; `findActiveRelease` only sees releases that are still
    // running; and `findLatestRelease` sees nothing at all when the newer variation arrived
    // via an `immediate` or `prerequisites` release, which create no AutomatedRelease record.
    //
    // Reachable in the repo's steady state, not by misconfiguration: manifests are one per
    // PR and never deleted, iteration PRs target a new variation of an EXISTING flag, and the
    // re-evaluation ledger keeps an unreleased older manifest alive indefinitely. Flip that
    // older manifest's intent from `hold` to `auto` — the documented way to release held work
    // — and without this guard Beacon starts a progressive rollout from v2 back to v1 and
    // reports it as a successful release.
    const servedIndex = variationLineageIndex(originalVar.value);
    const targetIndex = variationLineageIndex(targetVar.value);
    if (servedIndex !== undefined && targetIndex !== undefined && targetIndex < servedIndex) {
      return {
        flagKey: flag.flagKey,
        method: "held",
        note:
          `'${environmentKey}' already serves '${String(originalVar.value)}' and this manifest asks for ` +
          `'${String(targetVar.value)}' — releasing would move users BACKWARDS along the lineage. Held, not ` +
          `released: a newer variation superseded this manifest. Delete or update it, or release the newer ` +
          `one; nothing here can decide that.`,
      };
    }
    if (originalVar._id === targetVar._id) {
      return {
        flagKey: flag.flagKey,
        method: "noop",
        note: `'${String(targetVar.value)}' is already what '${environmentKey}' serves — nothing to release (re-deploy after completion?)`,
      };
    }
  }
  // Auto-factory flags are created DARK (targeting off) — merge ≠ release. LD
  // refuses to start an automated release on an off flag ("flag … is off",
  // confirmed live), so the same semantic patch turns targeting on; the release
  // instruction owns the fallthrough, so no traffic shifts except via stages.
  // (Iteration releases run on an already-on flag — no turnFlagOn needed.)
  const flagIsOn = envCfg?.on === true;

  // Prerequisites intent: LD-native — attach the parent flag(s) as prerequisites
  // and turn this flag ON serving treatment. It then releases exactly when its
  // parents do; no automated release is started.
  if (intent.prerequisites && intent.prerequisites.length > 0) {
    const instructions: Array<Record<string, unknown>> = [];
    for (const p of intent.prerequisites) {
      let parent: { data: FlagVariations };
      try {
        parent = await ld.getFlag<FlagVariations>(p.flagKey, `?env=${encodeURIComponent(environmentKey)}`);
      } catch {
        return {
          flagKey: flag.flagKey,
          method: "held",
          note: `releaseIntent prerequisite '${p.flagKey}' could not be read — held (fail-closed)${intentContext ? ` (${intentContext})` : ""}`,
        };
      }
      const parentVar = parentPinVariation(parent.data, environmentKey, p.variation ?? "on");
      if (!parentVar) {
        return {
          flagKey: flag.flagKey,
          method: "held",
          note: `releaseIntent prerequisite '${p.flagKey}' has no resolvable '${p.variation ?? "on"}' variation — held${intentContext ? ` (${intentContext})` : ""}`,
        };
      }
      instructions.push({ kind: "addPrerequisite", key: p.flagKey, variationId: parentVar._id });
    }
    instructions.push({ kind: "turnFlagOn" }, { kind: "updateFallthroughVariationOrRollout", variationId: targetVar._id });
    await ld.patchFlagSemantic(
      flag.flagKey,
      environmentKey,
      instructions,
      "auto-factory: release via prerequisites (releaseIntent)",
    );
    return {
      flagKey: flag.flagKey,
      method: "prerequisites",
      note: `on behind prerequisites [${intent.prerequisites.map((p) => `${p.flagKey}=${p.variation ?? "on"}`).join(", ")}]${intentContext ? ` (${intentContext})` : ""}`,
    };
  }

  // Defaults precedence: manifest releasePlan > the flag's release policy > demo defaults.
  //
  // A read FAILURE is not the same as "no policy configured", and conflating them is
  // dangerous: with no policy we drop the org's metric baseline and default auto-rollback
  // to on, which silently overrides a policy that says pause-and-wait. We still proceed
  // (a renamed beta path must not hard-stop every release, and Beacon's idempotency means
  // a hold might never be retried) — but the run says so.
  const policyRead = await readReleasePolicy(ld, flag.flagKey, environmentKey);
  const policy: ReleasePolicy | null = policyRead.status === "ok" ? policyRead.policy : null;
  let policyNote: string | undefined;
  if (policyRead.status === "ok" && policyRead.note) {
    // The policy WAS read and is being used; an unfamiliar field is worth surfacing but
    // must not discard it.
    policyNote = `release policy read with an unfamiliar shape (${policyRead.note}) — used as parsed`;
    console.warn(`auto-factory: ${policyNote}`);
  }
  if (policyRead.status === "unreadable") {
    policyNote =
      `release policy UNREADABLE (${policyRead.reason}) — released with manifest metrics only and ` +
      `auto-rollback on; a configured policy may have been ignored`;
    console.warn(`auto-factory: ${policyNote}`);
  }

  const ov = flag.releasePlan ?? flag.releaseOverrides ?? {};
  // UNION, not override. The manifest's metrics are what THIS PR added; the policy's are
  // the org's baseline. Taking `ov ?? policy` meant one agent-authored metric silently
  // dropped the whole standard set — five metrics became one, and the release was guarded
  // by a single narrow signal. Policy first so the baseline reads first in reports.
  const metricKeys = unionKeys(policy?.metricKeys, ov.metricKeys);
  const metricGroupKeys = unionKeys(policy?.metricGroupKeys, ov.metricGroupKeys);
  const hasMetrics = metricKeys.length > 0 || metricGroupKeys.length > 0;

  const method: ReleaseKind =
    ov.releaseMethod ?? policy?.releaseMethod ?? (hasMetrics ? "guarded" : "progressive");

  if (method === "immediate") {
    await ld.patchFlagSemantic(
      flag.flagKey,
      environmentKey,
      [
        ...(flagIsOn ? [] : [{ kind: "turnFlagOn" }]),
        { kind: "updateFallthroughVariationOrRollout", variationId: targetVar._id },
      ],
      "auto-factory: immediate release",
    );
    return { flagKey: flag.flagKey, method, ...(policyNote ? { note: policyNote } : {}) };
  }

  const metrics: MetricRef[] = [
    ...metricKeys.map((key) => ({ key, isGroup: false })),
    ...metricGroupKeys.map((key) => ({ key, isGroup: true })),
  ];
  // Inherit the policy's rollback choice rather than asserting over it. A policy set to
  // "pause and wait for human intervention" (`rollbackOnRegression: false`) was previously
  // overridden to auto-rollback on every metric — the same override bug as the metrics
  // one above, and worse: that changes WHAT is watched, this changes what HAPPENS when it
  // trips, and it failed toward the destructive action.
  //
  // The policy carries one value for the whole set while the API is per-metric, so this
  // is a fan-out. With no policy there is nothing to inherit, so keep the previous
  // default (true) rather than trading known behaviour for an unknown server-side one.
  // Default stays AUTO-ROLLBACK when the choice is unknown: reverting to a known-good
  // variation is the safer direction for users, and a paused release here has no pager —
  // `monitorRelease` writes to the console and nothing else. But when drift is what hid the
  // choice, an absent field is evidence of a RENAME rather than of "not configured", so the
  // run must say that a configured pause-and-wait may have been overridden.
  const rollbackUncertain = policyRead.status === "ok" && policyRead.rollbackChoiceUncertain === true;
  const autoRollback = policy?.rollbackOnRegression ?? true;
  const metricMonitoringPreferences: Record<string, { autoRollback: boolean }> = {};
  for (const m of metrics) metricMonitoringPreferences[m.key] = { autoRollback };

  const stages =
    ov.stages ?? policy?.stages ?? (method === "guarded" ? DEFAULT_GUARDED_STAGES : DEFAULT_PROGRESSIVE_STAGES);
  const usedDefaults = !ov.stages && !policy?.stages;

  await startRelease(ld, {
    flagKey: flag.flagKey,
    environmentKey,
    turnFlagOn: !flagIsOn,
    releaseKind: method,
    originalVariationId: originalVar._id,
    targetVariationId: targetVar._id,
    randomizationUnit: ov.randomizationUnit ?? policy?.randomizationUnit ?? DEFAULT_RANDOMIZATION_UNIT,
    stages,
    ...(ov.extensionDurationMillis !== undefined
      ? { extensionDurationMillis: ov.extensionDurationMillis }
      : {}),
    ...(method === "guarded" && metrics.length
      ? { metrics, metricMonitoringPreferences }
      : {}),
  });

  const rollbackNote =
    method === "guarded" && metrics.length > 0 && rollbackUncertain
      ? "the policy's rollback choice could not be read (shape drift) — released with AUTO-ROLLBACK ON; " +
        "a configured pause-and-wait may have been overridden"
      : "";
  if (rollbackNote) console.warn(`auto-factory: ${rollbackNote}`);
  const notes = [policyNote, rollbackNote, usedDefaults ? "used demo default stages (no overrides or policy stages)" : ""]
    .filter(Boolean)
    .join("; ");
  return {
    flagKey: flag.flagKey,
    method,
    ...(notes ? { note: notes } : {}),
  };
}
