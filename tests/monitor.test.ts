import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dedupeMonitors, monitorTriggeredRelease } from "@auto-factory/beacon";
import type { LdClient } from "@auto-factory/shared";

// ---------------------------------------------------------------------------
// Round seven, finding 6: a release that finishes before it can be listed was
// never monitored. monitorTriggeredRelease resolves the release id via
// findActiveRelease, which filters to NOT-finished — a release completing
// inside the ~8s retry envelope is filtered out, the code logs "it may have
// completed instantly", and returns WITHOUT running the completion path. So
// repointDependentPrerequisites never fired for exactly the case the log names.
// Fix: on no-active, one unfiltered look at the newest release; if it is
// `completed`, run the repoint.
// ---------------------------------------------------------------------------

/**
 * Fake LD covering findActiveRelease/findLatestRelease (same listing path) plus
 * what repointDependentPrerequisites touches: a multivariate parent serving
 * variation v2, with one auto-factory child pinned to v1.
 */
function fakeLd(latestStatus: string, patches: unknown[]): LdClient {
  return {
    projectKey: "p",
    async request(opts: { path: string }): Promise<{ status: number; ok: boolean; data: unknown }> {
      if (opts.path.includes("/automated-releases")) {
        return { status: 200, ok: true, data: { items: [{ id: "rel-1", kind: "guarded", status: latestStatus, latestStageIndex: 2 }] } };
      }
      throw new Error(`unexpected LD request: ${opts.path}`);
    },
    async getFlag(flagKey: string): Promise<{ status: number; ok: boolean; data: unknown }> {
      if (flagKey === "parent-flag") {
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "v1", value: "one" },
              { _id: "v2", value: "two" },
            ],
            environments: { production: { on: true, fallthrough: { variation: 1 } } },
          },
        };
      }
      return {
        status: 200,
        ok: true,
        data: {
          tags: ["auto-factory"],
          environments: { production: { prerequisites: [{ key: "parent-flag", variation: 0 }] } },
        },
      };
    },
    async getDependentFlags(): Promise<{ status: number; ok: boolean; data: unknown }> {
      return { status: 200, ok: true, data: { items: [{ key: "child-flag" }] } };
    },
    async patchFlagSemantic(flagKey: string, env: string, instructions: unknown[]): Promise<unknown> {
      patches.push({ flagKey, env, instructions });
      return { status: 200, ok: true, data: {} };
    },
  } as unknown as LdClient;
}

const settings = { enabled: true, pollMillis: 5, timeoutMillis: 1_000 };

describe("monitorTriggeredRelease — release finished before it could be listed", () => {
  it("runs the completion path when the newest release is already completed", async () => {
    const patches: unknown[] = [];
    const final = await monitorTriggeredRelease(fakeLd("completed", patches), "parent-flag", "production", settings);
    // THE DISCRIMINATOR: pre-fix this returned null ("may have completed
    // instantly") and repointed nothing.
    assert.equal(final?.status, "completed");
    assert.equal(patches.length, 1, "the stranded child was re-pointed");
    const patch = patches[0] as { flagKey: string; instructions: Array<{ kind: string; variationId?: string }> };
    assert.equal(patch.flagKey, "child-flag");
    assert.equal(patch.instructions[1]?.kind, "addPrerequisite");
    assert.equal(patch.instructions[1]?.variationId, "v2", "pinned to what the environment now serves");
  });

  it("does NOT repoint when the newest release ended reverted", async () => {
    // reverted/monitoring_stopped don't repoint on the normal path either — the
    // environment went back to the original variation.
    const patches: unknown[] = [];
    const final = await monitorTriggeredRelease(fakeLd("reverted", patches), "parent-flag", "production", settings);
    assert.equal(final, null);
    assert.deepEqual(patches, []);
  });
});

// ---------------------------------------------------------------------------
// Round seven, finding 8: every redelivery of an `already_running` flag attached
// ANOTHER detached 24h monitor loop for the same release — duplicate polling and
// duplicate (idempotent) repoints. The default onReleaseStarted is now deduped
// per flag/environment while a watch is in flight.
// ---------------------------------------------------------------------------
describe("dedupeMonitors", () => {
  it("attaches at most one in-flight watch per flag/environment", async () => {
    let started = 0;
    let release: () => void = () => {};
    const gateP = new Promise<void>((r) => (release = r));
    const attach = dedupeMonitors(async () => {
      started++;
      await gateP;
    });
    attach("flag-a", "production");
    attach("flag-a", "production"); // redelivered already_running — must not stack
    attach("flag-a", "production");
    assert.equal(started, 1, "one watch, however many redeliveries");
    // A different key is independent.
    attach("flag-b", "production");
    assert.equal(started, 2);
    // Once the watch ends (completed, or Beacon gave up), a re-attach is legitimate
    // — that is how a restarted/redelivered notification picks a release back up.
    release();
    await gateP;
    await new Promise((r) => setImmediate(r)); // let .finally free the key
    attach("flag-a", "production");
    assert.equal(started, 3, "re-attachable after the previous watch settles");
  });
});
