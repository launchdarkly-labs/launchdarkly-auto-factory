#!/usr/bin/env node
/**
 * PreToolUse gate: don't let a PR leave the machine before AutoFactory has run.
 *
 * Codex sibling of bootstrap/claude-code/hooks/autofactory-gate.mjs — same
 * stdin JSON, same `permissionDecision` output contract. Wired in
 * .codex/hooks.json against the shell tool, this intercepts `git push` and
 * `gh pr create` and checks the run record the `autofactory` CLI writes at
 * `<git-dir>/autofactory-last-run.json` (dry runs don't write one). Decisions:
 *
 *   - AUTOFACTORY_REQUIRE_LABEL=true and the PR / create command is not
 *     labeled `autofactory` → allow (label-gated mode: bugfixes, chores,
 *     docs, etc. skip AutoFactory).
 *   - no record, or record from another branch → DENY, with the fix
 *     ("run $autofactory") fed back to the agent.
 *   - record says the review REJECTED the change (or a deterministic check
 *     failed) → DENY unless the command carries AUTOFACTORY_ACK_RED=1.
 *     Claude Code's gate ASKS the human here; Codex parses but does not yet
 *     support permissionDecision "ask", so the human's override is explicit:
 *     they confirm, and the push re-runs prefixed with AUTOFACTORY_ACK_RED=1.
 *   - otherwise → allow.
 *
 * Deliberately branch-granular, not content-granular: committing the agents'
 * edits (or small follow-ups) after a run must not re-trip the gate. "Re-run
 * after significant new changes" stays advisory, in AGENTS.md.
 *
 * Standalone by design — no imports from the tooling repo, so it can be
 * committed to any app repo as-is. Fails OPEN on its own errors: a broken
 * gate must not brick pushing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Label that means "new feature — AutoFactory required" (Action + local gate). */
const AUTOFACTORY_LABEL = "autofactory";
/** Optional label-gated mode; mirrors the Action's AUTOFACTORY_REQUIRE_LABEL repo variable. */
const REQUIRE_LABEL = process.env.AUTOFACTORY_REQUIRE_LABEL === "true";

function decide(permissionDecision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

function normalizeLabel(label) {
  return String(label ?? "")
    .trim()
    .toLowerCase();
}

function hasAutofactoryLabel(labels) {
  return labels.some((l) => normalizeLabel(l) === AUTOFACTORY_LABEL);
}

/**
 * Labels passed to `gh pr create` via repeated `--label` / `-l` flags.
 * Does not shell-parse quoted values with spaces beyond a simple token grab —
 * prefer `--label autofactory`.
 */
function labelsFromPrCreateCommand(command) {
  const labels = [];
  const re = /(?:^|\s)(?:--label|-l)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m;
  while ((m = re.exec(command))) {
    labels.push(m[1] ?? m[2] ?? m[3]);
  }
  return labels;
}

/** Open PR labels for the current branch, or null if none / gh unavailable. */
function labelsForBranch() {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "view", "--json", "labels", "--jq", ".labels[].name"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!raw) return [];
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

try {
  let command = "";
  try {
    command = String(JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command ?? "");
  } catch {
    decide("allow", "unparsable hook input — gate skipped");
  }

  // Only outward-bound PR actions are gated: `git`/`gh` must sit at a command
  // position (start, or after && ; | etc., optionally behind env assignments
  // like AUTOFACTORY_ACK_RED=1), and `push` must be git's SUBCOMMAND (allowing
  // global options like -C <dir> / --no-pager before it) — so
  // `git stash push`, `echo git push`, and commit messages that mention
  // pushing all pass through.
  const cmdPos = String.raw`(?:^|[;&|(]\s*|\n\s*)(?:\w+=\S*\s+)*`;
  const isGitPush = new RegExp(`${cmdPos}git\\s+(?:-[cC]\\s+\\S+\\s+|--?\\S+\\s+)*push\\b`).test(command);
  const isPrCreate = new RegExp(`${cmdPos}gh\\s+pr\\s+create\\b`).test(command);
  if (!isGitPush && !isPrCreate) {
    decide("allow", "not a push / PR-create command");
  }

  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let branch;
  let gitDir;
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const raw = git(["rev-parse", "--git-dir"]);
    gitDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  } catch {
    decide("allow", "not a git repository — gate skipped");
  }
  // The chain is for change branches; pushing the default branch isn't a PR.
  if (branch === "main" || branch === "master" || branch === "HEAD") {
    decide("allow", `no AutoFactory gate on '${branch}'`);
  }

  // Label-gated mode (opt-in): unlabeled / non-feature PRs skip AutoFactory.
  // Default mode gates every push, label or not.
  if (REQUIRE_LABEL) {
    if (isPrCreate) {
      const labels = labelsFromPrCreateCommand(command);
      if (!hasAutofactoryLabel(labels)) {
        decide(
          "allow",
          "gh pr create without `autofactory` label — AutoFactory gate skipped (AUTOFACTORY_REQUIRE_LABEL)",
        );
      }
    } else {
      const prLabels = labelsForBranch();
      if (prLabels === null) {
        decide(
          "allow",
          "no open PR for this branch — AutoFactory gate skipped (AUTOFACTORY_REQUIRE_LABEL; add the `autofactory` label when you open a feature PR)",
        );
      }
      if (!hasAutofactoryLabel(prLabels)) {
        const shown = prLabels.length ? prLabels.join(", ") : "none";
        decide(
          "allow",
          `PR labels [${shown}] do not include \`autofactory\` — AutoFactory gate skipped (AUTOFACTORY_REQUIRE_LABEL)`,
        );
      }
    }
  }

  const recordPath = join(gitDir, "autofactory-last-run.json");
  if (!existsSync(recordPath)) {
    decide(
      "deny",
      `AutoFactory has not run on branch '${branch}'. Run the autofactory skill on the change set first (a dry run does not count), then push.`,
    );
  }
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    record = undefined;
  }
  if (!record || record.branch !== branch) {
    decide(
      "deny",
      `AutoFactory last ran on branch '${record?.branch ?? "(unknown)"}', not '${branch}'. Run the autofactory skill on this branch first, then push.`,
    );
  }
  if (record.outcome === "rejected" || record.outcome === "verification-failed" || record.outcome === "incomplete") {
    // Human override for a red verdict: an explicit env marker on the command
    // itself (Codex has no "ask" decision — see header).
    const acked =
      process.env.AUTOFACTORY_ACK_RED === "1" || /(^|[;&|(]\s*|\s)AUTOFACTORY_ACK_RED=1(\s|$)/.test(command);
    if (acked) {
      decide("allow", `pushing '${branch}' despite '${record.outcome}' — human override (AUTOFACTORY_ACK_RED=1)`);
    }
    decide(
      "deny",
      `AutoFactory's last run on '${branch}' ended '${record.outcome}' (${record.at}). A red verdict is a review ` +
        `opinion, not a pipeline failure — ask the human. If they choose to push anyway, re-run this exact ` +
        `command prefixed with AUTOFACTORY_ACK_RED=1 (never add it without their explicit say-so).`,
    );
  }
  decide("allow", `AutoFactory ran on '${branch}': ${record.outcome}${record.flagKey ? ` (flag ${record.flagKey})` : ""}`);
} catch (e) {
  decide("allow", `AutoFactory gate error (failing open): ${e instanceof Error ? e.message : e}`);
}
