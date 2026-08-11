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
 * Statuses that ARE a rejection of the CONTENT we sent, so `held` — a human must edit this
 * manifest — is the honest answer.
 *
 * AN ALLOWLIST, AND IT USED TO BE A DENYLIST ("any 4xx except {401, 403, 408, 429}"). That
 * over-claimed, because LaunchDarkly documents exactly six responses on
 * `PATCH /api/v2/flags/{projectKey}/{featureFlagKey}` — **400, 401, 404, 405, 409, 429** — and
 * three of them are not about content at all:
 *
 *  - **409 "Status conflict"**, which LaunchDarkly's own API overview describes as "The API request
 *    can not be completed because it conflicts with a concurrent API request" and answers with
 *    **"Retry your request."** A human editing the flag in the LaunchDarkly UI as our patch lands
 *    produces one. Calling it content CHANGED PRODUCTION BEHAVIOUR, which is why it is the reason
 *    this list was inverted: flag `F`, `pr-41`→v2 (ranked first by `targetRank`), `pr-40`→v1. As a
 *    throw, the slot is claimed, pr-40 defers, and v2 releases on the next deploy. As `held` the
 *    slot stays OPEN, so pr-40's own idempotency read sees nothing running and **v1 is rolled out
 *    to production** — a spurious rollout caused by a transient conflict, with v2 landing on top of
 *    it next deploy, plus an `ACTION REQUIRED` telling the operator to go edit a correct manifest.
 *  - **405 "Approval is required to make this request"** is a per-ENVIRONMENT setting. Required
 *    approvals in production is standard enterprise LaunchDarkly configuration and production is
 *    Beacon's target, so as a content rejection EVERY manifest for EVERY flag is told to fix its
 *    `releasePlan`.
 *  - **404 "Invalid resource identifier"** is the flag or the environment, not the release plan. A
 *    notification carrying a wrong `environment` reported as a per-flag manifest defect, forever.
 *
 * WHY EXCLUDING THOSE THREE IS SAFE, which is the argument the whole allowlist rests on. A throw
 * claims the flag's per-notification action slot (see the catch in `server.ts`), and a claimed slot
 * costs a sibling manifest a DELAY unless the throw is BOTH deterministic AND per-manifest — that
 * one shape starves the sibling permanently. 405 and 404 are per-environment or per-flag, so every
 * manifest for that flag hits them identically and there is no sibling that could have released;
 * 409 is transient and resolves on the next deploy. All three land in the "delay, not starvation"
 * bucket `server.ts`'s catch already enumerates.
 *
 * AND AN UNKNOWN 4xx KEEPS THROWING — the reason this is an allowlist rather than a longer denylist.
 * A status LaunchDarkly does not document here is one we have no basis to call a manifest-content
 * defect, and asserting it anyway sends an operator to edit a correct file while the real cause goes
 * unreported. The cost of the other direction is bounded at one delayed deploy, so declining to
 * classify what we do not recognise is the cheaper error.
 *
 * ALSO EXCLUDED, each for its own reason:
 *  - **429 "Rate limited"**: LaunchDarkly declined it, so nothing was written — but
 *    `LdClient.request` had already spent its own backoff budget (RATE_LIMIT_RETRIES) and the cause
 *    is load, not the manifest. Reporting a spent budget as "a human must fix this manifest"
 *    describes a transient condition as a human problem.
 *  - **408**: appears NOWHERE in LaunchDarkly's v2 spec, so it is not LaunchDarkly behaviour — a
 *    proxy in front of it can emit one. Kept excluded because a timed-out request may have been
 *    received and PROCESSED, which makes it the one 4xx where write-certainty is as unknowable as a
 *    5xx; it belongs in the "we do not know" bucket that claims the slot.
 *  - **401 "Invalid access token" / 403**: Beacon's credentials, not the manifest's content, and
 *    pointing an operator at `releasePlan` when the API key is wrong sends them to the wrong file.
 *    They are PER-FLAG OR PER-ENVIRONMENT AT WORST, NEVER PER-MANIFEST — not "global", which is what
 *    this comment used to claim and what LaunchDarkly's model does not support: custom-role resource
 *    specifiers are globbed and environment-scoped (`proj/*:env/*:flag/ops_*` is a documented
 *    example, and a flag is a child of both a project and an environment). The conclusion survives
 *    the corrected premise, because per-flag is already a "starves nobody" bucket: LaunchDarkly has
 *    no separate role action for a guarded versus a progressive release, so two manifests for one
 *    flag always request the same actions and one cannot be refused while the other succeeds.
 */
const CONTENT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400]);

/**
 * Did LaunchDarkly REFUSE this patch on the CONTENT we sent (as opposed to failing to answer about
 * it, or refusing it for a reason that has nothing to do with the manifest)? Returns the status
 * when so.
 *
 * Classified on the STATUS CODE carried by `LdApiError`, which is what `LdClient.request` throws
 * for every non-2xx — never on the message text, which is LaunchDarkly's to change.
 *
 * WHY THIS IS A DIFFERENT KIND OF FAILURE from everything else a patch can throw. The rule in
 * `server.ts` is that a throw claims the flag's per-notification action slot, because a patch's
 * response is awaited AFTER LaunchDarkly applied it — so a lost response is "we do not know whether
 * we wrote". An allowlisted content rejection is not a lost response: LaunchDarkly answered, and its
 * answer is that it did not apply the patch. Write-certainty is therefore knowable from the error
 * itself, and the failure is DETERMINISTIC and PER-MANIFEST — the same manifest is refused on every
 * deploy — which is the one shape for which claiming the slot starves a releasable sibling
 * permanently rather than delaying it.
 */
function contentRefusalStatus(e: unknown): number | undefined {
  if (!(e instanceof LdApiError)) return undefined;
  return CONTENT_REJECTION_STATUSES.has(e.status) ? e.status : undefined;
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
 * The `held` result for a patch LaunchDarkly refused on content grounds — or a RETHROW when the
 * error is anything else (transient, or a write we cannot rule out; see the catch in `server.ts`).
 *
 * ONE builder for both patch sites in this file, the release-start patch and the `prerequisites`
 * release's patch, because the load-bearing claim is identical and must not drift between them:
 * NOTHING WAS WRITTEN, so a sibling manifest for this flag can still release in this same
 * notification. That claim is what keeps the flag's action slot free, and it holds for a
 * MULTI-instruction patch as much as for a single-instruction one because LaunchDarkly documents
 * that "Semantic patches are not applied partially; either all of the instructions are applied or
 * none of them are. If any instruction is invalid, the endpoint returns an error and will not change
 * the resource." A previous round left the `prerequisites` patch unclassified for want of exactly
 * that guarantee, and treated it as an assumption rather than a documented property.
 */
function heldOnContentRefusal(
  e: unknown,
  flagKey: string,
  /** What LaunchDarkly refused, named as an operator would recognise it. */
  refused: string,
  /** Where the refused values came from, so the operator knows which field to edit. */
  whereToLook: string,
): TriggerResult {
  const status = contentRefusalStatus(e);
  if (status === undefined) throw e;
  return {
    flagKey,
    method: "held",
    note:
      `LaunchDarkly REJECTED ${refused} (HTTP ${status}): "${ldMessage((e as LdApiError).responseBody)}". ` +
      `Semantic patches are never applied partially, so the patch did NOT apply: nothing was written, ` +
      `and a sibling manifest for '${flagKey}' can still release in this same notification. HELD for a ` +
      `human: ${whereToLook} Fix it and deploy again; this is re-checked on any later deploy.`,
  };
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
    // CLASSIFIED LIKE THE RELEASE-START PATCH, and it was the known gap the previous round
    // documented instead of fixing. This patch's `addPrerequisite` instructions are built from
    // `releaseIntent.prerequisites`, which nothing validates against LaunchDarkly: `sandboxTools`
    // checks only that a key LOOKS like a flag key, and `normalizePrerequisites` accepts any
    // syntactically valid one. So a manifest naming a CIRCULAR prerequisite — a parent that already
    // depends on this flag, directly or through a chain — is one LaunchDarkly MUST refuse, and it is
    // deterministic and per-manifest: as a bare throw it claimed the flag's action slot on every
    // deploy and starved the sibling that could release, permanently.
    //
    // The stated blocker was wanting a rejection LaunchDarkly really returns; a circular
    // prerequisite is one. And the property that licenses the classifier is now DOCUMENTED rather
    // than assumed for this multi-instruction patch: semantic patches are never applied partially
    // (see `heldOnContentRefusal`), so a refusal means the `turnFlagOn` and the fallthrough change
    // did not land either — nothing was written, and the sibling can still release.
    try {
      await ld.patchFlagSemantic(
        flag.flagKey,
        environmentKey,
        instructions,
        "auto-factory: release via prerequisites (releaseIntent)",
      );
    } catch (e) {
      return heldOnContentRefusal(
        e,
        flag.flagKey,
        "this manifest's prerequisites release instruction",
        `the rejected values come from the manifest's releaseIntent.prerequisites ` +
          `[${intent.prerequisites.map((p) => `${p.flagKey}=${p.variation ?? "on"}`).join(", ")}] — a ` +
          `CIRCULAR prerequisite (a parent that already depends on '${flag.flagKey}', directly or ` +
          `through a chain) and a dependency-depth limit are the ones LaunchDarkly refuses.`,
      );
    }
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
    return heldOnContentRefusal(
      e,
      flag.flagKey,
      `this manifest's ${method} release instruction`,
      `the rejected values come from the manifest's releasePlan (stages, metricKeys, ` +
        `metricGroupKeys, randomizationUnit) or the flag's release policy — a guarded stage ` +
        `allocation above 50% is the common one.`,
    );
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
