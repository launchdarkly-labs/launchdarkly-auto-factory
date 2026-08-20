/**
 * Working-tree change context for front ends that run Phase 1 against a local
 * checkout instead of a GitHub pull request (the CLI; the Cursor extension has
 * its own equivalent). Read-only `git` helpers plus a builder that produces the
 * same context shape the graph walker's prompt builder and the AI SDK's
 * instruction interpolation expect (REPO / PR_TITLE / PR_BODY / PR_NUMBER /
 * PR_BRANCH), so the agents run unchanged; only the source of the values
 * differs.
 *
 * There is no PR number locally, so the branch name (sanitized) stands in for
 * it — it becomes the release-manifest id (`.release-flags/pr-<branch>.json`),
 * which Phase 2 discovers by file presence, not by the number itself.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export interface RepoState {
  /** Current branch name, or undefined when detached. */
  branch?: string;
  /** Short HEAD SHA. */
  head?: string;
  /** Commits on HEAD not on the base branch. */
  aheadOfBase: number;
  /** Working-tree changes (porcelain lines): staged, unstaged, untracked. */
  dirtyFiles: number;
  /** The base ref that was resolvable, if any. */
  resolvedBase?: string;
  /**
   * The commit `resolvedBase` points at. The ref NAME is not an identity:
   * `origin/main` moves on any `git fetch` with no change to HEAD or the working
   * tree, and an unresolvable `origin/<base>` silently falls through to the local
   * branch. Anything that records "what this walk diffed against" needs the SHA.
   */
  resolvedBaseSha?: string;
  /** owner/name parsed from the origin remote, if any. */
  repoSlug?: string;
}

/** Whether `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** First base candidate that exists locally (origin/<base>, <base>, origin/main, main). */
async function resolveBase(cwd: string, base: string): Promise<string | undefined> {
  for (const ref of [`origin/${base}`, base, "origin/main", "main"]) {
    try {
      await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function parseSlug(remoteUrl: string): string | undefined {
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const m = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/);
  return m?.[1];
}

export async function readRepoState(cwd: string, base: string): Promise<RepoState> {
  const state: RepoState = { aheadOfBase: 0, dirtyFiles: 0 };
  try {
    state.branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || undefined;
    if (state.branch === "HEAD") state.branch = undefined; // detached
    state.head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  } catch {
    /* empty repo / no commits */
  }
  state.resolvedBase = await resolveBase(cwd, base);
  if (state.resolvedBase) {
    try {
      state.resolvedBaseSha = await git(cwd, ["rev-parse", state.resolvedBase]);
    } catch {
      /* left undefined — consumers must treat that as "unknown", never "unchanged" */
    }
    try {
      const n = await git(cwd, ["rev-list", "--count", `${state.resolvedBase}..HEAD`]);
      state.aheadOfBase = Number(n) || 0;
    } catch {
      /* */
    }
  }
  try {
    const porcelain = await git(cwd, ["status", "--porcelain"]);
    state.dirtyFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  } catch {
    /* */
  }
  try {
    state.repoSlug = parseSlug(await git(cwd, ["remote", "get-url", "origin"]));
  } catch {
    /* no origin */
  }
  return state;
}

/** Latest commit subject + body, for synthesizing a change title/description. */
export async function lastCommit(cwd: string): Promise<{ subject?: string; body?: string }> {
  try {
    const subject = await git(cwd, ["log", "-1", "--pretty=%s"]);
    const body = await git(cwd, ["log", "-1", "--pretty=%b"]);
    return { subject: subject || undefined, body: body || undefined };
  } catch {
    return {};
  }
}

/** True when there is something for Phase 1 to act on (commits ahead, or dirty). */
export function hasChangeToProcess(state: RepoState): boolean {
  return state.aheadOfBase > 0 || state.dirtyFiles > 0;
}

export interface WorkingTreeContext extends Record<string, unknown> {
  REPO?: string;
  PR_NUMBER?: string;
  PR_TITLE?: string;
  PR_BODY?: string;
  PR_BRANCH?: string;
  SHA?: string;
}

export async function buildWorkingTreeContext(root: string, state: RepoState): Promise<WorkingTreeContext> {
  const { subject, body } = await lastCommit(root);
  const branch = state.branch;
  const slug = (branch ?? "working-tree").replace(/[^a-zA-Z0-9._-]/g, "-");
  return {
    REPO: state.repoSlug,
    PR_BRANCH: branch,
    PR_NUMBER: slug,
    PR_TITLE: subject ?? branch ?? "Local changes",
    PR_BODY: body ?? "",
    SHA: state.head,
  };
}

/** Interpolation variables for the AI SDK (mirrors the Action's buildVariables). */
export function buildWorkingTreeVariables(ctx: WorkingTreeContext, appProjectKey: string): Record<string, unknown> {
  return {
    PR_NUMBER: ctx.PR_NUMBER ?? "",
    PR_TITLE: ctx.PR_TITLE ?? "",
    PR_BODY: ctx.PR_BODY ?? "",
    REPO: ctx.REPO ?? "",
    PR_BRANCH: ctx.PR_BRANCH ?? "",
    TICKET_ID: "",
    LAUNCHDARKLY_PROJECT: appProjectKey,
  };
}
