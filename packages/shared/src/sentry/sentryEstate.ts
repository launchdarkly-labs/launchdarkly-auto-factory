/**
 * Higher-level Sentry estate picture for Phase 1 agents (ADR 0015).
 *
 * Never throws into the agent chain — returns `{ available: false, warning }`
 * when creds/API fail (same contract as o11yClient).
 */

import {
  discoverAggregates,
  eventStats,
  findRelatedIssue,
  sampleErrorEvents,
  searchIssues,
  type SentryIssueSummary,
} from "./sentryClient.js";
import { sentryConnectionFromEnv, type SentryConnection } from "./sentryEnv.js";

export interface EstatePictureOpts {
  /** Hours to look back (mapped to Sentry statsPeriod). */
  windowHours?: number;
  flagKey?: string;
  sha?: string;
  /** Extra Discover/issue query fragment. */
  query?: string;
  transaction?: string;
  /** Override env connection (tests). */
  connection?: SentryConnection | null;
}

export interface SentryEstatePicture {
  available: boolean;
  warning?: string;
  org?: string;
  project?: string;
  statsPeriod?: string;
  topIssues?: SentryIssueSummary[];
  relatedIssue?: SentryIssueSummary | null;
  errorCountApprox?: number;
  aggregates?: Record<string, number | string>;
  attribution?: {
    sampled: number;
    withLaunchdarklyContext: number;
    flagTagHits: string[];
    /** True when recent errors lack launchdarklyContext — LD↔Sentry metrics will ignore them. */
    launchdarklyContextGap: boolean;
  };
  /**
   * Guidance for the metrics author: LD o11y/`otel*` still need dual-export;
   * Sentry aggregates alone are not valid guarded-release backings.
   */
  dualExportHint?: string;
  notes?: string[];
}

function statsPeriodFromHours(hours: number): string {
  if (hours <= 1) return "1h";
  if (hours <= 24) return `${Math.max(1, Math.round(hours))}h`;
  if (hours <= 24 * 7) return `${Math.max(1, Math.round(hours / 24))}d`;
  return "14d";
}

/** Build a structured estate picture for `query_sentry`. */
export async function getEstatePicture(opts: EstatePictureOpts = {}): Promise<SentryEstatePicture> {
  const conn =
    opts.connection === undefined ? sentryConnectionFromEnv() : opts.connection;
  if (!conn) {
    return {
      available: false,
      warning:
        "Sentry estate unavailable — set SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT " +
        "(same token family as Beacon Seer). Repo may still have the Sentry SDK; detect via grep.",
      dualExportHint:
        "Latency guardrails still need LD-native metrics (otel* / track() / kind=trace). " +
        "If the app only sends OTLP to Sentry, dual-export to LD hosted o11y (ADR 0015).",
    };
  }

  const windowHours = opts.windowHours ?? 24;
  const statsPeriod = statsPeriodFromHours(windowHours);
  const notes: string[] = [];
  const issueQueryParts = ["is:unresolved"];
  if (opts.flagKey) issueQueryParts.push(opts.flagKey);
  if (opts.query) issueQueryParts.push(opts.query);
  if (opts.transaction) issueQueryParts.push(`transaction:${opts.transaction}`);

  try {
    const [topIssues, relatedIssue, stats, aggregates, attribution] = await Promise.all([
      searchIssues(conn, {
        query: issueQueryParts.join(" "),
        statsPeriod,
        limit: 8,
        sort: "freq",
      }),
      findRelatedIssue(conn, {
        flagKey: opts.flagKey,
        sha: opts.sha,
        statsPeriod,
      }),
      eventStats(conn, {
        query: opts.transaction
          ? `event.type:error transaction:${opts.transaction}`
          : "event.type:error",
        statsPeriod,
      }),
      discoverAggregates(conn, {
        field: "count()",
        query: opts.transaction
          ? `event.type:error transaction:${opts.transaction}`
          : "event.type:error",
        statsPeriod,
      }),
      sampleErrorEvents(conn, {
        statsPeriod,
        query: opts.flagKey ? `event.type:error ${opts.flagKey}` : "event.type:error",
        limit: 10,
      }),
    ]);

    const errorCountApprox = stats.reduce((s, p) => s + p.count, 0);
    if (attribution.sampled > 0 && attribution.withLaunchdarklyContext === 0) {
      notes.push(
        "Recent error events lack Sentry custom context 'launchdarklyContext' — " +
          "the LD↔Sentry metrics integration will ignore them until instrumented (ADR 0014).",
      );
    }
    notes.push(
      "Do NOT attach Sentry Explore aggregates as guarded-release metrics. " +
        "Use LD metrics: sentry-errors-* (errors), otel*/track()/trace (latency/business).",
    );

    return {
      available: true,
      org: conn.org,
      project: conn.project,
      statsPeriod,
      topIssues,
      relatedIssue,
      errorCountApprox,
      aggregates,
      attribution: {
        ...attribution,
        launchdarklyContextGap:
          attribution.sampled > 0 && attribution.withLaunchdarklyContext === 0,
      },
      dualExportHint:
        "If list_metrics shows no otel* autogens but Sentry has traffic, enable dual-export: " +
        "same OTel spans → Sentry and LD hosted o11y (or run @launchdarkly/observability alongside Sentry). " +
        "Knowledge-graph service edges still read LD MCP query-traces (ADR 0010/0015).",
      notes,
    };
  } catch (e) {
    return {
      available: false,
      org: conn.org,
      project: conn.project,
      warning: `Sentry estate query failed: ${e instanceof Error ? e.message : e}`,
      dualExportHint:
        "Fall back to repo detection (grep Sentry SDK) + list_metrics for otel*/sentry-errors-*.",
    };
  }
}
