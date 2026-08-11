import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { LdResourceWriter, SandboxToolExecutor, type LdClient } from "@auto-factory/shared";

interface Patch {
  flagKey: string;
  env: string;
  instructions: Array<Record<string, unknown>>;
}

function fakeLd(opts: {
  parentExists?: boolean;
  childEnvs?: Record<string, { on?: boolean; prerequisites?: Array<{ key: string }> }>;
} = {}) {
  const patches: Patch[] = [];
  const childEnvs = opts.childEnvs ?? { production: {}, test: {} };
  const ld = {
    projectKey: "app-proj",
    getFlag: async (flagKey: string) => {
      if (flagKey === "parent-flag") {
        if (opts.parentExists === false) throw new Error("404");
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "pv-true", value: true },
              { _id: "pv-false", value: false },
            ],
          },
        };
      }
      return {
        status: 200,
        ok: true,
        data: {
          variations: [
            { _id: "cv-true", value: true },
            { _id: "cv-false", value: false },
          ],
          environments: childEnvs,
        },
      };
    },
    patchFlagSemantic: async (flagKey: string, env: string, instructions: Array<Record<string, unknown>>) => {
      patches.push({ flagKey, env, instructions });
      return { status: 200, ok: true, data: {} };
    },
  } as unknown as LdClient;
  return { ld, patches };
}

describe("addPrerequisite: on-behind-parent wiring", () => {
  it("attaches the prerequisite AND turns the child on serving treatment, per environment", async () => {
    const { ld, patches } = fakeLd();
    const note = await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    assert.equal(patches.length, 2);
    for (const p of patches) {
      assert.deepEqual(
        p.instructions.map((i) => i.kind),
        ["addPrerequisite", "turnFlagOn", "updateFallthroughVariationOrRollout"],
      );
      assert.equal(p.instructions[0]?.key, "parent-flag");
      assert.equal(p.instructions[0]?.variationId, "pv-true");
      assert.equal(p.instructions[2]?.variationId, "cv-true");
    }
    assert.match(note, /ON serving treatment behind 'parent-flag'=on/);
  });

  it("variation 'off' resolves the parent's false variation", async () => {
    const { ld, patches } = fakeLd();
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "off");
    assert.equal(patches[0]?.instructions[0]?.variationId, "pv-false");
  });

  it("is idempotent: fully-wired environments are skipped; partial ones are completed", async () => {
    const { ld, patches } = fakeLd({
      childEnvs: {
        production: { on: true, prerequisites: [{ key: "parent-flag" }] }, // fully wired
        test: { on: false, prerequisites: [{ key: "parent-flag" }] }, // prereq only
      },
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag");
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.env, "test");
    assert.deepEqual(
      patches[0]?.instructions.map((i) => i.kind),
      ["turnFlagOn", "updateFallthroughVariationOrRollout"],
    );
  });

  it("throws a clean message when the parent flag is missing from the app project", async () => {
    const { ld } = fakeLd({ parentExists: false });
    await assert.rejects(
      () => new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag"),
      /parent flag 'parent-flag' not found in project 'app-proj'/,
    );
  });

  it("a MET prerequisite (parent already released) attaches WITHOUT arming — the child stays dark", async () => {
    // Iterating on a released feature: arming would put the child live the
    // moment its code deploys, re-coupling deploy with release.
    const patches: Patch[] = [];
    const ld = {
      projectKey: "app-proj",
      getFlag: async (flagKey: string) => {
        if (flagKey === "parent-flag") {
          return {
            status: 200,
            ok: true,
            data: {
              variations: [
                { _id: "pv-true", value: true },
                { _id: "pv-false", value: false },
              ],
              environments: {
                production: { on: true, fallthrough: { variation: 0 }, offVariation: 1 }, // serving true
                test: { on: false, offVariation: 1 }, // dark here
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "cv-true", value: true },
              { _id: "cv-false", value: false },
            ],
            environments: { production: {}, test: {} },
          },
        };
      },
      patchFlagSemantic: async (flagKey: string, env: string, instructions: Array<Record<string, unknown>>) => {
        patches.push({ flagKey, env, instructions });
        return { status: 200, ok: true, data: {} };
      },
    } as unknown as LdClient;

    const note = await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    const byEnv = Object.fromEntries(patches.map((p) => [p.env, p.instructions.map((i) => i.kind)]));
    // production: prereq met → attach only, NO turnFlagOn.
    assert.deepEqual(byEnv.production, ["addPrerequisite"]);
    // test: parent dark → unmet → full on-behind-parent arming.
    assert.deepEqual(byEnv.test, ["addPrerequisite", "turnFlagOn", "updateFallthroughVariationOrRollout"]);
    assert.match(note, /stays DARK/);
    assert.match(note, /armed in test/);
  });
});

describe("addPrerequisite: multivariate parents and children", () => {
  /** Multivariate parent (control/v1/v2) + multivariate child (control/v1). */
  function fakeMultivariateLd(parentEnvs: Record<string, unknown>) {
    const patches: Patch[] = [];
    const ld = {
      projectKey: "app-proj",
      getFlag: async (flagKey: string) => {
        if (flagKey === "parent-flag") {
          return {
            status: 200,
            ok: true,
            data: {
              variations: [
                { _id: "pv-control", value: "control" },
                { _id: "pv-v1", value: "v1" },
                { _id: "pv-v2", value: "v2" },
              ],
              defaults: { onVariation: 1, offVariation: 0 },
              environments: parentEnvs,
            },
          };
        }
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "cv-control", value: "control" },
              { _id: "cv-v1", value: "v1" },
            ],
            environments: { production: {}, test: {} },
          },
        };
      },
      patchFlagSemantic: async (flagKey: string, env: string, instructions: Array<Record<string, unknown>>) => {
        patches.push({ flagKey, env, instructions });
        return { status: 200, ok: true, data: {} };
      },
    } as unknown as LdClient;
    return { ld, patches };
  }

  it("'on' pins what each environment's fallthrough serves (per-env resolution)", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { variation: 1 } }, // serves v1
      test: { fallthrough: { variation: 2 } }, // serves v2
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    const byEnv = Object.fromEntries(patches.map((p) => [p.env, p.instructions[0]]));
    assert.equal(byEnv.production?.variationId, "pv-v1");
    assert.equal(byEnv.test?.variationId, "pv-v2");
    // Child fallthrough points at its multivariate treatment (lineage tip v1).
    assert.equal(patches[0]?.instructions[2]?.variationId, "cv-v1");
  });

  it("an explicit parent variation value ('v2') pins exactly that in every env", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { variation: 1 } },
      test: { fallthrough: { variation: 1 } },
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "v2");
    for (const p of patches) assert.equal(p.instructions[0]?.variationId, "pv-v2");
  });

  it("'on' falls back to the heaviest rollout arm, then the default on-variation", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { rollout: { variations: [{ variation: 1, weight: 30000 }, { variation: 2, weight: 70000 }] } } },
      test: {}, // no fallthrough at all → defaults.onVariation (v1)
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    const byEnv = Object.fromEntries(patches.map((p) => [p.env, p.instructions[0]]));
    assert.equal(byEnv.production?.variationId, "pv-v2");
    assert.equal(byEnv.test?.variationId, "pv-v1");
  });

  it("an explicit childVariation selects which child variation goes live behind the parent", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { variation: 1 } },
      test: { fallthrough: { variation: 1 } },
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on", "control");
    for (const p of patches) assert.equal(p.instructions[2]?.variationId, "cv-control");
  });

  it("throws when a multivariate parent lacks the requested explicit variation", async () => {
    const { ld } = fakeMultivariateLd({ production: { fallthrough: { variation: 1 } } });
    await assert.rejects(
      () => new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "v9"),
      /could not be applied/,
    );
  });
});

describe("write_manifest: releasePlan.prerequisites is a machine field", () => {
  const root = mkdtempSync(join(tmpdir(), "af-manifest-prereq-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const executor = () =>
    new SandboxToolExecutor(root, undefined, false, undefined, undefined, "workingTree", true);

  it("accepts real flag keys with on/off variations", async () => {
    const r = await executor().execute("write_manifest", {
      path: ".release-flags/pr-1.json",
      manifest: {
        flagKey: "child-flag",
        releasePlan: { prerequisites: [{ flagKey: "enable-payment-intents", variation: "on" }] },
      },
    });
    assert.notEqual(r.isError, true, r.content);
  });

  it("rejects prose stuffed into flagKey (live failure mode, PR #11)", async () => {
    const r = await executor().execute("write_manifest", {
      path: ".release-flags/pr-2.json",
      manifest: {
        releasePlan: {
          prerequisites: [
            { flagKey: "ADVISORY: togglemart-payments intents-api gate (key unknown)", variation: "on" },
          ],
        },
      },
    });
    assert.equal(r.isError, true);
    assert.match(r.content, /machine field/);
  });

  it("rejects invalid variations and non-object entries", async () => {
    const bad = await executor().execute("write_manifest", {
      path: ".release-flags/pr-3.json",
      manifest: { releasePlan: { prerequisites: [{ flagKey: "ok-key", variation: "maybe" }] } },
    });
    assert.equal(bad.isError, true);
    const alsoBad = await executor().execute("write_manifest", {
      path: ".release-flags/pr-4.json",
      manifest: { releasePlan: { prerequisites: ["enable-x"] } },
    });
    assert.equal(alsoBad.isError, true);
  });
});

// ---------------------------------------------------------------------------
// releasePlan.stages reaches LaunchDarkly UNVALIDATED: `trigger.ts` passes it straight into the
// startAutomatedRelease instruction. LaunchDarkly caps a GUARDED stage at 50% (the metric
// comparison needs a control group at least as large as the treatment — `trigger.ts` quotes the
// live rejection, "stage allocation must not exceed 50%"), so a 100% guarded stage is a permanent
// 400 on that one manifest.
//
// Beacon now RECOVERS from that: the rejection is reported `held` and the flag's action slot is
// left free (see `PATCH_FAILURE_TAXONOMY` in `packages/beacon/src/trigger.ts` for which rejections
// qualify and why). This is the other end — authoring-time defence in depth, so the agent path
// cannot commit the manifest that needs recovering. Both ends exist because `.release-flags/` is
// hand-editable in git.
// ---------------------------------------------------------------------------
describe("write_manifest: releasePlan.stages is the rollout LaunchDarkly will be asked for", () => {
  const root = mkdtempSync(join(tmpdir(), "af-manifest-stages-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const executor = () =>
    new SandboxToolExecutor(root, undefined, false, undefined, undefined, "workingTree", true);
  let n = 0;
  const write = (releasePlan: Record<string, unknown>) =>
    executor().execute("write_manifest", {
      path: `.release-flags/pr-s${++n}.json`,
      manifest: { flagKey: "enable-x", releasePlan },
    });

  it("accepts the guarded default shape (20% → 50%, ascending, within the cap)", async () => {
    const r = await write({
      releaseMethod: "guarded",
      metricKeys: ["latency"],
      stages: [
        { allocation: 20000, durationMillis: 300000 },
        { allocation: 50000, durationMillis: 300000 },
      ],
    });
    assert.notEqual(r.isError, true, r.content);
  });

  it("rejects a 100% GUARDED stage — the permanent rejection that cost a sibling its release", async () => {
    // PREVENTS writing the manifest LaunchDarkly refuses forever. The message has to state the unit,
    // because 50 / 5000 / 50000 are all plausible-looking guesses for "50%".
    const r = await write({
      releaseMethod: "guarded",
      stages: [{ allocation: 20000, durationMillis: 300000 }, { allocation: 100000, durationMillis: 300000 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content, /guarded cap of 50000/);
    assert.match(r.content, /BASIS POINTS/, "the unit is the thing an author gets wrong");
    assert.match(r.content, /progressive/, "and the escape is named, since the flag's policy may override the method");
  });

  it("names what the progressive escape COSTS, so it is not a silently dead metric set", async () => {
    // PREVENTS trading a rejection for a worse manifest. The message names
    // `releaseMethod: "progressive"` as the escape, and taking it has two consequences an author
    // cannot see from here: an explicit `releaseMethod` outranks the flag's LaunchDarkly release
    // policy PERMANENTLY for this manifest (`ov.releaseMethod ?? policy?.releaseMethod ?? …`), and
    // `trigger.ts` sends `metrics` only when the method is guarded — so the manifest's `metricKeys`
    // become DEAD and the rollout is guarded by nothing.
    //
    // Without this the nudge swapped a loud false rejection for a silent loss of the metric set,
    // which is the worse of the two: nobody finds out.
    const r = await write({
      releaseMethod: "guarded",
      metricKeys: ["checkout-latency"],
      stages: [{ allocation: 100000, durationMillis: 300000 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content, /metricKeys\/metricGroupKeys become DEAD/, "THE DISCRIMINATOR: the cost is stated");
    assert.match(r.content, /outranks the flag's release policy/, "and that the pin is permanent, not per-deploy");
    assert.match(r.content, /guarded by\s+nothing/, "and what that leaves the rollout with");
  });

  it("infers GUARDED from metrics when no releaseMethod is set — as trigger.ts does", async () => {
    // PREVENTS a gap between the check and the code it protects: `trigger.ts` resolves the method as
    // `releaseMethod ?? policy ?? (hasMetrics ? "guarded" : "progressive")`, so metrics with no
    // explicit method mean guarded, and a 100% stage is still a 400.
    //
    // AND IT SAYS SO: this is the inference, not the manifest's own word, so the flag's release
    // policy can overturn it at deploy time (only an EXPLICIT releaseMethod beats the policy). A
    // flag whose policy is a progressive release would have accepted these stages, so the rejection
    // can be FALSE — acceptable as a loud error naming an escape, dishonest if unstated.
    const r = await write({ metricKeys: ["checkout-latency"], stages: [{ allocation: 100000, durationMillis: 300000 }] });
    assert.equal(r.isError, true);
    assert.match(r.content, /guarded cap/);
    assert.match(r.content, /metricKeys with no explicit releaseMethod/, "it says WHY it thinks this is guarded");
    assert.match(r.content, /FALSE rejection/, "THE DISCRIMINATOR: the inference admits it can be overruled");
    assert.match(r.content, /policy beats the metrics inference/, "and names what overrules it");
  });

  it("does NOT claim a false rejection when the manifest itself said guarded", async () => {
    // The control arm for the warning above. An explicit `releaseMethod: "guarded"` BEATS the flag's
    // policy, so nothing can overturn it and the cap is the last word — printing "this may be a
    // false rejection" there would be wrong, and would teach an author to ignore a real refusal.
    const r = await write({
      releaseMethod: "guarded",
      stages: [{ allocation: 100000, durationMillis: 300000 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content, /releaseMethod: "guarded"/, "it attributes the method to the manifest");
    assert.doesNotMatch(r.content, /FALSE rejection/, "THE DISCRIMINATOR: no false-rejection hedge on a certain one");
  });

  it("does not promise the policy takes over when the manifest PINNED the method", async () => {
    // PREVENTS AN ESCAPE HATCH THAT IS NOT ONE. The message's last line used to be "Omit stages
    // entirely to use the flag's configured release policy" — unconditionally. `trigger.ts` resolves
    // the two from DIFFERENT chains: `stages = ov.stages ?? policy.stages ?? defaults`, but
    // `method = ov.releaseMethod ?? policy.releaseMethod ?? inferred`. So with `releaseMethod`
    // pinned, dropping `stages` inherits the policy's stages and NOT its method — the pin still
    // outranks it, the release is still guarded, and the cap the author just hit still applies to
    // whatever they inherited. An author following that advice would come back with the same
    // rejection and no idea why.
    const pinned = await write({
      releaseMethod: "guarded",
      stages: [{ allocation: 100000, durationMillis: 300000 }],
    });
    assert.equal(pinned.isError, true);
    assert.match(pinned.content, /but NOT its\s+method/, "THE DISCRIMINATOR: omitting stages does not shed the method");
    assert.match(pinned.content, /outranks the policy permanently/, "and the pin is permanent");
    assert.doesNotMatch(
      pinned.content,
      /Omit stages entirely to use the flag's configured release policy/,
      "the unconditional promise is gone",
    );

    // The control arm: with no explicit method, omitting stages really does hand both over.
    const inferred = await write({
      metricKeys: ["checkout-latency"],
      stages: [{ allocation: 100000, durationMillis: 300000 }],
    });
    assert.equal(inferred.isError, true);
    assert.match(inferred.content, /Omit stages entirely to fall back to the flag's configured release policy/);
    // AND IT HEDGES, because "with no explicit releaseMethod this manifest inherits the policy's
    // METHOD as well as its stages" — which this assertion used to pin — is false in two traceable
    // combinations: a policy that sets no `releaseMethod` leaves `trigger.ts` INFERRING one from
    // metrics, and an unreadable policy leaves `policy` null so nothing is inherited at all. Pinning
    // the confident version made the suite defend the over-claim.
    assert.match(inferred.content, /ONLY if the policy sets one/, "THE DISCRIMINATOR: the promise is conditional");
    assert.match(inferred.content, /INFERRED from whether this manifest\s+carries metrics/, "and the fallback is named");
  });

  it("tells an IMMEDIATE manifest its stages are ignored, not inherited", async () => {
    // PREVENTS ADVICE ABOUT A MECHANISM THIS MANIFEST NEVER REACHES, and this branch shipped unpinned:
    // a grep for `IGNORES stages` across tests/ found nothing, while the branch is plainly reachable —
    // `stageSetProblem` rejects a non-guarded stage set too (descending allocations, bad durations).
    //
    // `trigger.ts` returns from its immediate branch BEFORE `stages` is resolved, so for this manifest
    // the stages are not capped, not defaulted and not inherited from the flag's policy: they are read
    // by nothing. Telling this author about inheritance would describe a path their release does not
    // take.
    const r = await write({
      releaseMethod: "immediate",
      stages: [{ allocation: 100000, durationMillis: 300000 }, { allocation: 50000, durationMillis: 300000 }],
    });
    assert.equal(r.isError, true, r.content);
    assert.match(r.content, /IGNORES stages entirely/, "THE DISCRIMINATOR: ignored, not inherited");
    assert.match(r.content, /never reads a stage set/, "and why");
    assert.doesNotMatch(r.content, /inherits the policy/, "so no inheritance is promised");
    assert.doesNotMatch(r.content, /guarded cap/, "and no cap is claimed for a method that has none");
  });

  it("does not quote back a releaseMethod it does not recognise", async () => {
    // PREVENTS PRESENTING GARBAGE AS A DECISION. `write_manifest` does not validate `releaseMethod`
    // (noted for the owner, deliberately not changed here), so an unrecognised value reaches this
    // message — and interpolating it as `releaseMethod "<whatever>"` reads as though Beacon accepted it
    // and will act on it. This branch was also unpinned: nothing in tests/ matched it.
    const r = await write({
      releaseMethod: "instant",
      stages: [{ allocation: 50000, durationMillis: 300000 }, { allocation: 20000, durationMillis: 300000 }],
    });
    assert.equal(r.isError, true, r.content);
    assert.match(
      r.content,
      /not one of "guarded", "progressive" or "immediate", and nothing here validates it/,
      "THE DISCRIMINATOR: the value is described, not quoted back as a method",
    );
    assert.doesNotMatch(r.content, /releaseMethod "instant"/, "so it is never echoed as if it were valid");
  });

  it("allows a 100% stage for a PROGRESSIVE release — the cap is guarded-only", async () => {
    // The control arm. A progressive rollout has no metric comparison and no control group to
    // preserve, and the demo defaults themselves end at 100%.
    const r = await write({
      releaseMethod: "progressive",
      stages: [
        { allocation: 20000, durationMillis: 300000 },
        { allocation: 50000, durationMillis: 300000 },
        { allocation: 100000, durationMillis: 300000 },
      ],
    });
    assert.notEqual(r.isError, true, r.content);
  });

  it("rejects allocations that do not ascend, and ones outside 1–100000", async () => {
    // Descending stages are a rollout that pulls traffic BACK mid-release; a percentage (50) or a
    // fraction (0.5) written where basis points are expected is a 0.05%/0.0005% stage that looks
    // fine in the file. Neither is what the author meant, and both reach production.
    const descending = await write({
      releaseMethod: "progressive",
      stages: [{ allocation: 50000, durationMillis: 300000 }, { allocation: 20000, durationMillis: 300000 }],
    });
    assert.equal(descending.isError, true);
    assert.match(descending.content, /does not exceed the previous/);

    const tooBig = await write({ releaseMethod: "progressive", stages: [{ allocation: 200000, durationMillis: 1 }] });
    assert.equal(tooBig.isError, true);
    assert.match(tooBig.content, /outside 1–100000/);

    const zero = await write({ releaseMethod: "progressive", stages: [{ allocation: 0, durationMillis: 1 }] });
    assert.equal(zero.isError, true, "a 0% stage releases to nobody and never finishes");
  });

  it("rejects a malformed stage set rather than letting it reach LaunchDarkly", async () => {
    const empty = await write({ releaseMethod: "progressive", stages: [] });
    assert.equal(empty.isError, true);
    assert.match(empty.content, /must not be empty/);

    const notArray = await write({ releaseMethod: "progressive", stages: { allocation: 20000 } });
    assert.equal(notArray.isError, true);
    assert.match(notArray.content, /must be an array/);

    const noDuration = await write({ releaseMethod: "progressive", stages: [{ allocation: 20000 }] });
    assert.equal(noDuration.isError, true, "durationMillis is required by the release instruction");
    assert.match(noDuration.content, /durationMillis/);
  });

  it("leaves a manifest with no stages alone — omitting them defers to the flag's policy", async () => {
    // The precedence `trigger.ts` implements is manifest > policy > demo defaults, so an absent
    // `stages` is meaningful rather than incomplete. Validating it into existence would override a
    // configured policy.
    const r = await write({ metricKeys: ["latency"] });
    assert.notEqual(r.isError, true, r.content);
  });
});
