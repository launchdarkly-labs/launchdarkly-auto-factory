import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LdClient } from "@auto-factory/shared";
import {
  LdApiError,
  findActiveRelease,
  monitorRelease,
  readReleasePolicy,
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

  it("finds a PAUSED release among terminal ones — starting another would double up", async () => {
    // The previous version of this test passed with the change REVERTED: the old code
    // returned items[0] and the stub ignored the filter, so a lone paused item "passed"
    // either way. Terminal entries ahead of it make the client-side classification the
    // only thing that can produce the right answer.
    const { ld } = releases([
      { id: "done", status: "completed" },
      { id: "paused-one", status: "paused" },
    ]);
    const active = await findActiveRelease(ld, "enable-x", "production");
    assert.equal(active?.id, "paused-one");
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

// ---------------------------------------------------------------------------
// Policy drift is classified by RECOGNIZED FIELDS, not by whether the body looks empty.
// The no-policy body is NOT empty — it carries empty strings — so an emptiness heuristic
// would flag every policy-free flag on every release.
// ---------------------------------------------------------------------------
describe("readReleasePolicy: drift detection without emptiness guessing", () => {
  const read = async (status: number, data: unknown) => {
    const ld = {
      projectKey: "p",
      request: async () => {
        if (status >= 400) return { status, ok: false, data };
        return { status, ok: true, data };
      },
    } as unknown as LdClient;
    return readReleasePolicy(ld, "enable-x", "production");
  };

  it("the real no-policy body is ABSENT and silent, not drift", async () => {
    // Observed live: empty strings, not an empty object, not a 404.
    const r = await read(200, { releaseMethod: "", releasePolicyKey: "", releasePolicyName: "" });
    assert.equal(r.status, "absent");
  });

  it("the real policy body is OK", async () => {
    const r = await read(200, {
      releaseMethod: "guarded-release",
      releasePolicyKey: "test",
      releasePolicyName: "Prod policy",
      guardedReleaseConfig: { rolloutContextKindKey: "user", metricKeys: ["m1"], rollbackOnRegression: false },
    });
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.policy.rollbackOnRegression, false);
  });

  it("an unmappable releaseMethod is drift, not absence", async () => {
    // Previously vanished into `absent`: silent demo defaults and auto-rollback flipped on.
    const r = await read(200, { releaseMethod: "canary-release" });
    assert.equal(r.status, "unreadable");
    assert.match((r as { reason: string }).reason, /unrecognized releaseMethod 'canary-release'/);
  });

  it("PARTIAL drift is surfaced as a note WITHOUT discarding what parsed", async () => {
    // A recognised method beside a renamed inner config. Reporting this as `unreadable`
    // would throw away the method too and force auto-rollback on — worse than using the
    // half we recovered. So: usable, with the missing half named.
    const r = await read(200, {
      releaseMethod: "guarded-release",
      guardedReleaseConfig: { metricKeysV2: ["m1"], rollbackOnRegressionV2: false },
    });
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.policy.releaseMethod, "guarded", "keep what parsed");
    assert.match(
      (r as { note?: string }).note ?? "",
      /guardedReleaseConfig had content but nothing in it was recognized/,
    );
  });

  it("an additive field on a VALID policy does not discard it", async () => {
    // The failure this ordering prevents: one benign API addition previously made every
    // read `unreadable`, which drops the metric baseline and flips auto-rollback on
    // org-wide — the exact failure the tri-state was built to prevent.
    const r = await read(200, {
      releaseMethod: "guarded-release",
      releasePolicyName: "Prod policy",
      releasePolicyDescription: "org standard",
      guardedReleaseConfig: { rolloutContextKindKey: "user", metricKeys: ["m1"], rollbackOnRegression: false },
    });
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.policy.rollbackOnRegression, false, "pause-and-wait survives");
    assert.deepEqual(r.status === "ok" ? r.policy.metricKeys : [], ["m1"], "the baseline survives");
    assert.match((r as { note?: string }).note ?? "", /releasePolicyDescription/, "still reported");
  });

  it("an empty config block on a no-policy body is NOT drift", async () => {
    // Rule 2 counts non-empty VALUES, matching rule 3's treatment of empty strings — so a
    // policy-free environment stays silent even if LD starts sending an empty block.
    const r = await read(200, {
      releaseMethod: "",
      guardedReleaseConfig: { rolloutContextKindKey: "", metricKeys: [], stages: [] },
    });
    assert.equal(r.status, "absent");
  });

  it("an unrecognized POPULATED top-level field is drift; empty ones are not", async () => {
    const drifted = await read(200, { releaseMethod: "", somethingNew: "value" });
    assert.equal(drifted.status, "unreadable");
    assert.match((drifted as { reason: string }).reason, /somethingNew/);
    // Known boilerplate and empty values must stay silent, or `absent` rots into noise.
    const fine = await read(200, { releaseMethod: "", _links: { self: {} }, futureField: "" });
    assert.equal(fine.status, "absent");
  });

  it("404 and transport failures are unreadable, with the cause", async () => {
    const notFound = await read(404, {});
    assert.equal(notFound.status, "unreadable");
    assert.match((notFound as { reason: string }).reason, /404/);
    const threw = await readReleasePolicy(
      { projectKey: "p", request: async () => { throw new Error("socket hang up"); } } as unknown as LdClient,
      "enable-x",
      "production",
    );
    assert.equal(threw.status, "unreadable");
    assert.match((threw as { reason: string }).reason, /socket hang up/);
  });
});

// ---------------------------------------------------------------------------
// Monitoring a release that pauses. Keeping the watch is what lets a human resume it and
// still have the completion observed — completion is what repoints child flags.
// ---------------------------------------------------------------------------
describe("monitorRelease keeps watching an unrecognised (paused) state", () => {
  const poller = (statuses: string[]) => {
    let i = 0;
    const seen: string[] = [];
    const ld = {
      projectKey: "p",
      request: async () => {
        const status = statuses[Math.min(i, statuses.length - 1)] ?? "in_progress";
        seen.push(status);
        i++;
        return { status: 200, ok: true, data: { id: "r1", kind: "guarded", status, latestStageIndex: 0, stages: [] } };
      },
    } as unknown as LdClient;
    return { ld, seen };
  };

  it("polls through a pause and returns the release once a human resumes it to completion", async () => {
    const { ld, seen } = poller(["in_progress", "paused", "paused", "completed"]);
    const final = await monitorRelease(ld, "production", "r1", { pollMillis: 1, timeoutMillis: 5_000 });
    assert.equal(final.status, "completed", "the resumed completion must be observed");
    assert.deepEqual(seen, ["in_progress", "paused", "paused", "completed"]);
  });

  it("returns the last observation on timeout instead of throwing", async () => {
    // Throwing made an unresolved pause look like a monitoring error.
    const { ld } = poller(["paused"]);
    const final = await monitorRelease(ld, "production", "r1", { pollMillis: 1, timeoutMillis: 20 });
    assert.equal(final.status, "paused");
  });

  it("survives transient poll failures instead of ending monitoring for good", async () => {
    let calls = 0;
    const ld = {
      projectKey: "p",
      request: async () => {
        calls++;
        if (calls <= 2) throw new Error("connection reset");
        return { status: 200, ok: true, data: { id: "r1", kind: "guarded", status: "completed", latestStageIndex: 0, stages: [] } };
      },
    } as unknown as LdClient;
    const final = await monitorRelease(ld, "production", "r1", { pollMillis: 1, timeoutMillis: 5_000 });
    assert.equal(final.status, "completed", "two transient failures must not strand the completion");
  });
});

// ---------------------------------------------------------------------------
// Partial drift INSIDE a config block: the case rule 2 cannot see once any one field
// parses, and the one that matters, because losing `rollbackOnRegression` changes what
// happens when a metric regresses.
// ---------------------------------------------------------------------------
describe("readReleasePolicy: inner-field drift", () => {
  const read = async (data: unknown) =>
    readReleasePolicy(
      { projectKey: "p", request: async () => ({ status: 200, ok: true, data }) } as unknown as LdClient,
      "enable-x",
      "production",
    );

  it("flags ONE renamed inner field and marks the rollback choice uncertain", async () => {
    const r = await read({
      releaseMethod: "guarded-release",
      guardedReleaseConfig: { rolloutContextKindKey: "user", metricKeys: ["m1"], rollbackBehavior: "pause_and_wait" },
    });
    assert.equal(r.status, "ok", "what parsed is still usable");
    assert.match((r as { note?: string }).note ?? "", /guardedReleaseConfig carried unrecognized field\(s\): rollbackBehavior/);
    assert.equal((r as { rollbackChoiceUncertain?: true }).rollbackChoiceUncertain, true);
  });

  it("does NOT mark uncertainty when the rollback choice itself parsed", async () => {
    // Narrowness matters: additive drift alongside a readable choice is a note, not a
    // reason to doubt the choice.
    const r = await read({
      releaseMethod: "guarded-release",
      guardedReleaseConfig: { metricKeys: ["m1"], rollbackOnRegression: false, minimumSampleSize: 100 },
    });
    assert.equal(r.status, "ok");
    assert.match((r as { note?: string }).note ?? "", /minimumSampleSize/);
    assert.equal((r as { rollbackChoiceUncertain?: true }).rollbackChoiceUncertain, undefined);
    assert.equal(r.status === "ok" && r.policy.rollbackOnRegression, false);
  });

  it("catches type drift on the rollback field, which normalization drops silently", async () => {
    const r = await read({
      releaseMethod: "guarded-release",
      guardedReleaseConfig: { metricKeys: ["m1"], rollbackOnRegression: "false" },
    });
    assert.match((r as { note?: string }).note ?? "", /rollbackOnRegression was string, not a boolean/);
    assert.equal((r as { rollbackChoiceUncertain?: true }).rollbackChoiceUncertain, true);
  });

  it("a whole-BLOCK rename also marks uncertainty (top-level unknown key)", async () => {
    const r = await read({ releaseMethod: "guarded-release", guardedReleaseConfigV2: { metricKeys: ["m1"] } });
    assert.equal((r as { rollbackChoiceUncertain?: true }).rollbackChoiceUncertain, true);
  });

  it("known inner fields and empty values stay silent", async () => {
    const r = await read({
      releaseMethod: "guarded-release",
      guardedReleaseConfig: { rolloutContextKindKey: "user", metricKeys: ["m1"], rollbackOnRegression: true, stages: [] },
    });
    assert.equal(r.status, "ok");
    assert.equal((r as { note?: string }).note, undefined);
  });
});

describe("readReleasePolicy: retry shape", () => {
  it("SPACES its retries with doubling backoff", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const ld = {
      projectKey: "p",
      request: async () => {
        if (++calls <= 2) throw new Error("connection reset");
        return { status: 200, ok: true, data: { releaseMethod: "" } };
      },
    } as unknown as LdClient;
    const r = await readReleasePolicy(ld, "f", "production", { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(r.status, "absent");
    // The previous loop never slept at all: six attempts in ~0ms, covering only
    // sub-millisecond failures while claiming parity with the monitor's spaced polling.
    assert.deepEqual(sleeps, [250, 500]);
  });

  it("does NOT stack retries on an exhausted 429 budget", async () => {
    // An LdApiError(429) can only surface after LdClient spent its own backoff, so retrying
    // here multiplies a storm for no new information — and stalls a webhook handler.
    let calls = 0;
    const ld = {
      projectKey: "p",
      request: async () => {
        calls++;
        throw new LdApiError("GET", "/internal/x", 429, {});
      },
    } as unknown as LdClient;
    const r = await readReleasePolicy(ld, "f", "production", { sleep: async () => {} });
    assert.equal(r.status, "unreadable");
    assert.equal(calls, 1, "one attempt, not the full budget");
  });

  it("gives up after the bounded attempt count on other errors", async () => {
    let calls = 0;
    const ld = {
      projectKey: "p",
      request: async () => {
        calls++;
        throw new Error("reset");
      },
    } as unknown as LdClient;
    const r = await readReleasePolicy(ld, "f", "production", { sleep: async () => {} });
    assert.equal(r.status, "unreadable");
    assert.equal(calls, 3);
  });
});
