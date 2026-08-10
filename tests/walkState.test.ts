import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readRepoState } from "@auto-factory/shared";
import {
  NO_FEEDBACK_IN_PLAY,
  WALK_STATE_VERSION,
  clearWalkState,
  computeTreeHash,
  readWalkState,
  validateWalkState,
  walkStatePath,
  writeWalkState,
} from "@auto-factory/phase1-cli";

const tmps: string[] = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** A throwaway git repo with one commit. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-walkstate-"));
  tmps.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

const sampleRuns = [
  { configKey: "autofactory-research-planner", status: "completed" as const, output: "planned", tags: { flag_worthy: "true" }, iteration: 1 },
];

describe("walk state file (lives in .git, never in the working tree)", () => {
  it("round-trips the journal and stores it inside .git so it can't be committed", () => {
    const dir = repo();
    writeWalkState(dir, {
      graphKey: "gha-auto-factory",
      configStamp: "cfg123",
      branch: "feature",
      head: "sha1",
      policyMode: "always",
      base: "main",
      haltedAt: { kind: "pending-approval", node: "autofactory-flag-implementer" },
      runs: sampleRuns,
    }, NO_FEEDBACK_IN_PLAY);
    const p = walkStatePath(dir);
    assert.match(p, /[\\/]\.git[\\/]autofactory-walk-state\.json$/);
    // The whole reason for the .git location: `git status` must stay clean.
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "");

    const read = readWalkState(dir);
    assert.equal(read?.graphKey, "gha-auto-factory");
    assert.equal(read?.haltedAt.node, "autofactory-flag-implementer");
    assert.deepEqual(read?.runs, sampleRuns);
    assert.ok(read?.at, "stamped with a write time");
    assert.equal(read?.version, WALK_STATE_VERSION, "stamped with the current schema version");
  });

  it("round-trips POSITIONAL grants, so a later resume can honour where each took effect", () => {
    const dir = repo();
    const grants = [
      { edge: "review→flag", visits: 1, effectiveAfterRuns: 4 },
      { edge: "review→flag", visits: 1, effectiveAfterRuns: 9 },
    ];
    writeWalkState(dir, {
      graphKey: "g",
      configStamp: "cfg",
      head: "sha",
      policyMode: "always",
      base: "main",
      grants,
      haltedAt: { kind: "loop-exhausted", node: "review", exhaustedEdges: ["review→flag"] },
      runs: sampleRuns,
    }, NO_FEEDBACK_IN_PLAY);
    assert.deepEqual(readWalkState(dir)?.grants, grants, "positions must survive the round trip");
  });

  it("reads as absent before a write and after a clear", () => {
    const dir = repo();
    assert.equal(readWalkState(dir), undefined);
    writeWalkState(dir, { graphKey: "g", haltedAt: { kind: "loop-exhausted", node: "n" }, runs: sampleRuns }, NO_FEEDBACK_IN_PLAY);
    assert.ok(readWalkState(dir));
    clearWalkState(dir);
    assert.equal(readWalkState(dir), undefined);
    assert.equal(existsSync(walkStatePath(dir)), false);
  });

  it("a journal from an older schema version is REFUSED, not misread", () => {
    // Each bump added a load-bearing field (v2: grants + base, v3: exhaustedEdges). An
    // older journal read as if it were current would silently lose one and then either
    // diverge mid-replay or accept a grant it can't validate — confusing failures instead
    // of a clean refusal. Written raw, since writeWalkState always stamps the current
    // version. Deliberately relative to the constant so a future bump doesn't break it.
    const dir = repo();
    writeFileSync(
      walkStatePath(dir),
      JSON.stringify({
        version: WALK_STATE_VERSION - 1,
        graphKey: "g",
        configStamp: "cfg123",
        head: "sha1",
        treeHash: "tree1",
        policyMode: "always",
        haltedAt: { kind: "pending-approval", node: "n" },
        runs: sampleRuns,
        at: "2026-08-09T00:00:00.000Z",
      }),
    );
    const r = validateWalkState(readWalkState(dir), {
      graphKey: "g",
      configStamp: "cfg123",
      head: "sha1",
      treeHash: "tree1",
      policyMode: "always",
      base: "main",
    });
    assert.equal(r.ok, false);
    assert.match(
      (r as { reason: string }).reason,
      new RegExp(`version ${WALK_STATE_VERSION - 1}, this build expects ${WALK_STATE_VERSION}`),
    );
  });

  it("a corrupt file reads as absent rather than throwing", () => {
    const dir = repo();
    writeFileSync(walkStatePath(dir), "{not json");
    assert.equal(readWalkState(dir), undefined);
  });

  it("clearing when nothing is saved is a no-op", () => {
    const dir = repo();
    clearWalkState(dir);
    assert.equal(readWalkState(dir), undefined);
  });
});

describe("computeTreeHash — HEAD alone cannot detect what agents change", () => {
  it("is stable across calls with no changes", () => {
    const dir = repo();
    const a = computeTreeHash(dir);
    assert.ok(a, "computable in a normal repo");
    assert.equal(computeTreeHash(dir), a);
  });

  it("changes when a TRACKED file is edited without moving HEAD", () => {
    // This is the CLI's actual failure mode: gitMode "workingTree" means agents
    // edit files and never commit, so a head-only check would call this unchanged.
    const dir = repo();
    const before = computeTreeHash(dir);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "app.ts"), "export const x = 2;\n");
    const after = computeTreeHash(dir);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(headBefore, headAfter, "HEAD did not move");
    assert.notEqual(before, after, "but the tree hash must");
  });

  it("changes when an UNTRACKED file is added, and again when its contents change", () => {
    const dir = repo();
    const before = computeTreeHash(dir);
    writeFileSync(join(dir, "new-feature.ts"), "export const y = 1;\n");
    const added = computeTreeHash(dir);
    assert.notEqual(before, added, "a new untracked file counts");
    writeFileSync(join(dir, "new-feature.ts"), "export const y = 2;\n");
    // Content hashing, not just the path list — an agent rewriting a file it
    // created must invalidate the journal too.
    assert.notEqual(added, computeTreeHash(dir), "editing an untracked file counts");
  });

  it("returns to the original hash when a change is reverted", () => {
    const dir = repo();
    const before = computeTreeHash(dir);
    writeFileSync(join(dir, "app.ts"), "export const x = 2;\n");
    assert.notEqual(computeTreeHash(dir), before);
    writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
    assert.equal(computeTreeHash(dir), before, "content-addressed, not time-based");
  });

  it("returns undefined outside a git repo, so callers must fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-nogit-"));
    tmps.push(dir);
    assert.equal(computeTreeHash(dir), undefined);
  });

  it("handles an UNTRACKED file with a non-ASCII name (core.quotePath default)", () => {
    // With git's default core.quotePath=true, `ls-files` C-quotes non-ASCII names
    // ("na\303\257ve…"); `hash-object` then failed on the literal quoted string and
    // computeTreeHash returned undefined — permanently refusing resume in that repo.
    // Fail-closed, but availability lost for no reason; `-z` emits unquoted paths.
    const dir = repo();
    execFileSync("git", ["config", "core.quotePath", "true"], { cwd: dir });
    const before = computeTreeHash(dir);
    const name = "naïve-ページ.ts";
    writeFileSync(join(dir, name), "export const z = 1;\n");
    const withFile = computeTreeHash(dir);
    assert.ok(withFile, "must stay computable with a non-ASCII untracked filename");
    assert.notEqual(withFile, before, "the new file counts");
    writeFileSync(join(dir, name), "export const z = 2;\n");
    assert.notEqual(computeTreeHash(dir), withFile, "its contents still count");
  });
});

// ---------------------------------------------------------------------------
// The bug this file previously missed: it tested computeTreeHash in isolation and
// the file round-trip in isolation, but never the SEQUENCE — that the hash stored
// at a halt reflects the tree as the agents left it. Getting that wrong broke
// resume outright AND inverted the check (reverting the agents' edits made it
// pass, replaying a journal describing work no longer in the files).
// ---------------------------------------------------------------------------
describe("walk state captures the tree AT THE HALT, not before the walk", () => {
  const keysFor = (dir: string) => ({
    graphKey: "g",
    configStamp: "cfg123",
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
    treeHash: computeTreeHash(dir),
    policyMode: "always",
    base: "origin/main",
    baseSha: "base-sha-1",
  });
  const save = (dir: string) =>
    writeWalkState(dir, {
      graphKey: "g",
      configStamp: "cfg123",
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
      policyMode: "always",
      base: "origin/main",
      baseSha: "base-sha-1",
      haltedAt: { kind: "pending-approval", node: "autofactory-flag-implementer" },
      runs: sampleRuns,
    }, NO_FEEDBACK_IN_PLAY);

  it("resuming immediately after a halt is ACCEPTED (the normal path must work)", () => {
    const dir = repo();
    // Stand in for the agents having edited the tree before the halt.
    writeFileSync(join(dir, "app.ts"), "export const x = 2; // agent edit\n");
    save(dir);
    const r = validateWalkState(readWalkState(dir), keysFor(dir));
    assert.equal(r.ok, true, `a halt-then-resume with an untouched tree must validate: ${JSON.stringify(r)}`);
  });

  it("a human editing files after the halt is REFUSED", () => {
    const dir = repo();
    writeFileSync(join(dir, "app.ts"), "export const x = 2; // agent edit\n");
    save(dir);
    writeFileSync(join(dir, "app.ts"), "export const x = 3; // human edit\n");
    const r = validateWalkState(readWalkState(dir), keysFor(dir));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /working tree changed/);
  });

  it("REVERTING the agents' edits is refused, not accepted", () => {
    // The safety inversion. `git checkout -- .` is the reflex on seeing unwanted
    // agent edits; if the stored hash were the PRE-walk tree, that reflex would make
    // the check pass and replay a journal claiming work the files no longer contain.
    const dir = repo();
    const pristine = "export const x = 1;\n";
    writeFileSync(join(dir, "app.ts"), "export const x = 2; // agent edit\n");
    save(dir);
    writeFileSync(join(dir, "app.ts"), pristine); // revert
    const r = validateWalkState(readWalkState(dir), keysFor(dir));
    assert.equal(r.ok, false, "reverting the recorded work must NOT validate");
    assert.match((r as { reason: string }).reason, /working tree changed/);
  });

  it("stores a hash that differs from the pre-walk tree when the walk edited files", () => {
    // Directly pins what the sequence bug got wrong.
    const dir = repo();
    const preWalk = computeTreeHash(dir);
    writeFileSync(join(dir, "app.ts"), "export const x = 2; // agent edit\n");
    save(dir);
    assert.notEqual(readWalkState(dir)?.treeHash, preWalk);
    assert.equal(readWalkState(dir)?.treeHash, computeTreeHash(dir));
  });
});

// ---------------------------------------------------------------------------
// Round seven, finding 4: resume invalidation must pin the base COMMIT, not the
// ref name. The stored/compared value used to be the literal `--base` string
// ("main"), while the walk actually diffs against `resolveBase`'s answer —
// which prefers `origin/main`, a ref that moves on any `git fetch` with no
// change to HEAD or the working tree. Every other invalidation key then passed
// and the live nodes analysed a different diff than the replayed journal.
// ---------------------------------------------------------------------------
describe("resume invalidation pins the base COMMIT, not the ref name", () => {
  it("readRepoState reports the resolved base's SHA (and prefers origin/<base>)", async () => {
    const dir = repo();
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    const sha = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", sha]); // simulate a remote-tracking main
    const state = await readRepoState(dir, "main");
    assert.equal(state.resolvedBase, "origin/main");
    assert.equal(state.resolvedBaseSha, sha);
  });

  it("a fetch that advances origin/main REFUSES the resume — HEAD and tree unchanged", async () => {
    const dir = repo();
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    const baseSha = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", baseSha]);
    // The change under review: a feature branch one commit ahead of the base.
    git(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "feature.ts"), "export const f = 1;\n");
    git(["add", "-A"]);
    execFileSync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });

    // Halt: save the walk state the way run.ts now does — resolved ref + its SHA.
    const before = await readRepoState(dir, "main");
    writeWalkState(dir, {
      graphKey: "g",
      configStamp: "cfg123",
      head: git(["rev-parse", "--short", "HEAD"]),
      policyMode: "always",
      base: before.resolvedBase!,
      baseSha: before.resolvedBaseSha!,
      haltedAt: { kind: "pending-approval", node: "autofactory-flag-implementer" },
      runs: sampleRuns,
    }, NO_FEEDBACK_IN_PLAY);

    // While the human decides, an IDE auto-fetch advances origin/main: a new commit
    // lands on the remote main (same tree here, which makes the case HARDER — only
    // the commit identity moves).
    const tree = git(["rev-parse", `${baseSha}^{tree}`]);
    const movedSha = git(["commit-tree", tree, "-p", baseSha, "-m", "someone else's merge"]);
    git(["update-ref", "refs/remotes/origin/main", movedSha]);

    // HEAD did not move and the working tree is untouched — the pre-fix keys all pass.
    const after = await readRepoState(dir, "main");
    assert.equal(after.head, before.head, "HEAD unmoved");
    assert.equal(after.resolvedBase, "origin/main", "same resolved ref NAME");
    assert.notEqual(after.resolvedBaseSha, before.resolvedBaseSha, "but a different commit");

    const r = validateWalkState(readWalkState(dir), {
      graphKey: "g",
      configStamp: "cfg123",
      head: git(["rev-parse", "--short", "HEAD"]),
      treeHash: computeTreeHash(dir),
      policyMode: "always",
      base: after.resolvedBase!,
      baseSha: after.resolvedBaseSha!,
    });
    assert.equal(r.ok, false, "a moved base is a different diff — must refuse");
    assert.match((r as { reason: string }).reason, /moved since the walk was saved/);
  });

  it("origin/main becoming unresolvable does NOT silently fall through to local main", async () => {
    const dir = repo();
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    const sha = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", sha]);
    const before = await readRepoState(dir, "main");
    assert.equal(before.resolvedBase, "origin/main");
    writeWalkState(dir, {
      graphKey: "g",
      configStamp: "cfg123",
      head: sha,
      policyMode: "always",
      base: before.resolvedBase!,
      baseSha: before.resolvedBaseSha!,
      haltedAt: { kind: "pending-approval", node: "n" },
      runs: sampleRuns,
    }, NO_FEEDBACK_IN_PLAY);
    // The remote-tracking ref disappears; resolveBase falls through to local main.
    git(["update-ref", "-d", "refs/remotes/origin/main"]);
    const after = await readRepoState(dir, "main");
    assert.notEqual(after.resolvedBase, "origin/main");
    const r = validateWalkState(readWalkState(dir), {
      graphKey: "g",
      configStamp: "cfg123",
      head: sha,
      treeHash: computeTreeHash(dir),
      policyMode: "always",
      base: after.resolvedBase!,
      baseSha: after.resolvedBaseSha!,
    });
    assert.equal(r.ok, false, "a substituted base ref must refuse, even at the same commit");
    assert.match((r as { reason: string }).reason, /base ref changed/);
  });

  it("an unknown base commit on either side fails closed", () => {
    const dir = repo();
    writeWalkState(dir, {
      graphKey: "g",
      configStamp: "cfg123",
      head: "sha1",
      policyMode: "always",
      base: "origin/main",
      // no baseSha — e.g. state written where rev-parse failed
      haltedAt: { kind: "pending-approval", node: "n" },
      runs: sampleRuns,
    }, NO_FEEDBACK_IN_PLAY);
    const r = validateWalkState(readWalkState(dir), {
      graphKey: "g",
      configStamp: "cfg123",
      head: "sha1",
      treeHash: computeTreeHash(dir),
      policyMode: "always",
      base: "origin/main",
      baseSha: "abc123",
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /base commit/);
  });
});
