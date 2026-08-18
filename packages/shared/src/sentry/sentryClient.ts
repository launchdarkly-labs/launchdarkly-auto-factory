/**
 * Low-level Sentry REST client (ADR 0015).
 *
 * Shapes intentionally mirror Sentry MCP tools (`search_issues`, event
 * aggregates) so CI can run headlessly without MCP auth. Never throws for
 * transport/API failures when using the soft helpers — see sentryEstate.ts.
 */

import type { SentryConnection } from "./sentryEnv.js";

export interface SentryIssueSummary {
  id: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  permalink?: string;
  count?: string;
  userCount?: number;
  lastSeen?: string;
  firstSeen?: string;
  level?: string;
}

export interface SentryEventsStatsPoint {
  /** Unix seconds (Sentry stats buckets). */
  time: number;
  count: number;
}

export interface RelatedIssueContext {
  flagKey?: string;
  targetVariation?: string;
  sha?: string;
  /** Stats window, e.g. "24h" (Sentry statsPeriod). */
  statsPeriod?: string;
}

async function sentryFetch(
  conn: SentryConnection,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${conn.apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.authToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** List unresolved issues sorted by frequency. */
export async function searchIssues(
  conn: SentryConnection,
  opts: { query?: string; statsPeriod?: string; limit?: number; sort?: string } = {},
): Promise<SentryIssueSummary[]> {
  const query = opts.query ?? "is:unresolved";
  const statsPeriod = opts.statsPeriod ?? "24h";
  const limit = opts.limit ?? 10;
  const sort = opts.sort ?? "freq";
  const url =
    `/api/0/projects/${encodeURIComponent(conn.org)}/${encodeURIComponent(conn.project)}/issues/` +
    `?query=${encodeURIComponent(query)}&statsPeriod=${encodeURIComponent(statsPeriod)}` +
    `&sort=${encodeURIComponent(sort)}&limit=${limit}`;
  const res = await sentryFetch(conn, url);
  if (!res.ok) {
    throw new Error(`Sentry issues HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const items = (await res.json()) as SentryIssueSummary[];
  return Array.isArray(items) ? items : [];
}

/**
 * Derive Sentry search tokens from an LD flag key.
 *
 * Apps rarely put the full flag key in the issue title/culprit. A common
 * pattern is tagging errors as `feature:<slug>` while the flag is
 * `enable-<slug>` (e.g. flag `enable-broken-sign-in` → tag `feature:broken-sign-in`).
 * Searching only for the raw flag key returns zero hits; with swallowed API
 * errors that used to look like "no matching issue".
 */
export function relatedIssueSearchTokens(flagKey: string): string[] {
  const key = flagKey.trim();
  if (!key) return [];
  const tokens = new Set<string>([key]);
  // enable-foo / show-foo / allow-foo → foo (feature tag convention)
  const stripped = key.replace(/^(enable|show|allow|use|with|flag)-/i, "");
  if (stripped && stripped !== key) tokens.add(stripped);
  return [...tokens];
}

/** Build Sentry issue-search queries, most specific first. */
export function buildRelatedIssueQueries(ctx: RelatedIssueContext): string[] {
  const queries: string[] = [];
  const tokens = ctx.flagKey ? relatedIssueSearchTokens(ctx.flagKey) : [];
  for (const t of tokens) {
    queries.push(`is:unresolved feature:${t}`);
    queries.push(`is:unresolved flag:${t}`);
    queries.push(`is:unresolved ${t}`);
    if (ctx.targetVariation) {
      queries.push(`is:unresolved feature:${t} ${ctx.targetVariation}`);
    }
  }
  if (ctx.sha) queries.push(`is:unresolved release:${ctx.sha}`);
  queries.push("is:unresolved");
  // De-dupe while preserving order
  return [...new Set(queries)];
}

function issueMentionsFlag(issue: SentryIssueSummary, flagKey: string): boolean {
  const hay = `${issue.title ?? ""} ${issue.culprit ?? ""} ${issue.shortId ?? ""}`;
  if (hay.includes(flagKey)) return true;
  for (const t of relatedIssueSearchTokens(flagKey)) {
    if (hay.includes(t)) return true;
  }
  return false;
}

/**
 * Prefer issues tagged/titled for the flag (feature:/flag: search), then the
 * noisiest recent unresolved issue. Shared by metrics-author estate picture
 * and Beacon Seer (ADR 0014/0015).
 *
 * API failures are NOT swallowed into a silent null — if every query errors
 * (e.g. 403 missing `project:read` / `event:read` on the token), the last
 * error is rethrown so Beacon can log "permission denied" instead of the
 * misleading "no matching Sentry issue".
 */
export async function findRelatedIssue(
  conn: SentryConnection,
  ctx: RelatedIssueContext,
): Promise<SentryIssueSummary | null> {
  const statsPeriod = ctx.statsPeriod ?? "24h";
  const queries = buildRelatedIssueQueries(ctx);
  let lastError: Error | null = null;
  let sawSuccessfulEmpty = false;
  let fallback: SentryIssueSummary | null = null;

  for (const query of queries) {
    try {
      const items = await searchIssues(conn, { query, statsPeriod, limit: 10, sort: "freq" });
      if (items.length === 0) {
        sawSuccessfulEmpty = true;
        continue;
      }
      if (ctx.flagKey) {
        const flagged = items.find((i) => issueMentionsFlag(i, ctx.flagKey!));
        if (flagged) return flagged;
        // A feature:/flag: query that returned hits is already scoped — take top.
        if (query.includes("feature:") || query.includes("flag:")) {
          return items[0]!;
        }
        // Free-text / bare unresolved: keep as fallback, keep looking for a
        // better tagged match from earlier-specific queries that returned empty.
        fallback ??= items[0]!;
        continue;
      }
      return items[0]!;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
  }

  if (fallback) return fallback;
  // Only treat as "no issues" when at least one query succeeded with [].
  // If every attempt threw (auth/scope), surface that — callers used to log
  // a false "no matching Sentry issue".
  if (lastError && !sawSuccessfulEmpty) throw lastError;
  return null;
}

/**
 * Event timeseries for a Discover-style query (error counts over the window).
 * Soft-fails to [] on HTTP errors.
 */
export async function eventStats(
  conn: SentryConnection,
  opts: { query?: string; statsPeriod?: string; interval?: string } = {},
): Promise<SentryEventsStatsPoint[]> {
  const query = opts.query ?? "event.type:error";
  const statsPeriod = opts.statsPeriod ?? "24h";
  const interval = opts.interval ?? "1h";
  const url =
    `/api/0/projects/${encodeURIComponent(conn.org)}/${encodeURIComponent(conn.project)}/events/stats/` +
    `?query=${encodeURIComponent(query)}&statsPeriod=${encodeURIComponent(statsPeriod)}` +
    `&interval=${encodeURIComponent(interval)}`;
  const res = await sentryFetch(conn, url);
  if (!res.ok) return [];
  // Sentry returns nested arrays: [[timestamp, [{count: n}]], ...] or similar.
  const raw = (await res.json()) as unknown;
  return normalizeStats(raw);
}

function normalizeStats(raw: unknown): SentryEventsStatsPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: SentryEventsStatsPoint[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const time = Number(row[0]);
    const bucket = row[1];
    let count = 0;
    if (Array.isArray(bucket) && bucket[0] && typeof bucket[0] === "object") {
      count = Number((bucket[0] as { count?: number }).count ?? 0);
    } else if (typeof bucket === "number") {
      count = bucket;
    }
    if (Number.isFinite(time)) out.push({ time, count });
  }
  return out;
}

/**
 * Best-effort Discover aggregate via events API (count / failure_rate / p95).
 * Returns a compact string map; empty on failure.
 */
export async function discoverAggregates(
  conn: SentryConnection,
  opts: { field?: string; query?: string; statsPeriod?: string } = {},
): Promise<Record<string, number | string>> {
  // Organization-level events endpoint supports aggregate fields in newer APIs.
  // Soft-fail if unavailable for the plan/token.
  const field = opts.field ?? "count()";
  const query = opts.query ?? "event.type:error";
  const statsPeriod = opts.statsPeriod ?? "24h";
  const url =
    `/api/0/organizations/${encodeURIComponent(conn.org)}/events/` +
    `?project=${encodeURIComponent(conn.project)}` +
    `&field=${encodeURIComponent(field)}` +
    `&query=${encodeURIComponent(query)}` +
    `&statsPeriod=${encodeURIComponent(statsPeriod)}` +
    `&referrer=auto-factory-estate`;
  try {
    const res = await sentryFetch(conn, url);
    if (!res.ok) return {};
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const row = data.data?.[0];
    if (!row) return {};
    const out: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "number" || typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Sample recent error events and sniff for launchdarklyContext / flag tags. */
export async function sampleErrorEvents(
  conn: SentryConnection,
  opts: { limit?: number; statsPeriod?: string; query?: string } = {},
): Promise<{
  sampled: number;
  withLaunchdarklyContext: number;
  flagTagHits: string[];
}> {
  const limit = opts.limit ?? 10;
  const statsPeriod = opts.statsPeriod ?? "24h";
  const query = opts.query ?? "event.type:error";
  const url =
    `/api/0/projects/${encodeURIComponent(conn.org)}/${encodeURIComponent(conn.project)}/events/` +
    `?query=${encodeURIComponent(query)}&statsPeriod=${encodeURIComponent(statsPeriod)}&limit=${limit}&full=true`;
  try {
    const res = await sentryFetch(conn, url);
    if (!res.ok) return { sampled: 0, withLaunchdarklyContext: 0, flagTagHits: [] };
    const events = (await res.json()) as Array<{
      context?: Record<string, unknown>;
      tags?: Array<{ key: string; value: string }>;
    }>;
    if (!Array.isArray(events)) return { sampled: 0, withLaunchdarklyContext: 0, flagTagHits: [] };
    let withLaunchdarklyContext = 0;
    const flagTagHits: string[] = [];
    for (const ev of events) {
      if (ev.context && "launchdarklyContext" in ev.context) withLaunchdarklyContext += 1;
      for (const t of ev.tags ?? []) {
        if (t.key === "flag" || t.key.startsWith("ld.") || t.key.includes("feature")) {
          flagTagHits.push(`${t.key}=${t.value}`);
        }
      }
    }
    return { sampled: events.length, withLaunchdarklyContext, flagTagHits: [...new Set(flagTagHits)].slice(0, 20) };
  } catch {
    return { sampled: 0, withLaunchdarklyContext: 0, flagTagHits: [] };
  }
}
