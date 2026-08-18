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
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
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

  it("matches feature:broken-sign-in for enable-broken-sign-in (coffee-lab shape)", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(decodeURIComponent(url));
      if (url.includes("feature%3Abroken-sign-in") || url.includes("feature:broken-sign-in")) {
        return {
          status: 200,
          body: [
            {
              id: "7636790656",
              shortId: "COFFEE-LAB-11",
              title: 'error: relation "usernames" does not exist',
              culprit: "POST /api/auth/login",
            },
          ],
        };
      }
      // Raw flag-key free-text search returns nothing (real Sentry behavior).
      return { status: 200, body: [] };
    });
    const related = await findRelatedIssue(conn, { flagKey: "enable-broken-sign-in" });
    assert.equal(related?.shortId, "COFFEE-LAB-11");
    assert.ok(seen.some((u) => u.includes("feature:broken-sign-in") || u.includes("feature%3Abroken-sign-in")));
  });

  it("falls back to top issue when flag not in titles", async () => {
    mockFetch(() => ({
      status: 200,
      body: [{ id: "9", title: "Generic", shortId: "APP-9" }],
    }));
    const related = await findRelatedIssue(conn, { flagKey: "missing-flag" });
    assert.equal(related?.id, "9");
  });

  it("rethrows when every Sentry query fails (e.g. 403 missing scopes)", async () => {
    mockFetch(() => ({ status: 403, body: { detail: "You do not have permission to perform this action." } }));
    await assert.rejects(
      () => findRelatedIssue(conn, { flagKey: "enable-broken-sign-in" }),
      /Sentry issues HTTP 403/,
    );
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
