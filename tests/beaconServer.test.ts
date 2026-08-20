import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";

import { MemoryDeployStateStore, MemoryPendingStore, createApp, type BeaconConfig, type GitHubClient } from "@auto-factory/beacon";
import type { LdClient } from "@auto-factory/shared";

const SECRET = "s3cret";

const cfg: BeaconConfig = {
  secret: SECRET,
  githubToken: "unused",
  ldEnvironmentKey: "production",
  releaseFlagsDir: ".release-flags/",
  stateFile: "unused-by-tests.json",
  pendingFile: "unused-pending-by-tests.json",
  services: {
    "demo-backend": {
      side: "backend",
      repo: { owner: "o", name: "r" },
      statusUrl: "http://unused/api/status",
      statusShaField: "version",
      privateNetwork: false,
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
  opts2: { releasesListThrows?: boolean; patchThrows?: boolean } = {},
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
      if (opts2.patchThrows) throw new Error("LaunchDarkly PATCH failed: HTTP 502 — bad gateway");
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
  ldOpts: { releasesListThrows?: boolean; patchThrows?: boolean } = {},
): Promise<Harness> {
  const patches: unknown[] = [];
  const monitored: string[] = [];
  const listDirRefs: string[] = [];
  const app = createApp(cfg, fakeLd(activeReleases, patches, ldOpts), {
    store: new MemoryDeployStateStore(),
    pending: new MemoryPendingStore(),
    gh: fakeGh(listDirRefs),
    onReleaseStarted: (flagKey) => {
      monitored.push(flagKey);
    },
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
    ldOpts: { releasesListThrows?: boolean; patchThrows?: boolean } = {},
  ): Promise<Harness> {
    const h = await startHarness(activeReleases, ldOpts);
    harnesses.push(h);
    return h;
  }

  it("a store write failure answers 500 and the service SURVIVES", async () => {
    // Express 4 does not forward async handler rejections, and Node kills the process on an
    // unhandled one — so this used to take the whole service down mid-request, answering nothing
    // and killing every detached release monitor with it. Both stores write on every notification
    // and Beacon documents itself as running on an ephemeral filesystem, so ENOSPC / a read-only
    // mount is an ordinary production failure, not a contrived one.
    const failing = new MemoryDeployStateStore();
    failing.record = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const app = createApp(cfg, fakeLd({}, []), {
      store: failing,
      pending: new MemoryPendingStore(),
      gh: fakeGh([]),
      onReleaseStarted: () => {},
    });
    const server: Server = await new Promise((res) => {
      const sv = app.listen(0, () => res(sv));
    });
    try {
      const { port } = server.address() as { port: number };
      const post = async () =>
        fetch(`http://127.0.0.1:${port}/flag-releases`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-beacon-secret": SECRET },
          body: JSON.stringify({ service: "demo-backend", sha: "sha2", environment: "production" }),
        });
      const first = await post();
      assert.equal(first.status, 500, "answered, rather than dropping the connection");
      assert.match(JSON.stringify(await first.json()), /ENOSPC/, "the cause is reported to the caller");
      // THE DISCRIMINATOR: the process is still alive to serve the retry the 500 asks for.
      const second = await post();
      assert.equal(second.status, 500);
    } finally {
      server.close();
    }
  });

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
// Round seven, finding 1: the fullstack readiness check must not fail OPEN into
// "waiting". `otherSideHasFile(...).catch(() => false)` read "we could not check"
// as "the other side has not deployed" and acked 200 — the provider marked the
// delivery handled, nothing organic rediscovers the manifest, and the release
// stranded until a human re-POSTed. An incomplete check must answer retriably.
// ---------------------------------------------------------------------------
describe("beacon: fullstack readiness check failure", () => {
  const harnesses: Array<{ close(): void }> = [];
  const servers: Server[] = [];
  after(() => {
    harnesses.forEach((h) => h.close());
    servers.forEach((s) => s.close());
  });

  /** A local status endpoint for the "other side", answering a deployed SHA. */
  function statusEndpoint(): Promise<string> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "fe-sha" }));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        resolve(`http://127.0.0.1:${port}/api/status`);
      });
    });
  }

  async function fullstackHarness(fileExists: () => Promise<boolean>): Promise<Harness> {
    const fullCfg: BeaconConfig = {
      ...cfg,
      services: {
        ...cfg.services,
        "demo-frontend": {
          side: "frontend",
          repo: { owner: "o", name: "fe" },
          statusUrl: await statusEndpoint(),
          statusShaField: "version",
          privateNetwork: false,
        },
      },
    };
    const patches: unknown[] = [];
    const monitored: string[] = [];
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-9.json"];
      },
      async getFileJson(): Promise<unknown> {
        return { flagKey: "enable-both", scope: "fullstack" };
      },
      fileExists,
    } as unknown as GitHubClient;
    const app = createApp(fullCfg, fakeLd({}, patches), {
      store: new MemoryDeployStateStore(),
      pending: new MemoryPendingStore(),
      gh,
      onReleaseStarted: (flagKey) => {
      monitored.push(flagKey);
    },
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
          listDirRefs: [],
          close: () => server.close(),
        });
      });
    });
  }

  it("DIAGNOSES an incomplete readiness check distinctly, and acks rather than retrying", async () => {
    // gh.fileExists throws on any non-404 (github.ts) — a 403 rate limit is the
    // review's exact failure scenario, with both sides actually deployed.
    const h = await fullstackHarness(async () => {
      throw new Error("GitHub /repos/o/fe/contents failed: HTTP 403 — rate limited");
    });
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });

    // THE DISCRIMINATOR IS THE DIAGNOSIS, NOT THE STATUS. Under `.catch(() => false)`
    // this reported action "waiting" / "other service not deployed yet" — a confident
    // claim about a service it never reached, which sends an operator to the wrong
    // place. The tri-state classifier is kept for exactly this.
    const outcome = res.json.outcomes[0];
    assert.equal(outcome.action, "error", "an unverifiable check is not the normal 'waiting' state");
    assert.match(String(outcome.detail), /could not be VERIFIED/);
    assert.doesNotMatch(String(outcome.detail), /not deployed/, "must not assert the other side is behind");

    // 200, NOT 503, and the strand is deliberate: a redelivery can re-release a flag
    // LaunchDarkly already reverted (round eight, F1), which is worse than a strand a
    // human can fix. The detail must therefore not promise an automatic retry.
    assert.equal(res.status, 200);
    // The ledger re-checks it on a later deploy; the message must say so rather than
    // claiming nothing will ever retry (it used to, correctly, before the ledger existed).
    assert.match(String(outcome.detail), /ledger will re-check/);
    assert.match(String(outcome.detail), /re-POST to retry now/);
    assert.deepEqual(h.patches, [], "no release started on an unverified readiness");
  });

  it("still acks 200 'waiting' on a DEFINITIVE not-deployed (GitHub 404)", async () => {
    const h = await fullstackHarness(async () => false); // fileExists=false is a real 404
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcomes[0].action, "waiting");
    assert.deepEqual(h.patches, []);
  });

  it("releases when the other side definitively has the file", async () => {
    const h = await fullstackHarness(async () => true);
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcomes[0].action, "released");
  });
});

// ---------------------------------------------------------------------------
// The idempotency guard must FAIL CLOSED. It used to be `.catch(() => null)`, which
// answered "does this flag already have an active release?" with "no" whenever the read
// failed — and then performed a write. Read failures cluster during rate limiting and
// outages, so the wrong answer arrived exactly when it did the most damage.
//
// The 503 is a REFUSAL, not a working retry: the Notifier logs a non-2xx and exits 0, and
// Railway documents no webhook retry, so recovery is a human re-POST. The status is still
// right — it cannot duplicate a release, and it works for a CD system that does retry —
// but the outcome must not promise an automatic one.
// ---------------------------------------------------------------------------
describe("beacon: idempotency guard failure", () => {
  const harnesses: Harness[] = [];
  after(() => harnesses.forEach((h) => h.close()));

  it("starts NOTHING and answers 503 when the guard read fails", async () => {
    const h = await startHarness({}, { releasesListThrows: true });
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1", environment: "production" });
    // 503, not 200: the work is unfinished and nothing was started.
    assert.equal(res.status, 503);
    const outcome = res.json.outcomes[0];
    assert.equal(outcome.action, "error");
    assert.match(String(outcome.detail), /NOT started/);
    assert.match(String(outcome.detail), /re-POST/, "the recovery action must be stated, not implied");
    assert.doesNotMatch(
      String(outcome.detail),
      /redeliver this notification to retry/,
      "must not promise a redelivery that nothing performs",
    );
    // THE DISCRIMINATOR: no write happened. Under `.catch(() => null)` triggerRelease runs
    // and records a startAutomatedRelease patch, and the status is 200.
    assert.deepEqual(h.patches, []);
    assert.deepEqual(h.monitored, []);
  });
});

// ---------------------------------------------------------------------------
// A triggerRelease throw ACKS 200 and strands the flag — and must keep doing so.
//
// Round seven wanted this retriable, on the argument that retrying is safe by
// construction (a landed patch comes back as `already_running`). Round eight
// falsified it: that holds only while the release is RUNNING. The case a
// provider's backoff actually produces is the patch landing, the response being
// lost, the guarded release running, a metric regressing, and LaunchDarkly
// REVERTING it. `reverted` is terminal, so `findActiveRelease` sees nothing, the
// noop guard sees served(original) != target, and the redelivery starts a SECOND
// release of the variation the guardrail just rolled back.
//
// So this asserts the ABSENCE of a retriable answer. It is a deliberate strand,
// pending the re-evaluation ledger in docs/loop-seam.md.
// ---------------------------------------------------------------------------
describe("beacon: release trigger failure", () => {
  const harnesses: Harness[] = [];
  after(() => harnesses.forEach((h) => h.close()));

  it("acks 200 and asks for a human re-POST when the trigger throws mid-release", async () => {
    const h = await startHarness({}, { patchThrows: true });
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });
    // 503 here would invite the redelivery that re-releases a reverted flag.
    assert.equal(res.status, 200);
    const outcome = res.json.outcomes[0];
    assert.equal(outcome.action, "error");
    assert.match(String(outcome.detail), /HTTP 502/, "the cause must survive into the outcome");
    assert.match(String(outcome.detail), /ledger will re-check/);
    assert.match(String(outcome.detail), /re-POST to retry now/, "the faster recovery must be stated");
    // A THROW HERE MAY LAND AFTER THE PATCH APPLIED (`startRelease` awaits res.text()), which is
    // why the slot is claimed. So this outcome must NOT tell an operator the release was not
    // started: acting on that in the LaunchDarkly UI starts a second rollout of a flag that may
    // already be releasing. The idempotency sites may say "NOT started" — their read failed before
    // any write — and this one may not.
    assert.doesNotMatch(String(outcome.detail), /not started/i, "the write state here is UNKNOWN, not known-not-written");
    assert.match(String(outcome.detail), /UNKNOWN/, "and it says so");
    assert.deepEqual(h.monitored, [], "nothing handed to the monitor for a failed trigger");
  });

  it("a re-POST while the release is still running converges on already_running", async () => {
    // The recovery path a human takes after the strand above. Note this converges
    // only because the release is RUNNING — once it reaches a terminal status the
    // guard cannot see it, which is precisely why the 503 was reverted.
    const h = await startHarness({ "enable-one": "rel-9" }, { patchThrows: true });
    harnesses.push(h);
    const res = await h.post("/flag-releases", { service: "demo-backend", sha: "sha1" });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcomes[0].action, "already_running");
  });
});

// ---------------------------------------------------------------------------
// One watch per flag/environment in flight, asserted THROUGH createApp.
//
// The dedup used to sit only in the `deps.onReleaseStarted ?? …` default branch,
// so every test — all of which inject that dep — ran straight past it. Sabotaging
// the wrapper changed no test result. It now wraps the attach function
// unconditionally, which is both the property Beacon wants and the only way this
// is observable from outside.
// ---------------------------------------------------------------------------
describe("beacon: release monitors are deduped per flag/environment", () => {
  const harnesses: Array<{ close(): void }> = [];
  after(() => harnesses.forEach((h) => h.close()));

  it("a redelivered already_running does not stack a second watch", async () => {
    const attaches: string[] = [];
    let release!: () => void;
    const hanging = new Promise<void>((r) => {
      release = r;
    });
    // A real monitor polls for up to 24h. Dedup is only observable while one is
    // IN FLIGHT, so the injected attach must not settle until we say so.
    const app = createApp(cfg, fakeLd({ "enable-one": "rel-9" }, []), {
      store: new MemoryDeployStateStore(),
      pending: new MemoryPendingStore(),
      gh: fakeGh([]),
      onReleaseStarted: async (flagKey, environmentKey) => {
        attaches.push(`${flagKey}/${environmentKey}`);
        await hanging;
      },
    });
    const server: Server = await new Promise((res) => {
      const s = app.listen(0, () => res(s));
    });
    harnesses.push({ close: () => server.close() });
    const { port } = server.address() as { port: number };
    const post = async (): Promise<number> => {
      const r = await fetch(`http://127.0.0.1:${port}/flag-releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-beacon-secret": SECRET },
        body: JSON.stringify({ service: "demo-backend", sha: "sha1", environment: "production" }),
      });
      return r.status;
    };

    assert.equal(await post(), 200);
    assert.equal(await post(), 200, "a redelivery is still acked");
    assert.deepEqual(attaches, ["enable-one/production"], "the second delivery must not attach a second watch");

    // Once the first watch settles the key frees, so a later release can be watched —
    // that is the Beacon-restart recovery path, and it must not be dedup'd away forever.
    release();
    await hanging;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await post(), 200);
    assert.equal(attaches.length, 2, "a settled watch frees the key for the next release");
  });
});
