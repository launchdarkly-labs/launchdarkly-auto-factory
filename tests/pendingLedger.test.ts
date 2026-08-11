import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  FilePendingStore,
  MemoryPendingStore,
  PENDING_ACTIONS,
  PENDING_LEDGER_VERSION,
  recordOutcome,
} from "@auto-factory/beacon";

// ---------------------------------------------------------------------------
// The re-evaluation ledger.
//
// Beacon evaluates each manifest exactly once, because discovery is a FILENAME diff
// between two SHAs — a file present at both ends is never rediscovered. So every
// non-final outcome (held / waiting / error) got one chance and stranded, with
// nothing to retry it: the Notifier cannot fail a deploy, and Railway documents no
// webhook retry. This store is what remembers.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "beacon-ledger-"));
  dirs.push(d);
  return d;
};

const entry = (flagKey: string, action: string) => ({
  service: "demo-backend",
  environment: "production",
  sha: "sha1",
  flagKey,
  sourceFile: `.release-flags/${flagKey}.json`,
  action,
});

describe("recordOutcome — remember unfinished, forget finished", () => {
  it("keeps every non-final action and drops every final one", () => {
    const store = new MemoryPendingStore();
    for (const a of ["held", "waiting", "error"]) recordOutcome(store, entry(`f-${a}`, a));
    for (const a of ["released", "noop", "skipped", "already_running"]) recordOutcome(store, entry(`f-${a}`, a));
    const kept = store.list("demo-backend", "production").map((e) => e.flagKey).sort();
    assert.deepEqual(kept, ["f-error", "f-held", "f-waiting"]);
  });

  it("a flag that finally releases stops being tracked", () => {
    const store = new MemoryPendingStore();
    recordOutcome(store, entry("enable-one", "waiting"));
    assert.equal(store.list("demo-backend", "production").length, 1);
    // The counterpart deployed; the next evaluation releases it.
    recordOutcome(store, entry("enable-one", "released"));
    assert.deepEqual(store.list("demo-backend", "production"), [], "the ledger must not grow without bound");
  });

  it("counts attempts and preserves when the flag FIRST stranded", () => {
    const store = new MemoryPendingStore();
    recordOutcome(store, { ...entry("enable-one", "waiting"), sha: "sha1" });
    recordOutcome(store, { ...entry("enable-one", "waiting"), sha: "sha2" });
    recordOutcome(store, { ...entry("enable-one", "held"), sha: "sha3" });
    const [e] = store.list("demo-backend", "production");
    assert.equal(e?.attempts, 3);
    assert.equal(e?.firstSeenSha, "sha1", "how long this has been stuck is the useful number");
    assert.equal(e?.lastSha, "sha3");
    assert.equal(e?.lastAction, "held", "the CURRENT reason, not the original one");
  });

  it("scopes entries per service and environment", () => {
    const store = new MemoryPendingStore();
    recordOutcome(store, entry("enable-one", "held"));
    recordOutcome(store, { ...entry("enable-one", "held"), environment: "staging" });
    recordOutcome(store, { ...entry("enable-one", "held"), service: "demo-frontend" });
    assert.equal(store.list("demo-backend", "production").length, 1);
    assert.equal(store.list("demo-backend", "staging").length, 1);
    assert.equal(store.list("demo-frontend", "production").length, 1);
  });

  it("needsHuman survives, so a reverted release is never quietly re-tried", () => {
    const store = new MemoryPendingStore();
    recordOutcome(store, { ...entry("enable-one", "error"), needsHuman: true });
    assert.equal(store.list("demo-backend", "production")[0]?.needsHuman, true);
  });

  it("PENDING_ACTIONS agrees with what the Notifier calls non-final", () => {
    // Two lists in two files: if they disagree, a flag is either reported to an operator
    // and never re-checked, or re-checked forever and never reported.
    assert.deepEqual([...PENDING_ACTIONS].sort(), ["error", "held", "waiting"]);
  });
});

describe("FilePendingStore", () => {
  it("round-trips through the file, and a missing file is a first run", () => {
    const dir = tmpDir();
    const file = join(dir, "nested", "pending.json");
    const a = new FilePendingStore(file);
    assert.deepEqual(a.list("demo-backend", "production"), [], "ENOENT is an empty ledger, not an error");
    recordOutcome(a, entry("enable-one", "held"));

    const b = new FilePendingStore(file);
    const [e] = b.list("demo-backend", "production");
    assert.equal(e?.flagKey, "enable-one");
    assert.equal(e?.lastAction, "held");
  });

  it("clearing persists, so a released flag stays gone across a restart", () => {
    const dir = tmpDir();
    const file = join(dir, "pending.json");
    const a = new FilePendingStore(file);
    recordOutcome(a, entry("enable-one", "held"));
    recordOutcome(a, entry("enable-one", "released"));
    assert.deepEqual(new FilePendingStore(file).list("demo-backend", "production"), []);
  });

  it("REFUSES a file whose version it does not recognise", () => {
    // The keying changed once (flagKey → sourceFile). Without a version, a file written
    // under the old scheme loads with keys that never match a lookup, so entries are
    // re-created alongside stale twins that never clear — silently. That is worse than a
    // refusal, which an operator sees at boot.
    const dir = tmpDir();
    const file = join(dir, "pending.json");
    writeFileSync(file, JSON.stringify({ version: PENDING_LEDGER_VERSION + 1, entries: {} }));
    assert.throws(() => new FilePendingStore(file), /version/);
  });

  it("REFUSES the pre-version shape (a bare map of entries)", () => {
    const dir = tmpDir();
    const file = join(dir, "pending.json");
    // Exactly what the previous revision wrote: a flat map, keyed by flagKey, no version.
    writeFileSync(
      file,
      JSON.stringify({
        "demo-backend@production#enable-one": {
          service: "demo-backend",
          environment: "production",
          flagKey: "enable-one",
          sourceFile: ".release-flags/enable-one.json",
          firstSeenSha: "sha1",
          lastSha: "sha1",
          lastAction: "held",
          attempts: 1,
        },
      }),
    );
    assert.throws(() => new FilePendingStore(file), /version/);
  });

  it("DERIVES keys on load, so a mis-keyed entry is not immortal", () => {
    // `list()` filters on fields but `clear()` deletes by derived key, so an entry whose
    // stored key disagreed with its fields was returned and re-evaluated forever, re-created
    // as a twin on every upsert, and never deletable — the same silent-stale-twin failure the
    // version gate prevents, but inside a VALID file. Reachable because these messages invite
    // hand-editing, and the obvious edit after a rename changes sourceFile and not the key.
    const dir = tmpDir();
    const file = join(dir, "pending.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: PENDING_LEDGER_VERSION,
        entries: {
          "a-stale-key-that-matches-nothing": {
            service: "demo-backend",
            environment: "production",
            flagKey: "enable-one",
            sourceFile: ".release-flags/pr-1.json",
            firstSeenSha: "sha1",
            lastSha: "sha1",
            lastAction: "held",
            attempts: 1,
          },
        },
      }),
    );
    const store = new FilePendingStore(file);
    assert.equal(store.list("demo-backend", "production").length, 1, "the entry is still loaded");

    // A final outcome for that manifest must actually remove it.
    recordOutcome(store, {
      service: "demo-backend",
      environment: "production",
      sha: "sha2",
      flagKey: "enable-one",
      sourceFile: ".release-flags/pr-1.json",
      action: "released",
    });
    assert.deepEqual(store.list("demo-backend", "production"), [], "clear() must reach it");
    assert.deepEqual(new FilePendingStore(file).list("demo-backend", "production"), [], "and it stays gone");
  });

  it("REFUSES TO START on an unreadable ledger rather than silently forgetting", () => {
    // Starting empty would look identical to "nothing is pending", and every in-flight
    // release would strand with nothing tracking it — a safety net that quietly is not
    // there is worse than one that refuses to start.
    const dir = tmpDir();
    const file = join(dir, "pending.json");
    writeFileSync(file, "{ this is not json");
    assert.throws(() => new FilePendingStore(file), /could not be read|refusing to start/);
  });
});
