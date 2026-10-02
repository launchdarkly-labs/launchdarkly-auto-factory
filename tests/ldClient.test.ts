import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LdApiError, LdClient } from "@auto-factory/shared";

const conn = { apiKey: "tok-123", baseUrl: "https://ld.example", projectKey: "p" };

function withFetch(impl: typeof fetch): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = orig;
  };
}

describe("LdClient", () => {
  it("sends the raw Authorization header and parses JSON", async () => {
    let capturedUrl = "";
    let capturedAuth: unknown;
    const restore = withFetch((async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ key: "f" }), { status: 200 });
    }) as unknown as typeof fetch);

    const res = await new LdClient(conn).getFlag<{ key: string }>("f");
    restore();

    assert.equal(res.status, 200);
    assert.equal(res.data.key, "f");
    assert.equal(capturedAuth, "tok-123");
    assert.ok(capturedUrl.includes("/api/v2/flags/p/f"));
  });

  it("treats 409 as ok for createFlag (okStatuses)", async () => {
    const restore = withFetch((async () => new Response("{}", { status: 409 })) as unknown as typeof fetch);
    const res = await new LdClient(conn).createFlag({ key: "f" });
    restore();
    assert.equal(res.status, 409);
    assert.equal(res.ok, true);
  });

  it("throws LdApiError on an unexpected error status", async () => {
    const restore = withFetch((async () => new Response("nope", { status: 400 })) as unknown as typeof fetch);
    await assert.rejects(() => new LdClient(conn).getFlag("f"), (e: unknown) => {
      assert.ok(e instanceof LdApiError);
      assert.equal((e as LdApiError).status, 400);
      assert.equal((e as LdApiError).attempts, 1);
      return true;
    });
    restore();
  });

  it("retries a 5xx on GET, then surfaces it with the attempt count and a logged request", async () => {
    let attempts = 0;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    const restore = withFetch((async () => {
      attempts += 1;
      return new Response('{"code":"internal_service_error"}', { status: 500, headers: { "Retry-After": "0.01" } });
    }) as unknown as typeof fetch);

    await assert.rejects(() => new LdClient(conn).getFlag("f"), (e: unknown) => {
      assert.ok(e instanceof LdApiError);
      assert.equal((e as LdApiError).status, 500);
      assert.equal((e as LdApiError).attempts, 3);
      assert.match((e as Error).message, /after 3 attempts/);
      return true;
    });
    restore();
    console.warn = origWarn;

    assert.equal(attempts, 3); // initial try + SERVER_ERROR_RETRIES
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /HTTP 500 after 3 attempt\(s\).*internal_service_error.*Request body: \(none\)/);
  });

  it("retries a 5xx on createFlag and logs the payload if it never succeeds", async () => {
    let attempts = 0;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    const restore = withFetch((async () => {
      attempts += 1;
      return new Response("", { status: 503, headers: { "Retry-After": "0.01" } });
    }) as unknown as typeof fetch);

    await assert.rejects(() => new LdClient(conn).createFlag({ key: "f", description: "gates x" }), LdApiError);
    restore();
    console.warn = origWarn;

    assert.equal(attempts, 3);
    assert.match(warnings[0] ?? "", /POST \/api\/v2\/flags\/p → HTTP 503.*"description":"gates x"/);
  });

  it("recovers when a retried create comes back 409 (the first attempt landed)", async () => {
    let attempts = 0;
    const restore = withFetch((async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("", { status: 502, headers: { "Retry-After": "0.01" } })
        : new Response("{}", { status: 409 });
    }) as unknown as typeof fetch);

    const res = await new LdClient(conn).createFlag({ key: "f" });
    restore();
    assert.equal(res.status, 409);
    assert.equal(attempts, 2);
  });

  it("keeps the full 429 budget after earlier 5xx retries", async () => {
    let attempts = 0;
    const origWarn = console.warn;
    console.warn = () => {};
    const restore = withFetch((async () => {
      attempts += 1;
      return attempts <= 2
        ? new Response("{}", { status: 500, headers: { "Retry-After": "0.01" } })
        : new Response('{"code":"rate_limited"}', { status: 429, headers: { "Retry-After": "0.01" } });
    }) as unknown as typeof fetch);

    await assert.rejects(() => new LdClient(conn).getFlag("f"), (e: unknown) => {
      assert.equal((e as LdApiError).status, 429);
      assert.equal((e as LdApiError).attempts, 9); // 2 × 500, then initial 429 + RATE_LIMIT_RETRIES
      return true;
    });
    restore();
    console.warn = origWarn;
    assert.equal(attempts, 9);
  });

  it("counts 429 retries in the reported attempts", async () => {
    let attempts = 0;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    const restore = withFetch((async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('{"code":"rate_limited"}', { status: 429, headers: { "Retry-After": "0.01" } })
        : new Response("{}", { status: 500, headers: { "Retry-After": "0.01" } });
    }) as unknown as typeof fetch);

    await assert.rejects(() => new LdClient(conn).getFlag("f"), (e: unknown) => {
      assert.equal((e as LdApiError).attempts, 4); // 429, then 500 + SERVER_ERROR_RETRIES
      return true;
    });
    restore();
    console.warn = origWarn;
    assert.equal(attempts, 4);
    assert.match(warnings[0] ?? "", /after 4 attempt\(s\)/);
  });

  it("honors an HTTP-date Retry-After on a 5xx instead of the 1s fallback", async () => {
    let attempts = 0;
    const t0 = Date.now();
    const restore = withFetch((async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("{}", { status: 503, headers: { "Retry-After": new Date(Date.now() - 5000).toUTCString() } })
        : new Response('{"key":"f"}', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await new LdClient(conn).getFlag<{ key: string }>("f");
    restore();
    assert.equal(res.status, 200);
    assert.equal(attempts, 2);
    assert.ok(Date.now() - t0 < 500, "a past HTTP-date means retry now, not after the 1s fallback");
  });

  it("never retries a 5xx on PATCH (a semantic patch could apply twice)", async () => {
    let attempts = 0;
    const origWarn = console.warn;
    console.warn = () => {};
    const restore = withFetch((async () => {
      attempts += 1;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch);

    await assert.rejects(() => new LdClient(conn).patchFlagSemantic("f", "production", [{ kind: "turnFlagOn" }]), LdApiError);
    restore();
    console.warn = origWarn;
    assert.equal(attempts, 1);
  });

  it("retries 429s honoring Retry-After, then succeeds", async () => {
    let attempts = 0;
    const t0 = Date.now();
    const restore = withFetch((async () => {
      attempts += 1;
      if (attempts <= 2) {
        return new Response('{"code":"rate_limited"}', { status: 429, headers: { "Retry-After": "0.05" } });
      }
      return new Response('{"key":"f"}', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await new LdClient(conn).getFlag<{ key: string }>("f");
    restore();

    assert.equal(res.status, 200);
    assert.equal(attempts, 3);
    assert.ok(Date.now() - t0 >= 100, "should have slept through two backoffs");
  });

  it("surfaces the 429 as LdApiError when retries are exhausted", async () => {
    let attempts = 0;
    const restore = withFetch((async () => {
      attempts += 1;
      return new Response('{"code":"rate_limited"}', { status: 429, headers: { "Retry-After": "0.01" } });
    }) as unknown as typeof fetch);

    await assert.rejects(() => new LdClient(conn).getFlag("f"), (e: unknown) => {
      assert.ok(e instanceof LdApiError);
      assert.equal((e as LdApiError).status, 429);
      return true;
    });
    restore();
    assert.equal(attempts, 7); // initial try + RATE_LIMIT_RETRIES
  });

  it("falls back to X-Ratelimit-Reset (clamped to the minimum backoff) when Retry-After is absent", async () => {
    let attempts = 0;
    const t0 = Date.now();
    const restore = withFetch((async () => {
      attempts += 1;
      if (attempts === 1) {
        // Reset in the past → clamped up to the 500ms minimum backoff.
        return new Response('{"code":"rate_limited"}', {
          status: 429,
          headers: { "X-Ratelimit-Reset": String(Date.now() - 1000) },
        });
      }
      return new Response('{"key":"f"}', { status: 200 });
    }) as unknown as typeof fetch);

    const res = await new LdClient(conn).getFlag<{ key: string }>("f");
    restore();

    assert.equal(res.status, 200);
    assert.equal(attempts, 2);
    assert.ok(Date.now() - t0 >= 450, "should have slept ~the minimum backoff");
  });

  it("sends the semantic-patch content-type for flag patches", async () => {
    let ct: unknown;
    const restore = withFetch((async (_url: string, init: RequestInit) => {
      ct = (init.headers as Record<string, string>)["Content-Type"];
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    await new LdClient(conn).patchFlagSemantic("f", "production", [{ kind: "turnFlagOn" }]);
    restore();
    assert.match(String(ct), /domain-model=launchdarkly\.semanticpatch/);
  });
});
