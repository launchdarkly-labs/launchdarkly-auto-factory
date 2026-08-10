import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LdClient } from "@auto-factory/shared";
import {
  findActiveRelease,
  isReleaseFinished,
  isReleaseRunning,
  normalizeReleasePolicy,
} from "@auto-factory/shared";

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

// ---------------------------------------------------------------------------
// Release status handling. `rollbackOnRegression: false` makes a PAUSED release
// reachable, and neither the idempotency guard nor the monitor loop modelled it.
// ---------------------------------------------------------------------------
describe("release status: unknown states fail safe in both directions", () => {
  it("a status we don't recognise is NOT running and NOT finished", () => {
    for (const s of ["paused", "awaiting_approval", "something_new"]) {
      assert.equal(isReleaseRunning(s), false, `${s} must not be polled as running`);
      assert.equal(isReleaseFinished(s), false, `${s} must not be treated as finished`);
    }
  });

  it("known statuses classify as expected", () => {
    assert.equal(isReleaseRunning("in_progress"), true);
    assert.equal(isReleaseFinished("in_progress"), false);
    for (const s of ["completed", "reverted", "monitoring_stopped"]) {
      assert.equal(isReleaseRunning(s), false, s);
      assert.equal(isReleaseFinished(s), true, s);
    }
  });

  it("the two predicates are deliberately NOT complements", () => {
    // The asymmetry is the safety property: monitoring stops on unknown (observe-only, so
    // stopping early is free) while the idempotency guard treats unknown as active (so a
    // re-delivered webhook cannot start a second release on the same flag).
    const unknown = "paused";
    assert.equal(isReleaseRunning(unknown), false);
    assert.equal(isReleaseFinished(unknown), false);
  });
});

describe("findActiveRelease treats any non-terminal release as active", () => {
  const releases = (items: Array<{ id: string; status: string }>) => {
    const calls: string[] = [];
    const ld = {
      projectKey: "p",
      request: async (o: { path: string }) => {
        calls.push(o.path);
        return { status: 200, ok: true, data: { items } };
      },
    } as unknown as LdClient;
    return { ld, calls };
  };

  it("finds a PAUSED release, which the old status:in_progress filter missed", async () => {
    const { ld } = releases([{ id: "r1", status: "paused" }]);
    const active = await findActiveRelease(ld, "enable-x", "production");
    assert.equal(active?.id, "r1", "a paused release is still active — starting another would double up");
  });

  it("skips terminal releases and returns the first active one", async () => {
    const { ld } = releases([
      { id: "old-completed", status: "completed" },
      { id: "old-reverted", status: "reverted" },
      { id: "live", status: "in_progress" },
    ]);
    assert.equal((await findActiveRelease(ld, "enable-x", "production"))?.id, "live");
  });

  it("returns null when every release is terminal", async () => {
    const { ld } = releases([{ id: "a", status: "completed" }, { id: "b", status: "monitoring_stopped" }]);
    assert.equal(await findActiveRelease(ld, "enable-x", "production"), null);
  });

  it("no longer filters server-side on status, and does not limit to one", async () => {
    // A server-side limit=1 would hide an older active release behind a newer terminal
    // one, which is the same double-start hazard by a different route.
    const { ld, calls } = releases([]);
    await findActiveRelease(ld, "enable-x", "production");
    assert.doesNotMatch(calls[0] ?? "", /in_progress/);
    assert.doesNotMatch(calls[0] ?? "", /limit=1(&|$)/);
    assert.match(calls[0] ?? "", /environmentKey%3Aproduction/);
  });
});
