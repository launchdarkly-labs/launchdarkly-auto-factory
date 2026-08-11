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
import { LdApiError, type LdClient } from "@auto-factory/shared";

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
  /**
   * "LaunchDarkly REFUSED the patch." The opposite shape to `patchLandsThenThrows`: the patch is
   * NOT recorded, because a non-2xx means it was never applied — which is the whole property fix 1
   * turns on. Returns the status LD answered with and its own message; `LdClient.request` throws
   * exactly this for every non-2xx, so the status really is on the throw.
   */
  patchRejects?: (patch: Patch) => { status: number; message: string } | undefined;
  /** Boolean flags a manifest may name as a `releaseIntent` prerequisite parent. */
  parents?: string[];
  /** Make the automated-releases listing throw, for the fail-closed early return. */
  releasesThrow?: boolean;
  /**
   * Make ONLY the "is anything running?" read throw, leaving the history read working.
   *
   * The two are told apart by their page size, which is the documented difference:
   * `findLatestRelease` asks for `limit=1` (the newest item, terminal or not) while
   * `findActiveRelease` deliberately does NOT — it takes `limit=20`, because the newest release
   * may be terminal while an older one is still active. Needed to reach the case where the
   * ledger's repoint gate cannot be evaluated but the terminal-history guard can.
   */
  activeListingThrows?: boolean;
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
        if (state.releasesThrow) throw new Error("connection reset");
        if (state.activeListingThrows && opts.path.includes("limit=20")) {
          throw new Error("connection reset (the active-release listing only)");
        }
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
      if (state.parents?.includes(key)) {
        // A boolean prerequisite parent: `parentPinVariation` pins its `true` variation.
        return {
          status: 200,
          ok: true,
          data: {
            variations: [{ _id: "id-parent-on", value: true }, { _id: "id-parent-off", value: false }],
            environments: { production: { on: true } },
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
      const rejection = state.patchRejects?.({ flagKey, instructions });
      if (rejection) {
        // Deliberately NOT recorded: LaunchDarkly declined to apply it.
        throw new LdApiError("PATCH", `/api/v2/flags/p/${flagKey}`, rejection.status, {
          code: "invalid_request",
          message: rejection.message,
        });
      }
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
// A manifest naming a variation LaunchDarkly does not have. It used to THROW, and a throw
// claims the flag's action slot unconditionally — correctly, for the throws that motivated
// that rule: `startRelease` awaits `res.text()` AFTER the patch is applied, so a lost
// response is "we do not know whether we wrote".
//
// This refusal has none of those properties: it happens before any patch is sent, and it
// happens to THIS file alone, every time. Why that combination is the one the slot claim
// cannot survive is argued in `PATCH_FAILURE_TAXONOMY` (`packages/beacon/src/trigger.ts`),
// which is the only place this repo states it. What matters here is the consequence:
// `targetRank` evaluates the HIGHER target first, and that is the missing one.
// ---------------------------------------------------------------------------
describe("a manifest naming a nonexistent variation is HELD, not thrown", () => {
  it("does not starve the sibling that can release, on this deploy or any later one", async () => {
    // PREVENTS: zero releases, forever. The flag has control/v1 only. pr-41 asks for v2, which
    // does not exist; pr-40 asks for v1 and is releasable right now. Ordered highest-first, pr-41
    // goes FIRST, threw, and the catch claimed the flag's slot — so pr-40 was deferred with a
    // report saying "another manifest released 'checkout-flow' in this notification", which had
    // not happened. Deterministic, so every later deploy repeated it identically.
    //
    // Reachable without a contrived fixture: `write_manifest` validates targetVariation against
    // /^v\d+$/ but never against the flag's real variations, so a failed addVariation, a skipped
    // implementer step or a loop-back rerun writes exactly this manifest — and `.release-flags/`
    // is hand-editable in git.
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      mvState({ values: ["control", "v1"] }),
    );

    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1, "THE DISCRIMINATOR: exactly one release, where there used to be none");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v1", "and it is the SIBLING's target");

    const fortyOne = outcomeFor(r.json, 41);
    assert.equal(fortyOne.action, "held", "a human has to say what v2 was meant to be");
    assert.match(JSON.stringify(fortyOne.detail), /no such variation/);

    const forty = outcomeFor(r.json, 40);
    assert.equal(forty.action, "released");
    assert.doesNotMatch(
      JSON.stringify(forty.detail),
      /another manifest/,
      "and it is no longer told that a release it never got had already happened",
    );

    // pr-41 stays tracked (held is not final) so the fix takes effect on a later deploy; pr-40 is
    // done.
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(41)],
    );
  });
});

// ---------------------------------------------------------------------------
// A LAUNCHDARKLY REJECTION OF MANIFEST CONTENT IS A REFUSAL, NOT A TRANSPORT ERROR.
//
// The instruction body `startRelease` sends is built from manifest content that NOTHING has
// validated against LaunchDarkly: `releasePlan.stages`, `metricKeys`, `metricGroupKeys`,
// `randomizationUnit`. `patchFlagSemantic` turns any non-2xx into a throw, and `server.ts`'s catch
// claims the flag's action slot for any throw — a rule written for LOST RESPONSES, where the patch
// may already have applied.
//
// An ALLOWLISTED client error is not a lost response: LaunchDarkly answered, and its answer is that
// it did not apply the patch. Which statuses those are, what each one does and does not prove, and
// why a throw is the wrong answer for them, are in `PATCH_FAILURE_TAXONOMY`
// (`packages/beacon/src/trigger.ts`) — not here, and NOT generalised over "any client error", which
// the four tests below disprove one status at a time.
//
// This comment used to end by asserting that such a failure always recurs for one manifest and one
// manifest only. That was a FIFTH copy of the argument, and it had already drifted: the row for the
// status the test below uses now records a second cause that is a property of the FLAG, so its blast
// radius is `unknown`. The copy went stale the moment the table was corrected, which is the whole
// reason the table is the only home.
// ---------------------------------------------------------------------------
describe("a release instruction LaunchDarkly REJECTS is held, not filed as a lost write", () => {
  /** Reject only the patch that starts a release of `id-v2`, i.e. pr-41's. */
  const rejectV2Start = (status: number, message: string) => (p: Patch) =>
    p.instructions.some((i) => i.kind === "startAutomatedRelease" && i.targetVariationId === "id-v2")
      ? { status, message }
      : undefined;

  it("a 400 on pr-41's stages leaves pr-40 free to release", async () => {
    // PREVENTS: zero releases across every deploy. pr-41 asks for a GUARDED release with a 100%
    // stage — `trigger.ts` documents that LaunchDarkly caps guarded stages at 50% and quotes the
    // live rejection, so THIS fixture is a rejection of pr-41's own content that recurs on every
    // deploy. (The status itself proves less than that; see its row.) Ordered
    // highest-target-first, pr-41 goes FIRST; as a throw it claimed the flag's slot and pr-40 was
    // deferred with the report "another manifest released 'checkout-flow' in this notification",
    // which had not happened. Deterministic, so every later deploy repeated it identically.
    const state = mvState({
      patchRejects: rejectV2Start(400, "stage allocation must not exceed 50%"),
    });
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], {
        [path(40)]: manifest("v1"),
        [path(41)]: manifest("v2", {
          releasePlan: { releaseMethod: "guarded", metricKeys: ["latency"], stages: [{ allocation: 100000, durationMillis: 300000 }] },
        }),
      }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1, "THE DISCRIMINATOR: exactly one release, where there used to be none");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v1", "and it is the SIBLING's target");

    const fortyOne = outcomeFor(r.json, 41);
    assert.equal(fortyOne.action, "held", "a refusal of manifest content needs a human, not a retry");
    const note = String(fortyOne.detail.note);
    assert.match(
      note,
      /stage allocation must not exceed 50%/,
      "and it names LAUNCHDARKLY'S OWN message, so the operator knows what to edit",
    );

    // AND THE CAVEAT COMES FIRST, which is the whole point of it. This status has a second cause
    // that has nothing to do with the manifest (the row says which), so leading with "the values you
    // sent are wrong" and hedging afterwards is the same over-claim, just later in the sentence. The
    // caveat is carried by the ROW (`operatorCaveat`), not by the call site, so it cannot leak onto a
    // status it is not true of — see the 422 test below for the other half.
    assert.match(note, /CHECK LAUNCHDARKLY BEFORE EDITING ANYTHING/, "the hedge is present");
    assert.ok(
      note.indexOf("CHECK LAUNCHDARKLY") < note.indexOf("releasePlan"),
      "THE DISCRIMINATOR: it precedes the manifest-blame rather than trailing it",
    );

    const forty = outcomeFor(r.json, 40);
    assert.equal(forty.action, "released");
    assert.doesNotMatch(
      JSON.stringify(forty.detail),
      /another manifest/,
      "and it is no longer told that a release it never got had already happened",
    );

    // pr-41 stays tracked (held is not final), so a corrected manifest takes effect on any later
    // deploy; pr-40 is done.
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(41)],
    );
  });

  // -------------------------------------------------------------------------
  // THE CLASSIFIER IS AN ALLOWLIST, NOT A DENYLIST.
  //
  // It used to return a refusal for ANY 4xx except a short exclusion list, which asserted "this
  // manifest's content is wrong" about statuses that are nothing of the kind. The 409 case below is
  // not merely mislabelled: it CHANGES WHAT PRODUCTION GETS.
  //
  // These tests are the per-status CANARIES, so each necessarily names its own status. The ARGUMENT
  // for each classification is not restated here — it is one row of `PATCH_FAILURE_TAXONOMY` in
  // `packages/beacon/src/trigger.ts`, which is its only home ("the taxonomy has exactly one home"
  // below pins that). Each comment states only what the test would catch.
  // -------------------------------------------------------------------------
  it("a 409 keeps throwing, and the sibling is NOT spuriously released", async () => {
    // PREVENTS A SPURIOUS ROLLOUT FROM A TRANSIENT CONFLICT — the one item in this round that is a
    // production-behaviour regression rather than a mislabelled report.
    //
    // 409 is "Status conflict": LaunchDarkly's API overview describes it as "conflicts with a
    // concurrent API request" and its remediation is "Retry your request." A human editing
    // `checkout-flow` in the LaunchDarkly UI as pr-41's patch lands produces exactly this.
    //
    // As a content refusal, pr-41 answers `held` and does NOT claim the flag's action slot — so
    // pr-40's own idempotency read sees nothing running and v1 IS ROLLED OUT TO PRODUCTION, with v2
    // landing on top of it on the next deploy, plus an ACTION REQUIRED telling the operator to edit a
    // manifest that is correct. Throwing claims the slot, pr-40 defers, and v2 releases next deploy:
    // a delay instead of a wrong rollout. Transient failures belong in the delay bucket.
    const state = mvState({
      patchRejects: rejectV2Start(409, "The API request can not be completed because it conflicts with a concurrent API request"),
    });
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(
      h.starts().length,
      0,
      "THE DISCRIMINATOR: v1 did NOT roll out behind a conflict on v2 — nothing released on this flag",
    );
    const fortyOne = outcomeFor(r.json, 41);
    assert.equal(fortyOne.action, "error", "a concurrent-edit conflict is transient, not a manifest defect");
    assert.match(String(fortyOne.detail), /release trigger failed/);
    assert.match(String(outcomeFor(r.json, 40).detail), /deferred/, "and the slot is claimed, so the sibling waits");
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile).sort(),
      [path(40), path(41)],
      "both non-final: the next deploy re-evaluates, by which time the conflict has cleared",
    );

    // The conflict clears (the human's UI edit finished) and v2 — the higher target — releases,
    // which is the outcome the throw preserved and the `held` classification lost.
    state.patchRejects = undefined;
    const second = await h.post("sha2");
    assert.equal(h.starts().length, 1, "exactly one release across both deploys");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "THE DISCRIMINATOR: and it is v2, never v1");
    assert.equal(outcomeFor(second.json, 41).action, "released");
  });

  it("a 405 approval requirement keeps throwing — every manifest for the flag hits it alike", async () => {
    // PREVENTS telling every manifest for every flag to go fix its releasePlan for an approval
    // requirement, which no manifest edit can satisfy. Required approvals in production is standard
    // enterprise configuration and production is Beacon's target.
    //
    // NOTE WHAT THIS COMMENT NO LONGER CLAIMS. It used to put LaunchDarkly's message in quotation
    // marks — that wording appears in no LaunchDarkly document, so the fixture below says something
    // plainly invented instead of re-seeding an unearned quotation. And it argued the scope of the
    // setting, which is the row's job and was over-claimed there too (see it: the scoping is
    // narrower than the old wording said, and the conclusion survives anyway). What this test
    // checks is the observable behaviour: it throws, and the report does not name `releasePlan`.
    const state = mvState({ patchRejects: rejectV2Start(405, "approval required for this environment") });
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      state,
    );

    const r = await h.post("sha1");
    const fortyOne = outcomeFor(r.json, 41);
    assert.equal(fortyOne.action, "error", "THE DISCRIMINATOR: an approval requirement is not a manifest defect");
    assert.doesNotMatch(
      String(fortyOne.detail),
      /releasePlan/,
      "and the operator is NOT sent to edit releasePlan for an environment setting",
    );
    assert.equal(h.starts().length, 0);
  });

  it("a 404 'invalid resource identifier' keeps throwing — the flag or the environment, not this file", async () => {
    // PREVENTS reporting a wrong `environment` on the notification as a permanent defect of one
    // manifest. The identifiers in Beacon's request PATH are the flag and the environment, so every
    // manifest for that flag hits this identically; reported as content, a mistyped environment
    // blamed the manifest forever. The row carries the argument, including the residual this comment
    // used to argue away with the word "never".
    const state = mvState({ patchRejects: rejectV2Start(404, "Invalid resource identifier") });
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(
      outcomeFor(r.json, 41).action,
      "error",
      "THE DISCRIMINATOR: a bad flag/environment identifier is not this manifest's content",
    );
    assert.equal(h.starts().length, 0);
  });

  // -------------------------------------------------------------------------
  // THE IMMEDIATE PATCH: HELD, AND IT TAKES THE FLAG'S SLOT ANYWAY.
  //
  // The owner's narrowing of handoff §6, and the only place in Beacon where an outcome that wrote
  // nothing blocks its siblings. Two arms, because ONE MECHANISM NOW HAS TWO BEHAVIOURS and only one
  // of them is the exception: the divergent-target arm below encodes the decision, and the two tests
  // above (a refused release-start patch, a refused prerequisites patch) are its control arms — both
  // still hand the slot to the sibling, and both assert which variation actually rolled out.
  // -------------------------------------------------------------------------
  /** Refuse the patch `immediate` sends: a fallthrough change with no prerequisite instructions. */
  const rejectImmediate = (status: number, message: string) => (p: Patch) =>
    p.instructions.some((i) => i.kind === "updateFallthroughVariationOrRollout") &&
    !p.instructions.some((i) => i.kind === "addPrerequisite")
      ? { status, message }
      : undefined;

  it("is HELD like the other two patches — the same refusal must not read differently", async () => {
    // PREVENTS AN ASYMMETRY BY RELEASE METHOD. This patch was the only one of the three with no
    // try/catch, so an identical LaunchDarkly refusal produced `held` plus LaunchDarkly's own message
    // on a guarded/progressive manifest, and `error — release trigger failed` on an `immediate` one.
    const h = await harness(
      ghWith([`pr-50.json`], { [path(50)]: manifest("v2", { releasePlan: { releaseMethod: "immediate" } }) }),
      mvState({ patchRejects: rejectImmediate(400, "flag is archived") }),
    );

    const r = await h.post("sha1");
    const fifty = outcomeFor(r.json, 50);
    assert.equal(fifty.action, "held", "THE DISCRIMINATOR: held, as for the other two patches");
    const note = String(fifty.detail.note);
    assert.match(note, /flag is archived/, "carrying LaunchDarkly's own message");
    // AND THE NOTE POINTS AT THE RIGHT TWO THINGS, in the right order. None of the VALUES in this
    // patch came from the manifest — the variation id is one LaunchDarkly reported — so the flag and
    // the environment come first. But one field of this file DID choose this instruction, and an
    // earlier version of this note said to look "rather than at any field of this file", which left an
    // author with a refusal they could actually act on and no way to know it: `releaseMethod:
    // "immediate"` is what asks for a direct fallthrough change instead of a staged release, and
    // dropping it is the remedy `sandboxTools` already teaches.
    assert.match(note, /look at the FLAG and the ENVIRONMENT first/, "the flag and environment come first");
    assert.match(note, /releaseMethod "immediate" is what asks for a direct/, "THE DISCRIMINATOR: the routing field is named");
    assert.doesNotMatch(
      note,
      /stages|metricKeys|metricGroupKeys|randomizationUnit|releaseIntent/,
      "and no VALUE of this file is blamed, because none of them is in this patch",
    );
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(50)],
      "held is not final, so it is re-checked on the next deploy",
    );
  });

  it("but it TAKES THE FLAG'S SLOT: a sibling wanting an OLDER variation must not roll out", async () => {
    // THE OWNER'S REPRODUCTION, and the arm that encodes their decision. It must fail if this patch
    // ever goes back to leaving the slot free.
    //
    // pr-50 wants v2 by an `immediate` release; pr-51 wants v1. `targetRank` runs pr-50 FIRST because
    // its target is higher, and LaunchDarkly refuses its patch. When `held` freed the slot, pr-51's
    // own idempotency read then saw nothing running and rolled v1 — the OLDER variation — out to
    // production while the newer manifest sat held. `server.ts` calls that direction unrecoverable:
    // no later deploy undoes a rollout backwards.
    //
    // Freeing the slot buys nothing in exchange, which is what makes the narrowing sound rather than
    // merely convenient: nothing in this patch's body came from pr-50, so there is no refusal here
    // that could have singled it out while pr-51 succeeded. The sibling is DELAYED one deploy, not
    // denied — `held` is non-final and both entries stay in the ledger.
    //
    // The targets are DIVERGENT on purpose. With both manifests on v2 this test passed either way:
    // one release happened and it was v2's, whichever manifest produced it.
    const state = mvState({ patchRejects: rejectImmediate(400, "flag is archived") });
    const h = await harness(
      ghWith([`pr-50.json`, `pr-51.json`], {
        [path(50)]: manifest("v2", { releasePlan: { releaseMethod: "immediate" } }),
        [path(51)]: manifest("v1"),
      }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(
      h.starts().length,
      0,
      "THE DISCRIMINATOR: nothing rolled out — with the slot free this was a rollout of id-v1",
    );
    assert.equal(outcomeFor(r.json, 50).action, "held");
    const fiftyOne = outcomeFor(r.json, 51);
    assert.equal(fiftyOne.action, "held", "the sibling is deferred, not released");
    assert.match(String(fiftyOne.detail), /deferred/);

    // AND THE CLAIM IS AUDITABLE IN THE OUTCOME, not just in the log: a slot taken by something other
    // than a write is indistinguishable from a bug in `performedAWrite` unless it says why.
    const claim = String(outcomeFor(r.json, 50).detail.claimsSlotWithoutWriting);
    assert.match(claim, /cannot tell one 'immediate' manifest from another/, "the reason is the property the narrowing turns on");
    assert.match(claim, /NARROWS handoff §6/, "and it names what it is narrowing");

    // Both non-final, so the next deploy re-evaluates: the sibling loses a deploy, not its release.
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile).sort(),
      [path(50), path(51)],
    );

    // THE SAME HARNESS, CONTINUED — not a new one. The first version of this arm built a fresh harness
    // with an EMPTY ledger, so it re-discovered both manifests as new and proved nothing about the held
    // entry: v1 was then withheld by an ordinary write claim, not by anything this test is about. The
    // point is that the DEFERRED sibling and the HELD entry both survive into the next deploy, so
    // mutate the refusal on the live state and post again.
    state.patchRejects = undefined;
    const r2 = await h.post("sha2");
    assert.equal(outcomeFor(r2.json, 50).action, "released", "the held entry re-evaluates and pr-50 releases");
    assert.equal(h.starts().length, 0, "an immediate release starts no automated release");
    assert.match(String(outcomeFor(r2.json, 51).detail), /deferred/, "and v1 still never rolls out");
  });

  it("KNOWN GAP: an equal-target sibling by another method defers for as long as the refusal stands", async () => {
    // NOT A PREVENTION TEST. This one PINS A GAP the owner chose to record rather than close, on the
    // precedent of the 403 gap in `PATCH_FAILURE_TAXONOMY` — which is also a case where neither
    // available answer is right and the wrong one was previously asserted to be impossible. In the
    // owner's words: "a sibling targeting the same or a later variation by a different method would
    // have succeeded, and defers while the refusal stands."
    //
    // The setup is exactly what §6 was written to prevent, with nothing gained, and the earlier slot claim
    // said it could not happen ("every sibling would be refused identically"). It can. pr-50 asks for
    // v2 by `immediate`; pr-51 asks for THE SAME v2 by the default staged method, so it sends
    // `turnFlagOn` + `startAutomatedRelease` and no fallthrough instruction at all — the refusal below
    // does not match its patch and never would. Equal `targetRank`, stable order, pr-50 first every
    // time. So pr-51 never gets a chance, on this deploy or any later one, while the refusal stands.
    //
    // It is accepted because the alternative on the table was a rollout BACKWARDS (the test above),
    // which no later deploy undoes, whereas this costs deploys and is recovered the moment a human
    // fixes the flag. What must not happen is the gap being asserted away again, so this test fails if
    // pr-51 ever releases — which would mean the slot was freed — AND checks that the claim Beacon
    // reports names the residual out loud.
    const h = await harness(
      ghWith([`pr-50.json`, `pr-51.json`], {
        [path(50)]: manifest("v2", { releasePlan: { releaseMethod: "immediate" } }),
        [path(51)]: manifest("v2"),
      }),
      mvState({ patchRejects: rejectImmediate(400, "flag is archived") }),
    );

    for (const sha of ["sha1", "sha2", "sha3"]) {
      const r = await h.post(sha);
      assert.equal(outcomeFor(r.json, 50).action, "held", `${sha}: pr-50 still refused`);
      assert.match(String(outcomeFor(r.json, 51).detail), /deferred/, `${sha}: and pr-51 still defers`);
    }
    assert.equal(
      h.starts().length,
      0,
      "THE GAP: pr-51 wanted the same variation by a method that was never refused, and never ran",
    );

    // AND BEACON SAYS SO. The claim used to assert this case away; now it records it, in the note an
    // operator reads and in the ledger entry, so nobody has to rediscover it from the code.
    const claim = String(outcomeFor(await h.post("sha4").then((r) => r.json), 50).detail.claimsSlotWithoutWriting);
    assert.match(claim, /KNOWN RESIDUAL/, "the residual is stated, not implied");
    assert.match(
      claim,
      /same or a later variation by a different method would have succeeded/,
      "in the owner's own words, so a reviewer can match it to the decision",
    );
    assert.doesNotMatch(
      claim,
      /refused identically|no reachable loss/,
      "and the two false clauses that used to assert this gap away are gone",
    );
  });

  it("an UNDOCUMENTED 4xx keeps throwing rather than being asserted to be a content defect", async () => {
    // PREVENTS re-widening this to "any 4xx". 418 is not in LaunchDarkly's documented set for this
    // endpoint, so there is no basis for calling it a manifest-content defect — and asserting it
    // anyway sends an operator to edit a correct file while the real cause goes unreported. The cost
    // of the throw is one delayed deploy, which is the cheaper error.
    const state = mvState({ patchRejects: rejectV2Start(418, "unexpected") });
    const h = await harness(ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }), state);
    const r = await h.post("sha1");
    assert.equal(outcomeFor(r.json, 41).action, "error", "THE DISCRIMINATOR: unknown ⇒ not classified as content");
    assert.equal(h.starts().length, 0);
  });

  it("a 429 is NOT reclassified: it stays an error and still claims the slot", async () => {
    // PREVENTS widening the classifier to "any 4xx" — the row for this status says why it is out,
    // and this test says what that buys. The behaviour kept is the pre-existing one, in both halves:
    // `error`, and the flag's slot claimed. pr-40 pays a DELAY rather than its release, and the next
    // deploy re-evaluates both entries.
    const state = mvState({ patchRejects: rejectV2Start(429, "rate limit exceeded") });
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      state,
    );

    const r = await h.post("sha1");
    const fortyOne = outcomeFor(r.json, 41);
    assert.equal(fortyOne.action, "error", "THE DISCRIMINATOR: a rate limit is not a content refusal");
    assert.match(String(fortyOne.detail), /release trigger failed/);
    const deferred = String(outcomeFor(r.json, 40).detail);
    assert.match(deferred, /deferred/, "and the slot is still claimed");
    // AND THE DEFERRAL SAYS WHY HONESTLY. This is the bucket where "nothing was written" is
    // DEFINITIVE — LaunchDarkly declined the patch — so ANY claim about what the manifest that went
    // first did is false here: not "released", not "wrote", and not "we do not know" either. The one
    // thing true of every claimant is that it took the flag's single slot, so that is all the message
    // says. Three revisions each got a different one of those wrong and none was pinned.
    assert.match(deferred, /acted on first/, "THE DISCRIMINATOR: the reason given is the slot");
    // AND THE SLOT'S SCOPE IS STATED CORRECTLY. `actedOnFlag` is keyed by flagKey, so the rule is one
    // manifest per FLAG per notification; the first version of this message said "only one may act per
    // notification", which tells an operator whose deploy released three flags that Beacon does one
    // thing per deploy. `/acted on first/` alone could not see that.
    assert.match(deferred, /only one manifest per flag may act/, "and its scope is per flag, not per notification");
    assert.doesNotMatch(deferred, /\bwrote\b|\bwritten\b/, "no write is claimed — LaunchDarkly's refusal rules it out");
    assert.doesNotMatch(deferred, /released/, "and certainly not a release");
    assert.doesNotMatch(deferred, /unknown/, "nor 'outcome unknown': the outcome here is known to be nothing");
    assert.equal(h.starts().length, 0, "so nothing released on this flag in this notification");
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile).sort(),
      [path(40), path(41)],
      "both non-final, so the next deploy re-evaluates them",
    );
  });

  it("a rejected manifest releases as soon as it is corrected, on any later deploy", async () => {
    // The recovery half: `held` is not final, so the ledger keeps re-checking — and re-READS the
    // manifest at the current sha. This is what makes the refusal actionable rather than merely
    // honest, and a `noop` (final) classification would have destroyed it.
    //
    // 422, DELIBERATELY. A bad randomizationUnit is a body LaunchDarkly cannot understand, and
    // 422 is the row in its API-wide error table that says exactly that: "the update description
    // can not be understood… Ensure that the request body is correct for the type of patch you
    // are using, either JSON patch or semantic patch."
    //
    // This test previously used 422 and was moved to 400 on the false premise that 422 was an
    // undocumented status. It is the canonical one. The move made the suite green while a releasable
    // sibling lost its release on every 422 — the canary was edited instead of the code. Restored.
    // The other allowlisted status, 400, is covered by the first test in this block, so both are
    // pinned per-status: a status silently dropped from the allowlist stops being `held`.
    const state = mvState({
      patchRejects: rejectV2Start(422, "randomizationUnit 'organisation' is not configured"),
    });
    const h = await harness(ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }), state);

    const first = await h.post("sha1");
    const held = outcomeFor(first.json, 41);
    assert.equal(held.action, "held");

    // AND THE OTHER ROW'S CAVEAT DOES NOT LEAK ONTO THIS STATUS. The first attempt at that caveat
    // appended it inside the call site's `whereToLook`, which is built BEFORE the status is known —
    // so a 422, the canonical rejection of a semantic patch body, sent the operator hunting for
    // something the row for a different status warns about. It is per-ROW text now
    // (`operatorCaveat`), which is what makes per-status honesty mechanical rather than advisory.
    const note = String(held.detail.note);
    assert.match(note, /randomizationUnit 'organisation' is not configured/, "LaunchDarkly's own message");
    assert.match(note, /releasePlan/, "and this status DOES point at the manifest's own fields");
    assert.doesNotMatch(
      note,
      /pending scheduled change|CHECK LAUNCHDARKLY/i,
      "THE DISCRIMINATOR: no caveat borrowed from a different row",
    );

    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(41)],
      "kept, so a human's fix can take effect",
    );

    // The human fixes the manifest; LaunchDarkly now accepts it.
    state.patchRejects = undefined;

    const second = await h.post("sha2");
    assert.equal(outcomeFor(second.json, 41).action, "released", "THE DISCRIMINATOR: the fix is not a no-op");
    assert.equal(h.starts().length, 1);
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "released ⇒ no longer pending");
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
// EVERY writing method claims the slot. `performedAWrite` could lose "prerequisites" or
// "immediate" without failing a single test, and either loss lets a sibling manifest start a
// rollout on a flag this notification has already patched.
// ---------------------------------------------------------------------------
describe("every method that WROTE claims the flag's action slot", () => {
  it("a `prerequisites` release claims it, so a sibling cannot start a rollout behind it", async () => {
    // Both manifests ask for v2, so the (stable) sort cannot reorder them: pr-50 is evaluated
    // first and patches the flag ON serving v2 behind a prerequisite. Unclaimed, pr-51 then starts
    // a progressive rollout from a fallthrough this same notification wrote.
    const h = await harness(
      ghWith([`pr-50.json`, `pr-51.json`], {
        [path(50)]: manifest("v2", {
          releaseIntent: { prerequisites: [{ flagKey: "parent-flag", variation: "on" }] },
        }),
        [path(51)]: manifest("v2"),
      }),
      mvState({ parents: ["parent-flag"] }),
    );
    const r = await h.post("sha1");
    assert.equal(outcomeFor(r.json, 50).action, "released");
    assert.ok(
      h.patches.some((p) => p.instructions.some((i) => i.kind === "addPrerequisite")),
      "pr-50 really did write",
    );
    assert.equal(h.starts().length, 0, "THE DISCRIMINATOR: no rollout on a flag already written this round");
    assert.equal(outcomeFor(r.json, 51).action, "held");
    assert.match(String(outcomeFor(r.json, 51).detail), /deferred/, "deferred non-finally, so it is re-checked");
  });

  it("but a REJECTED prerequisites patch does NOT claim it, and the sibling releases", async () => {
    // PREVENTS A SIBLING LOSING ITS RELEASE VIA THIS PATH — the gap the previous round
    // found and documented instead of fixing, for want of a rejection LaunchDarkly really returns.
    // A CIRCULAR prerequisite is one it must refuse, and nothing upstream can prevent it:
    // `sandboxTools` checks only that a prerequisite key looks like a flag key, and
    // `normalizePrerequisites` accepts any syntactically valid one.
    //
    // Only the release-start patch was classified, so a 4xx on `addPrerequisite` threw, and the
    // catch in server.ts claims the flag's slot for any throw. That claim is right for a LOST
    // RESPONSE and wrong here: this refusal recurs for this one file on every deploy, so pr-51 was
    // deferred forever while being told "another manifest released 'checkout-flow' in this
    // notification", which had not happened.
    //
    // Both manifests ask for v2, so the (stable) sort cannot reorder them and pr-50 — the rejected
    // one — is evaluated FIRST, which is the ordering that makes the lost release reachable.
    const state = mvState({
      parents: ["parent-flag"],
      patchRejects: (p) =>
        p.instructions.some((i) => i.kind === "addPrerequisite")
          ? { status: 400, message: "circular prerequisite: 'parent-flag' already depends on 'checkout-flow'" }
          : undefined,
    });
    const h = await harness(
      ghWith([`pr-50.json`, `pr-51.json`], {
        [path(50)]: manifest("v2", {
          releaseIntent: { prerequisites: [{ flagKey: "parent-flag", variation: "on" }] },
        }),
        [path(51)]: manifest("v2"),
      }),
      state,
    );

    const r = await h.post("sha1");
    assert.equal(h.starts().length, 1, "THE DISCRIMINATOR: exactly one release, where there used to be none");
    assert.equal(h.starts()[0]?.targetVariationId, "id-v2", "and it is the SIBLING's");

    const fifty = outcomeFor(r.json, 50);
    assert.equal(fifty.action, "held", "a refused prerequisite needs a human, not a retry");
    assert.match(
      JSON.stringify(fifty.detail),
      /circular prerequisite/,
      "and it names LAUNCHDARKLY'S OWN message, so the operator knows what to edit",
    );
    assert.match(
      JSON.stringify(fifty.detail),
      /releaseIntent\.prerequisites/,
      "and points at releaseIntent, not releasePlan — this patch's values come from the intent",
    );

    const fiftyOne = outcomeFor(r.json, 51);
    assert.equal(fiftyOne.action, "released");
    assert.doesNotMatch(
      JSON.stringify(fiftyOne.detail),
      /another manifest/,
      "and it is no longer told that a release it never got had already happened",
    );

    // pr-50 stays tracked (held is not final), so a corrected intent takes effect on a later deploy.
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(50)],
    );
  });

  it("an `immediate` release claims it too", async () => {
    const h = await harness(
      ghWith([`pr-50.json`, `pr-51.json`], {
        [path(50)]: manifest("v2", { releasePlan: { releaseMethod: "immediate" } }),
        [path(51)]: manifest("v2"),
      }),
      mvState(),
    );
    const r = await h.post("sha1");
    assert.equal(outcomeFor(r.json, 50).action, "released");
    assert.ok(
      h.patches.some((p) => p.instructions.some((i) => i.kind === "updateFallthroughVariationOrRollout")),
      "pr-50 really did write",
    );
    assert.equal(h.starts().length, 0, "THE DISCRIMINATOR: no rollout on a flag already written this round");
    assert.match(String(outcomeFor(r.json, 51).detail), /deferred/);
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

  it("orders the PENDING pass on the FRESHLY READ target, not the remembered one", async () => {
    // PREVENTS ordering on the stored `targetVariation`. A human retargets pr-41 from v1 to v2 —
    // the documented iteration edit, and exactly the fix a pending entry invites. The ledger still
    // remembers v1, so on the stored values both entries rank equally, the (stable) sort keeps
    // insertion order, pr-40 takes the flag's single action slot, and production gets v1 while the
    // manifest that now asks for v2 waits for another deploy.
    const h = await harness(
      ghWith([`pr-40.json`, `pr-41.json`], { [path(40)]: manifest("v1"), [path(41)]: manifest("v2") }),
      mvState(),
    );
    h.seed(40, "v1");
    h.seed(41, "v1"); // as last recorded, BEFORE the edit

    const r = await h.post("sha1", "sha0");
    assert.equal(r.json.discovered, 0, "the ledger is the only path that could act here");
    assert.equal(h.starts().length, 1);
    assert.equal(
      h.starts()[0]?.targetVariationId,
      "id-v2",
      "THE DISCRIMINATOR: ordered by what the manifests ask for NOW",
    );
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

// ---------------------------------------------------------------------------
// The repoint's GATE and its DESTINATION are about different moments.
//
// The gate is `findLatestRelease(...).status === "completed"` — a fact about the past. The
// destination is the parent's LIVE fallthrough, read inside `repoint.ts`. While a release is
// running those disagree, and the disagreement writes to production: mid-rollout the
// fallthrough still resolves to the ORIGINAL variation (the heaviest arm at stage 1; decided by
// LaunchDarkly's arm order at a guarded release's 50/50 stage), so children get pulled onto the
// variation the release is ramping AWAY from.
//
// `monitor.ts` has the identical shape and is fenced behind `!active` after five
// `findActiveRelease` attempts. `evaluateManifest`'s `noop`/`immediate` repoint is fenced by its
// own idempotency read. This caller had no such precondition and fired BEFORE
// `findActiveRelease` was ever reached.
//
// THE FIXTURE THIS BLOCK IS WRITTEN ON, and why it is not the rollback shape. It used to be:
// flag serving `control` with a child pinned to `v1`, i.e. a repoint that moves the child
// BACKWARDS. `repoint.ts` now refuses that outright (see the next block), so on that fixture
// nothing repoints under ANY gate and the activeness gate would be undiscriminated — the control
// arm would pass with the gate deleted. It also asserted `id-control` as the expected
// destination, a value its own comment called known-wrong.
//
// So the shape here is a FORWARD repoint the new lineage guard permits — child pinned to
// `control`, parent serving `v2` — with a release still listed `in_progress`. That is reachable
// without any eventual consistency: a progressive release's last stage puts the treatment at the
// heaviest weight, so the fallthrough already resolves to `v2` while the release is still
// running and can still be REVERTED to `control`. Repointing then satisfies the child's
// prerequisite off a value LaunchDarkly may take back.
// ---------------------------------------------------------------------------
describe("the ledger repoints only once the release has stopped moving", () => {
  /** Mid-rollout FORWARD shape: on, already serving `v2`, child still pinned to `control`. */
  const midRollout = (releases: Array<{ id: string; status: string }>): MvState =>
    mvState({
      on: true,
      served: "v2",
      releases,
      children: { "enable-child": { pinned: "control" } },
    });

  const heldByIntent = () =>
    ghWith([`pr-41.json`], { [path(41)]: manifest("v2", { releaseIntent: { action: "hold" } }) });

  it("does NOT repoint while a release is still running on that flag", async () => {
    // PREVENTS: repointing `enable-child` from `control` to `v2` off a fallthrough the running
    // release is still moving. The child is DARK while pinned to a variation the parent does not
    // serve, so this repoint takes it live for 100% of traffic with no rollout — and if the release
    // then reverts, the child is left pinned to a variation production no longer serves.
    //
    // Note the listing shape: newest-first, so the completed release is `items[0]` (what
    // `findLatestRelease` returns, limit=1) while an older one is still active — the case
    // `findActiveRelease`'s "no limit=1" comment exists for.
    const h = await harness(
      heldByIntent(),
      midRollout([{ id: "rel-1", status: "completed" }, { id: "rel-2", status: "in_progress" }]),
    );
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    assert.equal(r.json.discovered, 0, "only the ledger can reach this manifest");
    assert.equal(
      h.patches.find((p) => p.flagKey === "enable-child"),
      undefined,
      "THE DISCRIMINATOR: no child was moved while the fallthrough was still in motion",
    );
    assert.deepEqual(h.patches, [], "and nothing else was written either");
    assert.equal(
      outcomeFor(r.json, 41).action,
      "already_running",
      "the very next step already knew a release was running — the repoint just ran first",
    );
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(41)],
      "kept, so the repoint happens on a later deploy once the release ends",
    );
  });

  it("still repoints when NOTHING is running — the gate is exactly `!active`", async () => {
    // The control arm. Same fixture, one release removed, so ACTIVENESS is the only thing that
    // varies between this test and the one above — which is what makes the gate discriminated in
    // both directions: DELETE OR WIDEN the gate (repoint even while a release is running) and the
    // test above fails; NARROW it (never repoint) and this one does. Stated backwards before —
    // "widen it and this one does" — which named the wrong arm for the wrong direction, and would
    // have sent anyone using this comment to check the harmless failure.
    //
    // The destination is now a legitimate one (`control` → `v2`, forward), so this also pins that
    // the new lineage guard does not block the ordinary case.
    const h = await harness(heldByIntent(), midRollout([{ id: "rel-1", status: "completed" }]));
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    const childPatch = h.patches.find((p) => p.flagKey === "enable-child");
    assert.ok(childPatch, "THE DISCRIMINATOR: an unwatched completion still reaches its children");
    assert.equal(childPatch.instructions[1]?.variationId, "id-v2", "and it is aimed at what the flag serves");
    assert.equal(outcomeFor(r.json, 41).action, "held", "its own intent still holds it — repointing is not releasing");
  });

  it("SKIPS the repoint when it cannot tell whether a release is running", async () => {
    // Fail CLOSED on the side effect. The history read succeeds and says `completed`, so the old
    // code repointed; only the "is anything running?" read fails. An unreadable listing does not
    // establish that the fallthrough has stopped moving, and the repoint is a WRITE — so it is
    // skipped, which costs a repoint the next deploy performs.
    const state = midRollout([{ id: "rel-1", status: "completed" }]);
    state.activeListingThrows = true;
    const h = await harness(heldByIntent(), state);
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    assert.deepEqual(h.patches, [], "THE DISCRIMINATOR: no child moved on a read we could not make");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "error", "and the manifest's own idempotency read fails closed for the same reason");
    assert.match(String(o.detail), /idempotency check failed/);
    assert.equal(r.status, 503, "nothing was started, so a retry cannot duplicate a release");
    assert.deepEqual(
      h.pending.list("demo-backend", "production").map((e) => e.sourceFile),
      [path(41)],
    );
  });
});

// ---------------------------------------------------------------------------
// A REPOINT MUST NEVER MOVE A CHILD BACKWARDS ALONG THE LINEAGE.
//
// `repoint.ts` computes the destination from the parent's LIVE serving variation, and "live"
// includes states a human deliberately put the flag into. `trigger.ts` explicitly advises serving
// an earlier variation directly as the way to roll back, and doing so leaves
// `findLatestRelease` still reporting the old release as `completed` — so every repoint caller's
// gate is satisfied and the destination is now `control`.
//
// The consequence is a WRITE CAUSED BY A ROLLBACK: a child pinned behind an unmet prerequisite is
// dark, and repointing it to what the parent now serves MEETS that prerequisite, so the child
// serves its treatment to 100% of traffic with no rollout and no monitoring.
//
// The fix is a strict narrowing, and it covers all three callers at once — `monitor.ts`, the
// `noop`/`immediate` repoint in `server.ts`, and the ledger's — because it lives inside
// `repoint.ts` rather than in any gate.
// ---------------------------------------------------------------------------
describe("a repoint never moves a child backwards along the lineage", () => {
  const heldByIntent = (target: string) =>
    ghWith([`pr-41.json`], { [path(41)]: manifest(target, { releaseIntent: { action: "hold" } }) });

  it("refuses to move a child from v1 to control when a human rolled the parent back", async () => {
    // PREVENTS the rollback-triggered un-dark. Nothing is running, the newest release is
    // `completed`, and the parent serves `control` — exactly the state `trigger.ts` recommends for
    // a deliberate rollback — so every gate on the repoint passes and only the lineage comparison
    // stands between the rollback and a child flag going live at 100%.
    const h = await harness(
      heldByIntent("v2"),
      mvState({
        on: true,
        served: "control",
        releases: [{ id: "rel-1", status: "completed" }],
        children: { "enable-child": { pinned: "v1" } },
      }),
    );
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    assert.equal(r.json.discovered, 0, "only the ledger can reach this manifest");
    assert.deepEqual(h.patches, [], "THE DISCRIMINATOR: no child patch — the rollback wrote nothing");
    assert.equal(outcomeFor(r.json, 41).action, "held", "and the manifest's own verdict is untouched");
  });

  it("still repoints control → v1: a first release is forward, and pinned has no lineage index", async () => {
    // The forward control arm that a too-broad guard would break. `control` has no vN index at all,
    // so "is the destination behind what is pinned?" has no answer — and the answer must be ALLOW,
    // because this is the first release of every flag the factory creates.
    const h = await harness(
      heldByIntent("v1"),
      mvState({
        values: ["control", "v1"],
        on: true,
        served: "v1",
        releases: [{ id: "rel-1", status: "completed" }],
        children: { "enable-child": { pinned: "control" } },
      }),
    );
    h.seed(41, "v1");

    const r = await h.post("sha1", "sha0");
    const childPatch = h.patches.find((p) => p.flagKey === "enable-child");
    assert.ok(childPatch, "THE DISCRIMINATOR: the ordinary first release still reaches its children");
    assert.equal(childPatch.instructions[1]?.variationId, "id-v1");
    assert.equal(outcomeFor(r.json, 41).action, "held");
  });

  it("still repoints v1 → v2: both are lineage-indexed and the destination is ahead", async () => {
    // The other forward arm — the iteration case, where BOTH values have a lineage index. A guard
    // written as "refuse whenever pinned has an index" would pass the test above and break this one,
    // which is the whole point of having both.
    const h = await harness(
      heldByIntent("v2"),
      mvState({
        on: true,
        served: "v2",
        releases: [{ id: "rel-1", status: "completed" }],
        children: { "enable-child": { pinned: "v1" } },
      }),
    );
    h.seed(41, "v2");

    const r = await h.post("sha1", "sha0");
    const childPatch = h.patches.find((p) => p.flagKey === "enable-child");
    assert.ok(childPatch, "THE DISCRIMINATOR: an iteration still carries its children forward");
    assert.equal(childPatch.instructions[1]?.variationId, "id-v2");
  });
});

// ---------------------------------------------------------------------------
// The ledger's terminal gate, and what its early returns report. A sabotage sweep found each
// of these silently survivable: the `monitoring_stopped` half of the gate was unasserted, and
// every `targetOf(...)` spread on an early return could be deleted with all tests green.
// ---------------------------------------------------------------------------
describe("the ledger refuses BOTH non-completed terminal statuses", () => {
  it("monitoring_stopped is refused exactly like reverted", async () => {
    // PREVENTS narrowing the gate to `status === "reverted"`. A release whose monitoring stopped
    // is FINISHED WITHOUT HAVING COMPLETED — it can be parked mid-ramp with nobody watching — so
    // re-triggering it is the same hazard as re-releasing a reverted variation. Since the question
    // now has one implementation (`terminalHistoryRefusal`), this covers the repeat-sha path too.
    const h = await harness(
      ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }),
      mvState({ releases: [{ id: "rel-9", status: "monitoring_stopped" }] }),
    );
    h.seed(41, "v2");
    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "error");
    assert.equal(o.needsHuman, true);
    assert.match(String(o.detail), /monitoring_stopped/);
    assert.deepEqual(h.patches, [], "THE DISCRIMINATOR: nothing re-triggered");
    assert.equal(o.targetVariation, "v2", "and the refusal still names the variation it refused");
  });
});

describe("every ledger early return still names the variation it is about", () => {
  // PREVENTS deleting any `targetOf(...)` spread on an early return. `recordOutcome` writes back
  // what it is GIVEN and deliberately does not merge with the stored value (a manifest that drops
  // its target now means "the tip"), so a missing spread silently ERASES the field from the
  // ledger — and then every log line names a flag that four manifests also name, with no way to
  // tell which PR's work is waiting.

  it("a manifest that cannot be re-read keeps its variation, on the outcome and in the ledger", async () => {
    const gh = {
      async listDir(): Promise<string[]> {
        return [`pr-41.json`];
      },
      async getFileJson(): Promise<unknown> {
        throw new Error("502 from GitHub");
      },
      async fileExists(): Promise<boolean> {
        return true;
      },
    } as unknown as GitHubClient;
    const h = await harness(gh, mvState());
    h.seed(41, "v2");
    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "error");
    assert.equal(o.targetVariation, "v2", "THE DISCRIMINATOR: the outcome still says which variation");
    assert.equal(
      h.pending.list("demo-backend", "production")[0]?.targetVariation,
      "v2",
      "and the fold-back does not erase it",
    );
  });

  it("a withdrawn manifest names its variation as it leaves the ledger", async () => {
    // Final, so this is the LAST report about this work — the one place a lost variation can
    // never be recovered on a later deploy.
    const h = await harness(ghWith([`pr-41.json`], {}), mvState());
    h.seed(41, "v2");
    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "skipped");
    assert.equal(o.targetVariation, "v2", "THE DISCRIMINATOR: the final word names the work");
    assert.deepEqual(h.pending.list("demo-backend", "production"), [], "withdrawn ⇒ dropped");
  });

  it("an unreadable release history names the FRESHLY READ variation", async () => {
    // This one reports `parsed.targetVariation`, not the remembered one: the manifest was read
    // successfully, so a human's edit to the target must show up even though the guard failed.
    const h = await harness(
      ghWith([`pr-41.json`], { [path(41)]: manifest("v2") }),
      mvState({ releasesThrow: true }),
    );
    h.seed(41, "v1"); // stale: the manifest has since been edited to v2
    const r = await h.post("sha1", "sha0");
    const o = outcomeFor(r.json, 41);
    assert.equal(o.action, "error");
    assert.match(String(o.detail), /release history/);
    assert.equal(o.targetVariation, "v2", "THE DISCRIMINATOR: as read now, not as remembered");
    assert.equal(h.pending.list("demo-backend", "production")[0]?.targetVariation, "v2");
  });
});
