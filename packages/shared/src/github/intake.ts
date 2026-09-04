/**
 * GitHub plumbing for the ISSUE INTAKE entry point (ADR 0019): read the issue
 * the coder is asked to implement, open the pull request that hands the work to
 * the regular chain, and carry the INTENT MARKER that joins the two runs.
 *
 * The marker is an HTML comment in the PR body — invisible on GitHub, trivially
 * parseable by the Action — naming the intent (`issue-<n>`), the intake run id,
 * and where it ran. The PR-triggered run reads it to set TICKET_ID and to stamp
 * `ticket` on its own `run` context, so agent telemetry from BOTH runs (the
 * coder's tokens, the chain's tokens, the flag it created) share a join key.
 *
 * Auth: a token from AUTOFACTORY_INTAKE_TOKEN, then GITHUB_TOKEN, then the local
 * `gh` CLI's session. In GitHub Actions prefer a PAT for the PR open: PRs opened
 * with the workflow's own GITHUB_TOKEN do not trigger `pull_request` workflows,
 * so the regular chain would never see the PR.
 */

import { execFileSync } from "node:child_process";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  state: string;
  labels: string[];
  /** True when the "issue" number is actually a pull request. */
  isPullRequest: boolean;
}

export interface IntentMarker {
  /** The intent id, e.g. `issue-42` — the value TICKET_ID takes downstream. */
  intent: string;
  issue?: number;
  repo?: string;
  /** The intake run's pipeline run id (the `run` context key of the coder's run). */
  intakeRun?: string;
  graph?: string;
  node?: string;
  surface?: string;
}

const MARKER_OPEN = "<!-- autofactory-intent ";
const MARKER_CLOSE = " -->";

/** Serialize the marker as a single-line HTML comment for a PR body. */
export function buildIntentMarker(marker: IntentMarker): string {
  return `${MARKER_OPEN}${JSON.stringify(marker)}${MARKER_CLOSE}`;
}

/** Find and parse the intent marker in a PR body; undefined when absent/invalid. */
export function parseIntentMarker(body: string | undefined | null): IntentMarker | undefined {
  if (!body) return undefined;
  const start = body.indexOf(MARKER_OPEN);
  if (start === -1) return undefined;
  const end = body.indexOf(MARKER_CLOSE, start + MARKER_OPEN.length);
  if (end === -1) return undefined;
  try {
    const parsed = JSON.parse(body.slice(start + MARKER_OPEN.length, end)) as Partial<IntentMarker>;
    if (!parsed || typeof parsed.intent !== "string" || !parsed.intent) return undefined;
    return parsed as IntentMarker;
  } catch {
    return undefined;
  }
}

/** The ticket id a PR body carries via its intent marker (e.g. `issue-42`). */
export function intentTicketId(body: string | undefined | null): string | undefined {
  return parseIntentMarker(body)?.intent;
}

/** Conventional intent id for a GitHub issue. */
export function issueIntentId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/** Conventional working branch for an issue's intake run. */
export function issueBranchName(issueNumber: number): string {
  return `autofactory/issue-${issueNumber}`;
}

/**
 * Resolve a GitHub token: AUTOFACTORY_INTAKE_TOKEN, GITHUB_TOKEN, else the local
 * `gh auth token` (a developer running the CLI). Undefined when none is available.
 */
export function resolveGitHubToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const fromEnv = env.AUTOFACTORY_INTAKE_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function apiBase(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

async function gh<T>(path: string, token: string | undefined, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "launchdarkly-auto-factory",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Read an issue. Works unauthenticated on public repos; a token is needed otherwise. */
export async function fetchIssue(repo: string, issueNumber: number, token: string | undefined): Promise<GitHubIssue> {
  const raw = await gh<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    labels?: Array<{ name?: string } | string>;
    pull_request?: unknown;
  }>(`/repos/${repo}/issues/${issueNumber}`, token);
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    htmlUrl: raw.html_url,
    state: raw.state,
    labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

export interface PullRequestRef {
  number: number;
  htmlUrl: string;
}

/** The open PR whose head is `headBranch` on this repo, if any (idempotent re-runs). */
export async function findOpenPullRequest(
  repo: string,
  headBranch: string,
  token: string | undefined,
): Promise<PullRequestRef | undefined> {
  const owner = repo.split("/")[0];
  const list = await gh<Array<{ number: number; html_url: string }>>(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}&per_page=1`,
    token,
  );
  const pr = list[0];
  return pr ? { number: pr.number, htmlUrl: pr.html_url } : undefined;
}

export interface CreatePullRequestArgs {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export async function createPullRequest(repo: string, args: CreatePullRequestArgs, token: string): Promise<PullRequestRef> {
  const pr = await gh<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title: args.title, body: args.body, head: args.head, base: args.base, draft: args.draft ?? false }),
  });
  return { number: pr.number, htmlUrl: pr.html_url };
}

/** Add labels to an issue or PR (PRs are issues for the labels API). */
export async function addLabels(repo: string, number: number, labels: string[], token: string): Promise<void> {
  if (labels.length === 0) return;
  await gh(`/repos/${repo}/issues/${number}/labels`, token, { method: "POST", body: JSON.stringify({ labels }) });
}

/** Post a comment on an issue or PR. */
export async function commentOnIssue(repo: string, number: number, body: string, token: string): Promise<void> {
  await gh(`/repos/${repo}/issues/${number}/comments`, token, { method: "POST", body: JSON.stringify({ body }) });
}
