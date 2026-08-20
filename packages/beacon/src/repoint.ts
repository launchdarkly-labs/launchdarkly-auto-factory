/**
 * Prerequisite re-pointing after a variation release.
 *
 * LaunchDarkly prerequisites pin a specific parent VARIATION (by id). When a
 * multivariate parent iterates (release moves fallthrough v1 → v2), any child
 * flag prerequisite'd on v1 silently goes dark — wrong, since vN is the same
 * capability the child depends on. After a release completes, this module
 * re-points auto-factory children of the released flag to the variation the
 * environment now serves.
 *
 * Scope guards: only children tagged `auto-factory` (we never rewrite a
 * human's hand-built dependency), only the released environment, and only
 * prerequisites on THIS flag. Boolean parents never need re-pointing (their
 * "on" variation id never changes), so callers may skip them. And never
 * BACKWARDS: a child pinned to `vN` is left alone when the parent now serves
 * something earlier, or something off the lineage entirely — see the guard
 * below, which is what makes a human's rollback safe. By contract this NEVER
 * throws — like release monitoring, a re-point failure is loudly logged, not
 * fatal.
 */

import { variationLineageIndex, type LdClient } from "@auto-factory/shared";

interface ParentFlag {
  variations?: Array<{ _id: string; value: unknown }>;
  environments?: Record<
    string,
    { on?: boolean; fallthrough?: { variation?: number; rollout?: { variations?: Array<{ variation?: number; weight?: number }> } } }
  >;
}

interface ChildFlag {
  tags?: string[];
  environments?: Record<string, { prerequisites?: Array<{ key?: string; variation?: number }> }>;
}

export interface RepointOutcome {
  childKey: string;
  action: "repointed" | "skipped" | "error";
  detail: string;
}

/**
 * Re-point auto-factory children of `flagKey` in `environmentKey` to the
 * variation the parent's fallthrough now serves. Returns per-child outcomes
 * (empty when the parent is boolean, off, or has no dependents).
 */
export async function repointDependentPrerequisites(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
): Promise<RepointOutcome[]> {
  const tag = `[beacon] repoint ${flagKey}/${environmentKey}`;
  try {
    const { data: parent } = await ld.getFlag<ParentFlag>(flagKey, `?env=${encodeURIComponent(environmentKey)}`);
    const variations = parent.variations ?? [];
    if (variations.some((v) => typeof v.value === "boolean")) return []; // boolean parents can't drift
    const cfg = parent.environments?.[environmentKey];
    if (cfg?.on !== true) return []; // nothing is being served; nothing to re-point to

    const at = (idx: number | undefined) => (idx === undefined ? undefined : variations[idx]);
    const arms = [...(cfg.fallthrough?.rollout?.variations ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const serving = at(cfg.fallthrough?.variation) ?? at(arms[0]?.variation);
    if (!serving) return [];

    const deps = await ld.getDependentFlags<{ items?: Array<{ key?: string }> }>(flagKey);
    const childKeys = (deps.data.items ?? []).map((i) => i.key).filter((k): k is string => Boolean(k));
    if (childKeys.length === 0) return [];

    const outcomes: RepointOutcome[] = [];
    for (const childKey of childKeys) {
      try {
        const { data: child } = await ld.getFlag<ChildFlag>(childKey, `?env=${encodeURIComponent(environmentKey)}`);
        const prereq = (child.environments?.[environmentKey]?.prerequisites ?? []).find((p) => p?.key === flagKey);
        if (!prereq) {
          outcomes.push({ childKey, action: "skipped", detail: `no prerequisite on '${flagKey}' in '${environmentKey}'` });
          continue;
        }
        const pinned = at(prereq.variation);
        if (pinned?._id === serving._id) {
          outcomes.push({ childKey, action: "skipped", detail: `already pinned to '${String(serving.value)}'` });
          continue;
        }
        // NEVER REPOINT A CHILD BACKWARDS ALONG THE LINEAGE.
        //
        // The destination is the parent's LIVE serving variation, and "live" includes states a
        // human deliberately put the flag into. `trigger.ts` explicitly advises serving `control`
        // directly as the way to roll back ("a deliberate rollback is LaunchDarkly's job — revert
        // the release, or serve the variation directly"), and `findLatestRelease` still reports the
        // old release as `completed` afterwards, so every repoint caller's gate is satisfied.
        //
        // What that did: a child pinned to `v1` was repointed to `control`. A child pinned behind
        // an unmet prerequisite is DARK; repointing it to what the parent now serves MEETS the
        // prerequisite, so the child immediately serves its treatment to 100% of traffic with no
        // rollout and no monitoring — caused BY a rollback. That is the most destructive write in
        // this module and it had no guard.
        //
        // The comparison is deliberately asymmetric, and this is a STRICT NARROWING of a write:
        //  - `pinned` has no lineage index (`control`, a hand-named value) ⇒ ALLOW. This is the
        //    first release, control → v1, the normal forward case.
        //  - `pinned` is vN and `serving` is vM with M >= N ⇒ ALLOW (v1 → v2, the iteration case).
        //  - `pinned` is vN and `serving` is vM with M < N ⇒ REFUSE.
        //  - `pinned` is vN and `serving` has no lineage index at all ⇒ REFUSE. This is the rollback
        //    case above: we cannot tell whether leaving the lineage is forward or backward, and
        //    `trigger.ts` makes the same call for the same reason (its "NOT IN THE LINEAGE" hold).
        //
        // It does NOT need the parent's target variation, which is why it is fixable here while the
        // forward mid-rollout hazard (repointing to the arm a running release is ramping away from)
        // is not: `AutomatedRelease` carries no target variation, but `pinned` and `serving` are
        // both already in hand.
        //
        // IT MUST STAY ABOVE THE `auto-factory` TAG CHECK, and that ordering is load-bearing for the
        // MESSAGE rather than for the write — which is why nothing caught it until a test did (see
        // "an UNTAGGED child pinned to vN gets the BACKWARDS message" in triggerMultivariate.test.ts).
        // Either order skips the patch, so an untagged child pinned to `vN` under a rolled-back parent
        // is safe either way. But below the tag check it is told "not auto-factory-tagged — re-point it
        // manually if it should follow 'control'", which is ADVICE TO DO THE DESTRUCTIVE THING: a human
        // following it satisfies the prerequisite and takes a dark child live at 100% with no rollout,
        // as a consequence of a rollback. The backwards refusal has to be the answer whenever it
        // applies, because it is the one that names the consequence.
        const pinnedIndex = variationLineageIndex(pinned?.value);
        const servingIndex = variationLineageIndex(serving.value);
        if (pinnedIndex !== undefined && (servingIndex === undefined || servingIndex < pinnedIndex)) {
          outcomes.push({
            childKey,
            action: "skipped",
            detail:
              `pinned to '${String(pinned?.value)}' but '${flagKey}' now serves '${String(serving.value)}' — ` +
              `repointing would move this child BACKWARDS along the lineage, so it is refused. This is what a ` +
              `deliberate rollback looks like (a human serving an earlier variation directly); satisfying the ` +
              `prerequisite here would take the child live at 100% with no rollout. Repoint it by hand if that ` +
              `is really what is wanted.`,
          });
          continue;
        }
        if (!(child.tags ?? []).includes("auto-factory")) {
          // A human's hand-built dependency: surface the drift, never rewrite it.
          outcomes.push({
            childKey,
            action: "skipped",
            detail: `pinned to '${String(pinned?.value)}' but not auto-factory-tagged — re-point it manually if it should follow '${String(serving.value)}'`,
          });
          continue;
        }
        await ld.patchFlagSemantic(
          childKey,
          environmentKey,
          [
            { kind: "removePrerequisite", key: flagKey },
            { kind: "addPrerequisite", key: flagKey, variationId: serving._id },
          ],
          `auto-factory: re-point prerequisite ${flagKey} to released variation ${String(serving.value)}`,
        );
        outcomes.push({ childKey, action: "repointed", detail: `'${String(pinned?.value)}' → '${String(serving.value)}'` });
      } catch (e) {
        outcomes.push({ childKey, action: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const o of outcomes) console.log(`${tag}: ${o.childKey} ${o.action} (${o.detail})`);
    return outcomes;
  } catch (e) {
    console.warn(`${tag}: failed (children may be pinned to a stale variation): ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
