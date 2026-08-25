import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LdResourceWriter,
  latestVariationValue,
  nextVariationValue,
  variationReleased,
  type FlagState,
  type LdClient,
} from "@auto-factory/shared";

/** Fake LdClient capturing the createFlag/createMetric body, returning a scripted status. */
function fakeClient(status: number) {
  let lastBody: Record<string, unknown> | undefined;
  let lastPatch: { instructions: unknown[] } | undefined;
  const capture = async (body: unknown) => {
    lastBody = body as Record<string, unknown>;
    return { status, data: {} };
  };
  const client = {
    projectKey: "demo",
    createFlag: capture,
    createMetric: capture,
    patchFlagProjectSemantic: async (_key: string, instructions: unknown[]) => {
      lastPatch = { instructions };
      return { status: 200, data: {} };
    },
  } as unknown as LdClient;
  return { client, body: () => lastBody, patch: () => lastPatch };
}

describe("LdResourceWriter.createFlag (multivariate)", () => {
  it("throws when key is missing", async () => {
    const { client } = fakeClient(201);
    const writer = new LdResourceWriter(client);
    await assert.rejects(() => writer.createFlag({ key: "" }), /flag key is required/);
  });

  it("reports created on a success status, with the v1 treatment", async () => {
    const { client } = fakeClient(201);
    const r = await new LdResourceWriter(client).createFlag({ key: "enable-x" });
    assert.equal(r.created, true);
    assert.equal(r.alreadyExists, false);
    assert.equal(r.key, "enable-x");
    assert.equal(r.variation, "v1");
    assert.match(r.detail, /Created multivariate flag 'enable-x'/);
  });

  it("reports alreadyExists on 409 (idempotent re-run)", async () => {
    const { client } = fakeClient(409);
    const r = await new LdResourceWriter(client).createFlag({ key: "enable-x" });
    assert.equal(r.created, false);
    assert.equal(r.alreadyExists, true);
    assert.match(r.detail, /already exists/);
  });

  it("merges + dedupes the standard auto-factory tags with caller tags", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createFlag({ key: "k", tags: ["auto-factory", "custom"] });
    const tags = body()?.tags as string[];
    assert.deepEqual([...tags].sort(), ["auto-factory", "auto-generated", "custom"]);
  });

  it("creates a STRING multivariate flag: control (off) + v1 (on), dark by default", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createFlag({ key: "k", treatmentDescription: "new checkout" });
    const b = body();
    assert.equal(b?.temporary, true);
    const variations = b?.variations as Array<{ value: string; name: string; description?: string }>;
    assert.deepEqual(
      variations.map((v) => v.value),
      ["control", "v1"],
    );
    assert.match(variations[1]?.description ?? "", /new checkout/);
    // On = v1 (index 1); Off = control (index 0).
    assert.deepEqual(b?.defaults, { onVariation: 1, offVariation: 0 });
  });

  it("frontend scope enables client-side SDK availability on create", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createFlag({ key: "k", scope: "frontend" });
    assert.deepEqual(body()?.clientSideAvailability, {
      usingEnvironmentId: true,
      usingMobileKey: false,
    });
  });

  it("includes maintainerId when the writer is built with one, omits it otherwise", async () => {
    const withMaintainer = fakeClient(201);
    await new LdResourceWriter(withMaintainer.client, { maintainerId: "member-123" }).createFlag({ key: "k" });
    assert.equal(withMaintainer.body()?.maintainerId, "member-123");

    const without = fakeClient(201);
    await new LdResourceWriter(without.client).createFlag({ key: "k" });
    assert.equal(without.body()?.maintainerId, undefined);
  });

  it("backend scope does not expose the flag to the client-side SDK", async () => {
    const { client, body, patch } = fakeClient(201);
    await new LdResourceWriter(client).createFlag({ key: "k", scope: "backend" });
    assert.equal(body()?.clientSideAvailability, undefined);
    assert.equal(patch(), undefined);
  });

  it("on 409 with frontend scope, patches client-side availability for an existing flag", async () => {
    const { client, patch } = fakeClient(409);
    await new LdResourceWriter(client).createFlag({ key: "k", scope: "frontend" });
    assert.deepEqual(patch()?.instructions, [
      { kind: "turnOnClientSideAvailability", value: "usingEnvironmentId" },
    ]);
  });
});

describe("variation lineage helpers", () => {
  it("nextVariationValue continues the vN lineage, ignoring non-lineage values", () => {
    assert.equal(nextVariationValue(["control", "v1"]), "v2");
    assert.equal(nextVariationValue(["control", "v1", "v3"]), "v4");
    assert.equal(nextVariationValue(["control"]), "v1");
    assert.equal(nextVariationValue([true, false]), "v1");
  });

  it("latestVariationValue returns the lineage tip or undefined", () => {
    assert.equal(latestVariationValue(["control", "v1", "v2"]), "v2");
    assert.equal(latestVariationValue([true, false]), undefined);
  });
});

describe("LdResourceWriter.addVariation", () => {
  function fakeFlagClient(variations: Array<{ value: unknown }>) {
    let patched: { ops?: unknown[] } = {};
    const client = {
      projectKey: "demo",
      getFlag: async () => ({ status: 200, ok: true, data: { variations } }),
      patchFlagJson: async (_key: string, ops: unknown[]) => {
        patched = { ops };
        return { status: 200, ok: true, data: {} };
      },
    } as unknown as LdClient;
    return { client, patched: () => patched };
  }

  it("appends the requested value via JSON patch", async () => {
    const { client, patched } = fakeFlagClient([{ value: "control" }, { value: "v1" }]);
    const r = await new LdResourceWriter(client).addVariation("enable-x", { value: "v2", description: "denser layout" });
    assert.equal(r.created, true);
    assert.equal(r.variation, "v2");
    const op = (patched().ops as Array<Record<string, unknown>>)[0];
    assert.equal(op?.op, "add");
    assert.equal(op?.path, "/variations/-");
    assert.deepEqual(op?.value, { value: "v2", name: "v2", description: "denser layout" });
  });

  it("defaults to the next lineage value when none is passed", async () => {
    const { client } = fakeFlagClient([{ value: "control" }, { value: "v1" }]);
    const r = await new LdResourceWriter(client).addVariation("enable-x");
    assert.equal(r.variation, "v2");
  });

  it("is idempotent on the intended value (PR re-runs don't mint v3)", async () => {
    const { client, patched } = fakeFlagClient([{ value: "control" }, { value: "v1" }, { value: "v2" }]);
    const r = await new LdResourceWriter(client).addVariation("enable-x", { value: "v2" });
    assert.equal(r.created, false);
    assert.equal(r.alreadyExists, true);
    assert.equal(r.variation, "v2");
    assert.equal(patched().ops, undefined);
  });

  it("refuses legacy boolean flags with child-flag guidance", async () => {
    const { client } = fakeFlagClient([{ value: true }, { value: false }]);
    await assert.rejects(
      () => new LdResourceWriter(client).addVariation("enable-old"),
      /legacy BOOLEAN flag.*child flag/s,
    );
  });

  it("rejects non-lineage values", async () => {
    const { client } = fakeFlagClient([{ value: "control" }, { value: "v1" }]);
    await assert.rejects(
      () => new LdResourceWriter(client).addVariation("enable-x", { value: "fancy-mode" }),
      /vN lineage/,
    );
  });
});

describe("variationReleased (the ride-vs-iterate rule)", () => {
  const state = (envs: FlagState["environments"]): FlagState => ({
    exists: true,
    key: "enable-x",
    kind: "multivariate",
    variations: [{ value: "control" }, { value: "v1" }],
    latestVariation: "v1",
    environments: envs,
  });
  const env = (over: Partial<FlagState["environments"][string]>): FlagState["environments"][string] => ({
    on: false,
    fallthroughServes: [],
    prerequisites: [],
    rulesServe: [],
    individualTargets: false,
    released: [],
    ...over,
  });

  it("production is the environment of record when present", () => {
    const s = state({
      production: env({}),
      test: env({ on: true, released: ["v1"] }), // QA serving — must not count
    });
    assert.equal(variationReleased(s, "v1").released, false);
  });

  it("serving via fallthrough/rules in production counts as released", () => {
    const s = state({ production: env({ on: true, released: ["v1"] }) });
    const r = variationReleased(s, "v1");
    assert.equal(r.released, true);
    assert.deepEqual(r.envs, ["production"]);
  });

  it("an in-progress automated release counts as released (mid-release iterations must mint vN+1)", () => {
    const s = state({ production: env({ on: true, activeRelease: { status: "in_progress", kind: "guarded" } }) });
    assert.equal(variationReleased(s, "v1").released, true);
  });

  it("without a production environment, ANY environment serving counts (conservative)", () => {
    const s = state({ staging: env({ on: true, released: ["v1"] }) });
    assert.equal(variationReleased(s, "v1").released, true);
  });

  it("a missing flag is never released", () => {
    const s: FlagState = { exists: false, key: "nope", kind: "multivariate", variations: [], environments: {} };
    assert.equal(variationReleased(s, "v1").released, false);
  });
});

describe("LdResourceWriter.getFlagState", () => {
  it("reports exists=false on a 404 without throwing", async () => {
    const client = {
      projectKey: "demo",
      getFlag: async () => {
        throw new Error("404");
      },
    } as unknown as LdClient;
    const s = await new LdResourceWriter(client).getFlagState("nope");
    assert.equal(s.exists, false);
    assert.equal(s.key, "nope");
  });

  it("maps kind, lineage, and per-env serving (rollout arms with weight > 0)", async () => {
    const client = {
      projectKey: "demo",
      getFlag: async () => ({
        status: 200,
        ok: true,
        data: {
          temporary: true,
          tags: ["auto-factory"],
          variations: [{ value: "control", name: "Control" }, { value: "v1" }, { value: "v2" }],
          environments: {
            production: {
              on: true,
              offVariation: 0,
              fallthrough: { rollout: { variations: [{ variation: 1, weight: 90000 }, { variation: 2, weight: 10000 }, { variation: 0, weight: 0 }] } },
              prerequisites: [{ key: "parent-flag" }],
              rules: [],
              targets: [],
            },
            test: { on: false, offVariation: 0, fallthrough: { variation: 2 } },
          },
        },
      }),
      // findActiveRelease probes (internal API) — fail them; must degrade to "unknown".
      request: async () => {
        throw new Error("internal API unavailable");
      },
    } as unknown as LdClient;
    const s = await new LdResourceWriter(client).getFlagState("enable-x");
    assert.equal(s.exists, true);
    assert.equal(s.kind, "multivariate");
    assert.equal(s.latestVariation, "v2");
    const prod = s.environments.production;
    assert.deepEqual(prod?.fallthroughServes.sort(), ["v1", "v2"]);
    assert.deepEqual(prod?.released.sort(), ["v1", "v2"]);
    assert.equal(prod?.activeRelease, "unknown");
    assert.deepEqual(prod?.prerequisites, [{ flagKey: "parent-flag" }]);
    // Off env: fallthrough recorded but nothing released.
    const test = s.environments.test;
    assert.deepEqual(test?.fallthroughServes, ["v2"]);
    assert.deepEqual(test?.released, []);
    assert.equal(test?.activeRelease, undefined); // off flag → release probe skipped
  });

  it("classifies boolean flags and stringifies their values", async () => {
    const client = {
      projectKey: "demo",
      getFlag: async () => ({
        status: 200,
        ok: true,
        data: {
          variations: [{ value: true }, { value: false }],
          environments: { production: { on: true, fallthrough: { variation: 0 } } },
        },
      }),
      request: async () => ({ status: 200, ok: true, data: { items: [] } }),
    } as unknown as LdClient;
    const s = await new LdResourceWriter(client).getFlagState("enable-old");
    assert.equal(s.kind, "boolean");
    assert.equal(s.latestVariation, undefined);
    assert.deepEqual(s.environments.production?.released, ["true"]);
  });
});

describe("LdResourceWriter.createMetric", () => {
  it("throws when key or eventKey is missing", async () => {
    const { client } = fakeClient(201);
    const w = new LdResourceWriter(client);
    await assert.rejects(() => w.createMetric({ key: "", eventKey: "e", category: "error" }), /metric key is required/);
    await assert.rejects(() => w.createMetric({ key: "k", eventKey: "", category: "error" }), /eventKey is required/);
  });

  it("error category → occurrence, LowerThanBaseline, default user unit", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({ key: "k-error-rate", eventKey: "k-error", category: "error" });
    const b = body();
    assert.equal(b?.kind, "custom");
    assert.equal(b?.eventKey, "k-error");
    assert.equal(b?.isNumeric, false);
    assert.equal(b?.successCriteria, "LowerThanBaseline");
    assert.deepEqual(b?.randomizationUnits, ["user"]);
    assert.equal(b?.unit, undefined); // occurrence metrics carry no numeric unit
  });

  it("latency category → numeric with unit + aggregation", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({ key: "k-latency", eventKey: "k-latency", category: "latency" });
    const b = body();
    assert.equal(b?.isNumeric, true);
    assert.equal(b?.unit, "ms");
    assert.equal(b?.unitAggregationType, "average");
    assert.equal(b?.successCriteria, "LowerThanBaseline");
  });

  it("business category → HigherThanBaseline occurrence", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({ key: "k-success", eventKey: "k-success", category: "business" });
    const b = body();
    assert.equal(b?.isNumeric, false);
    assert.equal(b?.successCriteria, "HigherThanBaseline");
  });

  it("honors a custom randomization unit and merges standard tags", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({
      key: "k",
      eventKey: "e",
      category: "error",
      randomizationUnit: "account",
      // LaunchDarkly tags cannot contain ":" — the flag-reference convention is flag-<key>
      tags: ["flag-enable-x"],
    });
    const b = body();
    assert.deepEqual(b?.randomizationUnits, ["account"]);
    assert.deepEqual([...(b?.tags as string[])].sort(), ["auto-factory", "auto-generated", "flag-enable-x"]);
  });

  it("reports alreadyExists on 409", async () => {
    const { client } = fakeClient(409);
    const r = await new LdResourceWriter(client).createMetric({ key: "k", eventKey: "e", category: "error" });
    assert.equal(r.created, false);
    assert.equal(r.alreadyExists, true);
    assert.match(r.detail, /already exists/);
  });
});
