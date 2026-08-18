/**
 * On guarded-release revert, find a related Sentry issue and start Seer Autofix
 * (ADR 0014 / 0015). Issue-scoped — inventing empty issues won't work.
 *
 * Issue matching is shared with Phase 1 `query_sentry` via
 * `@auto-factory/shared` `findRelatedIssue`.
 *
 * Gated by BEACON_SEER_AUTOFIX=true. Never throws: same contract as monitoring
 * (observability side-effect, not release control).
 */

import {
  findRelatedIssue,
  sentryConnectionFromEnv,
  type SentryIssueSummary,
} from "@auto-factory/shared";

export interface SeerAutofixSettings {
  enabled: boolean;
  authToken?: string;
  org?: string;
  project?: string;
  /** Default open_pr — run Autofix through opening a fix PR. */
  stoppingPoint: "root_cause" | "solution" | "code_changes" | "open_pr";
  /** Sentry API host (default https://sentry.io). */
  apiBase: string;
}

export function seerSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SeerAutofixSettings {
  return {
    enabled: env.BEACON_SEER_AUTOFIX === "true",
    authToken: env.SENTRY_AUTH_TOKEN,
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    stoppingPoint: (env.BEACON_SEER_STOPPING_POINT as SeerAutofixSettings["stoppingPoint"]) || "open_pr",
    apiBase: (env.SENTRY_API_BASE || "https://sentry.io").replace(/\/+$/, ""),
  };
}

export interface RevertAutofixContext {
  flagKey: string;
  environmentKey: string;
  /** owner/repo when known (helps issue search / Autofix repo selection). */
  repoFullName?: string;
  /** Deploy SHA that started the release, when known. */
  sha?: string;
  targetVariation?: string;
}

async function sentryFetch(
  settings: SeerAutofixSettings,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${settings.apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${settings.authToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** Resolve a related issue using the shared estate matcher (ADR 0015). */
export async function findRelatedSentryIssue(
  settings: SeerAutofixSettings,
  ctx: RevertAutofixContext,
): Promise<SentryIssueSummary | null> {
  if (!settings.authToken || !settings.org || !settings.project) return null;
  return findRelatedIssue(
    {
      authToken: settings.authToken,
      org: settings.org,
      project: settings.project,
      apiBase: settings.apiBase,
    },
    {
      flagKey: ctx.flagKey,
      targetVariation: ctx.targetVariation,
      sha: ctx.sha,
      statsPeriod: "24h",
    },
  );
}

export async function startSeerAutofix(
  settings: SeerAutofixSettings,
  issueId: string,
  ctx: RevertAutofixContext,
): Promise<{ runId?: string; ok: boolean; detail: string }> {
  if (!settings.authToken || !settings.org) {
    return { ok: false, detail: "missing SENTRY_AUTH_TOKEN or SENTRY_ORG" };
  }

  const body: Record<string, unknown> = {
    stopping_point: settings.stoppingPoint,
    instruction:
      `Guarded release for LaunchDarkly flag '${ctx.flagKey}' in environment ` +
      `'${ctx.environmentKey}' was REVERTED by a guardrail. Investigate the ` +
      `regression under the treatment variation` +
      (ctx.targetVariation ? ` '${ctx.targetVariation}'` : "") +
      (ctx.sha ? ` (deploy ${ctx.sha})` : "") +
      ` and open a fix PR.`,
  };
  if (ctx.repoFullName) {
    body.repo_name = ctx.repoFullName;
  }

  const res = await sentryFetch(settings, `/api/0/organizations/${encodeURIComponent(settings.org)}/issues/${issueId}/autofix/`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (res.status === 202 || res.ok) {
    const data = (await res.json().catch(() => ({}))) as { run_id?: string; sentry_run_id?: string };
    const runId = data.sentry_run_id ?? data.run_id;
    return {
      ok: true,
      runId,
      detail: `Autofix started for issue ${issueId}${runId ? ` (run ${runId})` : ""} → ${settings.stoppingPoint}`,
    };
  }

  const errText = await res.text().catch(() => "");
  return { ok: false, detail: `Autofix HTTP ${res.status}: ${errText.slice(0, 400)}` };
}

/**
 * Full revert → Seer path. Logs outcomes; never throws.
 */
export async function triggerSeerOnRevert(
  ctx: RevertAutofixContext,
  settings: SeerAutofixSettings = seerSettingsFromEnv(),
): Promise<void> {
  const tag = `[beacon/seer] ${ctx.flagKey}/${ctx.environmentKey}`;
  try {
    if (!settings.enabled) {
      console.log(`${tag}: Seer Autofix disabled (set BEACON_SEER_AUTOFIX=true to enable)`);
      return;
    }
    // Prefer shared env helper so Phase 1 and Beacon agree on "configured".
    const conn = sentryConnectionFromEnv({
      SENTRY_AUTH_TOKEN: settings.authToken,
      SENTRY_ORG: settings.org,
      SENTRY_PROJECT: settings.project,
      SENTRY_API_BASE: settings.apiBase,
    });
    if (!conn) {
      console.warn(`${tag}: Seer enabled but SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT incomplete — skipping`);
      return;
    }

    let issue;
    try {
      issue = await findRelatedSentryIssue(settings, ctx);
    } catch (e) {
      // Auth/scope failures used to be swallowed inside findRelatedIssue and
      // logged as "no matching issue" — hide the real 403 (missing
      // project:read / event:read on SENTRY_AUTH_TOKEN).
      console.warn(
        `${tag}: Sentry issue search failed (check SENTRY_AUTH_TOKEN scopes — need project:read + event:read, and event:write for Autofix): ` +
          `${e instanceof Error ? e.message : e}`,
      );
      return;
    }
    if (!issue) {
      console.warn(
        `${tag}: no matching Sentry issue in the last 24h — Autofix skipped ` +
          `(searched feature:/flag: tags derived from '${ctx.flagKey}'` +
          (ctx.targetVariation ? ` / ${ctx.targetVariation}` : "") +
          `). Tag treatment-path errors with feature:<slug> or flag:<flagKey>.`,
      );
      return;
    }

    console.log(`${tag}: matched issue ${issue.shortId ?? issue.id} — ${issue.title ?? "(no title)"}`);
    const result = await startSeerAutofix(settings, issue.id, ctx);
    if (result.ok) {
      console.log(`${tag}: ${result.detail}${issue.permalink ? ` — ${issue.permalink}` : ""}`);
    } else {
      console.warn(`${tag}: ${result.detail}`);
    }
  } catch (e) {
    console.warn(`${tag}: Seer hook error (release already reverted): ${e instanceof Error ? e.message : e}`);
  }
}
