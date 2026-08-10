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
 *
 * v5 added `humanFeedback` (a resume's undelivered guidance, carried until a live node
 * consumes it) and `baseSha` (the resolved base ref's commit, so a moved `origin/main`
 * invalidates the journal even though the ref NAME still matches). A v5 journal read by
 * a v4 build would silently drop the feedback and skip the base-commit check.
 */
export const WALK_STATE_VERSION = 5;

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
  /**
   * The RESOLVED base ref the recorded walk diffed against (e.g. `origin/main`,
   * not the `--base main` the user typed) — a different base is a different diff.
   * Resolved, because `resolveBase` prefers `origin/<base>` and falls through to
   * the local branch: two runs typing the same `--base` can diff against
   * different refs, and the name must record which one it actually was.
   */
  base?: string;
  /**
   * The commit `base` pointed at when the walk halted. The ref NAME alone is not
   * an identity: `origin/main` moves on any `git fetch` — an IDE auto-fetch while
   * the human decides on an approval is enough — with no change to HEAD or the
   * working tree, and the live nodes would then analyse a different diff than the
   * replayed journal was recorded against.
   */
  baseSha?: string;
  /**
   * Loop-edge grants in force for THIS walk, each stamped with the point it took effect
   * (see `LoopGrant`). Journalled because the walk branches on them, and POSITIONAL
   * because a flat total applied uniformly un-blocks earlier positions and diverges — see
   * the LoopGrant docs for the shape that failed.
   */
  grants?: LoopGrant[];
  /**
   * Human guidance (`--feedback`) that has NOT yet been delivered to any live node.
   *
   * The walker hands `humanFeedback` to the first LIVE node only. A resume that
   * replays the journal and then halts before the frontier runs — the default
   * shape, since the reviewer loop's target is the default gated step — has
   * delivered it to nobody. Persisting it here means the next `--resume` re-injects
   * it automatically; dropping it silently defeated the invariant that a loop grant
   * requires guidance (`--grant-visits` refuses to travel without `--feedback`).
   * Cleared (not written) once any live node has consumed it.
   */
  humanFeedback?: string;
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
  /** Resolved base ref name (see WalkState.base). */
  base?: string;
  /** Commit the resolved base points at NOW (see WalkState.baseSha). */
  baseSha?: string;
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
    // `-z`: NUL-separated, UNQUOTED paths. Without it, git's default
    // core.quotePath=true C-quotes any non-ASCII filename ("na\303\257ve.ts"),
    // hash-object then fails on the literal quoted string, and this function
    // returned undefined — permanently refusing resume in that repo (fail-closed,
    // but availability lost for no reason).
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)
      .sort();
    let untrackedDigest = "";
    if (untracked.length > 0) {
      // Content hashes, so an untracked file's *contents* changing invalidates too.
      // Paths ride as argv (execFileSync, no shell), which is exact for any filename;
      // the residual risk is OS argv-length limits on a VERY long untracked list,
      // where execFileSync throws and this fails closed to "cannot resume".
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
/**
 * For a caller with no feedback in play: a fresh run where `--feedback` was not passed, or
 * a test not exercising feedback at all.
 *
 * Deliberately a named constant rather than a default parameter. `writeWalkState`'s third
 * argument is REQUIRED so a resume path cannot silently omit the carry — that omission was a
 * real defect and no test at that layer could see it. A default would restore exactly the
 * silence; this makes "there was none" an explicit, greppable claim.
 */
export const NO_FEEDBACK_IN_PLAY = { inForce: undefined, totalRuns: 0, replayedRuns: 0 } as const;

/**
 * Persist a halted walk.
 *
 * Two fields are computed HERE rather than accepted, and both for the same reason: a
 * caller that omits one produces a state file that looks valid and silently breaks a
 * later resume, which no test at this layer can detect.
 *
 *  - `treeHash` — an earlier revision took it from the caller, which passed a hash
 *    captured BEFORE the walk. Every realistic resume was refused, and reverting the
 *    agents' edits made validation *pass*.
 *  - `humanFeedback` — omitting the carry let a granted resume halt at a gate and lose
 *    the human's guidance, so the granted iteration re-ran with no new information. It
 *    is excluded from the `state` parameter's type and taken via `feedback` instead, so
 *    "forgetting" it is a compile error rather than a silent behaviour change.
 */
export function writeWalkState(
  root: string,
  state: Omit<WalkState, "version" | "at" | "treeHash" | "humanFeedback">,
  feedback: {
    /** The feedback in force this round — `resume.humanFeedback`, or `--feedback` on a fresh run. */
    inForce: string | undefined;
    /** Total runs the walk produced, replayed + live. */
    totalRuns: number;
    /** How many of those were replayed (0 on a fresh run). */
    replayedRuns: number;
  },
): void {
  try {
    const treeHash = computeTreeHash(root);
    if (!treeHash) {
      console.warn("could not hash the working tree — saving walk state anyway, but --resume will refuse it");
    }
    const carried = carryUnconsumedFeedback(feedback.inForce, feedback.totalRuns, feedback.replayedRuns);
    writeFileSync(
      walkStatePath(root),
      JSON.stringify(
        {
          version: WALK_STATE_VERSION,
          ...state,
          ...carried,
          ...(treeHash ? { treeHash } : {}),
          at: new Date().toISOString(),
        },
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
    // changes — a wrong result rather than a refusal. Both sides are the RESOLVED
    // ref, so `origin/main` becoming unresolvable and falling through to local
    // `main` is a mismatch here, not a silent substitution.
    return { ok: false, reason: `the base ref changed since the walk was saved ('${state.base}' → '${keys.base}')` };
  }
  if (!state.baseSha || !keys.baseSha) {
    return { ok: false, reason: "could not determine the base commit on both sides — refusing to resume" };
  }
  if (state.baseSha !== keys.baseSha) {
    // The ref NAME matching is not enough: `origin/main` moves on any `git fetch`
    // (an IDE auto-fetch during an approval pause is the realistic case) with no
    // change to HEAD or the working tree. The journal was recorded against the old
    // commit's diff; the live nodes would analyse the new one.
    return {
      ok: false,
      reason: `the base ref '${state.base}' moved since the walk was saved (${state.baseSha.slice(0, 12)} → ${keys.baseSha.slice(0, 12)}) — the journal describes a diff against the old base`,
    };
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
 * The feedback a halt must carry into the saved state: whatever was in force this
 * round (newly passed, or re-loaded from the previous state), IF no live node ran to
 * consume it. The walker delivers `humanFeedback` to the first LIVE node only, so
 * "consumed" is exactly "at least one run beyond the replayed journal" — a walk that
 * replayed everything and halted at the frontier's gate delivered it to nobody.
 *
 * NOT called by callers directly: `writeWalkState` applies it, because a caller that
 * forgets to is a silent regression no test can see (see that function's note).
 */
export function carryUnconsumedFeedback(
  feedback: string | undefined,
  totalRuns: number,
  replayedRuns: number,
): { humanFeedback: string } | Record<string, never> {
  return feedback !== undefined && totalRuns <= replayedRuns ? { humanFeedback: feedback } : {};
}

/**
 * Assemble the walker's `resume` input from a validated saved state plus this round's
 * CLI options — the journal to replay, the accumulated grants, and the feedback in force.
 *
 * ONE function rather than three inline steps in run.ts, because the three are not
 * independent: the grants' effective position and the journal length are the same number,
 * and the feedback decision ("newly passed wins, else re-inject the saved one") is
 * meaningless without the journal it rides with. Assembling them apart is how a resume
 * shipped that replayed correctly and dropped the human's guidance on the floor.
 *
 * The returned object IS the walker's `ResumeInput` shape, so a caller cannot use the
 * journal while skipping the feedback — there is nothing left to skip.
 */
export function buildResumeInput(
  state: WalkState,
  opts: { grantVisits?: Record<string, number>; feedback?: string },
): { journal: readonly NodeRun[]; grants?: LoopGrant[]; humanFeedback?: string } {
  const replayedRuns = state.runs.length;
  const allGrants = appendGrants(state.grants ?? [], opts.grantVisits ?? {}, replayedRuns);
  const feedback = opts.feedback ?? state.humanFeedback;
  return {
    journal: state.runs,
    ...(allGrants.length > 0 ? { grants: allGrants } : {}),
    ...(feedback ? { humanFeedback: feedback } : {}),
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
