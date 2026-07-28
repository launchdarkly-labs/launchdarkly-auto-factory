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
