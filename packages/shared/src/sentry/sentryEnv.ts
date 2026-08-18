/**
 * Sentry connection settings shared by Phase 1 `query_sentry` and Beacon Seer
 * (ADR 0014 / 0015).
 */

export interface SentryConnection {
  authToken: string;
  org: string;
  project: string;
  /** API host without trailing slash (default https://sentry.io). */
  apiBase: string;
}

/**
 * Read Sentry connection from env. Returns null when incomplete — callers treat
 * that as "Sentry estate unavailable" (never throw into the agent chain).
 */
export function sentryConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): SentryConnection | null {
  const authToken = env.SENTRY_AUTH_TOKEN?.trim();
  const org = env.SENTRY_ORG?.trim();
  const project = env.SENTRY_PROJECT?.trim();
  if (!authToken || !org || !project) return null;
  return {
    authToken,
    org,
    project,
    apiBase: (env.SENTRY_API_BASE || "https://sentry.io").replace(/\/+$/, ""),
  };
}
