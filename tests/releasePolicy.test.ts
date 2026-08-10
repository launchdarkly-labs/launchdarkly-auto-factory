import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeReleasePolicy } from "@auto-factory/shared";

describe("normalizeReleasePolicy", () => {
  it("maps a guarded release policy (method, stages, randomization unit, metrics)", () => {
    const p = normalizeReleasePolicy({
      releaseMethod: "guarded-release",
      guardedReleaseConfig: {
        rolloutContextKindKey: "member",
        metricKeys: ["errors"],
        metricGroupKeys: ["core"],
        stages: [{ allocation: 50000, durationMillis: 1000 }],
      },
    });
    assert.equal(p.releaseMethod, "guarded");
    assert.equal(p.randomizationUnit, "member");
    assert.deepEqual(p.stages, [{ allocation: 50000, durationMillis: 1000 }]);
    assert.deepEqual(p.metricKeys, ["errors"]);
    assert.deepEqual(p.metricGroupKeys, ["core"]);
  });

  it("maps a progressive release policy (no metrics)", () => {
    const p = normalizeReleasePolicy({
      releaseMethod: "progressive-rollout",
      progressiveReleaseConfig: { rolloutContextKindKey: "user", stages: [{ allocation: 100000, durationMillis: 1 }] },
    });
    assert.equal(p.releaseMethod, "progressive");
    assert.equal(p.randomizationUnit, "user");
    assert.equal(p.metricKeys, undefined);
  });

  it("returns an empty policy when nothing is configured", () => {
    assert.deepEqual(normalizeReleasePolicy({}), {});
  });

  it("extracts rollbackOnRegression and the policy identity (verified against a real project)", () => {
    // The shape abram-backend's "Prod policy" actually returns. All three of these were
    // previously discarded — rollbackOnRegression is the rollback-vs-pause choice, and the
    // key/name are what PR-time reporting needs.
    const p = normalizeReleasePolicy({
      releaseMethod: "guarded-release",
      releasePolicyKey: "test",
      releasePolicyName: "Prod policy",
      guardedReleaseConfig: {
        rolloutContextKindKey: "user",
        metricKeys: [
          "ld_autogen__otel-default-http-5xx-rate",
          "ld_autogen__otel-request-average-latency",
          "login",
        ],
        rollbackOnRegression: false,
      },
    });
    assert.equal(p.releaseMethod, "guarded");
    assert.equal(p.rollbackOnRegression, false, "pause and wait, not auto-rollback");
    assert.equal(p.policyKey, "test");
    assert.equal(p.policyName, "Prod policy");
    assert.equal(p.metricKeys?.length, 3);
    assert.equal(p.stages, undefined, "this policy carries no stages — Beacon falls back");
  });

  it("distinguishes rollbackOnRegression:true from an absent value", () => {
    // Absent means "nothing to inherit", which callers treat as the previous default
    // rather than as false.
    assert.equal(
      normalizeReleasePolicy({ guardedReleaseConfig: { rollbackOnRegression: true } }).rollbackOnRegression,
      true,
    );
    assert.equal(normalizeReleasePolicy({ guardedReleaseConfig: {} }).rollbackOnRegression, undefined);
  });

  it("a non-policy environment normalizes to an empty policy, not a broken one", () => {
    // dev/test in a project whose policy is production-only return empty strings.
    assert.deepEqual(normalizeReleasePolicy({ releaseMethod: "", releasePolicyKey: "", releasePolicyName: "" }), {});
  });
});
