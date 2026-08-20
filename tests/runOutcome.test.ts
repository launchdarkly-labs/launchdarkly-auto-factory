import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveOutcome } from "@auto-factory/phase1-cli";

const base = { verificationFailed: false, loopExhausted: false, apply: false, noop: false, incomplete: false };

describe("deriveOutcome (safety-critical record mapping)", () => {
  it("a non-converged loop records as 'incomplete' — NOT a new outcome value", () => {
    // This is the back-compat contract: pre-push hooks deployed before loop
    // support block on 'incomplete', so a loop-exhausted run must map to it.
    assert.equal(deriveOutcome({ ...base, loopExhausted: true }), "incomplete");
    // Even if a stale routing tag made the verdict look approved.
    assert.equal(deriveOutcome({ ...base, loopExhausted: true, apply: true }), "incomplete");
  });

  it("verification failure takes precedence over everything", () => {
    assert.equal(deriveOutcome({ ...base, verificationFailed: true, loopExhausted: true, apply: true }), "verification-failed");
  });

  it("maps the normal verdicts", () => {
    assert.equal(deriveOutcome({ ...base, apply: true }), "approved");
    assert.equal(deriveOutcome({ ...base, noop: true }), "noop");
    assert.equal(deriveOutcome({ ...base, incomplete: true }), "incomplete");
    assert.equal(deriveOutcome({ ...base }), "rejected");
  });
});
