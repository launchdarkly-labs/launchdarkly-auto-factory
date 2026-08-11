import assert from "node:assert/strict";
import { type Server } from "node:http";
import { after, describe, it } from "node:test";

import {
  MemoryDeployStateStore,
  MemoryPendingStore,
  createApp,
  describeNotifyResult,
  recordOutcome,
  type BeaconConfig,
  type GitHubClient,
} from "@auto-factory/beacon";
import type { LdClient } from "@auto-factory/shared";

// ---------------------------------------------------------------------------
// Round eleven: the ledger remembers a MANIFEST, but every "is this done?" decision was
// being made about its FLAG.
//
// The steady state these tests are built on is the documented one, not a misconfiguration:
// manifests are one per PR (`.release-flags/pr-<N>.json`), they are NEVER deleted, and an
// iteration PR targets a new variation of an EXISTING flag. So one flag routinely has
// several manifests, each wanting a different `targetVariation`, and only one variation of
// a flag can be releasing at a time.
//
// Three consequences, all of which reported success while losing work:
//  - "some release of this flag completed" cleared a manifest that wanted a LATER variation;
//  - `already_running` (a release of some OTHER variation) was final, clearing an entry;
//  - a manifest whose target was BEHIND what production serves held forever AND consumed
//    the flag's single per-notification action slot, starving the manifest that could
//    actually release. That deadlocked: zero releases, on every deploy, permanently.
//
// Every test here holds the flag, the service, the environment and the sha direction fixed
// and varies ONE thing — usually the target variation — because that is the axis the
// previous rounds all held constant.
// ---------------------------------------------------------------------------

const SECRET = "s3cret";
const FLAG = "checkout-flow";
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

/** A manifest, addressed by the PR that wrote it. */
const path = (pr: number): string => `.release-flags/pr-${pr}.json`;
const manifest = (targetVariation?: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  flagKey: FLAG,
  scope: "backend",
  ...(targetVariation !== undefined ? { targetVariation } : {}),
  ...extra,
});

/**
 * A repo whose `.release-flags/` contents are FIXED across shas — the shape discovery can
 * never re-surface, and the shape the ledger exists for. `files` is the listing order GitHub
 * would give (filename order, i.e. oldest PR first), which is deliberately the wrong
 * evaluation order for a lineage.
 */
function ghWith(files: string[], manifests: Record<string, unknown>): GitHubClient {
  return {
    async listDir(): Promise<string[]> {
      return files;
    },
    async getFileJson(_repo: unknown, p: string): Promise<unknown> {
      return manifests[p] ?? null;
    },
    async fileExists(): Promise<boolean> {
      return true;
    },
  } as unknown as GitHubClient;
}

interface MvState {
  /** Lineage values, in flag order. `control` is index 0. */
  values: string[];
  /** Is targeting on? A dark flag serves its off-variation (`control`). */
  on: boolean;
  /** What the fallthrough serves when on. Mutable: a test advances it to complete a release. */
  served: string;
  releases: Array<{ id: string; status: string }>;
  /** Child flags prerequisite'd on FLAG, for the repointing assertion. */
  children: Record<string, { pinned: string; tags?: string[] }>;
  /**
   * "The patch LANDED and the response was lost." Recorded first, then thrown — which is exactly
   * what a proxy 5xx or a truncated body does to `startRelease`'s `await res.text()`, and the one
   * shape in which Beacon cannot know whether it wrote.
   */
  patchLandsThenThrows?: (patch: Patch) => boolean;
}

const mvState = (o: Partial<MvState> = {}): MvState => ({
  values: ["control", "v1", "v2"],
  on: false,
  served: "control",
  releases: [],
  children: {},
  ...o,
});

interface Patch {
  flagKey: string;
  instructions: Array<Record<string, unknown>>;
}

/** An AutoFactory multivariate flag (control/v1/v2) with per-environment targeting. */
function fakeMvLd(state: MvState, patches: Patch[]): LdClient {
  const idx = (value: string): number => state.values.indexOf(value);
  return {
    projectKey: "p",
    async request(opts: { path: string }): Promise<{ status: number; ok: boolean; data: unknown }> {
      if (opts.path.includes("/automated-releases")) {
        return { status: 200, ok: true, data: { items: state.releases } };
      }
      // 200 with empty fields is what a live environment with no policy returns; a 404 would
      // be reported as UNREADABLE and add noise to every note these tests read.
      if (opts.path.includes("/release-settings")) {
        return { status: 200, ok: true, data: { releaseMethod: "", releasePolicyKey: "" } };
      }
      return { status: 200, ok: true, data: { items: [] } };
    },
    async getFlag(key: string): Promise<{ status: number; ok: boolean; data: unknown }> {
      if (key === FLAG) {
        return {
          status: 200,
          ok: true,
          data: {
            variations: state.values.map((value) => ({ _id: `id-${value}`, value })),
            defaults: { onVariation: 1, offVariation: 0 },
            environments: {
              production: {
                on: state.on,
                offVariation: idx("control"),
                fallthrough: { variation: idx(state.served) },
              },
            },
          },
        };
      }
      const child = state.children[key];
      if (!child) throw new Error(`no such flag ${key}`);
      return {
        status: 200,
        ok: true,
        data: {
          tags: child.tags ?? ["auto-factory"],
          environments: { production: { prerequisites: [{ key: FLAG, variation: idx(child.pinned) }] } },
        },
      };
    },
    async getDependentFlags(): Promise<{ status: number; ok: boolean; data: unknown }> {
      return { status: 200, ok: true, data: { items: Object.keys(state.children).map((key) => ({ key })) } };
    },
    async patchFlagSemantic(
      flagKey: string,
      _env: string,
      instructions: Array<Record<string, unknown>>,
    ): Promise<unknown> {
      patches.push({ flagKey, instructions });
      if (state.patchLandsThenThrows?.({ flagKey, instructions })) {
        throw new Error("socket hang up (the patch landed; the response did not)");
      }
      return { status: 200, ok: true, data: {} };
    },
  } as unknown as LdClient;
}

interface H {
  post(sha: string, previousSha?: string): Promise<{ status: number; json: any }>;
  patches: Patch[];
  pending: MemoryPendingStore;
  /** Every startAutomatedRelease instruction issued so far, in order. */
  starts(): Array<Record<string, unknown>>;
  /** Seed a ledger entry, in the order given — the ORDER is what several tests vary. */
  seed(pr: number, targetVariation?: string): void;
}

async function harness(gh: GitHubClient, state: MvState): Promise<H> {
  const patches: Patch[] = [];
  const pending = new MemoryPendingStore();
  const app = createApp(cfg, fakeMvLd(state, patches), {
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
    async post(sha: string, previousSha?: string) {
      const r = await fetch(`http://127.0.0.1:${port}/flag-releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-beacon-secret": SECRET },
        body: JSON.stringify({
          service: "demo-backend",
          sha,
          environment: "production",
          ...(previousSha ? { previousSha } : {}),
        }),
      });
      return { status: r.status, json: await r.json() };
    },
    patches,
    pending,
    starts: () =>
      patches
        .flatMap((p) => p.instructions)
        .filter((i) => i.kind === "startAutomatedRelease"),
    seed: (pr, targetVariation) =>
      recordOutcome(pending, {
        service: "demo-backend",
        environment: "production",
        sha: "sha0",
        flagKey: FLAG,
        sourceFile: path(pr),
        action: "held",
        ...(targetVariation !== undefined ? { targetVariation } : {}),
      }),
  };
}

const outcomeFor = (json: any, pr: number): any =>
  json.outcomes.find((o: { sourceFile: string }) => o.sourceFile === path(pr));

// ---------------------------------------------------------------------------
// THE STARVATION SCENARIO. Under the previous code this deadlocked forever with zero
// releases, and reported two ordinary outcomes while doing it.
// ---------------------------------------------------------------------------
describe("a manifest that writes nothing must not starve one that can release", () => {
  it("pr-40 held on a future notBefore does not stop pr-41 releasing v2", async () => {
    // pr-40 asks for v1 but is held until 2099. pr-41 asks for v2 and is releasable NOW.
    //
    // Before: pr-40 sorted first (filename order) and claimed the flag's action slot BEFORE
    // triggerRelease was even called — so it held, wrote nothing, and pr-41 was deferred. Both
    // stayed pending, and every later deploy repeated it identically. Nothing ever released.
    const state = mvState();
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], {
        [path(40)]: manifest("v1", { releaseIntent: { action: "auto", notBefore: "2099-01-01" } }),
        [path(41)]: manifest("v2"),
      }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1, "exactly one release for one flag");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "THE DISCRIMINATOR: v2 released, not nothing");

    // pr-40 is still held and still tracked. Note that BOTH halves of the fix make this work,
    // which is the robustness worth having: ordered v2-first it is deferred by pr-41's real
    // write, and evaluated v1-first it would hold on its own notBefore WITHOUT taking the slot.
    const forty = outcomeFor(r.json, 40);
    assert.equal(forty.action, "held");
    assert.equal(outcomeFor(r.json, 41).action, "released");

    const stillPending = h.pending.list("demo-backend", "production").map((e) => e.sourceFile);
    assert.deepEqual(stillPending, [path(40)], "only the genuinely-unfinished manifest stays tracked");
  });

  it("an intent HOLD does not claim the slot either, with the ordering held constant", async () => {
    // Isolates the slot fix from the ordering fix: both manifests ask for v2, so they rank
    // equally and the sort (which is stable) cannot reorder them. pr-50 is evaluated first and
    // holds on `action: hold`; pr-51 must still release.
    const h = await harness(
      ghWith([`pr-50.json`, `pr-51.json`], {
        [path(50)]: manifest("v2", { releaseIntent: { action: "hold" } }),
        [path(51)]: manifest("v2"),
      }),
      mvState(),
    );
    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1);
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2");
    assert.equal(outcomeFor(r.json, 50).action, "held");
    assert.equal(outcomeFor(r.json, 51).action, "released", "THE DISCRIMINATOR: a hold wrote nothing");
  });
});

// ---------------------------------------------------------------------------
// THREE WRITE STATES, NOT TWO: wrote, did not write, and DON'T KNOW. "Don't know" used to be
// filed with "did not write", because the action slot was claimed only on the success return.
// ---------------------------------------------------------------------------
describe("a trigger that THREW may have written, so it claims the flag's slot", () => {
  it("a lost response on v2's start does not let a sibling release v1 behind it", async () => {
    // PREVENTS: `startRelease` awaits `fetch` and then `res.text()`, so a proxy 5xx or a truncated
    // body throws AFTER LaunchDarkly applied the patch. With the slot left open, pr-40 releases v1
    // while v2's rollout may already be live — and NEITHER lineage guard catches it, because
    // mid-rollout the fallthrough still serves `control`, whose lineage index is undefined, so
    // both backwards guards fall through. Beacon would ramp production onto the older variation.
    const state = mvState({
      patchLandsThenThrows: (p) => p.instructions.some((i) => i.kind === "startAutomatedRelease"),
    });
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1, "THE DISCRIMINATOR: exactly one start, even though the first one's answer was lost");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "and it is v2's — v1 never got a rollout");
    assert.equal(outcomeFor(r.json, 41).action, "error", "the unknown write is reported as an error, not a success");
    assert.match(String(outcomeFor(r.json, 40).detail), /deferred/, "the sibling defers");

    // Both non-final, so nothing is discarded: the next deploy re-evaluates both, by which time
    // the releases listing says what actually happened.
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile).sort(),
      [path(40), path(41)],
    );
  });
});

// ---------------------------------------------------------------------------
// Evaluation ORDER. Whichever manifest is evaluated first decides what production gets, so
// for a lineage the newest (furthest-forward) one has to go first. Filename order and Map
// insertion order both mean "oldest wins", which is backwards.
// ---------------------------------------------------------------------------
describe("highest target variation acts first", () => {
  it("orders the DISCOVERED list, so v2 releases and v1 defers", async () => {
    // Both are releasable, which is what makes this purely about order: evaluated oldest-first,
    // pr-40 releases control→v1 and pr-41 is deferred — production gets the older variation and
    // the newer work waits for another deploy.
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      mvState(),
    );
    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1);
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "THE DISCRIMINATOR: the newest variation wins the slot");
    assert.equal(outcomeFor(r.json, 41).action, "released");
    assert.match(String(outcomeFor(r.json, 40).detail), /deferred/);
  });

  it("an ABSENT targetVariation sorts as the TIP, not last", async () => {
    // Absent means "the lineage tip" (trigger.ts resolves it with latestVariationValue), so
    // ranking it lowest would invert the whole fix: pr-40 would go first and release v1 while the
    // manifest that actually wanted the tip waited.
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest() }),
      mvState(),
    );
    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1);
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "THE DISCRIMINATOR: the tip acted first");
    assert.equal(outcomeFor(r.json, 41).action, "released");
    assert.match(String(outcomeFor(r.json, 40).detail), /deferred/);
  });

  it("orders the PENDING list too, and v1 never releases", async () => {
    // Two manifests already in the ledger, nothing served yet. They are seeded v1-FIRST, which
    // is Map insertion order — the order the ledger would otherwise hand back.
    //
    // Discovery is out of the picture: both files exist at both shas (an explicit previousSha
    // makes that visible), so anything that happens here came from the ledger.
    const state = mvState();
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      state,
    );
    h.seed(40, "v1");
    h.seed(41, "v2");

    const first = await h.post("sha1", "sha0");
    assert.equal(first.json.discovered, 0, "the ledger is the only path that could act here");
    assert.equal(h.starts().length, 1);
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "THE DISCRIMINATOR: v2 acted first");
    assert.match(String(outcomeFor(first.json, 40).detail), /deferred/, "v1 defers NON-finally, so it is re-checked");
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(40)],
    );

    // The v2 release completes; production now serves v2.
    state.on = true;
    state.served = "v2";

    const second = await h.post("sha2");
    const forty = outcomeFor(second.json, 40);
    assert.equal(forty.action, "noop", "v1 is now MOOT — final, so it stops being re-checked");
    assert.match(JSON.stringify(forty.detail), /SUPERSEDED/);
    assert.equal(h.starts().length, 1, "THE DISCRIMINATOR: v1 never released, on any deploy");
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "the ledger empties instead of looping");
  });
});

// ---------------------------------------------------------------------------
// Behind the lineage vs. off the lineage. Same flag, same served variation, same everything
// except the target — and the two get different answers, because one request is already
// satisfied and the other is one we refuse.
// ---------------------------------------------------------------------------
describe("a served lineage decides what a manifest's target means", () => {
  const servingV2 = () => mvState({ on: true, served: "v2" });

  it("a target BEHIND what is served resolves as noop and CLEARS the entry", async () => {
    const h = await harness(ghWith([`pr-40.json`], { [path(40)]: manifest("v1") }), servingV2());
    h.seed(40, "v1");
    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 40);
    assert.equal(o.action, "noop");
    assert.match(JSON.stringify(o.detail), /SUPERSEDED/, "the report says why, not just that nothing happened");
    assert.deepEqual(h.patches, [], "THE DISCRIMINATOR: no rollout from v2 back to v1");
    assert.deepEqual(
      h.pending.list("demo-backend", "production"),
      [],
      "final ⇒ cleared; as `held` this entry was immortal and starved every newer manifest",
    );
  });

  it("a target OFF the lineage is HELD and stays pending for a human", async () => {
    // Only the target differs from the test above. `control` has no lineage index, so the
    // behind-the-lineage comparison cannot see it — and releasing it would ramp production back
    // to the original behaviour and call it a release.
    const h = await harness(ghWith([`pr-42.json`], { [path(42)]: manifest("control") }), servingV2());
    h.seed(42, "control");
    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 42);
    assert.equal(o.action, "held", "a refusal is NOT final — it needs a human, so it must stay visible");
    assert.match(JSON.stringify(o.detail), /NOT IN THE LINEAGE/);
    assert.deepEqual(h.patches, [], "THE DISCRIMINATOR: no automated un-release");
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(42)],
    );
  });
});

// ---------------------------------------------------------------------------
// `already_running` answers two questions differently: keep re-checking (yes), wake a human
// (no).
// ---------------------------------------------------------------------------
describe("already_running keeps the entry without raising an alarm", () => {
  it("a manifest wanting v2 that finds v1's release running stays in the ledger", async () => {
    // Only one variation of a flag can be releasing at a time, so this is the NORMAL shape of an
    // iteration PR landing mid-rollout. It used to be final: the entry cleared, the v2 release
    // never happened, and the deploy log said success.
    const h = await harness(
      ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }),
      mvState({ on: true, served: "v1", releases: [{ id: "rel-7", status: "in_progress" }] }),
    );
    const r = await h.post("sha1");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "already_running");
    assert.deepEqual(h.patches, [], "nothing written, so nothing to undo");

    const [entry] = h.pending.list("demo-backend", "production");
    assert.equal(entry?.sourceFile, path(41), "THE DISCRIMINATOR: still tracked, so a later deploy re-checks it");
    assert.equal(entry?.targetVariation, "v2", "and the report can say WHICH variation is waiting");

    // The other half: the operator must not be paged for an ordinary rollout.
    const report = describeNotifyResult({
      status: r.status,
      body: JSON.stringify(r.json),
      service: "demo-backend",
      sha: "sha1",
      beaconUrl: "https://beacon.example",
    });
    assert.equal(report.attention, false, "a redelivery during a normal rollout is not actionable");
    const text = report.lines.join("\n");
    assert.match(text, /pr-41\.json/, "but the line names the MANIFEST, not just the flag");
    assert.match(text, /→v2/, "and the variation it is waiting to release");
  });
});

// ---------------------------------------------------------------------------
// The `completed` shortcut that was deleted from reEvaluate was redundant AND wrong: wrong
// because it answered a manifest-level question at the flag level, redundant because
// triggerRelease reaches the same conclusion from what the environment serves — including
// the repointing side effect, which is the observation the ledger exists for.
// ---------------------------------------------------------------------------
describe("a release that completed unwatched still repoints its children", () => {
  it("resolves through triggerRelease's noop and re-points the child prerequisite", async () => {
    const state = mvState({
      on: true,
      served: "v2",
      releases: [{ id: "rel-1", status: "completed" }],
      children: { "enable-child": { pinned: "control" } },
    });
    const h = await harness(ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }), state);
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    assert.equal(r.json.discovered, 0, "only the ledger can reach this manifest");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "noop", "served === target, decided per manifest rather than per flag");

    const childPatch = h.patches.find((p) => p.flagKey === "enable-child");
    assert.ok(childPatch, "THE DISCRIMINATOR: the child was re-pointed without the deleted branch");
    assert.deepEqual(childPatch.instructions.map((i) => i.kind), ["removePrerequisite", "addPrerequisite"]);
    assert.equal(childPatch.instructions[1]?.variationId, "id-v2");
    assert.equal(h.starts().length, 0, "a completed release is not started again");
    assert.deepEqual(h.pending.list("demo-backend", "production"), []);
  });

  it("repoints even when the only pending manifest is HELD BY ITS OWN INTENT", async () => {
    // PREVENTS: the child flag staying dark indefinitely. Deleting the flag-level `completed`
    // branch removed its verdict (right) and its side effect (wrong). Because that branch ran
    // BEFORE processFlag, any entry for the flag repointed on the way past — including one held by
    // its own intent, which was its OWN trigger. So this is not the "unrelated manifest happened
    // to be pending" case: it is the documented steady state. Beacon restarts mid-rollout, no
    // deploy arrives before the release completes, and the flag's one pending manifest is an
    // iteration awaiting approval — `held` returns before triggerRelease ever reads LaunchDarkly,
    // so nothing repoints, on this deploy or any later one.
    const state = mvState({
      on: true,
      served: "v2",
      releases: [{ id: "rel-1", status: "completed" }],
      children: { "enable-child": { pinned: "control" } },
    });
    const h = await harness(
      ghWith([`pr-41.json`], { [path(41)]: manifest("v2", { releaseIntent: { action: "hold" } }) }),
      state,
    );
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    assert.equal(r.json.discovered, 0, "only the ledger can reach this manifest");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "held", "the VERDICT is unchanged: its own intent still holds it");

    const childPatch = h.patches.find((p) => p.flagKey === "enable-child");
    assert.ok(childPatch, "THE DISCRIMINATOR: an unwatched completion repoints its children anyway");
    assert.equal(childPatch.instructions[1]?.variationId, "id-v2");
    assert.equal(h.starts().length, 0, "and repointing is not releasing");
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(41)],
      "held is not final, so the entry stays — the repoint is a side effect, not an answer",
    );
  });

  it("a COMPLETED release of v1 does not discard a manifest waiting to release v2", async () => {
    // THE DEFECT the deletion fixes, as opposed to the redundancy above. `findLatestRelease` is a
    // question about a FLAG; the entry is a MANIFEST. So "this flag's newest release completed"
    // was read as "this entry's work is done", the entry was cleared as a final noop, and pr-41's
    // v2 release was silently dropped — with a log line saying the release completed.
    const state = mvState({ on: true, served: "v1", releases: [{ id: "rel-1", status: "completed" }] });
    const h = await harness(ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }), state);
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "released", "THE DISCRIMINATOR: v1 completing is not v2 releasing");
    assert.equal(o.targetVariation, "v2", "and the outcome names the variation, so a log can too");
    assert.equal(h.starts().length, 1);
    assert.equal(h.starts()[0]?.originalVariationId, "id-v1", "the iteration moves users off what is served");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2");
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "released ⇒ no longer pending");
  });
});
