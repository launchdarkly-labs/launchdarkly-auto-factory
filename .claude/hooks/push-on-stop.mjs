#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  // The repository is still the source of truth when hook input is unavailable.
}

const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const alreadyRetried = input.stop_hook_active === true;

function run(args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function detail(result) {
  return (result.stderr || result.stdout || result.error?.message || "unknown Git error")
    .trim()
    .slice(-1500);
}

function fail(message) {
  if (alreadyRetried) {
    process.stderr.write(`${message}\n`);
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ decision: "block", reason: message }));
  process.exit(0);
}

const inside = run(["rev-parse", "--is-inside-work-tree"]);
if (inside.status !== 0 || inside.stdout.trim() !== "true") {
  fail(`Stop hook could not find a Git repository at ${cwd}.`);
}

const branchResult = run(["branch", "--show-current"]);
const branch = branchResult.stdout.trim();
if (branchResult.status !== 0 || !branch) {
  fail("Stop hook cannot push from a detached HEAD. Check out a branch and try again.");
}

const gitDirResult = run(["rev-parse", "--absolute-git-dir"]);
if (gitDirResult.status !== 0) fail(`Stop hook could not locate the Git directory: ${detail(gitDirResult)}`);

const gitDir = gitDirResult.stdout.trim();
for (const operation of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
  if (existsSync(`${gitDir}/${operation}`)) {
    fail(`Stop hook found an unfinished Git operation (${operation}). Finish it before pushing.`);
  }
}

const lockDir = `${gitDir}/claude-stop-push.lock`;
try {
  mkdirSync(lockDir);
} catch {
  fail("Another Claude Code stop hook is already committing or pushing this repository.");
}

try {
  const status = run(["status", "--porcelain"]);
  if (status.status !== 0) fail(`Stop hook could not inspect the worktree: ${detail(status)}`);

  if (status.stdout.trim()) {
    const add = run(["add", "-A"]);
    if (add.status !== 0) fail(`Stop hook could not stage the changes: ${detail(add)}`);

    const staged = run(["diff", "--cached", "--quiet"]);
    if (staged.status === 1) {
      const commit = run(["commit", "-m", "chore: save Claude Code changes"]);
      if (commit.status !== 0) fail(`Stop hook could not commit the changes: ${detail(commit)}`);
    } else if (staged.status !== 0) {
      fail(`Stop hook could not inspect the staged changes: ${detail(staged)}`);
    }
  }

  const upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let push;
  if (upstream.status === 0) {
    push = run(["push"]);
  } else {
    const remotes = run(["remote"]);
    if (remotes.status !== 0) fail(`Stop hook could not list Git remotes: ${detail(remotes)}`);

    const names = remotes.stdout.trim().split(/\s+/).filter(Boolean);
    const remote = names.includes("origin") ? "origin" : names[0];
    if (!remote) fail("Stop hook cannot push because this repository has no Git remote.");
    push = run(["push", "--set-upstream", remote, "HEAD"]);
  }

  if (push.status !== 0) fail(`Stop hook could not push branch '${branch}': ${detail(push)}`);
} finally {
  rmSync(lockDir, { recursive: true, force: true });
}
