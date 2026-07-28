/**
 * A local record of the last completed AutoFactory run against a repo, written
 * to `<git-dir>/autofactory-last-run.json` — inside `.git/` on purpose, so it
 * can never be committed and never dirties the working tree.
 *
 * This is the evidence the pre-push gate reads (the PreToolUse hook in
 * bootstrap/claude-code/hooks/): "has AutoFactory run on this branch?" is
 * answered by branch match on this record, not by inferring from manifests
 * (a no-flag-needed run produces no manifest but still counts as a run).
 * Deliberately NOT written for dry runs (nothing was created), approval
 * pauses, or errors — those must not satisfy the gate.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type RunOutcome = "approved" | "noop" | "rejected" | "incomplete" | "verification-failed";

/**
 * Map a completed walk + verdict to the recorded outcome. Pure and unit-tested
 * because this mapping is safety-critical: a non-converged loop MUST record as
 * `"incomplete"` (NOT a new outcome value), so pre-push hooks deployed before
 * loop support — which block on `"incomplete"` — keep prompting instead of
 * failing open. The `loopExhausted` discriminator is carried separately on the
 * record for richer messaging in updated hooks.
 */
export function deriveOutcome(input: {
  verificationFailed: boolean;
  loopExhausted: boolean;
  apply: boolean;
  noop: boolean;
  incomplete: boolean;
}): RunOutcome {
  if (input.verificationFailed) return "verification-failed";
  if (input.loopExhausted) return "incomplete";
  if (input.apply) return "approved";
  if (input.noop) return "noop";
  if (input.incomplete) return "incomplete";
  return "rejected";
}

export interface RunRecord {
  branch?: string;
  head?: string;
  outcome: RunOutcome;
  /**
   * True when the run stopped on a non-converged loop. The `outcome` stays
   * `"incomplete"` for back-compat (deployed hooks block on that); this flag
   * lets updated tooling message it specifically.
   */
  loopExhausted?: boolean;
  /** Resources (e.g. flag keys) left orphaned by a re-plan across iterations. */
  orphanedResources?: string[];
  flagKey?: string;
  manifest?: string;
  at: string;
}

/** Best-effort: a missing record only means the gate stays closed. */
export function writeRunRecord(root: string, record: Omit<RunRecord, "at">): void {
  try {
    // rev-parse resolves worktrees/submodules where `.git` is a file, not a dir.
    const rawGitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
    writeFileSync(
      join(gitDir, "autofactory-last-run.json"),
      JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
  } catch (e) {
    console.warn(`could not write run record (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
