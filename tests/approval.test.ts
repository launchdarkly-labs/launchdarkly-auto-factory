import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WalkVerdict } from "@auto-factory/shared";
import { decideApproval, interpretWalk } from "@auto-factory/shared";

/** Build a WalkVerdict with safe defaults (no verdict, no skip). */
const verdict = (o: Partial<WalkVerdict> = {}): WalkVerdict => ({
  reviewApproved: false,
  hasVerdict: false,
  skipFlagging: false,
  inconsistentSkip: false,
  orphanedFlagKeys: [],
  orphanedMetricKeys: [],
  ...o,
});

describe("decideApproval (verdict-only — approvals happen pre-execution via gates)", () => {
  it("approves when the reviewer approved", () => {
    const d = decideApproval(verdict({ hasVerdict: true, reviewApproved: true }));
    assert.equal(d.apply, true);
    assert.equal(d.noop, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /approved/i);
  });

  it("rejects only when a verdict WAS recorded and was negative", () => {
    const d = decideApproval(verdict({ hasVerdict: true, reviewApproved: false }));
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /reject/i);
  });

  it("reports INCOMPLETE (not a rejection) when NO verdict was recorded", () => {
    const d = decideApproval(verdict({ hasVerdict: false }));
    assert.equal(d.incomplete, true);
    assert.equal(d.apply, false);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("skip_flagging is a successful no-op regardless of verdict", () => {
    const d = decideApproval(verdict({ skipFlagging: true }));
    assert.equal(d.noop, true);
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("inconsistentSkip → INCOMPLETE, NOT a clean no-op (false-green guard)", () => {
    // skip_flagging + a flag was really created in an earlier iteration.
    const d = decideApproval(verdict({ skipFlagging: true, inconsistentSkip: true }));
    assert.equal(d.incomplete, true);
    assert.equal(d.noop, false);
    assert.equal(d.apply, false);
    assert.match(d.reason, /orphan/i);
  });

  it("orphanedFlagKeys → INCOMPLETE even if the reviewer approved", () => {
    const d = decideApproval(verdict({ hasVerdict: true, reviewApproved: true, orphanedFlagKeys: ["flag-old"] }));
    assert.equal(d.incomplete, true);
    assert.equal(d.apply, false);
    assert.match(d.reason, /flag-old/);
  });
});

describe("interpretWalk", () => {
  it("reads the canonical review_approved / risk_level tags", () => {
    const v = interpretWalk({ review_approved: "true", risk_level: "high" });
    assert.equal(v.hasVerdict, true);
    assert.equal(v.reviewApproved, true);
    assert.equal(v.risk, "high");
  });

  it("accepts approve/approved verdict spellings", () => {
    for (const val of ["approve", "approved", "true"]) {
      assert.equal(interpretWalk({ review_approved: val }).reviewApproved, true, val);
    }
    assert.equal(interpretWalk({ review_approved: "reject" }).reviewApproved, false);
  });

  it("falls back to legacy tag names", () => {
    assert.equal(interpretWalk({ review_decision: "approve" }).reviewApproved, true);
    assert.equal(interpretWalk({ decision: "approved" }).reviewApproved, true);
    assert.equal(interpretWalk({ risk: "medium" }).risk, "medium");
  });

  it("no verdict tags at all → hasVerdict false", () => {
    const v = interpretWalk({ flag_created: "true" });
    assert.equal(v.hasVerdict, false);
  });

  it("reads skip_flagging", () => {
    assert.equal(interpretWalk({ skip_flagging: "true" }).skipFlagging, true);
    assert.equal(interpretWalk({}).skipFlagging, false);
  });

  it("flags an inconsistent skip: skip_flagging set but inventory shows a created flag", () => {
    // Routing says "no flag needed" but the never-rewound inventory has one.
    const v = interpretWalk({ skip_flagging: "true" }, { flag_created: "true", flag_key: "flag-x" });
    assert.equal(v.inconsistentSkip, true);
  });

  it("does NOT flag inconsistency when no flag was created", () => {
    assert.equal(interpretWalk({ skip_flagging: "true" }, {}).inconsistentSkip, false);
  });

  it("detects a flag orphaned across iterations (earlier flag_key differs from final)", () => {
    const runs = [{ tags: { flag_key: "flag-old" } }, { tags: { flag_key: "flag-new" } }];
    const v = interpretWalk({}, { flag_key: "flag-new" }, runs);
    assert.deepEqual(v.orphanedFlagKeys, ["flag-old"]);
  });

  it("no orphan when every iteration used the same flag_key", () => {
    const runs = [{ tags: { flag_key: "flag-x" } }, { tags: { flag_key: "flag-x" } }];
    assert.deepEqual(interpretWalk({}, { flag_key: "flag-x" }, runs).orphanedFlagKeys, []);
  });
});

// ---------------------------------------------------------------------------
// The metrics author is the node a judge-driven quality loop re-runs, and
// `inventory.metric_keys` is last-write-wins — so an abandoned metric was
// previously invisible on a run that still exited 0.
// ---------------------------------------------------------------------------
describe("orphaned metrics (judge-driven rework on the metrics author)", () => {
  it("a rework that creates a DIFFERENT metric reports INCOMPLETE, not approved", () => {
    const runs = [
      { tags: { metric_keys: "checkout-conv-v1" } },
      { tags: { metric_keys: "checkout-conv-v2" } }, // iteration 2 replaced it
    ];
    const v = interpretWalk(
      { review_approved: "true" },
      { flag_key: "enable-x", metric_keys: "checkout-conv-v2" },
      runs,
    );
    assert.deepEqual(v.orphanedMetricKeys, ["checkout-conv-v1"]);
    const d = decideApproval(v);
    assert.equal(d.incomplete, true, "an orphaned metric must not report success");
    assert.equal(d.apply, false);
    assert.match(d.reason, /checkout-conv-v1/);
  });

  it("amending the SAME metric across iterations is clean", () => {
    // What the rework instructions tell the agent to do.
    const runs = [{ tags: { metric_keys: "checkout-conv" } }, { tags: { metric_keys: "checkout-conv" } }];
    const v = interpretWalk({ review_approved: "true" }, { metric_keys: "checkout-conv" }, runs);
    assert.deepEqual(v.orphanedMetricKeys, []);
    assert.equal(decideApproval(v).apply, true);
  });

  it("ADDING a metric on the rework is clean; dropping one is not", () => {
    // metric_keys is a comma-separated LIST, so this is a set comparison, not a
    // string comparison — a superset must not read as an orphan.
    const added = interpretWalk(
      { review_approved: "true" },
      { metric_keys: "a,b" },
      [{ tags: { metric_keys: "a" } }, { tags: { metric_keys: "a,b" } }],
    );
    assert.deepEqual(added.orphanedMetricKeys, []);
    assert.equal(decideApproval(added).apply, true);

    const dropped = interpretWalk(
      { review_approved: "true" },
      { metric_keys: "b" },
      [{ tags: { metric_keys: "a,b" } }, { tags: { metric_keys: "b" } }],
    );
    assert.deepEqual(dropped.orphanedMetricKeys, ["a"]);
    assert.equal(decideApproval(dropped).incomplete, true);
  });

  it("tolerates spacing and duplicates in the tag value", () => {
    const v = interpretWalk(
      { review_approved: "true" },
      { metric_keys: " b , b " },
      [{ tags: { metric_keys: "a, b" } }, { tags: { metric_keys: " b , b " } }],
    );
    assert.deepEqual(v.orphanedMetricKeys, ["a"]);
  });

  it("an orphaned FLAG still takes precedence in the reported reason", () => {
    const v = interpretWalk(
      { review_approved: "true" },
      { flag_key: "enable-y", metric_keys: "m2" },
      [{ tags: { flag_key: "enable-x", metric_keys: "m1" } }, { tags: { flag_key: "enable-y", metric_keys: "m2" } }],
    );
    assert.deepEqual(v.orphanedFlagKeys, ["enable-x"]);
    assert.deepEqual(v.orphanedMetricKeys, ["m1"]);
    const d = decideApproval(v);
    assert.equal(d.incomplete, true);
    assert.match(d.reason, /different flag/, "the flag is the more serious orphan");
  });
});
