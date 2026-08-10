/**
 * Resumable walk state for the CLI, written to
 * `<git-dir>/autofactory-walk-state.json` — inside `.git/` for the same reason
 * `runRecord.ts` is: it can never be committed and never dirties the working tree.
 *
 * This is NOT an extension of `runRecord.ts`, which is deliberately *not* written
 * on approval pauses (a pause must not satisfy the pre-push gate). This file has
 * the opposite policy: it exists only when a walk stopped halfway.
 *
 * What it holds is the journal — `WalkResult.runs` verbatim — plus the keys that
 * decide whether replaying it is still legitimate. The walker re-derives every
 * internal invariant (tags, inventory, edge budgets, routing snapshots) from the
 * journal, so nothing about walker internals is persisted here and this format
 * does not have to change when they do.
 *
 * Why a working-tree hash and not just HEAD: the CLI runs `gitMode: "workingTree"`,
 * so agents mutate files WITHOUT moving HEAD. A head-only check would happily
 * replay a journal recorded against completely different file contents.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { LoopGrant, NodeRun } from "@auto-factory/shared";

/**
 * Bumped when the shape changes; a mismatch invalidates instead of mis-reading.
 *
 * v2 added `grants` (cumulative loop-budget grants) and `base`. Both are load-bearing:
 * a v2 journal read by a v1 build would silently drop the grants and then diverge
 * mid-replay, which is a confusing failure rather than a clean refusal.
 *
 * v3 added `haltedAt.exhaustedEdges`, which bounds what a grant may target. A v3 journal
 * read by a v2 build would accept a grant that build cannot validate, so the same
 * reasoning applies.
 *
 * v4 replaced the flat `grants` map with a positional list (`LoopGrant[]`). A v4 journal
 * read by a v3 build would apply every grant uniformly and diverge; a v3 journal read by
 * a v4 build has no positions to honour. Refuse both.
 */
export const WALK_STATE_VERSION = 4;

const FILE_NAME = "autofactory-walk-state.json";

export interface WalkState {
  version: number;
  /** Graph the journal was recorded against. */
  graphKey: string;
  /** Committed-config content hash (see configVersion.ts) at the halt. */
  configStamp?: string;
  branch?: string;
  /** HEAD at the halt. */
  head?: string;
  /**
   * Content hash of the working tree at the halt — tracked modifications plus
   * untracked files. Undefined means it could not be computed, which must FAIL
   * a resume rather than skip the check.
   */
  treeHash?: string;
  /** Approval mode in force, so a policy change invalidates the journal. */
  policyMode?: string;
  /** Base ref the recorded walk diffed against — a different base is a different diff. */
  base?: string;
  /**
   * Loop-edge grants in force for THIS walk, each stamped with the point it took effect
   * (see `LoopGrant`). Journalled because the walk branches on them, and POSITIONAL
   * because a flat total applied uniformly un-blocks earlier positions and diverges — see
   * the LoopGrant docs for the shape that failed.
   */
  grants?: LoopGrant[];
  /**
   * Why the walk stopped. `exhaustedEdges` (keys `${source}→${target}`) are the loop
   * edges whose budget ENDED this walk — the only edges a resume grant may target.
   *
   * Deliberately not every edge that spent its budget: an ADVISORY loop that exhausted
   * and fell through has recorded downstream work in this journal, so granting it more
   * budget would mean re-running it and invalidating everything after — a partial
   * re-run, not a resume. There is no correct result to compute, so it is refused.
   */
  haltedAt: {
    kind: "pending-approval" | "loop-exhausted";
    node: string;
    exhaustedEdges?: string[];
  };
  /** `WalkResult.runs` verbatim — the replay journal. */
  runs: NodeRun[];
  at: string;
}

/** Keys the current process computes, to compare against a stored state. */
export interface WalkStateKeys {
  graphKey: string;
  configStamp?: string;
  head?: string;
  treeHash?: string;
  policyMode?: string;
  base?: string;
}

function gitDir(root: string): string {
  const raw = execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

export function walkStatePath(root: string): string {
  return join(gitDir(root), FILE_NAME);
}

/**
 * Hash of everything a walk could have read from the tree: HEAD, the tracked diff
 * against it, and the path+content of every untracked file. Returns undefined if
 * git can't answer — callers must treat that as "cannot resume", never as "no
 * change".
 */
export function computeTreeHash(root: string): string | undefined {
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const head = git(["rev-parse", "HEAD"]).trim();
    const trackedDiff = git(["diff", "HEAD"]);
    const untracked = git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    let untrackedDigest = "";
    if (untracked.length > 0) {
      // Content hashes, so an untracked file's *contents* changing invalidates too.
      const hashes = git(["hash-object", "--", ...untracked])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      untrackedDigest = untracked.map((p, i) => `${p}:${hashes[i] ?? "?"}`).join("\n");
    }
    return createHash("sha256").update(`${head}\n${trackedDiff}\n${untrackedDigest}`).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort persist; a failure only means the walk can't be resumed.
 *
 * `treeHash` is computed HERE, not accepted from the caller, and that is the whole
 * point: it must reflect the tree as it stands at the halt — after the agents have
 * edited it. A caller that computed the hash earlier in the run (say, alongside the
 * other invalidation keys before the walk started) would persist the PRE-walk tree,
 * which breaks resume two ways: every realistic halt refuses because agent edits
 * moved the tree, and worse, reverting those edits makes the check PASS and replay a
 * journal describing work the files no longer contain. Keeping the computation
 * inside this function makes that ordering mistake unrepresentable.
 */
export function writeWalkState(root: string, state: Omit<WalkState, "version" | "at" | "treeHash">): void {
  try {
    const treeHash = computeTreeHash(root);
    if (!treeHash) {
      console.warn("could not hash the working tree — saving walk state anyway, but --resume will refuse it");
    }
    writeFileSync(
      walkStatePath(root),
      JSON.stringify(
        { version: WALK_STATE_VERSION, ...state, ...(treeHash ? { treeHash } : {}), at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch (e) {
    console.warn(`could not write walk state (resume will not be available): ${e instanceof Error ? e.message : e}`);
  }
}

export function readWalkState(root: string): WalkState | undefined {
  try {
    const p = walkStatePath(root);
    if (!existsSync(p)) return undefined;
    const parsed = JSON.parse(readFileSync(p, "utf8")) as WalkState;
    return parsed && Array.isArray(parsed.runs) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the journal. Called once a walk reaches a real terminal, so a stale
 * journal can never be replayed against a later run.
 */
export function clearWalkState(root: string): void {
  try {
    rmSync(walkStatePath(root), { force: true });
  } catch {
    /* best-effort */
  }
}

export type WalkStateCheck = { ok: true; state: WalkState } | { ok: false; reason: string };

/**
 * Decide whether a stored journal may be replayed. FAIL-CLOSED: every key must be
 * present and equal. A missing value on either side is a mismatch, not a pass —
 * an unknown tree hash is exactly the case where replaying is most dangerous.
 */
export function validateWalkState(state: WalkState | undefined, keys: WalkStateKeys): WalkStateCheck {
  if (!state) return { ok: false, reason: "no saved walk state for this repo — nothing to resume" };
  if (state.version !== WALK_STATE_VERSION) {
    return { ok: false, reason: `saved walk state is version ${state.version}, this build expects ${WALK_STATE_VERSION}` };
  }
  if (state.runs.length === 0) return { ok: false, reason: "saved walk state has an empty journal" };
  if (state.graphKey !== keys.graphKey) {
    return { ok: false, reason: `saved walk state is for graph '${state.graphKey}', not '${keys.graphKey}'` };
  }
  // Fail-closed on every key, including UNKNOWN on either side: "we couldn't check"
  // is the case where replaying is most dangerous, so it must never read as "no
  // change". Note the deployment consequence — a packaged install without
  // config/agentcontrol can't compute a config stamp, so it can't resume.
  if (!state.configStamp || !keys.configStamp) {
    return { ok: false, reason: "could not verify the agent configs are unchanged — refusing to resume against unknown config state" };
  }
  if (state.configStamp !== keys.configStamp) {
    return {
      ok: false,
      reason: "the agent configs changed since the walk was saved (config stamp differs) — the journal describes a different graph",
    };
  }
  if (!state.head || !keys.head) {
    return { ok: false, reason: "could not determine HEAD on both sides — refusing to resume against unknown commit state" };
  }
  if (state.head !== keys.head) {
    return { ok: false, reason: `HEAD moved since the walk was saved (${state.head} → ${keys.head})` };
  }
  if (!state.treeHash || !keys.treeHash) {
    return { ok: false, reason: "could not verify the working tree is unchanged — refusing to resume against unknown file state" };
  }
  if (state.treeHash !== keys.treeHash) {
    return { ok: false, reason: "the working tree changed since the walk was saved — the agents' recorded work no longer matches the files" };
  }
  if (!state.policyMode || !keys.policyMode) {
    return { ok: false, reason: "could not determine the approval policy on both sides — refusing to resume" };
  }
  if (!state.base || !keys.base) {
    return { ok: false, reason: "could not determine the base ref on both sides — refusing to resume" };
  }
  if (state.base !== keys.base) {
    // The whole walk was recorded against a diff. A different base is a different
    // diff, so replayed steps and live steps would be reasoning about different
    // changes — a wrong result rather than a refusal.
    return { ok: false, reason: `the base ref changed since the walk was saved ('${state.base}' → '${keys.base}')` };
  }
  if (state.policyMode !== keys.policyMode) {
    return {
      ok: false,
      reason: `the approval policy changed since the walk was saved ('${state.policyMode}' → '${keys.policyMode}')`,
    };
  }
  return { ok: true, state };
}

/**
 * The loop edges a resume may grant extra budget to: those whose exhaustion ended the
 * saved walk. Empty for a gate halt — nothing was blocked by budget, so nothing is
 * grantable.
 */
export function grantableEdges(state: WalkState): Set<string> {
  return new Set(state.haltedAt.exhaustedEdges ?? []);
}

export type GrantCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate a resume's requested grants against what the saved walk actually halted on.
 *
 * USABILITY, not correctness: grants are positional now (see `LoopGrant`), so replay
 * reproduces the journal whatever a grant targets. This check exists because granting a
 * loop that already fell through is *incoherent* — its downstream work is recorded in the
 * journal, so re-running it would mean invalidating everything after, which is a partial
 * re-run rather than a resume. Refusing says so instead of quietly doing nothing useful.
 *
 * An earlier revision leaned on this for correctness, via "for an edge that ended the
 * walk, its first budget-block IS the halt". That premise is false when the halting node
 * has a second loop edge, which is why positions now carry the guarantee.
 */
export function validateGrants(state: WalkState, grants: Record<string, number>): GrantCheck {
  const requested = Object.keys(grants);
  if (requested.length === 0) return { ok: true };
  const grantable = grantableEdges(state);
  const bad = requested.filter((e) => !grantable.has(e));
  if (bad.length === 0) return { ok: true };
  const asFlag = (edge: string) => edge.replace("→", ":");
  if (grantable.size === 0) {
    return {
      ok: false,
      reason:
        `the saved walk stopped at ${state.haltedAt.kind === "pending-approval" ? "an approval gate" : "a loop"} ` +
        `('${state.haltedAt.node}') with no loop budget exhausted, so there is nothing to grant. ` +
        `Resume without --grant-visits.`,
    };
  }
  return {
    ok: false,
    reason:
      `--grant-visits ${bad.map(asFlag).join(", ")} does not name a loop edge that ended the saved walk. ` +
      `Grantable: ${[...grantable].map(asFlag).join(", ")}. ` +
      `An advisory loop that already fell through cannot be topped up — its downstream work is in the journal, ` +
      `so re-running it would invalidate the rest. Start a fresh run for that.`,
  };
}

/**
 * Carry a resume's new grants into the saved state, stamped with the point they took
 * effect — the length of the journal that was replayed this round.
 */
export function appendGrants(
  prior: LoopGrant[] | undefined,
  added: Record<string, number>,
  effectiveAfterRuns: number,
): LoopGrant[] {
  return [
    ...(prior ?? []),
    ...Object.entries(added).map(([edge, visits]) => ({ edge, visits, effectiveAfterRuns })),
  ];
}

/**
 * Would a grant of `visits` on `edge` actually raise its ceiling, or is the hard cap
 * already reached? A grant the cap swallows makes the resume replay, do no live work, and
 * re-halt identically — while the CLI cheerfully suggests granting again.
 */
export function grantIsAbsorbedByCap(
  declaredMaxVisits: number,
  prior: LoopGrant[] | undefined,
  edge: string,
  hardCap: number,
): boolean {
  const already = (prior ?? []).filter((g) => g.edge === edge).reduce((n, g) => n + Math.max(0, g.visits), 0);
  return Math.max(1, Math.floor(declaredMaxVisits)) + already >= hardCap;
}

/**
 * Parse a `--grant-visits <source>:<target>=<n>` value into the walker's
 * `extraVisits` key (`source→target`). Colon-separated because `→` and `>` are
 * hostile on a shell command line.
 */
export function parseVisitGrant(raw: string): { key: string; visits: number } | { error: string } {
  const m = /^([^:=]+):([^:=]+)=(\d+)$/.exec(raw.trim());
  if (!m) return { error: `expected <source>:<target>=<n>, got '${raw}'` };
  const n = Number(m[3]);
  if (!Number.isFinite(n) || n < 1) return { error: `visit grant must be at least 1, got '${raw}'` };
  return { key: `${m[1]}→${m[2]}`, visits: n };
}
