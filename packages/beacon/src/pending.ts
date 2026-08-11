/**
 * The re-evaluation ledger: flags whose release is NOT finished, re-checked on any
 * later webhook independently of discovery.
 *
 * Why it exists. Beacon evaluates each manifest exactly once, because discovery is a
 * FILENAME diff between two SHAs — a file present at both ends is never rediscovered. So
 * every outcome that is not final (`held`, `waiting`, `error`) got one chance and then
 * stranded, and nothing retried it: the Notifier cannot fail a deploy, and Railway
 * documents no webhook retry. This store is what remembers, so a later deploy — any
 * deploy, for any flag — gives the unfinished work another look.
 *
 * Two properties matter more than the retry itself:
 *  - re-evaluation re-reads the manifest AT THE CURRENT SHA, so a human's fix to a bad
 *    `releaseIntent` actually takes effect (previously a no-op: the file existed at both
 *    SHAs, so discovery never surfaced it again);
 *  - a release that finished while nobody was watching is noticed, so its dependent child
 *    flags get repointed.
 *
 * WEBHOOK-GATED, deliberately. Nothing here fires on a timer, so a `notBefore` date
 * passing still causes nothing until some deploy arrives. Closing that would make Beacon
 * a scheduler, against its stated design as a translator to LaunchDarkly primitives;
 * deferred as a separate decision (docs/loop-seam.md).
 *
 * Separate from the deploy-state store because the lifecycles differ — this is per-flag
 * and cleared on completion, that is per-service and permanent — and because mixing them
 * would muddle the fail-closed argument each one makes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PendingEntry {
  service: string;
  environment: string;
  flagKey: string;
  /** Path of the manifest, re-read at the CURRENT sha on each re-evaluation. */
  sourceFile: string;
  /** The sha whose deploy first produced a non-final outcome. */
  firstSeenSha: string;
  /** The sha of the most recent evaluation. */
  lastSha: string;
  /** The most recent non-final action (`held` | `waiting` | `error`). */
  lastAction: string;
  lastDetail?: string;
  /** How many times this flag has been evaluated, including the first. */
  attempts: number;
  /**
   * Set when re-evaluation must NOT proceed without a human — currently only a release
   * LaunchDarkly reverted. Kept in the ledger (so it stays visible) but never re-triggered.
   */
  needsHuman?: boolean;
}

export interface PendingStore {
  /** Entries awaiting re-evaluation for one service+environment. */
  list(service: string, environment: string): PendingEntry[];
  upsert(entry: PendingEntry): void;
  clear(service: string, environment: string, flagKey: string): void;
}

const key = (service: string, environment: string, flagKey: string): string =>
  `${service}@${environment}#${flagKey}`;

export class MemoryPendingStore implements PendingStore {
  protected entries = new Map<string, PendingEntry>();

  list(service: string, environment: string): PendingEntry[] {
    return [...this.entries.values()].filter((e) => e.service === service && e.environment === environment);
  }

  upsert(entry: PendingEntry): void {
    this.entries.set(key(entry.service, entry.environment, entry.flagKey), entry);
    this.persist();
  }

  clear(service: string, environment: string, flagKey: string): void {
    if (this.entries.delete(key(service, environment, flagKey))) this.persist();
  }

  /** No-op in memory; the file-backed subclass writes. */
  protected persist(): void {}
}

/**
 * JSON-file-backed ledger. Loaded once at construction, rewritten atomically on change.
 *
 * On an unreadable file this THROWS at construction rather than starting empty, matching
 * the deploy-state store — but for a different reason worth being precise about. Losing
 * this file is not destructive the way losing deploy state is (that one causes a mass
 * re-release; this one causes forgetting). It is however a silent loss of the only thing
 * standing between an unfinished release and a permanent strand, and a safety net that
 * quietly isn't there is worse than one that refuses to start.
 */
export class FilePendingStore extends MemoryPendingStore {
  private readonly file: string;
  private loaded = false;

  constructor(filePath: string) {
    super();
    this.file = resolve(filePath);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, PendingEntry>;
      this.entries = new Map(Object.entries(raw));
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") {
        throw new Error(
          `pending-release ledger '${this.file}' exists but could not be read — refusing to start ` +
            `without it, because unfinished releases would then strand with nothing tracking them. ` +
            `Fix or delete the file (deleting it forgets in-flight work; those flags need a manual ` +
            `re-POST). Cause: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.loaded = true;
  }

  protected override persist(): void {
    if (!this.loaded) return; // constructor-time population is not a write
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries), null, 2));
    renameSync(tmp, this.file);
  }
}

/** Actions that leave work unfinished. Must agree with notifyReport's NON_FINAL_ACTIONS. */
export const PENDING_ACTIONS: readonly string[] = ["held", "waiting", "error"];

/**
 * Fold one evaluation's outcome into the ledger: remember it while unfinished, forget it
 * once done. Called for EVERY outcome, including ones discovery produced, so a flag that
 * finally releases stops being tracked.
 */
export function recordOutcome(
  store: PendingStore,
  o: {
    service: string;
    environment: string;
    sha: string;
    flagKey: string;
    sourceFile: string;
    action: string;
    detail?: string;
    needsHuman?: boolean;
  },
): void {
  if (!PENDING_ACTIONS.includes(o.action)) {
    store.clear(o.service, o.environment, o.flagKey);
    return;
  }
  const existing = store
    .list(o.service, o.environment)
    .find((e) => e.flagKey === o.flagKey);
  store.upsert({
    service: o.service,
    environment: o.environment,
    flagKey: o.flagKey,
    sourceFile: o.sourceFile,
    firstSeenSha: existing?.firstSeenSha ?? o.sha,
    lastSha: o.sha,
    lastAction: o.action,
    ...(o.detail !== undefined ? { lastDetail: o.detail.slice(0, 500) } : {}),
    attempts: (existing?.attempts ?? 0) + 1,
    ...(o.needsHuman ? { needsHuman: true } : {}),
  });
}
