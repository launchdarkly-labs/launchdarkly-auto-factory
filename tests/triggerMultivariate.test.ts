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
  opts: { dependents?: string[]; policy?: Record<string, unknown> } = {},
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
    request: async () => {
      // getReleasePolicy is best-effort; unstubbed reads throw and fall back to defaults.
      if (!opts.policy) throw new Error("policy read not stubbed");
      return { status: 200, data: opts.policy };
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

  it("a targetVariation the flag lacks is an error, not a silent whole-flag release", async () => {
    const { ld } = fakeLd({ "enable-x": mvFlag(["control", "v1"], { on: false, offVariation: 0 }) });
    await assert.rejects(() => triggerRelease(ld, discovered({ targetVariation: "v9" }), "production"), /no variation 'v9'/);
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
