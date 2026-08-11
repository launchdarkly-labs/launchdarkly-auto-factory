import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// The Notifier bin, executed for real.
//
// notify.ts calls main() at import, so nothing can import it — which is exactly the
// gap that let three round-seven fixes ship with tested helpers and unwired call
// sites. Here the helper (notifyReport) is tested separately and THIS runs the
// actual bin as a subprocess, so the wiring is covered too: does it call the
// reporter, does it route attention to stderr, and does it still exit 0?
//
// That last one is the contract that must never break: the Notifier is a post-deploy
// step and must never fail a deploy. Everything else about this file exists so that
// "must not fail the deploy" stops meaning "must not tell anyone".
// ---------------------------------------------------------------------------

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "beacon", "dist", "notify.js");

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** A stand-in Beacon that answers every POST with the given status and JSON body. */
function fakeBeacon(status: number, body: unknown): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function runNotify(beaconUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("node", [BIN, "--service", "demo-backend", "--sha", "abc123"], {
      env: { ...process.env, BEACON_URL: beaconUrl, BEACON_WEBHOOK_SECRET: "s3cret" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("auto-factory-notify (the bin)", () => {
  it("reports stranded flags on stderr and STILL exits 0", async () => {
    const url = await fakeBeacon(200, {
      discovered: 2,
      outcomes: [
        { flag: "enable-one", action: "released" },
        { flag: "enable-two", action: "held", detail: "notBefore 2026-12-01" },
      ],
    });
    const r = await runNotify(url);
    assert.equal(r.code, 0, "a post-deploy hook must never fail the deploy");
    assert.match(r.stderr, /ACTION REQUIRED/, "the operator-visible marker must reach stderr");
    assert.match(r.stderr, /enable-two: held/);
    // THE DISCRIMINATOR: before this, a 200 printed as success and the strand was invisible.
    assert.doesNotMatch(r.stdout, /ACTION REQUIRED/, "attention belongs on stderr, not stdout");
  });

  it("a clean deploy stays on stdout and exits 0", async () => {
    const url = await fakeBeacon(200, { discovered: 1, outcomes: [{ flag: "enable-one", action: "released" }] });
    const r = await runNotify(url);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /enable-one=released/);
    assert.equal(r.stderr.trim(), "", "a clean deploy must not cry wolf");
  });

  it("a 503 is reported loudly and still exits 0", async () => {
    const url = await fakeBeacon(503, { outcomes: [{ flag: "enable-one", action: "error" }] });
    const r = await runNotify(url);
    assert.equal(r.code, 0, "even a Beacon outage must not fail the deploy");
    assert.match(r.stderr, /ACTION REQUIRED/);
    assert.match(r.stderr, /NOT REDELIVERED/);
    assert.match(r.stderr, /re-checks them on the NEXT deploy/);
  });

  it("an unreachable Beacon is reported loudly and still exits 0", async () => {
    // Port 1 refuses: this is the pre-response path, where fetch itself throws.
    const r = await runNotify("http://127.0.0.1:1");
    assert.equal(r.code, 0);
    assert.match(r.stderr, /ACTION REQUIRED/);
    assert.match(r.stderr, /could not reach Beacon/);
  });
});
