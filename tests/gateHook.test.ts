import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const HOOK = fileURLToPath(new URL("../bootstrap/claude-code/hooks/autofactory-gate.mjs", import.meta.url));
const tmps: string[] = [];

/** A throwaway git repo on a feature branch, optionally seeded with a run record. */
function repoWith(record: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "af-gate-"));
  tmps.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  git(["checkout", "-q", "-b", "feature"]);
  if (record) writeFileSync(join(dir, ".git", "autofactory-last-run.json"), JSON.stringify({ branch: "feature", at: "now", ...record }));
  return dir;
}

/** Run the hook against a `git push` command in `dir`; return its permission decision. */
function decisionFor(dir: string): string {
  const out = execFileSync("node", [HOOK], {
    cwd: dir,
    input: JSON.stringify({ tool_input: { command: "git push" } }),
    encoding: "utf8",
  });
  return JSON.parse(out).hookSpecificOutput.permissionDecision as string;
}

after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("autofactory-gate hook — fail-closed allowlist", () => {
  it("allows a clean success (approved / noop)", () => {
    assert.equal(decisionFor(repoWith({ outcome: "approved" })), "allow");
    assert.equal(decisionFor(repoWith({ outcome: "noop" })), "allow");
  });

  it("asks on a rejected verdict", () => {
    assert.equal(decisionFor(repoWith({ outcome: "rejected" })), "ask");
  });

  it("asks on a non-converged loop (outcome incomplete + loopExhausted)", () => {
    assert.equal(decisionFor(repoWith({ outcome: "incomplete", loopExhausted: true })), "ask");
  });

  it("FAILS CLOSED on an unrecognized future outcome value", () => {
    // The whole point of the allowlist: an outcome this copy of the hook has
    // never heard of must NOT slip through as allow.
    assert.equal(decisionFor(repoWith({ outcome: "some-future-value" })), "ask");
  });

  it("denies when no run record exists", () => {
    assert.equal(decisionFor(repoWith(null)), "deny");
  });
});
