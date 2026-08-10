import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";

import { otherSideHasFile, type BeaconConfig, type GitHubClient } from "@auto-factory/beacon";

// ---------------------------------------------------------------------------
// Round seven, finding 1: the fullstack readiness check must be TRI-STATE.
// "The other side has not deployed" (absent — the other side's own deploy
// notification is the retry) and "we could not find out" (unknown — nothing
// retries it) previously both collapsed to `false`, so a GitHub rate limit or a
// dead status endpoint read as "not deployed yet" and the release stranded in a
// 200-acked "waiting" forever.
// ---------------------------------------------------------------------------

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** A local status endpoint answering with the given JSON body (or status). */
function statusEndpoint(body: unknown, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}/api/status`);
    });
  });
}

function cfgWith(frontendStatusUrl: string): BeaconConfig {
  return {
    secret: "s",
    githubToken: "unused",
    ldEnvironmentKey: "production",
    releaseFlagsDir: ".release-flags/",
    stateFile: "unused.json",
    services: {
      "demo-backend": {
        side: "backend",
        repo: { owner: "o", name: "backend" },
        statusUrl: "http://127.0.0.1:1/unused",
        statusShaField: "version",
      },
      "demo-frontend": {
        side: "frontend",
        repo: { owner: "o", name: "frontend" },
        statusUrl: frontendStatusUrl,
        statusShaField: "version",
      },
    },
  };
}

function ghWhereFileExists(answer: () => Promise<boolean>): GitHubClient {
  return { fileExists: answer } as unknown as GitHubClient;
}

describe("otherSideHasFile — tri-state readiness", () => {
  it("present: the other side's deployed SHA has the file", async () => {
    const cfg = cfgWith(await statusEndpoint({ version: "fe-sha" }));
    const gh = ghWhereFileExists(async () => true);
    assert.deepEqual(await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json"), { state: "present" });
  });

  it("absent: a readable SHA plus a definitive GitHub 404", async () => {
    const cfg = cfgWith(await statusEndpoint({ version: "fe-sha" }));
    const gh = ghWhereFileExists(async () => false); // fileExists answers false ONLY on 404
    assert.deepEqual(await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json"), { state: "absent" });
  });

  it("unknown, NOT absent: the GitHub read fails (rate limit / 5xx / network)", async () => {
    // The exact failure from the review: both sides deployed, GitHub answers 403
    // mid-check. gh.fileExists throws on any non-404 error (github.ts), so this is
    // the real input shape.
    const cfg = cfgWith(await statusEndpoint({ version: "fe-sha" }));
    const gh = ghWhereFileExists(async () => {
      throw new Error("GitHub /repos/... failed: HTTP 403 — rate limit exceeded");
    });
    const r = await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json");
    assert.equal(r.state, "unknown");
    assert.match((r as { reason: string }).reason, /403/);
  });

  it("unknown, NOT absent: the status endpoint is unreachable", async () => {
    const cfg = cfgWith("http://127.0.0.1:1/api/status"); // nothing listens on port 1
    const gh = ghWhereFileExists(async () => true); // never reached
    const r = await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json");
    assert.equal(r.state, "unknown");
    assert.match((r as { reason: string }).reason, /unreachable/);
  });

  it("unknown, NOT absent: the status endpoint answers non-OK", async () => {
    const cfg = cfgWith(await statusEndpoint({ error: "boom" }, 502));
    const gh = ghWhereFileExists(async () => true);
    const r = await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json");
    assert.equal(r.state, "unknown");
    assert.match((r as { reason: string }).reason, /HTTP 502/);
  });

  it("unknown, NOT absent: the status endpoint has no usable SHA field", async () => {
    const cfg = cfgWith(await statusEndpoint({ version: 42 }));
    const gh = ghWhereFileExists(async () => true);
    const r = await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json");
    assert.equal(r.state, "unknown");
    assert.match((r as { reason: string }).reason, /'version' field/);
  });

  it("never throws: all failures are folded into the unknown state", async () => {
    const cfg = cfgWith(await statusEndpoint({ version: "fe-sha" }));
    const gh = ghWhereFileExists(async () => {
      throw new Error("boom");
    });
    // Would previously surface via the caller's `.catch(() => false)` → waiting.
    await assert.doesNotReject(otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json"));
  });

  it("absent when no opposite-side service is registered (pre-existing behavior)", async () => {
    const cfg = cfgWith(await statusEndpoint({ version: "fe-sha" }));
    delete (cfg.services as Record<string, unknown>)["demo-frontend"];
    const gh = ghWhereFileExists(async () => true);
    assert.deepEqual(await otherSideHasFile(cfg, gh, "backend", ".release-flags/pr-1.json"), { state: "absent" });
  });
});
