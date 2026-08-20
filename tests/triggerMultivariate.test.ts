import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DiscoveredFlag, LdClient } from "@auto-factory/shared";
import { repointDependentPrerequisites, triggerRelease } from "@auto-factory/beacon";

interface Patch {
  flagKey: string;
  instructions: Array<Record<string, unknown>>;
}

/** Multivariate LdClient stub: AutoFactory lineage flags with per-env targeting. */
function fakeLd(
  flags: Record<string, Record<string, unknown>>,
  opts: { dependents?: string[]; policy?: Record<string, unknown>; policyStatus?: number; policyThrows?: boolean } = {},
) {
  const patches: Patch[] = [];
  const ld = {
    projectKey: "app-proj",
    getFlag: async (key: string) => {
      const f = flags[key];
      if (!f) throw new Error(`no such flag ${key}`);
      return { status: 200, data: f };
    },
    getDependentFlags: async () => ({ status: 200, data: { items: (opts.dependents ?? []).map((key) => ({ key })) } }),
    patchFlagSemantic: async (flagKey: string, _env: string, instructions: Array<Record<string, unknown>>) => {
      patches.push({ flagKey, instructions });
      return { status: 200, data: {} };
    },
    request: async (o: { path: string }) => {
      // Release-settings reads: 404 / throw / 200-with-body, per the stub options. Any
      // other request (the automated-releases list) returns an empty page.
      if (!o.path.includes("release-settings")) return { status: 200, ok: true, data: { items: [] } };
      if (opts.policyThrows) throw new Error("connection reset");
      if (opts.policyStatus === 404) return { status: 404, ok: false, data: {} };
      if (!opts.policy) return { status: 200, ok: true, data: { releaseMethod: "", releasePolicyKey: "" } };
      return { status: 200, ok: true, data: opts.policy };
    },
  } as unknown as LdClient;
  return { ld, patches };
}

/** An AutoFactory multivariate flag: control/v1[/v2] with env targeting. */
function mvFlag(values: string[], env: Record<string, unknown>): Record<string, unknown> {
  return {
    variations: values.map((value, i) => ({ _id: `id-${value}`, value, index: i })),
    defaults: { onVariation: 1, offVariation: 0 },
    environments: { production: env },
  };
}

const discovered = (extra: Partial<DiscoveredFlag> = {}): DiscoveredFlag =>
  ({ flagKey: "enable-x", sourceFile: ".release-flags/pr-14.json", ...extra }) as DiscoveredFlag;

describe("triggerRelease — multivariate variation releases", () => {
  it("first release of a dark flag: control → v1, with turnFlagOn", async () => {
    const { ld, patches } = fakeLd({ "enable-x": mvFlag(["control", "v1"], { on: false, offVariation: 0 }) });
    const r = await triggerRelease(ld, discovered(), "production");
    assert.equal(r.method, "progressive"); // no metrics anywhere → progressive default
    const instr = patches[0]!.instructions;
    assert.equal(instr[0]!.kind, "turnFlagOn");
    const start = instr[1]!;
    assert.equal(start.kind, "startAutomatedRelease");
    assert.equal(start.originalVariationId, "id-control");
    assert.equal(start.targetVariationId, "id-v1");
  });

  it("iteration release on an on flag: v1 → v2 per the manifest targetVariation, no turnFlagOn", async () => {
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 1 } }),
    });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v2" }), "production");
    assert.equal(r.method, "progressive");
    const instr = patches[0]!.instructions;
    assert.equal(instr.length, 1, "already-on flag must not get turnFlagOn");
    assert.equal(instr[0]!.originalVariationId, "id-v1");
    assert.equal(instr[0]!.targetVariationId, "id-v2");
  });

  it("without targetVariation, releases the lineage tip", async () => {
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 1 } }),
    });
    await triggerRelease(ld, discovered(), "production");
    assert.equal(patches[0]!.instructions[0]!.targetVariationId, "id-v2");
  });

  it("noop when the environment already serves the target variation", async () => {
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 2 } }),
    });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v2" }), "production");
    assert.equal(r.method, "noop");
    assert.equal(patches.length, 0);
  });

  it("a targetVariation the flag lacks is HELD — never a silent whole-flag release, and never a throw", async () => {
    // The original thesis survives: naming a variation the flag does not have must NOT fall
    // through into releasing something else. What changed is the SHAPE of the refusal.
    //
    // It used to throw. `evaluateManifest`'s catch claims the flag's action slot for any throw
    // (rightly — a throw out of `startRelease` may follow a patch LaunchDarkly already applied),
    // but this refusal is decided before any patch is sent and applies to THIS file alone, every
    // time — so the claim never lifted, and `server.ts`'s "highest target first" ordering ran it
    // before the sibling that could release. `PATCH_FAILURE_TAXONOMY` (`trigger.ts`) is where that
    // combination of properties is argued; the end-to-end shape is in ledgerLineage.test.ts.
    //
    // `held` is the same answer as the off-the-lineage refusal three lines below it in
    // trigger.ts: a human named something that does not exist, only a human can say what was
    // meant, and `held` is not final, so the ledger re-checks it once they fix it.
    const { ld, patches } = fakeLd({ "enable-x": mvFlag(["control", "v1"], { on: false, offVariation: 0 }) });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v9" }), "production");
    assert.equal(r.method, "held", "THE DISCRIMINATOR: held, so it does not claim the flag's action slot");
    assert.match(String(r.note), /no such variation/);
    assert.match(String(r.note), /'v9'/, "the note names what was asked for");
    assert.match(String(r.note), /control, v1/, "and what the flag actually has, so the fix is obvious");
    assert.deepEqual(patches, [], "nothing released, which was the original point of this test");
  });

  it("an EMPTY targetVariation is that same held refusal, not the flag-level throw", async () => {
    // `flag.targetVariation ?? tip` uses `??`, so an empty string is NOT absent — it is a target
    // this one manifest names and the flag does not have. As `!targetValue` it fell into the
    // per-FLAG "no vN lineage" throw and cost siblings their release exactly like the case above;
    // the flag here plainly HAS a lineage, which is what makes the misclassification visible.
    const { ld, patches } = fakeLd({ "enable-x": mvFlag(["control", "v1"], { on: false, offVariation: 0 }) });
    const r = await triggerRelease(ld, discovered({ targetVariation: "" }), "production");
    assert.equal(r.method, "held", "THE DISCRIMINATOR: a refusal of this one file, not a thrown flag-level error");
    assert.deepEqual(patches, []);
  });

  it("a flag with NO vN lineage is HELD when the manifest named no target — it is NOT per-flag", async () => {
    // This test asserted the opposite, reasoning that no sibling could have released anyway. FALSE,
    // and the sibling assertion at the bottom is the evidence the old reasoning lacked: this branch
    // is reached only when a manifest names NO target, so a sibling naming an EXISTING variation
    // resolves normally. Throwing therefore claimed the flag's slot and starved that sibling on
    // every deploy, since an absent target ranks as the TIP and is evaluated first. Why that shape
    // must not claim the slot is stated once, in `PATCH_FAILURE_TAXONOMY`.
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "experiment-a"], { on: false, offVariation: 0 }),
    });
    const r = await triggerRelease(ld, discovered(), "production");
    assert.equal(r.method, "held", "THE DISCRIMINATOR: a refusal of this one file, not a thrown flag-level error");
    assert.match(r.note ?? "", /no vN lineage variation/);
    assert.match(r.note ?? "", /a sibling manifest for this flag can still release/);
    assert.deepEqual(patches, [], "nothing was written");

    // THE SIBLING THE OLD ARGUMENT SAID COULD NOT EXIST: same flag, same read, explicit target.
    const sibling = await triggerRelease(ld, discovered({ targetVariation: "experiment-a" }), "production");
    assert.notEqual(sibling.method, "held", `a sibling naming an existing variation acts: ${sibling.method}`);
    assert.ok(patches.length > 0, "so the slot the throw used to claim was a real release lost");
  });

  it("intent prerequisites on a MULTIVARIATE parent pin what its targeting points at", async () => {
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1"], { on: false, offVariation: 0 }),
      "enable-parent": mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 2 } }),
    });
    const r = await triggerRelease(
      ld,
      discovered({ releaseIntent: { prerequisites: [{ flagKey: "enable-parent", variation: "on" }] } }),
      "production",
    );
    assert.equal(r.method, "prerequisites");
    const instr = patches[0]!.instructions;
    assert.equal(instr[0]!.kind, "addPrerequisite");
    assert.equal(instr[0]!.variationId, "id-v2"); // the parent's served variation
    assert.equal(instr[2]!.variationId, "id-v1"); // child fallthrough → its treatment
  });
});

describe("repointDependentPrerequisites", () => {
  const parentServingV2 = () =>
    mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 2 } });
  const child = (pinnedIdx: number, tags: string[] = ["auto-factory"]): Record<string, unknown> => ({
    tags,
    environments: { production: { prerequisites: [{ key: "enable-x", variation: pinnedIdx }] } },
  });

  it("re-points an auto-factory child pinned on the previous variation", async () => {
    const { ld, patches } = fakeLd(
      { "enable-x": parentServingV2(), "enable-child": child(1) },
      { dependents: ["enable-child"] },
    );
    const outcomes = await repointDependentPrerequisites(ld, "enable-x", "production");
    assert.deepEqual(outcomes.map((o) => o.action), ["repointed"]);
    assert.equal(patches.length, 1);
    assert.deepEqual(
      patches[0]!.instructions.map((i) => i.kind),
      ["removePrerequisite", "addPrerequisite"],
    );
    assert.equal(patches[0]!.instructions[1]!.variationId, "id-v2");
  });

  it("skips children already pinned correctly and non-auto-factory children", async () => {
    const { ld, patches } = fakeLd(
      { "enable-x": parentServingV2(), "child-ok": child(2), "child-human": child(1, ["hand-built"]) },
      { dependents: ["child-ok", "child-human"] },
    );
    const outcomes = await repointDependentPrerequisites(ld, "enable-x", "production");
    assert.deepEqual(outcomes.map((o) => o.action), ["skipped", "skipped"]);
    assert.match(outcomes[1]!.detail, /not auto-factory-tagged/);
    assert.equal(patches.length, 0);
  });

  it("an UNTAGGED child pinned to vN gets the BACKWARDS message, not the re-point-it-manually one", async () => {
    // PINS THE ORDER OF TWO SKIP GUARDS, which no other test does — the backwards check sits ahead of
    // the `auto-factory` tag check, and moving it below failed NO test before this one.
    //
    // Both orders skip the write, so nothing detectable changes about behaviour; what changes is what
    // the operator is TOLD. The parent serves `control` with a child pinned to `v1`, which is a
    // human's deliberate rollback (`trigger.ts` recommends serving an earlier variation directly, and
    // `findLatestRelease` still reports the old release `completed`, so every caller's gate passes).
    //
    //  - current order: "repointing would move this child BACKWARDS ... satisfying the prerequisite
    //    here would take the child live at 100% with no rollout. Repoint it by hand if that is really
    //    what is wanted." — a warning, with the consequence named.
    //  - flipped: "not auto-factory-tagged — re-point it manually if it should follow 'control'",
    //    which is ADVICE TO DO THE DESTRUCTIVE THING. Following it un-darks the child at 100% of
    //    traffic, as a consequence of a rollback.
    //
    // So a refactor that reorders these guards cannot silently invert the advice.
    const { ld, patches } = fakeLd(
      {
        "enable-x": mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 0 } }),
        "child-human": child(1, ["hand-built"]),
      },
      { dependents: ["child-human"] },
    );
    const outcomes = await repointDependentPrerequisites(ld, "enable-x", "production");
    assert.deepEqual(outcomes.map((o) => o.action), ["skipped"]);
    assert.match(outcomes[0]!.detail, /BACKWARDS/, "THE DISCRIMINATOR: the backwards guard answered first");
    assert.match(outcomes[0]!.detail, /100% with no rollout/, "so the consequence is named");
    assert.doesNotMatch(
      outcomes[0]!.detail,
      /re-point it manually if it should follow/,
      "and the operator is NOT advised to make the child follow a rolled-back parent by hand",
    );
    assert.equal(patches.length, 0, "either way nothing is written — the message is the whole difference");
  });

  it("boolean parents and off parents are no-ops", async () => {
    const boolParent = {
      variations: [{ _id: "t", value: true }, { _id: "f", value: false }],
      environments: { production: { on: true, fallthrough: { variation: 0 } } },
    };
    const { ld } = fakeLd({ "enable-old": boolParent }, { dependents: ["whatever"] });
    assert.deepEqual(await repointDependentPrerequisites(ld, "enable-old", "production"), []);

    const { ld: ld2 } = fakeLd({ "enable-x": mvFlag(["control", "v1"], { on: false, offVariation: 0 }) });
    assert.deepEqual(await repointDependentPrerequisites(ld2, "enable-x", "production"), []);
  });

  it("never throws — a failed parent read logs and returns []", async () => {
    const { ld } = fakeLd({});
    assert.deepEqual(await repointDependentPrerequisites(ld, "gone", "production"), []);
  });
});

// ---------------------------------------------------------------------------
// Release policy inheritance. Shapes here mirror what abram-backend's "Prod policy"
// actually returns (verified 2026-08-10), not an invented fixture.
// ---------------------------------------------------------------------------
describe("triggerRelease — release policy is inherited, not overridden", () => {
  const POLICY_METRICS = ["ld_autogen__otel-default-http-5xx-rate", "ld_autogen__otel-request-average-latency"];
  const prodPolicy = (extra: Record<string, unknown> = {}) => ({
    releaseMethod: "guarded-release",
    releasePolicyKey: "test",
    releasePolicyName: "Prod policy",
    guardedReleaseConfig: { rolloutContextKindKey: "user", metricKeys: POLICY_METRICS, ...extra },
  });

  /** The startAutomatedRelease instruction from the recorded patches. */
  const releaseInstr = (patches: Patch[]) => {
    for (const p of patches) {
      const i = p.instructions.find((x) => x.kind === "startAutomatedRelease");
      if (i) return i as Record<string, unknown>;
    }
    throw new Error(`no startAutomatedRelease instruction in ${JSON.stringify(patches)}`);
  };

  it("UNIONS the policy's metrics with the manifest's instead of replacing them", async () => {
    // The bug this fixes: `ov.metricKeys ?? policy.metricKeys` meant one agent-authored
    // metric dropped the org's entire baseline — guarding the release by a single narrow
    // signal instead of five.
    const { ld, patches } = fakeLd(
      { "enable-x": mvFlag(["control", "v1"], { on: false }) },
      { policy: prodPolicy() },
    );
    await triggerRelease(ld, discovered({ releasePlan: { metricKeys: ["checkout-conversion"] } }), "production");
    const instr = releaseInstr(patches);
    assert.deepEqual(
      (instr.metrics as Array<{ key: string }>).map((m) => m.key),
      [...POLICY_METRICS, "checkout-conversion"],
      "policy baseline first, then this PR's addition",
    );
  });

  it("does not duplicate a metric the manifest and the policy both name", async () => {
    const { ld, patches } = fakeLd(
      { "enable-x": mvFlag(["control", "v1"], { on: false }) },
      { policy: prodPolicy() },
    );
    await triggerRelease(ld, discovered({ releasePlan: { metricKeys: [POLICY_METRICS[0]!, "extra"] } }), "production");
    const keys = (releaseInstr(patches).metrics as Array<{ key: string }>).map((m) => m.key);
    assert.deepEqual(keys, [...POLICY_METRICS, "extra"]);
  });

  it("INHERITS rollbackOnRegression:false as autoRollback:false on every metric", async () => {
    // A policy set to "pause and wait for human intervention" was previously overridden
    // to auto-rollback on every metric — failing toward the destructive action.
    const { ld, patches } = fakeLd(
      { "enable-x": mvFlag(["control", "v1"], { on: false }) },
      { policy: prodPolicy({ rollbackOnRegression: false }) },
    );
    await triggerRelease(ld, discovered(), "production");
    const prefs = releaseInstr(patches).metricMonitoringPreferences as Record<string, { autoRollback: boolean }>;
    assert.deepEqual(Object.keys(prefs).sort(), [...POLICY_METRICS].sort());
    for (const [key, v] of Object.entries(prefs)) {
      assert.equal(v.autoRollback, false, `${key} must inherit pause-and-wait`);
    }
  });

  it("inherits rollbackOnRegression:true as autoRollback:true", async () => {
    const { ld, patches } = fakeLd(
      { "enable-x": mvFlag(["control", "v1"], { on: false }) },
      { policy: prodPolicy({ rollbackOnRegression: true }) },
    );
    await triggerRelease(ld, discovered(), "production");
    const prefs = releaseInstr(patches).metricMonitoringPreferences as Record<string, { autoRollback: boolean }>;
    for (const v of Object.values(prefs)) assert.equal(v.autoRollback, true);
  });

  it("keeps auto-rollback when there is NO policy to inherit from", async () => {
    // Nothing to inherit, so preserve the previous behaviour rather than trading it for an
    // unknown server-side default.
    const { ld, patches } = fakeLd({ "enable-x": mvFlag(["control", "v1"], { on: false }) }); // policy read throws
    await triggerRelease(ld, discovered({ releasePlan: { metricKeys: ["only-mine"] } }), "production");
    const prefs = releaseInstr(patches).metricMonitoringPreferences as Record<string, { autoRollback: boolean }>;
    assert.deepEqual(prefs, { "only-mine": { autoRollback: true } });
  });
});

// ---------------------------------------------------------------------------
// A policy read FAILURE is not "no policy". Conflating them drops the org's metric
// baseline and flips auto-rollback on — silently overriding a pause-and-wait policy.
// ---------------------------------------------------------------------------
describe("triggerRelease — an unreadable policy is reported, not mistaken for absent", () => {
  const flags = () => ({ "enable-x": mvFlag(["control", "v1"], { on: false }) });

  it("a 404 from release-settings is reported as unreadable", async () => {
    // Observed on a live project: an environment with NO policy returns 200 with empty
    // fields. So 404 means the path or flag is wrong — including the rename the beta
    // endpoint is warned about — and must not read as "no policy configured".
    const { ld } = fakeLd(flags(), { policyStatus: 404 });
    const r = await triggerRelease(ld, discovered({ releasePlan: { metricKeys: ["m1"] } }), "production");
    assert.match(r.note ?? "", /policy UNREADABLE/);
    assert.match(r.note ?? "", /404/);
  });

  it("a thrown read is reported as unreadable, with the cause", async () => {
    const { ld } = fakeLd(flags(), { policyThrows: true });
    const r = await triggerRelease(ld, discovered({ releasePlan: { metricKeys: ["m1"] } }), "production");
    assert.match(r.note ?? "", /policy UNREADABLE/);
    assert.match(r.note ?? "", /connection reset/);
  });

  it("a genuinely absent policy (200, empty fields) is SILENT — nothing went wrong", async () => {
    const { ld } = fakeLd(flags()); // default stub: 200 with empty releaseMethod
    const r = await triggerRelease(ld, discovered({ releasePlan: { metricKeys: ["m1"] } }), "production");
    assert.doesNotMatch(r.note ?? "", /UNREADABLE/);
  });

  it("an unreadable read still releases — a renamed beta path must not stop every release", async () => {
    const { ld, patches } = fakeLd(flags(), { policyThrows: true });
    const r = await triggerRelease(ld, discovered({ releasePlan: { metricKeys: ["m1"] } }), "production");
    assert.equal(r.method, "guarded", "manifest metrics still produce a guarded release");
    assert.ok(patches.length > 0, "the release was started");
  });
});

// ---------------------------------------------------------------------------
// Round eight, F7b: BOOLEAN flags had no noop guard.
//
// The `served === target ⇒ noop` check lived only in the multivariate branch, so a
// boolean flag already serving `true` was re-released. That is not harmless: a
// progressive/guarded release restarts at stage 1, yanking most users back to
// `false`. Reachable by a re-POST after a completed boolean rollout.
// ---------------------------------------------------------------------------
describe("triggerRelease — boolean noop guard", () => {
  const booleanFlag = (on: boolean, offVariation = 1) => ({
    key: "legacy-bool",
    variations: [
      { _id: "var-true", value: true },
      { _id: "var-false", value: false },
    ],
    environments: {
      production: { on, offVariation, fallthrough: { variation: 0 } },
    },
  });
  const manifest = { flagKey: "legacy-bool", scope: "backend", sourceFile: ".release-flags/pr-1.json" };

  it("NOOPs when the environment already serves true", async () => {
    const { ld, patches } = fakeLd({ "legacy-bool": booleanFlag(true) });
    const result = await triggerRelease(ld, manifest as unknown as DiscoveredFlag, "production");
    assert.equal(result.method, "noop");
    assert.match(String(result.note), /already serves true/);
    assert.deepEqual(patches, [], "THE DISCRIMINATOR: no release restarted at stage 1");
  });

  it("still releases a dark boolean flag (targeting off)", async () => {
    // The guard must not block the normal case: merge ≠ release, so an auto-factory flag
    // is created dark and this is what turning it on looks like.
    const { ld, patches } = fakeLd({ "legacy-bool": booleanFlag(false) });
    const result = await triggerRelease(ld, manifest as unknown as DiscoveredFlag, "production");
    assert.notEqual(result.method, "noop", "a dark flag has something to release");
    assert.ok(patches.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Round ten, finding 1 (HIGH): a release must never move the lineage BACKWARDS.
//
// Manifests are one per PR and never deleted, iteration PRs target a new variation
// of an EXISTING flag, and the re-evaluation ledger keeps an unreleased older
// manifest alive indefinitely. So: pr-41 targets v1 and is `held`; pr-42 targets v2
// and releases. A human then flips pr-41's intent hold → auto — the documented way
// to release held work — and Beacon starts a progressive rollout from v2 back to v1,
// reported as a successful release.
//
// Every other guard misses it. The noop guard needs served === target. findActiveRelease
// only sees running releases. findLatestRelease sees NOTHING when v2 arrived via an
// `immediate` or `prerequisites` release, which create no AutomatedRelease record.
//
// The two backwards moves get DIFFERENT answers, which is the correction round eleven made:
// behind-the-lineage is MOOT (final `noop` — the work already happened and then some, so the
// ledger must stop tracking it), while leaving-the-lineage is a REFUSAL (`held` — a human has
// to decide). Answering `held` for the moot case is what blocked newer manifests forever: a
// held entry never clears, and it used to claim the flag's only per-notification action slot.
// ---------------------------------------------------------------------------
describe("triggerRelease — lineage regression guard", () => {
  const servingV2 = () =>
    mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 2 } });

  it("a target BEHIND what is served is MOOT: final noop, not a hold", async () => {
    // `held` would be the wrong shape twice over: it is not "release this later" (it must never
    // release), and non-final means the ledger re-checks it on every deploy forever.
    const { ld, patches } = fakeLd({ "enable-x": servingV2() });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v1" }), "production");
    assert.equal(r.method, "noop", "final, so recordOutcome clears the ledger entry");
    assert.match(String(r.note), /BACKWARDS/);
    assert.match(String(r.note), /SUPERSEDED/);
    assert.deepEqual(patches, [], "THE DISCRIMINATOR: no startAutomatedRelease at all");
  });

  it("HOLDS a target that would LEAVE the lineage — an automated un-release", async () => {
    // The only backwards move that was unguarded, and the most destructive: served v2, manifest
    // asks for `control`, so a progressive rollout ramps production back to the original
    // behaviour and reports it as a release. `control` has no lineage index, so the
    // behind-the-lineage comparison above cannot see it.
    //
    // `held`, not `noop`: unlike a superseded manifest this request is not already satisfied. It
    // is one we refuse, and a deliberate rollback is LaunchDarkly's job.
    const { ld, patches } = fakeLd({ "enable-x": servingV2() });
    const r = await triggerRelease(ld, discovered({ targetVariation: "control" }), "production");
    assert.equal(r.method, "held", "a refusal needs a human, so it must NOT be final");
    assert.match(String(r.note), /NOT IN THE LINEAGE/);
    assert.match(String(r.note), /LaunchDarkly's job/);
    assert.deepEqual(patches, [], "THE DISCRIMINATOR: no rollout from v2 back to control");
  });

  it("still releases FORWARD along the lineage", async () => {
    // The guard must not block the normal iteration release.
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1", "v2"], { on: true, offVariation: 0, fallthrough: { variation: 1 } }),
    });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v2" }), "production");
    assert.notEqual(r.method, "held");
    assert.ok(patches.length > 0);
  });

  it("still NOOPs when the target is exactly what is served", async () => {
    const { ld } = fakeLd({ "enable-x": servingV2() });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v2" }), "production");
    assert.equal(r.method, "noop", "equal is noop, not a regression");
  });

  it("releases normally out of a non-lineage SERVED variation", async () => {
    // control → v1 is the first release of every flag, and `control` has no lineage index — so
    // the guard keys off the SERVED side being in the lineage. When it isn't, there is no
    // backwards to refuse and nothing to guess an order about.
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1"], { on: true, offVariation: 0, fallthrough: { variation: 0 } }),
    });
    const r = await triggerRelease(ld, discovered({ targetVariation: "v1" }), "production");
    assert.notEqual(r.method, "held");
    assert.ok(patches.length > 0);
  });

  it("holds a hand-named target out of a lineage-served flag, rather than guessing its order", async () => {
    // Same refusal as `control`: from v1, "experiment-a" is neither forward nor backward, and
    // guessing is how an environment gets moved off the released lineage unattended.
    const { ld, patches } = fakeLd({
      "enable-x": mvFlag(["control", "v1", "experiment-a"], { on: true, offVariation: 0, fallthrough: { variation: 1 } }),
    });
    const r = await triggerRelease(ld, discovered({ targetVariation: "experiment-a" }), "production");
    assert.equal(r.method, "held");
    assert.deepEqual(patches, []);
  });
});
