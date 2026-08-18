import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findRelatedSentryIssue,
  seerSettingsFromEnv,
  startSeerAutofix,
  triggerSeerOnRevert,
} from "@auto-factory/beacon";

describe("seerAutofix settings", () => {
  it("defaults to disabled", () => {
    const s = seerSettingsFromEnv({});
    assert.equal(s.enabled, false);
    assert.equal(s.stoppingPoint, "open_pr");
  });

  it("reads env knobs", () => {
    const s = seerSettingsFromEnv({
      BEACON_SEER_AUTOFIX: "true",
      SENTRY_AUTH_TOKEN: "tok",
      SENTRY_ORG: "acme",
      SENTRY_PROJECT: "app",
      BEACON_SEER_STOPPING_POINT: "root_cause",
    });
    assert.equal(s.enabled, true);
    assert.equal(s.org, "acme");
    assert.equal(s.stoppingPoint, "root_cause");
  });
});

describe("seerAutofix HTTP", () => {
  it("findRelatedSentryIssue returns null when creds missing", async () => {
    const issue = await findRelatedSentryIssue(seerSettingsFromEnv({}), {
      flagKey: "new-greeting",
      environmentKey: "production",
    });
    assert.equal(issue, null);
  });

  it("startSeerAutofix reports missing creds", async () => {
    const r = await startSeerAutofix(seerSettingsFromEnv({}), "123", {
      flagKey: "x",
      environmentKey: "production",
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /missing/);
  });

  it("triggerSeerOnRevert is a no-op when disabled", async () => {
    // Must not throw.
    await triggerSeerOnRevert(
      { flagKey: "x", environmentKey: "production" },
      seerSettingsFromEnv({ BEACON_SEER_AUTOFIX: "false" }),
    );
  });
});
