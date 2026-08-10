/**
 * Deploy-state store: the SHAs Beacon has seen per (service, environment).
 *
 * Why state at all: discovery diffs `.release-flags/` between the current and
 * previous deploy SHAs, and most CD systems (Railway included) don't tell you
 * what was deployed before. Beacon remembering what it last processed is
 * deploy-system-agnostic and survives batched merges and redeploys. An
 * explicit `previousSha` in a notification always wins — callers that DO know
 * it stay authoritative.
 *
 * Two-deep history (`last` + `prior`), not just `last`: re-delivering the
 * current SHA's notification (provider retry, service restart, or the manual
 * recovery for a "waiting" fullstack flag) must re-diff the SAME range, not
 * the empty `sha..sha` range — so a re-notification resolves previousSha to
 * `prior` and `record` of an unchanged SHA is a no-op.
 *
 * The interface is the seam; the file-backed default suits a single-instance
 * prototype. Swap in a KV/DB-backed store for multi-instance deployments.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DeployState {
  /** SHA of the most recent recorded deploy. */
  last?: string;
  /** SHA of the deploy before that. */
  prior?: string;
}

export interface DeployStateStore {
  get(service: string, environment: string): DeployState;
  /** Record a deploy. Re-recording the current `last` SHA is a no-op. */
  record(service: string, environment: string, sha: string): void;
}

/**
 * Resolve the previousSha for a notification: an explicit value wins; else the
 * store's `last` (or `prior` when this is a re-notification of `last` itself);
 * else undefined — first deploy, all current release-flags treated as new.
 */
export function resolvePreviousSha(
  store: DeployStateStore,
  service: string,
  environment: string,
  sha: string,
  explicit: string | undefined,
): { previousSha: string | undefined; source: "request" | "state" | "none" } {
  if (explicit) return { previousSha: explicit, source: "request" };
  const state = store.get(service, environment);
  const previousSha = state.last === sha ? state.prior : state.last;
  return previousSha ? { previousSha, source: "state" } : { previousSha: undefined, source: "none" };
}

const key = (service: string, environment: string): string => `${service}@${environment}`;

/** In-memory store (tests, or callers that always supply previousSha). */
export class MemoryDeployStateStore implements DeployStateStore {
  protected states = new Map<string, DeployState>();

  get(service: string, environment: string): DeployState {
    return this.states.get(key(service, environment)) ?? {};
  }

  record(service: string, environment: string, sha: string): void {
    const k = key(service, environment);
    const current = this.states.get(k) ?? {};
    if (current.last === sha) return;
    this.states.set(k, { last: sha, ...(current.last ? { prior: current.last } : {}) });
  }
}

/**
 * JSON-file-backed store ({"service@environment": {last, prior}}). Loads on
 * construction, rewrites the file on every record (atomically via rename) —
 * fine at deploy-notification frequency.
 */
export class FileDeployStateStore extends MemoryDeployStateStore {
  private readonly file: string;

  constructor(filePath: string) {
    super();
    this.file = resolve(filePath);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, DeployState>;
      this.states = new Map(Object.entries(raw));
    } catch (e) {
      // ENOENT is a first run. ANYTHING ELSE must not read as one.
      //
      // Collapsing "no state yet" and "state unreadable" into "start empty" is destructive:
      // with no state, `resolvePreviousSha` returns undefined, discovery treats EVERY
      // manifest in .release-flags/ as new, and Beacon re-triggers all of them. For a flag
      // whose guarded release was already REVERTED by a metric regression, the environment
      // serves the original variation again — so it is not a no-op, and a guardrail's
      // rollback gets silently undone.
      //
      // Throwing here fails at construction (createApp, before any webhook is served), so an
      // operator sees it at boot rather than as a mass re-release. Deliberate reset is still
      // available: delete the file.
      if ((e as { code?: string }).code === "ENOENT") return;
      throw new Error(
        `deploy-state file '${this.file}' exists but could not be read — refusing to start with empty ` +
          `state, because that would re-trigger every release manifest in the repo. Fix or delete the ` +
          `file (deleting it deliberately resets to full re-discovery). Cause: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
    }
  }

  override record(service: string, environment: string, sha: string): void {
    super.record(service, environment, sha);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.states), null, 2));
    renameSync(tmp, this.file);
  }
}
