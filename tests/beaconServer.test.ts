import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, describe, it } from "node:test";

import { MemoryDeployStateStore, createApp, type BeaconConfig, type GitHubClient } from "@auto-factory/beacon";
import type { LdClient } from "@auto-factory/shared";

const SECRET = "s3cret";

const cfg: BeaconConfig = {
  secret: SECRET,
  githubToken: "unused",
  ldEnvironmentKey: "production",
  releaseFlagsDir: ".release-flags/",
  stateFile: "unused-by-tests.json",
  services: {
    "demo-backend": {
      side: "backend",
      repo: { owner: "o", name: "r" },
      statusUrl: "http://unused/api/status",
      statusShaField: "version",
    },
  },
};

/** Fake GitHub: sha1 has pr-1; sha2 adds pr-2. Both manifests are backend-scoped. */
function fakeGh(listDirRefs: string[]): GitHubClient {
  return {
    async listDir(_repo: unknown, _dir: string, ref: string): Promise<string[]> {
      listDirRefs.push(ref);
      return ref === "sha1" ? ["pr-1.json"] : ["pr-1.json", "pr-2.json"];
    },
    async getFileJson(_repo: unknown, path: string): Promise<unknown> {
      const flagKey = path.includes("pr-2") ? "enable-two" : "enable-one";
      return { flagKey, scope: "backend", releaseOverrides: { metricKeys: [`${flagKey}-error-rate`] } };
    },
    async fileExists(): Promise<boolean> {
      return true;
    },
  } as unknown as GitHubClient;
}

/** Fake LD client covering what triggerRelease + findActiveRelease touch. */
function fakeLd(
  activeReleases: Record<string, string>,
  patches: unknown[],
  opts2: { releasesListThrows?: boolean } = {},
): LdClient {
  return {
    projectKey: "autofactory-demo",
    async request(opts: { path: string }): Promise<{ status: number; ok: boolean; data: unknown }> {
      if (opts.path.includes("/automated-releases")) {
        if (opts2.releasesListThrows) throw new Error("connection reset");
        const flagKey = opts.path.split("/flags/")[1]?.split("/")[0] ?? "";
        const id = activeReleases[flagKey];
        return { status: 200, ok: true, data: { items: id ? [{ id, status: "in_progress" }] : [] } };
      }
      if (opts.path.includes("/release-settings")) {
        return { status: 404, ok: true, data: null }; // no configured policy
      }
      throw new Error(`unexpected LD request: ${opts.path}`);
    },
    async getFlag(): Promise<{ status: number; ok: boolean; data: unknown }> {
      return {
        status: 200,
        ok: true,
        data: {
          variations: [
            { _id: "var-on", value: true },
            { _id: "var-off", value: false },
          ],
        },
      };
    },
    async patchFlagSemantic(flagKey: string, env: string, instructions: unknown[]): Promise<unknown> {
      patches.push({ flagKey, env, instructions });
      return { status: 200, ok: true, data: {} };
    },
  } as unknown as LdClient;
}

interface Harness {
  post(path: string, body: unknown, secretHeader?: string | null): Promise<{ status: number; json: any }>;
  patches: unknown[];
  monitored: string[];
  listDirRefs: string[];
  close(): void;
}

function startHarness(
  activeReleases: Record<string, string> = {},
  ldOpts: { releasesListThrows?: boolean } = {},
): Promise<Harness> {
  const patches: unknown[] = [];
  const monitored: string[] = [];
  const listDirRefs: string[] = [];
  const app = createApp(cfg, fakeLd(activeReleases, patches, ldOpts), {
    store: new MemoryDeployStateStore(),
    gh: fakeGh(listDirRefs),
    onReleaseStarted: (flagKey) => monitored.push(flagKey),
  });
  return new Promise((resolveStart) => {
    const server: Server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolveStart({
        async post(path, body, secretHeader = SECRET) {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(secretHeader ? { "x-beacon-secret": secretHeader } : {}),
            },
            body: JSON.stringify(body),
          });
          return { status: res.status, json: await res.json() };
        },
        patches,
        monitored,
        listDirRefs,
        close: () => server.close(),
      });
    });
  });
}

describe("Beacon server", async () => {
  const harnesses: Harness[] = [];
  after(() => harnesses.forEach((h) => h.close()));
  async function harness(
    activeReleases: Record<string, string> = {},
    ldOpts: { releasesListThrows?: boolean } = {},
  ): Promise<Harness> {
    const h = await startHarness(activeReleases, ldOpts);
    harnesses.push(h);
    return h;
  }

  it("rejects a missing or wrong secret on both endpoints", async () => {
    const h = await harness();
    assert.equal((await h.post("/flag-releases", {}, null)).status, 401);
    assert.equal((await h.post("/flag-releases", {}, "wrong")).status, 401);
    assert.equal((await h.post("/webhooks/railway", {}, null)).status, 401);
  });

  it("accepts the secret as a query parameter (header-less providers)", async () => {
    const h = await harness();
    const res = await h.post(`/webhooks/railway?secret=${SECRET}`, { status: "BUILDING" }, null);
    assert.equal(res.status, 200);
    assert.equal(res.json.ignored, true);
  });

  it("releases discovered flags and tracks deploy state across notifications", async () => {
    const h = await harness();

    // First deploy: no state → everything at sha1 is new.
    const first = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });
    assert.equal(first.status, 200);
    assert.equal(first.json.previousShaSource, "none");
    assert.deepEqual(
      first.json.outcomes.map((o: { flag: string; action: string }) => [o.flag, o.action]),
      [["enable-one", "released"]],
    );

    // Second deploy: previousSha comes from state → only pr-2 is new.
    const second = await h.post("/flag-releases", { service: "demo-backend", sha: "sha2" });
    assert.equal(second.json.previousSha, "sha1");
    assert.equal(second.json.previousShaSource, "state");
    assert.deepEqual(
      second.json.outcomes.map((o: { flag: string }) => o.flag),
      ["enable-two"],
    );

    // Re-delivered notification: re-diffs the same range (prior), not sha2..sha2.
    const redelivered = await h.post("/flag-releases", { service: "demo-backend", sha: "sha2" });
    assert.equal(redelivered.json.previousSha, "sha1");
    assert.equal(redelivered.json.discovered, 1);

    // Guarded release started (metricKeys present) + handed to the monitor.
    assert.equal(h.patches.length >= 1, true);
    const instructions = (h.patches[0] as { instructions: Array<Record<string, unknown>> }).instructions;
    // The fake flag is dark (no environments payload) → the patch must turn
    // targeting on atomically with starting the release (LD rejects releases
    // on off flags — confirmed live: "flag … is off").
    assert.equal(instructions[0]?.kind, "turnFlagOn");
    const instr = instructions[1];
    assert.equal(instr?.kind, "startAutomatedRelease");
    assert.equal(instr?.releaseKind, "guarded");
    // LD rejects guarded stages above 50% — confirmed live ("stage allocation
    // must not exceed 50%"); the release completes to 100% after the last stage.
    const stages = instr?.stages as Array<{ allocation: number }>;
    assert.equal(stages.length > 0, true);
    for (const s of stages) assert.equal(s.allocation <= 50000, true, `stage ${s.allocation} exceeds 50%`);
    assert.equal(h.monitored.includes("enable-one"), true);
  });

  it("does not double-trigger a flag whose release is already running", async () => {
    const h = await harness({ "enable-one": "rel-123" });
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });
    const outcome = res.json.outcomes[0];
    assert.equal(outcome.action, "already_running");
    assert.deepEqual(outcome.detail, { releaseId: "rel-123" });
    assert.equal(h.patches.length, 0);
    assert.deepEqual(h.monitored, ["enable-one"]); // monitoring re-attached
  });

  it("translates a Railway deploy webhook into the same handling", async () => {
    const h = await harness();
    const res = await h.post(`/webhooks/railway?secret=${SECRET}`, {
      type: "DEPLOY",
      status: "SUCCESS",
      service: { name: "demo-backend" },
      environment: { name: "production" },
      deployment: { meta: { commitHash: "sha1" } },
    }, null);
    assert.equal(res.status, 200);
    assert.equal(res.json.service, "demo-backend");
    assert.equal(res.json.outcomes[0].action, "released");
  });

  it("rejects unknown services and unrecognized Railway payloads", async () => {
    const h = await harness();
    assert.equal((await h.post("/flag-releases", { service: "nope", sha: "x" })).status, 400);
    assert.equal((await h.post(`/webhooks/railway?secret=${SECRET}`, { status: "SUCCESS" }, null)).status, 422);
  });
});

// ---------------------------------------------------------------------------
// The idempotency guard must FAIL CLOSED. It used to be `.catch(() => null)`, which
// answered "does this flag already have an active release?" with "no" whenever the read
// failed — and then performed a write. Read failures cluster during rate limiting and
// outages, which is exactly when providers redeliver.
// ---------------------------------------------------------------------------
describe("beacon: idempotency guard failure", () => {
  const harnesses: Harness[] = [];
  after(() => harnesses.forEach((h) => h.close()));

  it("starts NOTHING and answers retriably when the guard read fails", async () => {
    const h = await startHarness({}, { releasesListThrows: true });
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1", environment: "production" });
    // 503, not 200: the work is unfinished, and redelivery is how it gets retried.
    assert.equal(res.status, 503);
    const outcome = res.json.outcomes[0];
    assert.equal(outcome.action, "error");
    assert.match(String(outcome.detail), /NOT started/);
    assert.match(String(outcome.detail), /redeliver/);
    // THE DISCRIMINATOR: no write happened. Under `.catch(() => null)` triggerRelease runs
    // and records a startAutomatedRelease patch, and the status is 200.
    assert.deepEqual(h.patches, []);
    assert.deepEqual(h.monitored, []);
  });
});
