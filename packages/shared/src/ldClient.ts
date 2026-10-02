/**
 * Thin LaunchDarkly REST client with a configurable base URL, so it can target
 * the prototype's project or any other instance. Uses global `fetch` (Node 18+).
 *
 * Auth header is the raw API key (LaunchDarkly convention — no "Bearer" prefix).
 */

import type { LdConnection } from "./env.js";

/** AI-config / agent-graph endpoints require the beta API version. */
const BETA = { "LD-API-Version": "beta" } as const;

export interface LdRequestOptions {
  method?: string;
  /** Path beginning with "/" (e.g. "/api/v2/flags/default/my-flag"). */
  path: string;
  body?: unknown;
  /** Extra headers (e.g. semantic-patch content-type, LD-API-Version). */
  headers?: Record<string, string>;
  /** Treat these status codes as success in addition to 2xx (e.g. [409]). */
  okStatuses?: number[];
}

export interface LdResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

/** Max automatic retries on HTTP 429 before surfacing the error. */
const RATE_LIMIT_RETRIES = 6;
/** Bounds on how long a single 429 backoff may sleep (LD's reset is usually <10s). */
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
/**
 * Max automatic retries on HTTP 5xx, applied only where a repeat is harmless:
 * GETs, and creates that treat 409 as success (a create that landed before the
 * 5xx comes back as 409 on retry). PATCHes are never retried — a semantic
 * patch could apply twice.
 */
const SERVER_ERROR_RETRIES = 2;
/** Cap on the request body echoed into the log when a 5xx is surfaced. */
const LOGGED_BODY_CHARS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `Retry-After` in ms, accepting both forms RFC 9110 allows: delay-seconds
 * ("2") and an HTTP-date. Undefined when absent or unparseable.
 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(at - Date.now(), 0);
}

/**
 * How long to wait before retrying a 429. Prefers `Retry-After`, falls back
 * to `X-Ratelimit-Reset` (epoch ms), else a fixed backoff.
 */
function backoffMs(res: Response): number {
  const retryAfter = retryAfterMs(res);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_BACKOFF_MS);
  }
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset - Date.now(), MIN_BACKOFF_MS), MAX_BACKOFF_MS);
  }
  return 2000;
}

/** Retry-After when the server sends one, else 1s, 2s, … */
function serverErrorBackoffMs(res: Response, retry: number): number {
  const retryAfter = retryAfterMs(res);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_BACKOFF_MS);
  }
  return 1000 * 2 ** retry;
}

function isRetryableOnServerError(opts: LdRequestOptions): boolean {
  const method = (opts.method ?? "GET").toUpperCase();
  return method === "GET" || (method === "POST" && (opts.okStatuses?.includes(409) ?? false));
}

export class LdClient {
  constructor(private readonly conn: LdConnection) {}

  get projectKey(): string {
    return this.conn.projectKey;
  }

  async request<T = unknown>(opts: LdRequestOptions): Promise<LdResponse<T>> {
    let res!: Response;
    // Separate budgets so 5xx retries never eat into the 429 allowance (and
    // vice versa); `attempts` counts every HTTP call for diagnostics.
    let rateLimitRetries = 0;
    let serverErrorRetries = 0;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      res = await fetch(`${this.conn.baseUrl}${opts.path}`, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: this.conn.apiKey,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 429 && rateLimitRetries < RATE_LIMIT_RETRIES) {
        await sleep(backoffMs(res));
        rateLimitRetries += 1;
        continue;
      }
      if (res.status >= 500 && serverErrorRetries < SERVER_ERROR_RETRIES && isRetryableOnServerError(opts)) {
        await sleep(serverErrorBackoffMs(res, serverErrorRetries));
        serverErrorRetries += 1;
        continue;
      }
      break;
    }

    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* leave as text */
      }
    }

    const ok = res.ok || (opts.okStatuses?.includes(res.status) ?? false);
    if (!ok) {
      const method = opts.method ?? "GET";
      if (res.status >= 500) {
        // A 5xx says nothing about which part of the request upset the server;
        // keep the request on record so the next look isn't guesswork.
        const sent = opts.body === undefined ? "(none)" : JSON.stringify(opts.body).slice(0, LOGGED_BODY_CHARS);
        console.warn(
          `[ld-api] ${method} ${opts.path} → HTTP ${res.status} after ${attempts} attempt(s). ` +
            `Response: ${text.slice(0, LOGGED_BODY_CHARS) || "(empty)"} Request body: ${sent}`,
        );
      }
      throw new LdApiError(method, opts.path, res.status, data, attempts);
    }
    return { status: res.status, ok, data: data as T };
  }

  /** GET a feature flag (optionally with environment summary). */
  getFlag<T = unknown>(flagKey: string, query = ""): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}${query}`,
    });
  }

  /**
   * JSON-Patch a flag (project-level fields — e.g. adding a variation to a
   * multivariate flag). Distinct from the semantic-patch methods below: the
   * flag PATCH endpoint treats a plain JSON body as RFC 6902 operations.
   */
  patchFlagJson<T = unknown>(flagKey: string, operations: unknown[], comment?: string): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}`,
      body: comment ? { comment, patch: operations } : operations,
    });
  }

  /** Flags that list this flag as a prerequisite (project-wide). */
  getDependentFlags<T = unknown>(flagKey: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}/dependent-flags`,
    });
  }

  // --- AI configs & agent graphs (beta) -----------------------------------
  // The AI-config / agent-graph endpoints require the beta API version.

  /** Get an AI config; returns status 404 (not throwing) when absent. */
  getAiConfig<T = unknown>(key: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${key}`,
      headers: BETA,
      okStatuses: [404],
    });
  }

  createAiConfig<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs`,
      headers: BETA,
      body,
    });
  }

  createAiConfigVariation<T = unknown>(configKey: string, body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${configKey}/variations`,
      headers: BETA,
      body,
    });
  }

  /** Partial update of an AI-config variation (e.g. attach a judgeConfiguration). */
  updateAiConfigVariation<T = unknown>(configKey: string, variationKey: string, body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${configKey}/variations/${variationKey}`,
      headers: BETA,
      body,
    });
  }

  // --- AI tools library (AgentControl) -------------------------------------

  /** Get an AI tool definition; returns status 404 (not throwing) when absent. */
  getAiTool<T = unknown>(key: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/projects/${this.conn.projectKey}/ai-tools/${key}`,
      headers: BETA,
      okStatuses: [404],
    });
  }

  /** Create an AI tool definition ({key, name, description, schema}). */
  createAiTool<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-tools`,
      headers: BETA,
      body,
    });
  }

  /** Partial update of an AI tool definition (description/schema sync). */
  updateAiTool<T = unknown>(key: string, body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-tools/${key}`,
      headers: BETA,
      body,
    });
  }

  /** Get an AI config's per-environment targeting (rules, variation ids). */
  getAiConfigTargeting<T = unknown>(key: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${key}/targeting`,
      headers: BETA,
    });
  }

  /** Semantic-patch an AI config's targeting in one environment (beta). */
  patchAiConfigTargeting<T = unknown>(
    key: string,
    body: { environmentKey: string; instructions: unknown[]; comment?: string },
  ): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${key}/targeting`,
      headers: BETA,
      body,
    });
  }

  /** Get an agent graph; returns status 404 (not throwing) when absent. */
  getAgentGraph<T = unknown>(key: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/projects/${this.conn.projectKey}/agent-graphs/${key}`,
      headers: BETA,
      okStatuses: [404],
    });
  }

  createAgentGraph<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/agent-graphs`,
      headers: BETA,
      body,
    });
  }

  /** Full-object update of an agent graph (the graph API is not JSON Patch). */
  updateAgentGraph<T = unknown>(key: string, body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/projects/${this.conn.projectKey}/agent-graphs/${key}`,
      headers: BETA,
      body,
    });
  }

  // --- Account members ------------------------------------------------------

  /**
   * Search account members (ACCOUNT-level endpoint — no project in the path).
   * `query` matches name/email fuzzily; callers wanting an exact email must
   * filter the returned items themselves.
   */
  findMembers<T = unknown>(query: string, limit = 20): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/members?filter=${encodeURIComponent(`query:${query}`)}&limit=${limit}`,
    });
  }

  // --- Flags & metrics ------------------------------------------------------

  /** Create a feature flag. Returns status 409 (not throwing) when it exists. */
  createFlag<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/flags/${this.conn.projectKey}`,
      body,
      okStatuses: [409],
    });
  }

  /** List metrics in the project (paginated; caller filters). */
  listMetrics<T = unknown>(limit = 100): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/metrics/${this.conn.projectKey}?limit=${limit}`,
    });
  }

  /** Create a metric. Returns status 409 (not throwing) when it exists. */
  createMetric<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    // Trace-backed metrics (kind=trace, traceQuery) require the beta API
    // version; event metrics don't. Send it only when needed so the proven
    // event path is untouched.
    const isTrace = typeof body === "object" && body !== null && (body as { kind?: string }).kind === "trace";
    return this.request<T>({
      method: "POST",
      path: `/api/v2/metrics/${this.conn.projectKey}`,
      ...(isTrace ? { headers: BETA } : {}),
      body,
      okStatuses: [409],
    });
  }

  /**
   * Apply a semantic-patch instruction set to a flag.
   * See releaseAdapter.ts for building automated-release instructions.
   */
  patchFlagSemantic<T = unknown>(
    flagKey: string,
    environmentKey: string,
    instructions: unknown[],
    comment?: string,
  ): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}`,
      headers: { "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch" },
      body: { environmentKey, instructions, ...(comment ? { comment } : {}) },
    });
  }

  /** Project-scoped semantic patch (e.g. turnOnClientSideAvailability). */
  patchFlagProjectSemantic<T = unknown>(
    flagKey: string,
    instructions: unknown[],
    comment?: string,
  ): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}`,
      headers: { "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch" },
      body: { instructions, ...(comment ? { comment } : {}) },
    });
  }
}

export class LdApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: unknown,
    /** HTTP calls made, including 429 and 5xx retries (1 = no retry). */
    readonly attempts = 1,
  ) {
    super(
      `LD API ${method} ${path} failed: HTTP ${status}${attempts > 1 ? ` (after ${attempts} attempts)` : ""} — ${JSON.stringify(responseBody)}`,
    );
    this.name = "LdApiError";
  }
}
