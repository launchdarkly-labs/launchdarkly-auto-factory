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
  LdApiError,
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
 * 4xx statuses that are NOT a rejection of what we sent, so they must keep throwing.
 *
 *  - 429 is a rate limit, and `LdClient.request` already spent its own backoff budget before
 *    surfacing it (RATE_LIMIT_RETRIES). Reporting a spent budget as "a human must fix this
 *    manifest" would be a lie about a transient condition, and the ledger's retry is the right
 *    answer to it.
 *  - 408 is a request timeout: the request may have been received and PROCESSED, so it is the one
 *    4xx where write-certainty is exactly as unknowable as a 5xx. It must stay in the
 *    "we do not know" bucket that claims the flag's action slot.
 *  - 401/403 are Beacon's credentials, not the manifest's content. They are deterministic but
 *    GLOBAL — every manifest for every flag hits them identically, so nobody is starved by the
 *    slot claim, and pointing an operator at `releasePlan` when the API key is wrong sends them
 *    to the wrong file.
 */
const NOT_A_CONTENT_REJECTION: ReadonlySet<number> = new Set([401, 403, 408, 429]);

/**
 * Did LaunchDarkly REFUSE this patch (as opposed to failing to answer about it)? Returns the
 * status when so.
 *
 * Classified on the STATUS CODE carried by `LdApiError`, which is what `LdClient.request` throws
 * for every non-2xx — never on the message text, which is LaunchDarkly's to change.
 *
 * WHY THIS IS A DIFFERENT KIND OF FAILURE from everything else `startRelease` can throw. The rule
 * in `server.ts` is that a throw claims the flag's per-notification action slot, because
 * `startRelease` awaits the response AFTER the patch is applied — so a lost response is "we do not
 * know whether we wrote". A client-error status is not a lost response: LaunchDarkly answered, and
 * its answer is that it did not apply the patch. Write-certainty is therefore knowable from the
 * error itself, and the failure is DETERMINISTIC and PER-MANIFEST — the same manifest is refused on
 * every deploy — which is the one shape for which claiming the slot starves a releasable sibling
 * permanently rather than delaying it.
 */
function contentRefusalStatus(e: unknown): number | undefined {
  if (!(e instanceof LdApiError)) return undefined;
  if (e.status < 400 || e.status >= 500) return undefined;
  if (NOT_A_CONTENT_REJECTION.has(e.status)) return undefined;
  return e.status;
}

/** LaunchDarkly's own explanation, so an operator can act on it without reading Beacon's logs. */
function ldMessage(responseBody: unknown): string {
  if (typeof responseBody === "string") return responseBody.slice(0, 300);
  if (responseBody && typeof responseBody === "object") {
    const m = (responseBody as { message?: unknown }).message;
    if (typeof m === "string" && m) return m.slice(0, 300);
  }
  try {
    return JSON.stringify(responseBody).slice(0, 300);
  } catch {
    return String(responseBody);
  }
}

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
   * The release method used, or an intent outcome:
   *  - "held" — NOT FINAL, so the ledger keeps re-checking it: releaseIntent said hold/manual,
   *    a future notBefore, a not-yet-executable ask like segments, an unintelligible intent
   *    (fail-closed), a target the flag HAS NO VARIATION for, a target that would leave the vN
   *    lineage altogether, or a release instruction LaunchDarkly REFUSED with a client error (see
   *    `contentRefusalStatus`). Every one of these is a human's decision, and NONE of them writes —
   *    so they must not claim the flag's action slot in `server.ts`.
   *  - "prerequisites" — flag turned on behind LD prerequisites; it releases when its parents do.
   *  - "noop" — FINAL: there is nothing left for this manifest to release. Either the target is
   *    already what the environment serves (a re-deploy after the release completed), or a NEWER
   *    variation of the same lineage superseded it.
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
    //
    // ABSENT means "the tip", and the tip is derived from THIS FLAG's own variations — so a flag
    // with no vN lineage at all defeats every manifest for it identically. That is a PER-FLAG
    // error and it stays a throw. An EMPTY string is NOT absent (`??` catches only
    // null/undefined): it is a target this one manifest names and the flag does not have, which
    // is the held case just below.
    const targetValue = flag.targetVariation ?? latestVariationValue(variations.map((v) => v.value));
    if (targetValue === undefined) {
      throw new Error(`multivariate flag '${flag.flagKey}' has no vN lineage variation to release`);
    }
    const t = variations.find((v) => v.value === targetValue);
    if (!t) {
      // HELD, NOT THROWN — and this was a PERMANENT loss of a release, not a delay.
      //
      // `evaluateManifest`'s catch claims the flag's per-notification action slot for ANY throw,
      // and that is right for the throws it was written for: `startRelease` awaits `res.text()`
      // AFTER LaunchDarkly applied the patch, so a lost response is "we do not know whether we
      // wrote" and must fail closed. This throw is none of those things — it is DETERMINISTIC,
      // PRE-WRITE and PER-MANIFEST. So it threw, claimed the slot, and starved the sibling that
      // could have released; and because `server.ts`'s `targetRank` evaluates the manifest naming
      // the HIGHER variation first, the manifest naming a MISSING higher variation went first
      // every time. Flag has control/v1, pr-41 asks v2, pr-40 asks v1 ⇒ zero releases, on that
      // deploy and every later one, with pr-40's own report claiming another manifest had
      // released the flag.
      //
      // Reachable without a contrived fixture: `write_manifest` (sandboxTools) validates
      // `targetVariation` against /^v\d+$/ but never against the flag's actual variations, so a
      // failed `addVariation`, a skipped implementer step or a loop-back rerun writes exactly
      // this — and `.release-flags/` is hand-editable in git.
      //
      // STRUCTURALLY IDENTICAL to the off-the-lineage refusal below: a human named a variation
      // that does not exist, only a human can say what was meant, and `held` is not final, so the
      // ledger re-checks it once they do.
      return {
        flagKey: flag.flagKey,
        method: "held",
        note:
          `this manifest asks for '${targetValue}' but '${flag.flagKey}' has no such variation (has: ` +
          `${variations.map((v) => String(v.value)).join(", ")}) — HELD for a human: either the variation ` +
          `was never added to the flag or the manifest's targetVariation is wrong. NOTHING WAS WRITTEN, so ` +
          `a sibling manifest for this flag can still release in this same notification.`,
      };
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
    //
    // The two backwards moves are NOT the same answer, and calling them both `held` was the
    // defect this replaced:
    //
    //  - BEHIND the lineage (target vN, served vM, N < M) is MOOT. Its work has already
    //    happened and then some, so it is FINAL (`noop`): `recordOutcome` clears the ledger
    //    entry and the manifest stops being re-checked. As `held` it stayed pending forever
    //    AND — because a non-writing return used to claim the per-notification action slot —
    //    starved every newer, releasable manifest for the same flag. Deadlock, zero releases.
    //  - LEAVING the lineage (served vM, target has no lineage index at all — `control`, or a
    //    hand-named variation) is a REFUSAL, so it stays `held` and needs a human. This is the
    //    most destructive backwards move and until now the only unguarded one: it starts a
    //    rollout from v2 to `control`, i.e. an automated un-release, reported as success.
    const servedIndex = variationLineageIndex(originalVar.value);
    const targetIndex = variationLineageIndex(targetVar.value);
    if (servedIndex !== undefined && targetIndex !== undefined && targetIndex < servedIndex) {
      return {
        flagKey: flag.flagKey,
        method: "noop",
        note:
          `'${environmentKey}' already serves '${String(originalVar.value)}' and this manifest asks for ` +
          `'${String(targetVar.value)}' — releasing would move users BACKWARDS along the lineage. A NEWER ` +
          `VARIATION SUPERSEDED this manifest, so its work is moot and nothing is left to release: dropped ` +
          `rather than held, because holding it would wait for a release that must never happen.`,
      };
    }
    if (servedIndex !== undefined && targetIndex === undefined) {
      return {
        flagKey: flag.flagKey,
        method: "held",
        note:
          `'${environmentKey}' already serves '${String(originalVar.value)}' and this manifest asks for ` +
          `'${String(targetVar.value)}', which is NOT IN THE LINEAGE — releasing would move users OFF the ` +
          `released lineage with no way to tell whether that is forward or backward. Held for a human: a ` +
          `deliberate rollback is LaunchDarkly's job (revert the release, or serve the variation directly), ` +
          `not a deploy notification's.`,
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

  // THE INSTRUCTION BODY IS BUILT FROM MANIFEST CONTENT THAT NOTHING HAS VALIDATED AGAINST
  // LAUNCHDARKLY: `stages`, `metricKeys`, `metricGroupKeys`, `randomizationUnit`. So a REJECTION is
  // reachable, deterministic, and per-manifest — and it must not be reported as a transport error.
  //
  // The live instance: guarded stages are capped at 50% (see DEFAULT_GUARDED_STAGES), so a manifest
  // with a 100% guarded stage is a permanent 400 ("stage allocation must not exceed 50%"). As a
  // throw that claimed the flag's action slot on EVERY deploy, and since `targetRank` evaluates the
  // higher target first, the rejected manifest went first and the releasable sibling was told
  // "another manifest released this flag" — which had not happened. Zero releases, forever.
  //
  // `held`, for the same reasons as the other per-manifest refusals in this file: nothing was
  // written (so the sibling can still release in this same notification), only a human can say what
  // the manifest should have said, and `held` is not final so the ledger re-checks it once they fix
  // it. `write_manifest` now checks the stage shape at authoring time as well, but the manifest is
  // hand-editable in git and this closes the whole CLASS — a missing metric, a bad randomization
  // unit, and anything else LaunchDarkly refuses.
  try {
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
  } catch (e) {
    const status = contentRefusalStatus(e);
    if (status === undefined) throw e; // transient, or a write we cannot rule out — see the catch in server.ts
    return {
      flagKey: flag.flagKey,
      method: "held",
      note:
        `LaunchDarkly REJECTED this manifest's ${method} release instruction (HTTP ${status}): ` +
        `"${ldMessage((e as LdApiError).responseBody)}". The patch was NOT applied, so nothing was ` +
        `written and a sibling manifest for '${flag.flagKey}' can still release in this same ` +
        `notification. HELD for a human: the rejected values come from the manifest's releasePlan ` +
        `(stages, metricKeys, metricGroupKeys, randomizationUnit) or the flag's release policy — a ` +
        `guarded stage allocation above 50% is the common one. Fix it and deploy again; this is ` +
        `re-checked on any later deploy.`,
    };
  }

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
