import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { FileDeployStateStore, MemoryDeployStateStore, resolvePreviousSha } from "@auto-factory/beacon";

describe("MemoryDeployStateStore", () => {
  it("keeps two-deep history per service@environment", () => {
    const store = new MemoryDeployStateStore();
    store.record("svc", "production", "aaa");
    assert.deepEqual(store.get("svc", "production"), { last: "aaa" });

    store.record("svc", "production", "bbb");
    assert.deepEqual(store.get("svc", "production"), { last: "bbb", prior: "aaa" });

    // Other environments and services are independent.
    assert.deepEqual(store.get("svc", "staging"), {});
    assert.deepEqual(store.get("other", "production"), {});
  });

  it("re-recording the current SHA is a no-op (preserves prior)", () => {
    const store = new MemoryDeployStateStore();
    store.record("svc", "production", "aaa");
    store.record("svc", "production", "bbb");
    store.record("svc", "production", "bbb"); // provider retry / restart
    assert.deepEqual(store.get("svc", "production"), { last: "bbb", prior: "aaa" });
  });
});

describe("resolvePreviousSha", () => {
  const store = new MemoryDeployStateStore();
  store.record("svc", "production", "aaa");
  store.record("svc", "production", "bbb");

  it("an explicit previousSha always wins", () => {
    assert.deepEqual(resolvePreviousSha(store, "svc", "production", "ccc", "explicit"), {
      previousSha: "explicit",
      source: "request",
    });
  });

  it("falls back to the stored last SHA for a new deploy", () => {
    assert.deepEqual(resolvePreviousSha(store, "svc", "production", "ccc", undefined), {
      previousSha: "bbb",
      source: "state",
    });
  });

  it("a re-notification of the current SHA re-diffs the same range (prior)", () => {
    assert.deepEqual(resolvePreviousSha(store, "svc", "production", "bbb", undefined), {
      previousSha: "aaa",
      source: "state",
    });
  });

  it("first deploy has no previousSha", () => {
    assert.deepEqual(resolvePreviousSha(store, "fresh", "production", "ccc", undefined), {
      previousSha: undefined,
      source: "none",
    });
  });
});

describe("FileDeployStateStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("persists across instances", () => {
    const file = join(dir, "state.json");
    const a = new FileDeployStateStore(file);
    a.record("svc", "production", "aaa");
    a.record("svc", "production", "bbb");

    const b = new FileDeployStateStore(file);
    assert.deepEqual(b.get("svc", "production"), { last: "bbb", prior: "aaa" });
  });

  it("starts empty when the file does not exist", () => {
    const store = new FileDeployStateStore(join(dir, "missing.json"));
    assert.deepEqual(store.get("svc", "production"), {});
  });
});

// ---------------------------------------------------------------------------
// A missing state file is a first run. An UNREADABLE one is not — and treating it as one
// makes `resolvePreviousSha` return undefined, which makes discovery treat every manifest
// in the repo as new. For a flag whose guarded release was already REVERTED by a metric
// regression, re-triggering silently undoes the guardrail's rollback.
// ---------------------------------------------------------------------------
describe("FileDeployStateStore: unreadable state is not a first run", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "af-state-"));
    dirs.push(d);
    return d;
  };

  it("a MISSING file constructs empty (a genuine first run)", () => {
    // `get` returns a DeployState, empty when nothing is known — so "no prior SHA".
    const store = new FileDeployStateStore(join(scratch(), "state.json"));
    assert.deepEqual(store.get("svc", "production"), {});
    assert.equal(store.get("svc", "production").last, undefined);
  });

  it("a CORRUPT file throws at construction rather than starting empty", () => {
    const file = join(scratch(), "state.json");
    writeFileSync(file, "{ not json");
    // Construction happens at boot, before any webhook is served, so this surfaces to an
    // operator instead of as a mass re-release.
    assert.throws(
      () => new FileDeployStateStore(file),
      /could not be read.*re-trigger every release manifest/s,
    );
  });

  it("the error says how to reset deliberately", () => {
    const file = join(scratch(), "state.json");
    writeFileSync(file, "]]not json[[");
    assert.throws(() => new FileDeployStateStore(file), /deleting it deliberately resets/);
  });

  it("a well-formed file still round-trips", () => {
    const file = join(scratch(), "state.json");
    const a = new FileDeployStateStore(file);
    a.record("svc", "production", "sha1");
    assert.equal(new FileDeployStateStore(file).get("svc", "production")?.last, "sha1");
  });
});

// ---------------------------------------------------------------------------
// Round eight, F2: re-recording the PRIOR sha must not rewrite history.
//
// `record` already no-op'd on `last`, but not on `prior`. So a re-POST of an older
// sha set {last: prior, prior: last} — swapping them — and the NEXT deploy then
// diffed a range that had already been processed, re-evaluating finished flags.
// That is the path by which a manual recovery attempt could re-release a flag whose
// release was already reverted.
// ---------------------------------------------------------------------------
describe("MemoryDeployStateStore: re-recording history", () => {
  it("re-recording `prior` is a no-op, so the window does not swap", () => {
    const s = new MemoryDeployStateStore();
    s.record("svc", "production", "sha1");
    s.record("svc", "production", "sha2");
    assert.deepEqual(s.get("svc", "production"), { last: "sha2", prior: "sha1" });

    s.record("svc", "production", "sha1"); // a re-POST of the older sha
    assert.deepEqual(
      s.get("svc", "production"),
      { last: "sha2", prior: "sha1" },
      "history must be unchanged: swapping makes the next deploy re-diff a processed range",
    );
  });

  it("re-recording `last` is still a no-op", () => {
    const s = new MemoryDeployStateStore();
    s.record("svc", "production", "sha1");
    s.record("svc", "production", "sha1");
    assert.deepEqual(s.get("svc", "production"), { last: "sha1" }, "no phantom prior");
  });

  it("a genuinely new sha still advances the window", () => {
    const s = new MemoryDeployStateStore();
    s.record("svc", "production", "sha1");
    s.record("svc", "production", "sha2");
    s.record("svc", "production", "sha3");
    assert.deepEqual(s.get("svc", "production"), { last: "sha3", prior: "sha2" });
  });
});
