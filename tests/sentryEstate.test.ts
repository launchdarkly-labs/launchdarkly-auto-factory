import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  findRelatedIssue,
  getEstatePicture,
  searchIssues,
  type SentryConnection,
} from "@auto-factory/shared";

const conn: SentryConnection = {
  authToken: "tok",
  org: "acme",
  project: "app",
  apiBase: "https://sentry.test",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("sentryClient searchIssues / findRelatedIssue", () => {
  it("parses issue list and prefers flag-titled match", async () => {
    mockFetch((url) => {
      assert.match(url, /\/issues\//);
      return {
        status: 200,
        body: [
          { id: "1", title: "Other boom", shortId: "APP-1" },
          { id: "2", title: "Error in new-greeting path", shortId: "APP-2" },
        ],
      };
    });
    const items = await searchIssues(conn, { query: "is:unresolved new-greeting" });
    assert.equal(items.length, 2);

    const related = await findRelatedIssue(conn, { flagKey: "new-greeting" });
    assert.equal(related?.id, "2");
  });

  it("falls back to top issue when flag not in titles", async () => {
    mockFetch(() => ({
      status: 200,
      body: [{ id: "9", title: "Generic", shortId: "APP-9" }],
    }));
    const related = await findRelatedIssue(conn, { flagKey: "missing-flag" });
    assert.equal(related?.id, "9");
  });
});

describe("getEstatePicture", () => {
  it("returns unavailable when connection is null", async () => {
    const pic = await getEstatePicture({ connection: null });
    assert.equal(pic.available, false);
    assert.match(pic.warning ?? "", /SENTRY_AUTH_TOKEN/);
  });

  it("assembles a picture from mocked Sentry APIs", async () => {
    mockFetch((url) => {
      if (url.includes("/issues/")) {
        return {
          status: 200,
          body: [{ id: "1", title: "Boom new-greeting", shortId: "APP-1", count: "12" }],
        };
      }
      if (url.includes("/events/stats/")) {
        return { status: 200, body: [[1_700_000_000, [{ count: 3 }]], [1_700_003_600, [{ count: 5 }]]] };
      }
      if (url.includes("/organizations/") && url.includes("/events/?")) {
        return { status: 200, body: { data: [{ "count()": 8 }] } };
      }
      if (url.includes("/events/") && url.includes("full=true")) {
        return {
          status: 200,
          body: [
            { context: { launchdarklyContext: { key: "u1" } }, tags: [] },
            { context: {}, tags: [{ key: "flag", value: "new-greeting" }] },
          ],
        };
      }
      return { status: 404, body: {} };
    });

    const pic = await getEstatePicture({
      connection: conn,
      flagKey: "new-greeting",
      windowHours: 24,
    });
    assert.equal(pic.available, true);
    assert.equal(pic.errorCountApprox, 8);
    assert.equal(pic.topIssues?.[0]?.id, "1");
    assert.equal(pic.attribution?.withLaunchdarklyContext, 1);
    assert.equal(pic.attribution?.launchdarklyContextGap, false);
    assert.ok(pic.dualExportHint);
  });
});
