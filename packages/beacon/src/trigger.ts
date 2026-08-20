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

/** How one HTTP status from a Beacon patch is classified, and why. One row, one argument. */
export interface PatchFailureClass {
  /** What Beacon does with it: `held` (a human must look at this manifest) or a rethrow. */
  readonly outcome: "held" | "throws";
  /**
   * Does it recur identically for THIS manifest on every deploy?
   *
   * `"either"` EXISTS BECAUSE ONE STATUS HONESTLY COVERS BOTH, and saying so is the only accurate
   * answer: the 400 row has a deterministic cause (a body LaunchDarkly will refuse every time) and a
   * transient one (a conflict with a pending change, which clears when a human clears it), and the
   * status alone cannot separate them. That row said `"deterministic"` while its own `why` described
   * the transient cause — the field contradicting its own prose, which is exactly the drift these
   * fields exist to stop.
   *
   * FOR THE THROWING-ROW INVARIANT, `"either"` counts as NOT transient, which is the conservative
   * direction: a row that might be deterministic must still be shown to be wider than one manifest.
   */
  readonly recurs: "deterministic" | "transient" | "either";
  /**
   * How wide the refusal is. This is the property that decides whether claiming the flag's action
   * slot costs a sibling manifest a DELAY or its RELEASE: only `deterministic` + `per-manifest`
   * makes the claim permanent, and permanent is starvation.
   */
  readonly blastRadius: "per-manifest" | "per-flag-or-environment" | "unknown";
  /** Is it knowable FROM THE ERROR that LaunchDarkly wrote nothing? */
  readonly wrote: "no" | "unknown";
  /** The whole argument for this row, stated once for the whole repo. */
  readonly why: string;
  /**
   * Text `heldOnContentRefusal` MUST put in front of its own "here is what to edit" paragraph for
   * this status, and for no other.
   *
   * THE POINT OF MAKING IT A FIELD RATHER THAN A SENTENCE IN `why`: `why` is inert prose that no
   * code reads, so the 400 row's instruction "the operator-facing note must not assert the manifest
   * is wrong" was enforced by nothing. The first attempt at it appended the caveat inside
   * `whereToLook`, which is built at the call site BEFORE the status is known — so a 422, the row
   * that calls itself the canonical content rejection, was told to go looking for a pending
   * scheduled change. Attaching operator text to the ROW is what makes per-status honesty
   * mechanical.
   */
  readonly operatorCaveat?: string;
}

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * THE STATUS → OUTCOME TAXONOMY. THIS IS ITS ONE AND ONLY HOME.
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `server.ts`'s catch, `packages/beacon/README.md` and `docs/loop-seam.md` each used to restate
 * this whole argument in their own words. Eleven prose corrections on this branch each fixed THREE
 * of those four copies, and the missed copy was always the one an auditor reads first — the last
 * instance missed a wrong claim seven lines above the test being edited, in the same file, in the
 * same diff. A FIFTH copy was then found in `tests/`, already drifted. So the copies are GONE:
 * those sites point here and carry no status codes of their own, and `tests/taxonomyHome.test.ts`
 * fails if one starts restating this.
 *
 * WHAT THAT TEST DOES AND DOES NOT BUY, since this comment used to claim it makes a second copy
 * "unrepresentable": it is a text filter, so it catches a copy that reuses this argument's WORDS —
 * which is how all eleven prior corrections went wrong, because prose gets inherited rather than
 * reinvented. A deliberate paraphrase that avoids the vocabulary goes straight through; one was
 * written to prove it. Review is still the mechanism for that, and nothing here replaces it.
 *
 * THE PATCH SITES THIS COVERS — `triggerRelease`'s THREE, which was itself a drifting count ("both
 * patches"). NOT ALL OF BEACON'S PATCHES: `repoint.ts` sends a fourth (`removePrerequisite` +
 * `addPrerequisite` on a child flag), which is caught locally and reported per child rather than
 * classified here, so the `outcome` column is global across THIS function and no further. Bringing it
 * in would need an answer to what a refused repoint means for the parent's outcome, which is a
 * different question from "whose content was wrong".
 *
 * The instruction lists are written out because the 403 row below turns on which ones DIFFER, and an
 * earlier revision of that row got them wrong from memory:
 *
 *  1. the `prerequisites` release: `addPrerequisite` (one per parent) + `turnFlagOn` +
 *     `updateFallthroughVariationOrRollout`. Its parent keys come from
 *     `releaseIntent.prerequisites`, which nothing validates against LaunchDarkly, and a CIRCULAR
 *     prerequisite is a refusal LaunchDarkly must return.
 *  2. the `immediate` release: `turnFlagOn` + `updateFallthroughVariationOrRollout`. NOTHING in this
 *     body came from the manifest — the variation id is read back from LaunchDarkly — so no content
 *     refusal is reachable here, but it is classified anyway, because the refusals that ARE reachable
 *     want the same answer as at the other two sites. See that site for why the reverse decision was
 *     taken first and why it was wrong.
 *  3. the release-start patch, via `startRelease`: `turnFlagOn` + `startAutomatedRelease`, and NO
 *     fallthrough instruction (the release owns the fallthrough). Its instruction body carries
 *     `releasePlan.stages`, `metricKeys`, `metricGroupKeys` and `randomizationUnit` straight
 *     through, and neither `write_manifest` nor Beacon validates all of them.
 *
 * All three are classified, so `heldOnContentRefusal` is reached from all three.
 *
 * CLASSIFIED ON THE STATUS carried by `LdApiError`, which `LdClient.request` throws for every
 * non-2xx — never on the message text, which is LaunchDarkly's to change.
 *
 * IT IS AN ALLOWLIST, and the two mistakes that produced it went in opposite directions. First a
 * DENYLIST ("any 4xx except a short list"), which asserted "your manifest is wrong" about statuses
 * that are nothing of the kind. Then an allowlist that UNDER-claimed, and that one is the
 * instructive one because the error was in the QUESTION: it was derived by asking "what does this
 * ENDPOINT document?" when LaunchDarkly's error table is **API-WIDE**, and the row whose
 * description is specifically about a patch body was therefore missed. Excluding it restored the
 * very starvation the allowlist had been written to remove. The right question is "what does
 * LaunchDarkly document for a malformed SEMANTIC PATCH?"
 *
 * WHY A `held` MAY CLAIM NOTHING WAS WRITTEN, even for a multi-instruction patch: LaunchDarkly
 * documents that "Semantic patches are not applied partially; either all of the instructions are
 * applied or none of them are. If any instruction is invalid, the endpoint returns an error and
 * will not change the resource." Documented, not assumed — an earlier round left site 1 above
 * unclassified for want of exactly this guarantee.
 *
 * WHY THE SHAPE OF A REFUSAL MATTERS MORE THAN ITS STATUS. A throw claims the flag's
 * per-notification action slot (`server.ts`), and a claimed slot costs a sibling manifest a DELAY —
 * unless the throw is BOTH deterministic AND per-manifest, which makes the claim permanent and the
 * sibling's release lost rather than late. That is why every row below carries `recurs` and
 * `blastRadius` as well as `outcome`, and why exactly one ROW of this table is allowed to be both
 * (403 — a recorded GAP, not a solved case). Not the only such shape in Beacon: the slot claim at the
 * patch carrying no manifest content accepts another, which is recorded in `PATCH_SITES` because it
 * is a property of a patch rather than of a status.
 *
 * A STATUS ABSENT FROM THIS MAP KEEPS THROWING: every other 4xx and all 5xx. That is the point of
 * an allowlist. A status LaunchDarkly does not document here is one we have no basis to call a
 * manifest-content defect, and asserting it anyway sends an operator to edit a correct file while
 * the real cause goes unreported. The cost of the other direction is bounded at one delayed deploy.
 */
export const PATCH_FAILURE_TAXONOMY: ReadonlyMap<number, PatchFailureClass> = new Map<number, PatchFailureClass>([
  [
    400,
    {
      outcome: "held",
      // EITHER, and this field used to say `deterministic` while its own `why` named a cause that
      // clears by itself. The two causes differ on both axes — a refused body is deterministic and
      // about one manifest, a pending-change conflict is transient and about the flag — so the only
      // honest values are the ones that admit the status conflates them.
      recurs: "either",
      // UNKNOWN, and this field used to say `per-manifest` while its own `why` explained that one of
      // the two causes is a property of the FLAG. Whichever cause it is, this row is `held`, so the
      // value drives no behaviour — which is exactly why it had to be corrected: a later reader
      // trusts the field over the prose, and the prose is what contradicted it.
      blastRadius: "unknown",
      wrote: "no",
      why:
        "Invalid request body — the status LaunchDarkly documents for a body it cannot accept, and " +
        "the live instance is a guarded stage above 50% ('stage allocation must not exceed 50%'), " +
        "which is per-manifest. BUT IT IS NOT ONLY THAT, AND THIS DISCRIMINATOR CANNOT TELL THE " +
        "DIFFERENCE. The same endpoint answers 400 when a change would conflict with a PENDING " +
        "SCHEDULED CHANGE or APPROVAL REQUEST on the flag — a property of the flag, not of any one " +
        "manifest; the documented opt-out is `ignoreConflicts=true`, which Beacon never sends and " +
        "MUST NOT send, because that would override a human's scheduled change. So the blast radius " +
        "is genuinely unknown, and `held` is the best available answer for both causes: it is " +
        "non-final, so the ledger re-releases the manifest as soon as the conflict clears, and it " +
        "claims no action slot either way. What the status cannot support is an operator note " +
        "asserting the manifest is wrong — hence `operatorCaveat`, which is code rather than advice.",
      operatorCaveat:
        "CHECK LAUNCHDARKLY BEFORE EDITING ANYTHING: this status is also how LaunchDarkly answers a " +
        "change that conflicts with a PENDING SCHEDULED CHANGE or APPROVAL REQUEST on this flag, " +
        "which Beacon deliberately will not override, and the two are indistinguishable from the " +
        "status alone. If that is the cause, nothing here is wrong and clearing the pending change " +
        "is the fix. Otherwise:",
    },
  ],
  [
    422,
    {
      outcome: "held",
      recurs: "deterministic",
      // UNKNOWN, for the same reason the 400 row is — and this row was falsified by a change made one
      // row above it, in the same diff, which is this branch's signature defect arriving from a new
      // direction. It said `per-manifest`. But this status can arrive at ANY of the three patches, and
      // `PATCH_SITES.immediate.carriesManifestContent === false` says no refusal of THAT BODY can tell
      // one `immediate` manifest from another (a narrower claim than "about one manifest": a sibling
      // using a different method sends a different body). Either way a blast radius stated per STATUS
      // cannot be right when the same status reaches patches of different kinds, so `blastRadius` is
      // meaningful only for rows that THROW — where the catch has no idea which patch it came from and
      // the value is all it has. For a `held` row it is `unknown` by definition, and the test enforces
      // that rather than trusting it.
      blastRadius: "unknown",
      wrote: "no",
      why:
        'Unprocessable entity — "The API request can not be completed because the update ' +
        'description can not be understood", whose documented solution is "Ensure that the request ' +
        'body is correct for the type of patch you are using, either JSON patch or semantic patch." ' +
        "That is precisely what `patchFlagSemantic` sends, so this is THE canonical content " +
        "rejection here. It is the row an endpoint-scoped reading of the docs missed, and excluding " +
        "it starved a releasable sibling permanently.",
    },
  ],
  [
    401,
    {
      outcome: "throws",
      recurs: "deterministic",
      blastRadius: "per-flag-or-environment",
      wrote: "no",
      why:
        "Invalid access token — Beacon's credentials, not the manifest's content. Pointing an " +
        "operator at `releasePlan` when the API key is wrong sends them to the wrong file; the file " +
        "to fix is the deployment's environment. Every manifest for the flag hits it identically, " +
        "so the slot claim starves nobody.",
    },
  ],
  [
    403,
    {
      outcome: "throws",
      recurs: "deterministic",
      blastRadius: "per-manifest",
      wrote: "no",
      why:
        "Forbidden — a permissions refusal, and THE ONE RECORDED GAP IN THIS TABLE: the only row " +
        "that is both deterministic and per-manifest, which is the shape that starves a sibling " +
        "permanently. WHAT MAKES IT REACHABLE, stated from the instruction lists above rather than " +
        "from memory: patch site 1 additionally requests `updatePrerequisites` (its " +
        "`addPrerequisite` instructions), which patch site 3 never does. So a custom role that " +
        "grants the fallthrough family but NOT `updatePrerequisites` refuses a prerequisites " +
        "manifest deterministically while its release-start sibling succeeds — and " +
        "`tests/ledgerLineage.test.ts` already puts one manifest of each kind on a single flag in a " +
        "single notification, so the sibling starves. THE CONVERSE IS NOT PER-MANIFEST and must not " +
        "be claimed as such: a role missing the fallthrough action refuses sites 1 AND 2, which " +
        "every manifest for that flag hits identically. Two earlier premises for this row were " +
        "wrong, in opposite directions. First a PROOF that no per-manifest 403 existed " +
        "('LaunchDarkly has no separate role action for a guarded versus a progressive release') — " +
        "true, and about the wrong split. Then a claim that the sites choose BETWEEN " +
        "`updatePrerequisites` and `updateFallthrough`, which the instruction lists refute: site 1 " +
        "requests the fallthrough action too. Note also that this repo has NOT established which " +
        "role action governs `startAutomatedRelease`, so nothing here asserts one. And custom-role " +
        "resource specifiers are globbed and environment-scoped (`proj/*:env/*:flag/ops_*` is a " +
        "documented example), so a 403 is never 'global' either, which is what this comment " +
        "claimed before all of that. NEITHER EXISTING BUCKET FITS, which is why this is recorded " +
        "rather than fixed: `held` would blame manifest content for a permissions problem and send " +
        "a human to edit a correct file, and throwing claims the slot forever. Closing it needs an " +
        "outcome that is neither 'the manifest is wrong' nor 'we may have written' — a permissions " +
        "verdict — plus some way to tell a role-scoped refusal from a wrong API key, which the " +
        "status alone is not.",
    },
  ],
  [
    404,
    {
      outcome: "throws",
      recurs: "deterministic",
      blastRadius: "per-flag-or-environment",
      wrote: "no",
      why:
        "Invalid resource identifier. The identifiers in Beacon's request PATH are the flag and the " +
        "environment, so a notification carrying a wrong `environment` is the documented cause, and " +
        "reporting that as manifest content blamed the manifest forever. It used to say 'never the " +
        "release plan', and NEVER IS UNEARNED: the release instruction also carries `metricKeys`, " +
        "`metricGroupKeys` and `randomizationUnit`, which are LaunchDarkly resources identified by " +
        "key and reach the API unvalidated (validating them needs a project read — deliberately " +
        "deferred). If one of those ever produced a 404 it would be deterministic and per-manifest, " +
        "i.e. the 403 shape above. Classified on the documented cause, with that residual named " +
        "rather than argued away.",
    },
  ],
  [
    405,
    {
      outcome: "throws",
      recurs: "deterministic",
      blastRadius: "per-flag-or-environment",
      wrote: "no",
      why:
        "An approval requirement. LaunchDarkly's endpoint documentation states that a request in an " +
        "environment that requires approvals will fail with 405; the message wording is NOT quoted " +
        "here, because the sentence this comment used to put in quotation marks appears in no " +
        "LaunchDarkly document — the behaviour is real, the quotation was not earned. Required " +
        "approvals in production is standard enterprise configuration and production is Beacon's " +
        "target, so as a content rejection EVERY manifest for EVERY flag would be told to fix its " +
        "`releasePlan`. Scoped PER ENVIRONMENT AND NARROWER, not 'a per-environment setting' as " +
        "this used to say: LaunchDarkly can also narrow it by tag (`requiredApprovalTags`) and per " +
        "flag+environment — the same over-claim class as the corrected 'global' 403. The conclusion " +
        "survives the corrected premise, because every narrowing is still at flag granularity or " +
        "wider: two manifests for one flag hit it identically, so the slot claim starves nobody.",
    },
  ],
  [
    408,
    {
      outcome: "throws",
      recurs: "transient",
      blastRadius: "unknown",
      wrote: "unknown",
      why:
        "Request timeout, and it appears NOWHERE in LaunchDarkly's v2 spec — so it is a proxy in " +
        "front of LaunchDarkly, not LaunchDarkly. Excluded for its own reason rather than the " +
        "others': a timed-out request may have been received and PROCESSED, which makes it the one " +
        "4xx where write-certainty is as unknowable as a 5xx. It belongs in the 'we do not know' " +
        "bucket that claims the slot.",
    },
  ],
  [
    409,
    {
      outcome: "throws",
      recurs: "transient",
      blastRadius: "per-flag-or-environment",
      wrote: "no",
      why:
        'Status conflict — "the API request can not be completed because it conflicts with a ' +
        'concurrent API request", whose documented remediation is "Retry your request." A human ' +
        "editing the flag in the LaunchDarkly UI as our patch lands produces one. THIS IS THE ROW " +
        "WHERE MISCLASSIFICATION CHANGED PRODUCTION BEHAVIOUR rather than just the report, and the " +
        "reason the denylist was inverted: flag F, pr-41 wants v2 (ranked first), pr-40 wants v1. " +
        "As a throw the slot is claimed, pr-40 defers, and v2 releases next deploy. As `held` the " +
        "slot stays OPEN, so pr-40's own idempotency read sees nothing running and V1 IS ROLLED OUT " +
        "TO PRODUCTION — a spurious rollout from a transient conflict, with v2 landing on top of it " +
        "next deploy, plus an ACTION REQUIRED telling the operator to edit a correct manifest.",
    },
  ],
  [
    429,
    {
      outcome: "throws",
      recurs: "transient",
      blastRadius: "per-flag-or-environment",
      wrote: "no",
      why:
        "Rate limited. LaunchDarkly declined it, so nothing was written — but `LdClient.request` had " +
        "already spent its own backoff budget (RATE_LIMIT_RETRIES) before surfacing it, and the " +
        "cause is load, not the manifest. Reporting a spent budget as 'a human must fix this " +
        "manifest' describes a transient condition as a human problem.",
    },
  ],
]);

/**
 * Statuses that ARE a rejection of the CONTENT we sent, so `held` — a human must look at this
 * manifest — is the best available answer.
 *
 * DERIVED from `PATCH_FAILURE_TAXONOMY` rather than written twice, so the allowlist and the reasons
 * for it cannot drift apart. `tests/taxonomyHome.test.ts` pins both the derivation and the
 * membership — the lint and the table's own invariants moved into that file in round 3, and four
 * pointers went on naming `ledgerLineage.test.ts` for two rounds after they stopped being true.
 */
export const CONTENT_REJECTION_STATUSES: ReadonlySet<number> = new Set(
  [...PATCH_FAILURE_TAXONOMY].filter(([, c]) => c.outcome === "held").map(([status]) => status),
);

/**
 * Did LaunchDarkly REFUSE this patch on the CONTENT we sent (as opposed to failing to answer about
 * it, or refusing it for a reason that has nothing to do with the manifest)? Returns the status
 * when so.
 *
 * WHY THIS IS A DIFFERENT KIND OF FAILURE from everything else a patch can throw. The rule in
 * `server.ts` is that a throw claims the flag's per-notification action slot, because a patch's
 * response is awaited AFTER LaunchDarkly applied it — so a lost response is "we do not know whether
 * we wrote". An allowlisted content rejection is not a lost response: LaunchDarkly answered, and its
 * answer is that it did not apply the patch. Write-certainty is therefore knowable from the error
 * itself, and the refusal recurs for this one manifest on every deploy — which is the shape for
 * which claiming the slot would starve a releasable sibling permanently rather than delaying it.
 *
 * What each allowlisted status does and does not prove is in `PATCH_FAILURE_TAXONOMY` above, and
 * anything an operator must be told BEFORE being pointed at their own file belongs in that row's
 * `operatorCaveat` — not in a caller's `whereToLook`, which is built before the status is known.
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
 * One of the patches `triggerRelease` sends, reduced to the ONE property that decides what a refusal
 * of it does to the flag's action slot.
 *
 * WHY THIS IS A VALUE AND NOT A COMMENT. Handoff §6 said flatly: "a manifest that writes nothing must
 * not take the flag's action slot", and the repo owner has NARROWED it —
 *
 *   §6 as it stood:  a manifest that writes nothing must not take the flag's action slot.
 *   Narrowed:  …except where the refusal cannot be specific to one manifest, in which case no
 *              sibling may act either.
 *
 * A narrowing of an invariant that lives only in prose is a narrowing nobody can audit, and this
 * branch's whole history says prose drifts while values do not. So the condition the narrowing turns
 * on — "can a refusal here single out one manifest?" — is `carriesManifestContent`, and
 * `heldOnContentRefusal` DERIVES the slot claim from it. There is no way to hold-and-claim at a site
 * whose body carries manifest content, and no way to forget the claim at the site whose body does
 * not. `tests/taxonomyHome.test.ts` pins the split exactly: ONE site carries no manifest content and
 * TWO do. ("One in each state" was the earlier wording and is arithmetically wrong for three sites
 * and two states — it also read as though the exception were half the surface rather than a third.)
 */
export interface PatchSite {
  readonly id: "prerequisites" | "immediate" | "release-start";
  /**
   * Does ANY part of this patch's instruction body come from the manifest?
   *
   * `true` for the prerequisites patch (parent keys from `releaseIntent.prerequisites`) and the
   * release-start patch (`stages`, `metricKeys`, `metricGroupKeys`, `randomizationUnit`). A refusal
   * of either CAN be a refusal of this one manifest, so `held` must leave the slot free or a
   * releasable sibling loses its release on every deploy — the defect §6 was written for.
   *
   * `false` for the `immediate` patch: `turnFlagOn` is a constant and the variation id was read back
   * from LaunchDarkly itself. No refusal of THAT BODY can tell one `immediate` manifest from another —
   * which is a narrower licence than it first appears, and the difference matters. It does NOT say
   * every sibling would be refused identically: a sibling using the default staged method sends
   * `turnFlagOn` + `startAutomatedRelease` and no fallthrough instruction at all, so a refusal aimed at
   * a direct fallthrough change does not touch it. See `PATCH_SITES.immediate` for what that costs and
   * for the residual the owner accepted.
   */
  readonly carriesManifestContent: boolean;
}

/**
 * The three sites, and the owner's decision recorded where the mechanism reads it.
 *
 * THE REPRODUCTION THAT DECIDED IT, at `immediate`: flag `checkout-flow`/production, `pr-50` targets
 * v2 with `releaseMethod: "immediate"`, `pr-51` targets v1. `targetRank` runs pr-50 first; its patch
 * is refused, and if `held` frees the slot then pr-51's own idempotency read sees nothing running and
 * v1 — the OLDER variation — is rolled out to production while the newer manifest is merely held.
 * That is the direction `server.ts` calls unrecoverable: no later deploy undoes a rollout backwards.
 *
 * WHAT THE SLOT CLAIM COSTS — A KNOWN GAP, RECORDED RATHER THAN CLOSED, by owner decision, on the
 * precedent of the 403 gap in `PATCH_FAILURE_TAXONOMY`. The owner's words:
 *
 *   "a sibling targeting the same or a later variation by a different method would have succeeded,
 *    and defers while the refusal stands"
 *
 * Reachable, and pinned by a test as a gap: pr-50 wants v2 by `immediate` and is refused; pr-51 wants
 * THE SAME v2 by the default staged method. Equal `targetRank`, stable order, pr-50 first every time —
 * so pr-51 defers on every deploy for as long as the refusal stands, and its own patch was never
 * refused. That is §6 starvation with nothing gained, and it is accepted because the alternative on the
 * table was a rollout backwards, which is not recoverable at all.
 *
 * TWO CLAIMS THAT USED TO BE HERE AND WERE FALSE, both about other patches' bodies rather than this
 * one's: "every sibling would be refused identically" (a staged sibling sends no fallthrough
 * instruction, so a refusal of a direct fallthrough change need not reach it) and "no reachable loss on
 * the sibling's side" (the paragraph above is that loss). The narrowing survives them; the reasoning
 * for it is the asymmetry of RECOVERABILITY — a deferred sibling releases when a human fixes the flag,
 * a rollout backwards is undone by nothing — not the absence of a loss.
 *
 * So: `held` (non-final, re-checked next deploy, operator told where to look) AND the slot claimed.
 */
export const PATCH_SITES: Readonly<Record<"prerequisites" | "immediate" | "releaseStart", PatchSite>> = {
  prerequisites: { id: "prerequisites", carriesManifestContent: true },
  immediate: { id: "immediate", carriesManifestContent: false },
  releaseStart: { id: "release-start", carriesManifestContent: true },
};

/**
 * The `held` result for a patch LaunchDarkly refused with an allowlisted status — or a RETHROW when
 * the error is anything else (transient, or a write we cannot rule out; see the catch in
 * `server.ts`).
 *
 * ONE builder for ALL THREE patch sites in this file (the inventory is in
 * `PATCH_FAILURE_TAXONOMY`), because the load-bearing claim is identical and must not drift:
 * NOTHING WAS WRITTEN. It holds for a MULTI-instruction patch as much as for a single-instruction one
 * because LaunchDarkly documents that "Semantic patches are not applied partially; either all of the
 * instructions are applied or none of them are. If any instruction is invalid, the endpoint returns
 * an error and will not change the resource." A previous round left the `prerequisites` patch
 * unclassified for want of exactly that guarantee, and treated it as an assumption rather than a
 * documented property.
 *
 * WHAT DOES NOT FOLLOW FROM IT, and this is the round-4 correction: "nothing was written" does not by
 * itself mean a sibling may act. That inference is sound only where the refusal could have been about
 * this one manifest. Where it could not, the slot is claimed — see `PatchSite`.
 *
 * ORDER OF THE OPERATOR TEXT IS LOAD-BEARING, not cosmetic. The row's `operatorCaveat` comes FIRST
 * and `whereToLook` second, because `whereToLook` names the caller's own fields — which reads as an
 * accusation, and for one of the allowlisted statuses that accusation may be baseless. Leading with
 * "the values you sent are X" and hedging afterwards is the same over-claim as before, just later in
 * the sentence.
 */
function heldOnContentRefusal(
  e: unknown,
  flagKey: string,
  /** Which patch was refused. Decides the slot, so it is not a label. */
  site: PatchSite,
  /** What LaunchDarkly refused, named as an operator would recognise it. */
  refused: string,
  /** Where the refused values came from, so the operator knows which field to edit. */
  whereToLook: string,
): TriggerResult {
  const status = contentRefusalStatus(e);
  if (status === undefined) throw e;
  const caveat = PATCH_FAILURE_TAXONOMY.get(status)?.operatorCaveat;
  // DERIVED, never passed in. See `PatchSite` for the narrowing this implements and whose it is.
  const claim = site.carriesManifestContent
    ? undefined
    : `no part of the '${site.id}' patch came from any manifest, so this refusal cannot tell one ` +
      `'${site.id}' manifest from another. A sibling asking for a DIFFERENT method sends a different ` +
      `body and might well succeed — which is exactly why the slot is claimed: it would be releasing a ` +
      `different variation of '${flagKey}' behind a refusal we cannot explain, and a rollout backwards ` +
      `is not undone by any later deploy. By owner decision this NARROWS handoff §6 ("a manifest that ` +
      `writes nothing must not take the flag's action slot"). KNOWN RESIDUAL: a sibling targeting the ` +
      `same or a later variation by a different method would have succeeded, and defers while the ` +
      `refusal stands.`;
  return {
    flagKey,
    method: "held",
    ...(claim ? { claimsSlotWithoutWriting: claim } : {}),
    note:
      `LaunchDarkly REJECTED ${refused} (HTTP ${status}): "${ldMessage((e as LdApiError).responseBody)}". ` +
      `Semantic patches are never applied partially, so the patch did NOT apply: nothing was written. ` +
      (claim
        ? `No other manifest for '${flagKey}' will act on it in this notification either, because ${claim} `
        : `A sibling manifest for '${flagKey}' can therefore still release in this same notification. `) +
      `HELD for a human: ${caveat ? `${caveat} ` : ""}${whereToLook} Once that is resolved, deploy ` +
      `again; this is re-checked on any later deploy.`,
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
   *    `contentRefusalStatus`). Every one of these is a human's decision, and NONE of them writes.
   *    Most therefore leave the flag's action slot free for a sibling — but "wrote nothing" is no
   *    longer sufficient for that on its own; see `claimsSlotWithoutWriting`.
   *  - "prerequisites" — flag turned on behind LD prerequisites; it releases when its parents do.
   *  - "noop" — FINAL: there is nothing left for this manifest to release. Either the target is
   *    already what the environment serves (a re-deploy after the release completed), or a NEWER
   *    variation of the same lineage superseded it.
   */
  method: ReleaseKind | "held" | "prerequisites" | "noop";
  note?: string;
  /**
   * Set when this outcome WROTE NOTHING and must nevertheless take the flag's per-notification action
   * slot, so no sibling manifest acts on that flag. The string is the REASON, and `server.ts` logs
   * it — a silent slot claim would be indistinguishable from a bug in `performedAWrite`.
   *
   * This is the narrowing of handoff §6 quoted in `PatchSite`, expressed as a value so that the one
   * exception is visible in the outcome an operator reads and in the mechanism that acts on it, not
   * only in a comment. It is DERIVED from the patch site, never chosen by a caller.
   *
   * Absent on every other `held` and on `noop`: their refusals can be about one manifest, so freeing
   * the slot is what stops a releasable sibling losing its release on every deploy.
   */
  claimsSlotWithoutWriting?: string;
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
    // ABSENT means "the tip", and the tip is derived from THIS FLAG's own variations. An EMPTY
    // string is NOT absent (`??` catches only null/undefined): it is a target this one manifest
    // names and the flag does not have, which is the held case just below.
    //
    // HELD, NOT THROWN — and the argument for throwing was wrong. It read: "a flag with no vN
    // lineage at all defeats every manifest for it identically, so this is a PER-FLAG error". That
    // is false. This branch is reached only when the manifest names NO target; a sibling naming an
    // EXPLICIT variation the flag does have resolves normally and would release (with `control`
    // served, both backwards guards fall through). And `targetRank` ranks an absent target as the
    // TIP — highest — so the tipless manifest is evaluated FIRST on every deploy, throws
    // deterministically, and claims the flag's slot before the sibling that could act.
    //
    // Deterministic, pre-write and per-manifest is exactly the shape `PATCH_FAILURE_TAXONOMY` says
    // must never claim the slot, and it is the permanent-starvation shape §6 forbids. So it gets
    // the same answer as its structural twin eleven lines below: only a human can say what was
    // meant, `held` is not final, and nothing was written.
    const targetValue = flag.targetVariation ?? latestVariationValue(variations.map((v) => v.value));
    if (targetValue === undefined) {
      return {
        flagKey: flag.flagKey,
        method: "held",
        note:
          `this manifest names no targetVariation, and '${flag.flagKey}' has no vN lineage variation to ` +
          `release (has: ${variations.map((v) => String(v.value)).join(", ")}) — HELD for a human: either ` +
          `add the variation to the flag or name an existing one in the manifest. NOTHING WAS WRITTEN, so ` +
          `a sibling manifest for this flag can still release in this same notification.`,
      };
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
        PATCH_SITES.prerequisites,
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

  // PATCH SITE 2 OF THREE (see PATCH_FAILURE_TAXONOMY) — the site that had no try/catch at all, and
  // the decision here was REVERSED after review. Both halves are recorded, because the reasoning is
  // the interesting part and the first answer was defensible-sounding.
  //
  // WHAT IS TRUE AND UNCHANGED: nothing this patch sends came from the manifest. `turnFlagOn` is a
  // constant and `targetVar._id` is a variation id read back from LaunchDarkly itself, so the
  // unvalidated-manifest-content path the classifier was built for is UNREACHABLE here. A content
  // refusal of this body would be LaunchDarkly refusing its own identifiers.
  //
  // THE ARGUMENT FOR LEAVING IT UNCLASSIFIED, and why it was wrong: "classifying it would produce a
  // report that is certainly wrong, because `heldOnContentRefusal` sends a human to edit values this
  // patch does not carry." That conflates the CLASSIFICATION with one string — `whereToLook` is a
  // parameter, so the note can say what is true of this site. And leaving it unclassified had a cost
  // that was never stated: the SAME LaunchDarkly response produces `held`, LaunchDarkly's own message
  // and a free action slot at sites 1 and 3, but `error — release trigger failed; re-POST to retry`
  // plus a slot claim on every deploy here. An operator comparing two flags would see the identical
  // refusal reported two different ways, and the taxonomy's `outcome` column — presented as global —
  // would have been true at two sites out of three.
  //
  // AND THE FIRST FIX OF THAT WENT TOO FAR, which is the round-4 correction and the reason this site
  // is now the only place in Beacon where a non-writing outcome takes the flag's slot. Classifying it
  // gave it `held`, and `held` freed the slot — so the reproduction in `PATCH_SITES` became live: the
  // refused `immediate` manifest holds, its sibling's idempotency read sees nothing running, and an
  // OLDER variation rolls out to production. "Nothing was written" was true and the inference drawn
  // from it was not. §6's protection is still WANTED here — the loss it guards against is reachable,
  // and `PATCH_SITES` records it as an accepted gap — but the rollout a free slot permits is
  // unrecoverable while a deferred sibling is not, so the owner narrowed §6 for exactly this case on
  // that asymmetry. The narrowing lives in `PatchSite.carriesManifestContent`, which
  // `heldOnContentRefusal` reads — not in this comment, so that it cannot be lost by editing prose.
  if (method === "immediate") {
    try {
      await ld.patchFlagSemantic(
        flag.flagKey,
        environmentKey,
        [
          ...(flagIsOn ? [] : [{ kind: "turnFlagOn" }]),
          { kind: "updateFallthroughVariationOrRollout", variationId: targetVar._id },
        ],
        "auto-factory: immediate release",
      );
    } catch (e) {
      return heldOnContentRefusal(
        e,
        flag.flagKey,
        PATCH_SITES.immediate,
        "this manifest's immediate release instruction",
        `none of the VALUES in that instruction came from the manifest — it turns '${flag.flagKey}' on ` +
          `in '${environmentKey}' and points its fallthrough at a variation id LaunchDarkly itself ` +
          `reported — so look at the FLAG and the ENVIRONMENT first. ` +
          // WHO ASKED FOR THIS SHAPE OF PATCH IS NOT ALWAYS THIS FILE, and a previous version of this
          // note asserted that it was. `method` resolves as `ov.releaseMethod ?? policy.releaseMethod
          // ?? inferred`, and `normalizeMethod` maps any policy value containing "immediate" to
          // `immediate` — so a manifest with no `releasePlan` at all reaches this patch on the
          // strength of the FLAG's release policy, and telling that author to drop a field they never
          // wrote sends them looking for something that does not exist. `ov` is
          // `releasePlan ?? releaseOverrides`, so the legacy key is covered by reading `ov` rather
          // than naming `releasePlan`.
          (ov.releaseMethod === "immediate"
            ? `One field of this file did choose this instruction, though: releaseMethod "immediate" ` +
              `asks for a direct fallthrough change instead of a staged release. If LaunchDarkly is ` +
              `refusing that shape of change specifically, dropping it so the release goes out as a ` +
              `staged rollout is a fix this file's author controls.`
            : `Note this manifest did NOT ask for an immediate release: the FLAG'S RELEASE POLICY in ` +
              `LaunchDarkly selected that shape (a manifest releaseMethod would have overridden it, ` +
              `and there is none here). So the shape is not this file's to change — the policy is ` +
              `where to change it.`),
      );
    }
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

  // PATCH SITE 3 OF THREE (see PATCH_FAILURE_TAXONOMY), AND THE INSTRUCTION BODY IS BUILT FROM
  // MANIFEST CONTENT THAT NOTHING HAS VALIDATED AGAINST LAUNCHDARKLY: `stages`, `metricKeys`,
  // `metricGroupKeys`, `randomizationUnit`. So a REJECTION is reachable, deterministic and
  // per-manifest — and it must not be reported as a transport error.
  //
  // The live instance: guarded stages are capped at 50% (see DEFAULT_GUARDED_STAGES), so a manifest
  // with a 100% guarded stage is a permanent content rejection ("stage allocation must not exceed
  // 50%"). As a throw that claimed the flag's action slot on EVERY deploy, and since `targetRank`
  // evaluates the higher target first, the rejected manifest went first and the releasable sibling
  // was told "another manifest released this flag" — which had not happened. Zero releases, forever.
  //
  // `held`, for the same reasons as the other per-manifest refusals in this file: nothing was
  // written (so the sibling can still release in this same notification), only a human can say what
  // the manifest should have said, and `held` is not final so the ledger re-checks it once they fix
  // it.
  //
  // WHAT THIS DOES AND DOES NOT CLOSE, stated precisely because the previous wording said "the whole
  // CLASS" and that was two over-claims in one. It closes the class of CONTENT REFUSALS OF THIS
  // PATCH — a bad stage set, a missing metric, a bad randomization unit, anything else LaunchDarkly
  // refuses on this body — for the statuses in the allowlist. It does NOT close: an allowlisted
  // status that was not about content at all (the 400 row: a pending scheduled change), or a refusal
  // outside the allowlist.
  //
  // ALL THREE SITES ARE CLASSIFIED. This list used to end "or patch site 2, which is unclassified on
  // purpose" — a claim about code that had been changed seventy lines above it, in the same diff, which
  // is this branch's signature defect and the reason the taxonomy stopped being prose. Site 2 IS
  // classified; its refusals are NEVER this manifest's content, because nothing in that body comes
  // from the manifest; and it is the ONE site where `held` also claims the flag's action slot, by the
  // owner's narrowing of §6 recorded in `PatchSite`. `write_manifest` also
  // checks the stage shape at authoring time, but that is defence in depth, not the guarantee —
  // `.release-flags/` is hand-editable in git and the other three fields are still unchecked.
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
      PATCH_SITES.releaseStart,
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
