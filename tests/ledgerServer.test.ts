import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";

import {
  MemoryDeployStateStore,
  MemoryPendingStore,
  createApp,
  type BeaconConfig,
  type GitHubClient,
} from "@auto-factory/beacon";
import type { LdClient } from "@auto-factory/shared";

// ---------------------------------------------------------------------------
// The ledger, end to end through createApp.
//
// The point of the ledger is that discovery CANNOT surface an unfinished flag a
// second time: discovery is a filename diff, so a manifest present at both SHAs is
// invisible to it forever. These tests therefore always use a second deploy whose
// diff contains nothing new — if the flag gets another evaluation, the ledger is the
// only thing that could have produced it.
//
// The safety half matters as much as the retry half. Re-evaluation is a WRITE path,
// and `findActiveRelease` excludes terminal statuses — so without a guard it would
// see "nothing running" for a release LaunchDarkly already REVERTED and start a
// second rollout of the variation the guardrail just rolled back. Automating that
// would have been strictly worse than the strand it replaced.
// ---------------------------------------------------------------------------

const SECRET = "s3cret";
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

const cfg: BeaconConfig = {
  secret: SECRET,
  githubToken: "unused",
  ldEnvironmentKey: "production",
  releaseFlagsDir: ".release-flags/",
  stateFile: "unused.json",
  pendingFile: "unused.json",
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

/** The manifest exists at EVERY sha — the shape discovery can never re-surface. */
function ghAlways(manifest: unknown, opts: { missingAt?: string } = {}): GitHubClient {
  return {
    async listDir(): Promise<string[]> {
      return ["pr-1.json"];
    },
    async getFileJson(_repo: unknown, _path: string, ref: string): Promise<unknown> {
      if (opts.missingAt === ref) return null;
      return manifest;
    },
    async fileExists(): Promise<boolean> {
      return true;
    },
  } as unknown as GitHubClient;
}

interface LdOpts {
  /** Releases returned by the automated-releases listing, newest first. */
  releases?: Array<{ id: string; status: string }>;
  /** Per-flag releases, for tests where two flags must differ. Overrides `releases`. */
  releasesByFlag?: Record<string, Array<{ id: string; status: string }>>;
  releasesThrows?: boolean;
  /** Variation the environment currently serves ("off" = a dark flag awaiting release). */
  served?: "on" | "off";
}

function fakeLd(patches: unknown[], o: LdOpts = {}): LdClient {
  return {
    projectKey: "p",
    async request(opts: { path: string }): Promise<{ status: number; ok: boolean; data: unknown }> {
      if (opts.path.includes("/automated-releases")) {
        if (o.releasesThrows) throw new Error("connection reset");
        const flagKey = opts.path.split("/flags/")[1]?.split("/")[0] ?? "";
        const items = o.releasesByFlag ? (o.releasesByFlag[flagKey] ?? []) : (o.releases ?? []);
        return { status: 200, ok: true, data: { items } };
      }
      if (opts.path.includes("/release-settings")) return { status: 404, ok: true, data: null };
      if (opts.path.includes("/dependent-flags") || opts.path.includes("/flags?")) {
        return { status: 200, ok: true, data: { items: [] } };
      }
      return { status: 200, ok: true, data: {} };
    },
    async getFlag(): Promise<{ status: number; ok: boolean; data: unknown }> {
      const on = { _id: "var-on", value: true };
      const off = { _id: "var-off", value: false };
      return {
        status: 200,
        ok: true,
        data: {
          variations: [on, off],
          environments: { production: { on: o.served === "on" } },
        },
      };
    },
    async patchFlagSemantic(flagKey: string, env: string, instructions: unknown[]): Promise<unknown> {
      patches.push({ flagKey, env, instructions });
      return { status: 200, ok: true, data: {} };
    },
  } as unknown as LdClient;
}

interface H {
  post(sha: string): Promise<{ status: number; json: any }>;
  patches: unknown[];
  pending: MemoryPendingStore;
  close(): void;
}

async function harness(gh: GitHubClient, ld: LdClient, patches: unknown[]): Promise<H> {
  const pending = new MemoryPendingStore();
  const app = createApp(cfg, ld, {
    store: new MemoryDeployStateStore(),
    pending,
    gh,
    onReleaseStarted: () => {},
  });
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  servers.push(server);
  const { port } = server.address() as { port: number };
  return {
    async post(sha: string) {
      const r = await fetch(`http://127.0.0.1:${port}/flag-releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-beacon-secret": SECRET },
        body: JSON.stringify({ service: "demo-backend", sha, environment: "production" }),
      });
      return { status: r.status, json: await r.json() };
    },
    patches,
    pending,
    close: () => server.close(),
  };
}

const HELD_MANIFEST = {
  flagKey: "enable-one",
  scope: "backend",
  // An unparseable notBefore normalizes to `hold` (fail-closed) — the manifest-fix case.
  releaseIntent: { action: "auto", notBefore: "next tuesday" },
};
const GOOD_MANIFEST = { flagKey: "enable-one", scope: "backend" };

describe("ledger: re-evaluation on a later deploy", () => {
  it("re-reads the manifest AT THE CURRENT SHA, so a human's fix takes effect", async () => {
    // THE PROPERTY THAT MATTERED MOST. Editing a bad releaseIntent used to be a no-op:
    // the file existed at both SHAs, so discovery never looked at it again.
    const patches: unknown[] = [];
    let manifest: unknown = HELD_MANIFEST;
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-1.json"];
      },
      async getFileJson(): Promise<unknown> {
        return manifest;
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(gh, fakeLd(patches, { served: "off" }), patches);

    const first = await h.post("sha1");
    assert.equal(first.json.outcomes[0].action, "held", "an unintelligible notBefore holds, fail-closed");
    assert.equal(h.pending.list("demo-backend", "production").length, 1, "held work is remembered");

    // The human fixes the manifest. No new manifest file, so discovery finds NOTHING.
    manifest = GOOD_MANIFEST;
    const second = await h.post("sha2");
    assert.equal(second.json.discovered, 0, "discovery cannot see it — this must come from the ledger");
    const o = second.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.ok(o?.viaLedger, "the outcome is attributed to the ledger");
    assert.equal(o.action, "released", "the fix took effect");
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "released ⇒ no longer pending");
  });

  it("drops an entry whose manifest has been deleted — the release was withdrawn", async () => {
    const patches: unknown[] = [];
    const h = await harness(ghAlways(HELD_MANIFEST, { missingAt: "sha2" }), fakeLd(patches, { served: "off" }), patches);
    await h.post("sha1");
    assert.equal(h.pending.list("demo-backend", "production").length, 1);
    const second = await h.post("sha2");
    const o = second.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.equal(o.action, "skipped");
    assert.match(String(o.detail), /withdrawn|absent/);
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "stop tracking a withdrawn release");
  });

  it("does not evaluate a flag twice when discovery already handled it", async () => {
    const patches: unknown[] = [];
    const h = await harness(ghAlways(HELD_MANIFEST), fakeLd(patches, { served: "off" }), patches);
    await h.post("sha1");
    // Same sha ⇒ resolvePreviousSha uses `prior`, so discovery re-surfaces pr-1.json.
    const again = await h.post("sha1");
    const forFlag = again.json.outcomes.filter((x: any) => x.flag === "enable-one");
    assert.equal(forFlag.length, 1, "one evaluation per notification, whichever path found it");
  });
});

describe("ledger: the guard that makes automatic re-evaluation safe", () => {
  it("REFUSES to re-trigger when the newest release was REVERTED", async () => {
    // The F1 hazard, now on an automatic path. findActiveRelease excludes terminal
    // statuses, so without this guard the ledger would start a second rollout of the
    // variation a guardrail just rolled back — worse than the strand it replaced.
    const patches: unknown[] = [];
    const h = await harness(
      ghAlways(HELD_MANIFEST),
      fakeLd(patches, { served: "off", releases: [{ id: "rel-1", status: "reverted" }] }),
      patches,
    );
    await h.post("sha1");
    const before = patches.length;
    const second = await h.post("sha2");
    const o = second.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.equal(o.action, "error");
    assert.equal(o.needsHuman, true, "a guardrail rollback needs a decision, not a retry");
    assert.match(String(o.detail), /reverted/);
    assert.equal(patches.length, before, "THE DISCRIMINATOR: no release was started");
    assert.equal(h.pending.list("demo-backend", "production")[0]?.needsHuman, true);
  });

  it("a needsHuman entry is reported on every deploy but never re-tried", async () => {
    const patches: unknown[] = [];
    const h = await harness(
      ghAlways(HELD_MANIFEST),
      fakeLd(patches, { served: "off", releases: [{ id: "rel-1", status: "reverted" }] }),
      patches,
    );
    await h.post("sha1");
    await h.post("sha2");
    const before = patches.length;
    const third = await h.post("sha3");
    const o = third.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.equal(o.needsHuman, true);
    assert.match(String(o.detail), /NEEDS A HUMAN/);
    assert.equal(patches.length, before, "still nothing started");
  });

  it("notices a release that COMPLETED unwatched, and repoints its children", async () => {
    // The other observation the ledger exists for: monitoring stopped at its deadline,
    // a human resumed the release, and it finished with nobody watching.
    const patches: unknown[] = [];
    const h = await harness(
      ghAlways(HELD_MANIFEST),
      fakeLd(patches, { served: "off", releases: [{ id: "rel-1", status: "completed" }] }),
      patches,
    );
    await h.post("sha1");
    const second = await h.post("sha2");
    const o = second.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.equal(o.action, "noop");
    assert.match(String(o.detail), /completed while unwatched/);
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "finished ⇒ no longer pending");
  });

  it("FAILS CLOSED when the release history cannot be read", async () => {
    const patches: unknown[] = [];
    const h = await harness(ghAlways(HELD_MANIFEST), fakeLd(patches, { served: "off" }), patches);
    await h.post("sha1");
    // Now make the listing throw for the ledger pass.
    const throwing = await harness(ghAlways(HELD_MANIFEST), fakeLd(patches, { releasesThrows: true }), patches);
    await throwing.post("sha1").catch(() => undefined);
    const before = patches.length;
    const second = await throwing.post("sha2");
    const o = second.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.ok(o, "the entry is still reported");
    assert.equal(o.action, "error");
    assert.equal(patches.length, before, "no history means no permission to trigger");
    assert.ok(throwing.pending.list("demo-backend", "production").length >= 1, "still pending, not forgotten");
  });
});

describe("re-POST safety: a repeat evaluation of an already-processed sha", () => {
  it("REFUSES to re-release a flag whose newest release was reverted", async () => {
    // The manual-recovery half of the same hazard. `findActiveRelease` excludes terminal
    // statuses, and a revert restores the ORIGINAL variation — so served != target and the
    // noop guard does not fire either. Without this, a well-meaning re-POST after a
    // rollback starts a second rollout of the variation the guardrail rejected.
    const patches: unknown[] = [];
    const h = await harness(
      ghAlways(GOOD_MANIFEST),
      fakeLd(patches, { served: "off", releases: [{ id: "rel-1", status: "reverted" }] }),
      patches,
    );
    await h.post("sha1"); // first evaluation: sha is new
    const before = patches.length;
    const repeat = await h.post("sha1"); // the human re-POSTs the same sha
    const o = repeat.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.equal(o.action, "error");
    assert.equal(o.needsHuman, true);
    assert.match(String(o.detail), /already processed/);
    assert.equal(patches.length, before, "THE DISCRIMINATOR: no second release");
  });

  it("but a NEW sha still releases — fix-and-redeploy is the way out of a revert", async () => {
    // The guard must not make a reverted flag permanently unreleasable. A new sha is a new
    // intent, and LaunchDarkly's release object carries no target variation, so the sha is
    // the only thing that distinguishes the two cases.
    //
    // Shape matters here: the dev's fix arrives as a NEW manifest (a new PR), so discovery
    // surfaces it at sha2. With no new manifest there is nothing to release and nothing in
    // the ledger either — the first release succeeded, which is why it was cleared.
    const patches: unknown[] = [];
    const gh = {
      async listDir(_repo: unknown, _dir: string, ref: string): Promise<string[]> {
        return ref === "sha1" ? ["pr-1.json"] : ["pr-1.json", "pr-2.json"];
      },
      async getFileJson(): Promise<unknown> {
        return GOOD_MANIFEST;
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(
      gh,
      fakeLd(patches, { served: "off", releases: [{ id: "rel-1", status: "reverted" }] }),
      patches,
    );
    await h.post("sha1");
    const before = patches.length;
    const fixed = await h.post("sha2"); // the dev fixed the regression and deployed
    const o = fixed.json.outcomes.find((x: any) => x.flag === "enable-one");
    assert.ok(o, "the new manifest is discovered at the new sha");
    assert.equal(o.action, "released", "a new commit must be able to start a fresh release");
    assert.ok(patches.length > before, "the guard must not make a reverted flag unreleasable forever");
  });

  it("fails closed when the history cannot be read on a repeat sha", async () => {
    const patches: unknown[] = [];
    const h = await harness(ghAlways(GOOD_MANIFEST), fakeLd(patches, { served: "off" }), patches);
    await h.post("sha1");
    const throwing = await harness(ghAlways(GOOD_MANIFEST), fakeLd(patches, { releasesThrows: true }), patches);
    const r = await throwing.post("sha1");
    // The idempotency guard also cannot read, so this is a 503 either way — the point is
    // that nothing was written.
    assert.equal(r.status, 503);
  });
});


// ---------------------------------------------------------------------------
// Round nine, finding 1 (CRITICAL): the ledger's identity must be the manifest's
// ADDRESS, not its content.
//
// An earlier revision keyed entries on flagKey and merely remembered sourceFile. So
// when a human fixed a manifest by correcting the flag key — exactly the fix an
// `error`/`held` entry invites — the safety guard inspected the OLD flag while the
// trigger fired on the NEW one, starting a second rollout of a variation a guardrail
// had rolled back. The entry then never cleared (recordOutcome keyed by the outcome's
// flag), so it repeated on every deploy: Beacon and the guardrail fighting each other.
//
// These tests hold the FILENAME and the SHA-direction fixed and vary the FLAGKEY —
// the axis every pre-existing ledger test held constant, which is why this passed.
// ---------------------------------------------------------------------------
describe("ledger identity: the manifest's address, not its content", () => {
  const heldAs = (flagKey: string) => ({
    flagKey,
    scope: "backend",
    releaseIntent: { action: "auto", notBefore: "next tuesday" },
  });

  it("guards the flag the manifest names NOW, not the one it used to name", async () => {
    const patches: unknown[] = [];
    let manifest: unknown = heldAs("flag-a");
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-1.json"];
      },
      async getFileJson(): Promise<unknown> {
        return manifest;
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    // flag-b's newest release was REVERTED by a guardrail; flag-a has no releases.
    const h = await harness(
      gh,
      fakeLd(patches, { served: "off", releasesByFlag: { "flag-b": [{ id: "rel-1", status: "reverted" }] } }),
      patches,
    );

    await h.post("sha1");
    const [entry] = h.pending.list("demo-backend", "production");
    assert.equal(entry?.sourceFile, ".release-flags/pr-1.json", "the entry is keyed by the manifest path");
    assert.equal(entry?.flagKey, "flag-a", "the flag it named is remembered for reporting");

    // The human fixes the manifest: it should have pointed at flag-b all along.
    manifest = heldAs("flag-b");
    const before = patches.length;
    const second = await h.post("sha2");

    const o = second.json.outcomes.find((x: any) => x.sourceFile === ".release-flags/pr-1.json");
    assert.ok(o, "the entry is re-evaluated");
    assert.equal(o.flag, "flag-b", "the outcome is about the flag the manifest names now");
    assert.equal(o.needsHuman, true, "flag-b's guardrail rollback must be respected");
    assert.equal(patches.length, before, "THE DISCRIMINATOR: no second rollout of the reverted variation");
  });

  it("does not leave a zombie entry when the flagKey changes", async () => {
    // The entry must still be ONE entry, updated — not a stale twin that never clears.
    const patches: unknown[] = [];
    let manifest: unknown = heldAs("flag-a");
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-1.json"];
      },
      async getFileJson(): Promise<unknown> {
        return manifest;
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(gh, fakeLd(patches, { served: "off" }), patches);

    await h.post("sha1");
    manifest = { flagKey: "flag-b", scope: "backend" }; // fixed key AND fixed intent
    await h.post("sha2");

    assert.deepEqual(
      h.pending.list("demo-backend", "production"),
      [],
      "the release succeeded under the new key, so the entry clears — no stale twin",
    );
  });

  it("two manifests naming the same flag are two entries, not one", async () => {
    // A consequence of address-keying, accepted deliberately: two manifests are two units
    // of work. The second is harmless — it finds the release already running, or noops.
    const patches: unknown[] = [];
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-1.json", "pr-2.json"];
      },
      async getFileJson(): Promise<unknown> {
        return heldAs("same-flag");
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(gh, fakeLd(patches, { served: "off" }), patches);
    await h.post("sha1");
    const paths = h.pending
      .list("demo-backend", "production")
      .map((e) => e.sourceFile)
      .sort();
    assert.deepEqual(paths, [".release-flags/pr-1.json", ".release-flags/pr-2.json"]);
  });
});


// ---------------------------------------------------------------------------
// Round ten, findings 2 and 3: the ledger's identity is the manifest's address, but
// the TARGET of an action is (flagKey, environment) — only one variation of a flag can
// be releasing at a time. Keying the memory right and leaving the action unguarded let
// two manifests naming one flag both reach triggerRelease in one notification.
//
// And `handledThisRound` was the last flagKey-keyed comparison left in Beacon, wrong in
// both directions: it skipped an entry whenever a DIFFERENT manifest naming the same flag
// was discovered, and failed to skip a genuine duplicate when the flagKey was corrected.
// ---------------------------------------------------------------------------
describe("one action per flag per notification", () => {
  const held = (flagKey: string) => ({
    flagKey,
    scope: "backend",
    releaseIntent: { action: "auto", notBefore: "next tuesday" },
  });

  it("two manifests naming one flag produce ONE trigger, and the second stays pending", async () => {
    const patches: unknown[] = [];
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-41.json", "pr-42.json"];
      },
      async getFileJson(): Promise<unknown> {
        return { flagKey: "checkout-flow", scope: "backend" }; // both releasable
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(gh, fakeLd(patches, { served: "off" }), patches);
    const r = await h.post("sha1");

    const starts = (patches as Array<{ instructions?: Array<{ kind?: string }> }>).filter((p) =>
      (p.instructions ?? []).some((i) => i.kind === "startAutomatedRelease"),
    );
    assert.equal(starts.length, 1, "THE DISCRIMINATOR: never two releases for one flag in one notification");

    const deferred = r.json.outcomes.filter((o: any) => String(o.detail).includes("deferred"));
    assert.equal(deferred.length, 1, "the second manifest is deferred, not silently dropped");
    // Non-final, so the ledger keeps it. Reporting `already_running` would be FINAL and would
    // clear the entry — discarding unreleased work and calling it success.
    assert.equal(deferred[0].action, "held");
    const pendingPaths = h.pending.list("demo-backend", "production").map((e) => e.sourceFile);
    assert.deepEqual(pendingPaths, [".release-flags/pr-42.json"], "the deferred manifest is still tracked");
  });

  it("a pending entry is NOT skipped because a different manifest names the same flag", async () => {
    const patches: unknown[] = [];
    let files = ["pr-41.json"];
    const gh = {
      async listDir(_r: unknown, _d: string, ref: string): Promise<string[]> {
        return ref === "sha1" ? ["pr-41.json"] : files;
      },
      async getFileJson(_r: unknown, path: string): Promise<unknown> {
        return held("checkout-flow"); // both manifests name the same flag, both held
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(gh, fakeLd(patches, { served: "off" }), patches);

    await h.post("sha1"); // pr-41 → held → pending
    files = ["pr-41.json", "pr-42.json"];
    const second = await h.post("sha2"); // pr-42 discovered, names the SAME flag

    const forPr41 = second.json.outcomes.find((o: any) => o.sourceFile === ".release-flags/pr-41.json");
    assert.ok(forPr41, "pr-41 must still be re-evaluated — under flagKey keying it vanished from the report");
    const entry41 = h.pending.list("demo-backend", "production").find((e) => e.sourceFile.includes("pr-41"));
    assert.equal(entry41?.lastSha, "sha2", "its lastSha must advance; frozen state also defeats a sha-ahead gate");
    assert.ok((entry41?.attempts ?? 0) >= 2);
  });
});
