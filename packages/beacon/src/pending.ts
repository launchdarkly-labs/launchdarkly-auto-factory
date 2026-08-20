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
 *  - a release that finished while nobody was watching is noticed on the next deploy, so its
 *    dependent child flags get repointed. Stated exactly, because this claim has drifted from
 *    the code twice: the repoint happens for ANY entry of that flag whose manifest still reads
 *    (server.ts, `latest?.status === "completed"`), INCLUDING one held by its own intent, and it
 *    happens without answering "is this manifest done?" — that stays `served`-vs-`target` inside
 *    `triggerRelease`. What it still needs is a deploy to arrive and at least one entry for the
 *    flag to be pending; a flag with nothing outstanding is release monitoring's job (monitor.ts).
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

/**
 * Bumped whenever the ledger's shape or KEYING changes. The file is persisted state, and
 * `FilePendingStore` throws only on an unreadable file — so without a version, a file written
 * under the old keying would load with wrong keys SILENTLY, which is how a stale entry would
 * outlive the fix that re-keyed it.
 *
 * v1: keyed by sourceFile. (An unreleased pre-v1 shape keyed by flagKey; see the note on
 * `sourceFile` below for why that was wrong.)
 *
 * NOT bumped for the additive OPTIONAL `targetVariation` field, deliberately — and for these
 * reasons, which are about EFFECT rather than about keying (an earlier revision argued "an absent
 * optional field cannot produce a mis-keyed entry", which is true, is what this gate protects, and
 * is not what makes the field safe to add):
 *
 *  - nothing DECIDES anything from the stored value. The pending pass orders entries by the target
 *    read from each manifest at the current sha (server.ts), so a legacy entry cannot even
 *    mis-order the pass;
 *  - `Array.prototype.sort` is stable, so even while ordering did read this field, a purely legacy
 *    ledger — every entry missing it, hence every entry ranked equally — behaved EXACTLY as before;
 *  - every entry heals on its first successful re-evaluation, which writes the field as read;
 *  - and ordering only ever has an effect among manifests sharing a `flagKey`, because that is the
 *    axis the single action slot runs on — so a mixed file's exposure was bounded to that.
 *
 * Against that: bumping forces operators to delete the file (the message below says so) and lose
 * real in-flight work, in exchange for a reporting field.
 */
export const PENDING_LEDGER_VERSION = 1;

export interface PendingEntry {
  service: string;
  environment: string;
  /**
   * THE IDENTITY of a unit of release work, together with service+environment.
   *
   * The manifest's ADDRESS, not its content. An earlier revision keyed on `flagKey` and
   * merely remembered this — which was backwards, and produced the worst defect on the
   * branch: `flagKey` is manifest content, so a human correcting a wrong key (exactly the
   * fix an `error` entry invites) left the safety guard checking the OLD flag while the
   * trigger fired on the NEW one, re-releasing a variation a guardrail had rolled back. The
   * entry also never cleared, so it repeated on every deploy.
   *
   * Keyed on the address, the guard always runs against the flag we are about to act on,
   * because that flag comes from the manifest we just read.
   */
  sourceFile: string;
  /** LAST KNOWN flag this manifest named. Reporting only — never an identity or a guard input. */
  flagKey: string;
  /**
   * LAST KNOWN variation this manifest asked for (absent = "the lineage tip", which is what
   * `trigger.ts` resolves an absent `targetVariation` to). Reporting only, exactly like
   * `flagKey` above — never an identity, never a guard input.
   *
   * It exists so a log can say "pr-41.json is waiting to release v2" instead of naming a flag
   * that four manifests also name. Deliberately NOT load-bearing: whether a manifest's work is
   * still outstanding is `served` vs `target` computed FRESH from LaunchDarkly at the moment of
   * decision (trigger.ts), because a remembered target goes stale the instant a human edits the
   * manifest — the same reason the ledger is keyed on the manifest's address and not its content.
   *
   * There is NO non-reporting use left. There was one — evaluation order — and the comment here
   * called it "a fairness heuristic [that] cannot decide anything", which was false: only one
   * variation of a flag can be releasing at a time, so whichever manifest is evaluated first takes
   * the flag's action slot and thereby decides what production serves. A test says so in as many
   * words ("orders the DISCOVERED list, so v2 releases and v1 defers"). That is why the pass now
   * orders on the target read from the manifest at the current sha instead of on this field: a
   * human retargeting an entry from v1 to v2 would otherwise still be ranked as v1 and lose the
   * slot to a sibling.
   */
  targetVariation?: string;
  /** The sha whose deploy first produced a non-final outcome. */
  firstSeenSha: string;
  /** The sha of the most recent evaluation. */
  lastSha: string;
  /** The most recent action that left work outstanding — see `PENDING_ACTIONS`. */
  lastAction: string;
  lastDetail?: string;
  /** How many times this flag has been evaluated, including the first. */
  attempts: number;
  /**
   * LAST KNOWN answer to "did the previous evaluation refuse to act unattended?" — currently only
   * a release LaunchDarkly reverted or stopped monitoring. REPORTING ONLY, exactly like `flagKey`
   * and `targetVariation` above.
   *
   * It used to be CONTROL FLOW: `reEvaluate` short-circuited on it before re-reading the manifest,
   * and the check was not sha-gated, so nothing in the code could ever clear it — a hand-edit of
   * this file was the only way out. Now the refusal is recomputed from the flag's release history
   * on every re-evaluation (server.ts, `terminalHistoryRefusal`), so the report is the same while
   * a human is still needed and stops by itself when one is not.
   */
  needsHuman?: boolean;
}

export interface PendingStore {
  /** Entries awaiting re-evaluation for one service+environment. */
  list(service: string, environment: string): PendingEntry[];
  upsert(entry: PendingEntry): void;
  clear(service: string, environment: string, sourceFile: string): void;
}

const key = (service: string, environment: string, sourceFile: string): string =>
  `${service}@${environment}#${sourceFile}`;

export class MemoryPendingStore implements PendingStore {
  protected entries = new Map<string, PendingEntry>();

  list(service: string, environment: string): PendingEntry[] {
    return [...this.entries.values()].filter((e) => e.service === service && e.environment === environment);
  }

  upsert(entry: PendingEntry): void {
    this.entries.set(key(entry.service, entry.environment, entry.sourceFile), entry);
    this.persist();
  }

  clear(service: string, environment: string, sourceFile: string): void {
    if (this.entries.delete(key(service, environment, sourceFile))) this.persist();
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
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        version?: number;
        entries?: Record<string, PendingEntry>;
      };
      // Refuse an unrecognised version rather than guess at the keying. A file written under
      // a different scheme would otherwise load with keys that never match a lookup, so
      // entries would be re-created alongside their stale twins and never clear.
      if (raw.version !== PENDING_LEDGER_VERSION) {
        throw new Error(
          `pending-release ledger '${this.file}' is version ${String(raw.version)}, this build expects ` +
            `${PENDING_LEDGER_VERSION}. Delete the file to start fresh. The flags it tracked then need a ` +
            `re-POST with an EXPLICIT previousSha (a bare one finds nothing — the manifests exist at both ` +
            `ends), or will be picked up the next time their manifest changes.`,
        );
      }
      // DERIVE the keys, never trust the stored ones. `list()` filters on fields while
      // `clear()` deletes by derived key, so an entry whose stored key disagreed with its
      // fields was immortal: returned and re-evaluated forever, re-created as a twin on every
      // upsert, and never deletable. That is the same silent-stale-twin failure the version
      // gate above exists to prevent, reachable inside a valid file — and hand-editing this
      // file is something the messages here actually invite.
      this.entries = new Map(
        Object.values(raw.entries ?? {}).map((e) => [key(e.service, e.environment, e.sourceFile), e]),
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") {
        throw new Error(
          `pending-release ledger '${this.file}' exists but could not be read — refusing to start ` +
            `without it, because unfinished releases would then strand with nothing tracking them. ` +
            `Fix or delete the file. Deleting it forgets in-flight work, and recovering that needs a ` +
            `re-POST with an EXPLICIT previousSha — a bare re-POST re-diffs from the recorded sha and ` +
            `finds nothing, because these manifests exist at both ends (which is why this ledger ` +
            `exists). Cause: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.loaded = true;
  }

  protected override persist(): void {
    if (!this.loaded) return; // constructor-time population is not a write
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: PENDING_LEDGER_VERSION, entries: Object.fromEntries(this.entries) }, null, 2),
    );
    renameSync(tmp, this.file);
  }
}

/**
 * Actions after which THIS MANIFEST'S work is still outstanding, so the ledger keeps the entry
 * and re-checks it on a later deploy.
 *
 * DELIBERATELY NOT the same list as notifyReport's `NON_FINAL_ACTIONS`, which they used to be
 * pinned to each other — the two lists answer two different questions:
 *
 *   this list          — "should the ledger keep re-checking this manifest?"
 *   NON_FINAL_ACTIONS  — "must a human do something?"
 *
 * `already_running` is the case that separates them, and conflating them lost work: only one
 * variation of a flag can be releasing at a time, so a manifest asking for v2 can hit an
 * `already_running` for the release of v1. That is not this manifest's work finishing. It used
 * to be FINAL, which cleared the entry and reported the discarded v2 release as a success. It is
 * still not ATTENTION-WORTHY — a redelivery during a normal rollout is the expected shape — so
 * it stays out of the notifier's set.
 */
export const PENDING_ACTIONS: readonly string[] = ["held", "waiting", "error", "already_running"];

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
    /** Reporting metadata, like `flagKey`. Written as last read; never consulted as a fact. */
    targetVariation?: string;
    sourceFile: string;
    action: string;
    detail?: string;
    needsHuman?: boolean;
  },
): void {
  if (!PENDING_ACTIONS.includes(o.action)) {
    store.clear(o.service, o.environment, o.sourceFile);
    return;
  }
  const existing = store.list(o.service, o.environment).find((e) => e.sourceFile === o.sourceFile);
  store.upsert({
    service: o.service,
    environment: o.environment,
    flagKey: o.flagKey,
    // Written as most recently READ, not merged with what was remembered: a manifest that drops
    // its `targetVariation` now means "the tip", and carrying the old value forward would report
    // a target the manifest no longer asks for.
    ...(o.targetVariation !== undefined ? { targetVariation: o.targetVariation } : {}),
    sourceFile: o.sourceFile,
    firstSeenSha: existing?.firstSeenSha ?? o.sha,
    lastSha: o.sha,
    lastAction: o.action,
    ...(o.detail !== undefined ? { lastDetail: o.detail.slice(0, 500) } : {}),
    attempts: (existing?.attempts ?? 0) + 1,
    ...(o.needsHuman ? { needsHuman: true } : {}),
  });
}
