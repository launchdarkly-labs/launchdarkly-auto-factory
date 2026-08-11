/**
 * Beacon HTTP service. Deploy notifications arrive on a provider-agnostic
 * webhook contract (or via a provider adapter that translates into it); Beacon
 * resolves what changed, discovers newly-added release flags, routes by scope
 * (with fullstack coordination), triggers releases via the LaunchDarkly
 * release adapter, and monitors each release to completion.
 *
 * Endpoints:
 *   POST /flag-releases     — generic contract: {service, sha, previousSha?, environment?}
 *   POST /webhooks/railway  — Railway deploy webhook (translated, same handling)
 *   GET  /health
 *
 * Auth: every POST must present BEACON_WEBHOOK_SECRET, either in the
 * `x-beacon-secret` header or a `?secret=` query parameter (for providers like
 * Railway whose webhooks can't set custom headers).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AutomatedRelease,
  type DiscoveredFlag,
  type ReleaseFlagFile,
  LdClient,
  findActiveRelease,
  findLatestRelease,
  isReleaseFinished,
  targetConnection,
  variationLineageIndex,
} from "@auto-factory/shared";
import express, { type Express, type Request, type Response } from "express";
import { type BeaconConfig, loadBeaconConfig } from "./config.js";
import { discoverNewReleaseFlags } from "./discovery.js";
import { otherSideHasFile } from "./fullstack.js";
import { GitHubClient } from "./github.js";
import { dedupeMonitors, monitorSettingsFromEnv, monitorTriggeredRelease } from "./monitor.js";
import { repointDependentPrerequisites } from "./repoint.js";
import { FilePendingStore, recordOutcome, type PendingEntry, type PendingStore } from "./pending.js";
import { parseRailwayWebhook } from "./railway.js";
import { decideScope } from "./scope.js";
import { FileDeployStateStore, resolvePreviousSha, type DeployStateStore } from "./state.js";
import { triggerRelease, type TriggerResult } from "./trigger.js";

interface FlagOutcome {
  flag: string;
  /**
   * The manifest this outcome is about. THE LEDGER'S IDENTITY, carried on the outcome so the
   * fold-back needs no side lookup — an earlier revision used a flagKey→sourceFile map with a
   * `?? ""` fallback, and an empty path made the next re-read fetch nothing, get null, and
   * silently clear the entry.
   */
  sourceFile: string;
  /**
   * The variation this manifest asked for, as read on THIS evaluation (absent = "the lineage
   * tip"). REPORTING METADATA, documented at `PendingEntry.targetVariation`: it is what makes one
   * flag's several manifests distinguishable in a log, and it is never read back as a fact —
   * served-vs-target is recomputed from LaunchDarkly inside `triggerRelease` every time.
   */
  targetVariation?: string;
  scope: string;
  action: "released" | "held" | "noop" | "already_running" | "skipped" | "waiting" | "error";
  detail?: unknown;
  /** True when this outcome came from the re-evaluation ledger, not from discovery. */
  viaLedger?: boolean;
  /**
   * True when this evaluation refused to act unattended (the flag's newest release is terminal and
   * not `completed`). A CONCLUSION recomputed from LaunchDarkly on every evaluation — see
   * `terminalHistoryRefusal` — never a remembered flag that gates anything.
   */
  needsHuman?: boolean;
}

interface DeployNotification {
  service: string;
  sha: string;
  previousSha?: string;
  environment: string;
}

export interface BeaconDeps {
  store?: DeployStateStore;
  gh?: GitHubClient;
  /** The re-evaluation ledger (unfinished releases). Injectable for tests. */
  pending?: PendingStore;
  /** Hook fired when a release is started (or found already running); the
   *  default monitors it to a terminal state. Injectable for tests. */
  onReleaseStarted?: (flagKey: string, environmentKey: string) => void | Promise<unknown>;
}

/**
 * Reporting metadata, spread into an outcome or a ledger write. Omitted when absent, because
 * absent MEANS something specific — "the lineage tip" (trigger.ts: `flag.targetVariation ??
 * latestVariationValue(...)`) — and a literal `undefined` in the ledger file would read as a
 * missing value instead.
 */
const targetOf = (t: string | undefined): { targetVariation?: string } =>
  t === undefined ? {} : { targetVariation: t };

/**
 * Where a manifest's target sits in the vN lineage, for ORDERING ONLY.
 *
 * Highest first, because for one flag the newest manifest is the one furthest forward, and it is
 * the one the lineage guard would bless — evaluate an older one first and it takes the single
 * per-flag action slot, deferring the release that should have happened. Map insertion order
 * ("oldest wins") was exactly backwards.
 *
 * ABSENT is the TIP, not the bottom: trigger.ts resolves a missing `targetVariation` to the
 * lineage tip, so ranking it lowest would invert the whole fix. A target that is not in the
 * lineage at all (`control`, a hand-named variation) ranks below every vN — it cannot be a
 * forward move from a lineage-served flag, and `trigger.ts` refuses it anyway.
 */
const TIP_RANK = Number.MAX_SAFE_INTEGER;
const targetRank = (targetVariation: string | undefined): number =>
  targetVariation === undefined ? TIP_RANK : (variationLineageIndex(targetVariation) ?? -1);

/**
 * Highest target variation first. STABLE (Array.prototype.sort is, per spec), so manifests with
 * equal rank keep the order they arrived in — discovery's filename order, or the ledger's.
 */
function highestTargetFirst<T>(items: T[], target: (item: T) => string | undefined): T[] {
  return [...items].sort((a, b) => targetRank(target(b)) - targetRank(target(a)));
}

/**
 * Methods that WROTE to LaunchDarkly. Only these — plus a trigger that THREW, see the catch in
 * `evaluateManifest` — may claim the per-flag action slot.
 *
 * A SWITCH over `TriggerResult["method"]` rather than a string disjunction, so a future
 * `ReleaseKind` fails to compile here instead of being silently classified as a non-write. Silence
 * is the destructive direction: an unclassified write leaves the flag's slot open and a sibling
 * manifest then releases a different variation of a flag we just patched. The old disjunction could
 * lose `"prerequisites"` or `"immediate"` without failing a single test.
 */
function performedAWrite(method: TriggerResult["method"]): boolean {
  switch (method) {
    case "progressive":
    case "guarded":
    case "immediate":
    case "prerequisites":
      return true;
    case "held":
    case "noop":
      return false;
    default: {
      // Unreachable while the union is exhaustive; adding a member breaks this assignment. If it
      // ever runs, it throws inside `evaluateManifest`'s try — which claims the slot and reports
      // `error`, i.e. fails closed rather than guessing "did not write".
      const unclassified: never = method;
      throw new Error(`unclassified release method '${String(unclassified)}' — refusing to guess whether it wrote`);
    }
  }
}

/**
 * MAY THIS MANIFEST BE RE-TRIGGERED, given the flag's terminal release history? Null = no
 * objection; otherwise the refusal, with the detail to report.
 *
 * ONE answer, asked from the two write paths that can arrive after a release already ended: a
 * repeat evaluation of an already-processed sha, and a ledger re-evaluation. They were two copies
 * with identical conditions and divergent detail strings — the last place a flag-level answer was
 * given to a manifest-level question in two voices.
 *
 * `findActiveRelease` excludes TERMINAL statuses, so it answers "nothing running" for a release
 * LaunchDarkly already REVERTED; and a revert restores the ORIGINAL variation, so served != target
 * and the noop guard does not fire either. Without this, either path starts a second rollout of the
 * variation a guardrail just rolled back.
 *
 * DELIBERATELY FLAG-LEVEL AND CONSERVATIVE, and this is policy, not an oversight: a guardrail
 * rejecting v1 also blocks a manifest wanting v2, which is arguably wrong but errs in the blocking
 * direction. `completed` is excluded because it is not an objection to anything — what a completed
 * release means for THIS manifest is decided by served-vs-target inside `triggerRelease`.
 */
function terminalHistoryRefusal(
  latest: AutomatedRelease | null,
  /** Why we were about to act — the caller's context, prefixed onto the shared explanation. */
  why: string,
): { status: string; detail: string } | null {
  if (!latest || !isReleaseFinished(latest.status) || latest.status === "completed") return null;
  return {
    status: latest.status,
    detail:
      `${why} and the newest release ${latest.id} is '${latest.status}' — NOT re-triggered, because ` +
      `re-releasing would undo a guardrail's rollback. NEEDS A HUMAN: deploy the fix as a new commit, ` +
      `which starts a fresh release`,
  };
}

/** Constant-time secret comparison (hashed first to equalize lengths). */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function presentedSecret(req: Request): string | undefined {
  const fromQuery = req.query.secret;
  return req.header("x-beacon-secret") ?? (typeof fromQuery === "string" ? fromQuery : undefined);
}

export function createApp(cfg: BeaconConfig, ld: LdClient, deps: BeaconDeps = {}): Express {
  const app = express();
  app.use(express.json());
  const gh = deps.gh ?? new GitHubClient(cfg.githubToken);
  const store = deps.store ?? new FileDeployStateStore(cfg.stateFile);
  const pending = deps.pending ?? new FilePendingStore(cfg.pendingFile);
  const monitorSettings = monitorSettingsFromEnv();
  // Detached on purpose: a guarded release runs for minutes-to-days; the notification
  // response must not wait on it.
  const attachMonitor =
    deps.onReleaseStarted ??
    (async (flagKey: string, environmentKey: string): Promise<void> => {
      if (!monitorSettings.enabled) return;
      await monitorTriggeredRelease(ld, flagKey, environmentKey, monitorSettings);
    });
  // Dedup wraps the attach function UNCONDITIONALLY, including an injected one. "One watch
  // per flag/environment in flight" is a property Beacon wants whoever does the watching —
  // a redelivered `already_running` must not stack a second 24h poll loop onto a release
  // that already has one. And when the dedup lived only in the `??` default branch, every
  // test injected straight past it, so the property was unverifiable by construction.
  const onReleaseStarted = dedupeMonitors(async (flagKey: string, environmentKey: string) =>
    attachMonitor(flagKey, environmentKey),
  );

  async function handleDeploy(n: DeployNotification): Promise<{ status: number; body: unknown }> {
    // Every notification leaves a trace: silent successes are indistinguishable
    // from lost deliveries when debugging a release that never started.
    console.log(`[beacon] deploy notification: service=${n.service} sha=${n.sha} env=${n.environment}`);
    const service = cfg.services[n.service];
    if (!service) {
      console.warn(`[beacon] unknown service '${n.service}' (registry: ${Object.keys(cfg.services).join(", ")})`);
      return { status: 400, body: { error: `unknown service '${n.service}'` } };
    }

    const { previousSha, source: previousShaSource } = resolvePreviousSha(
      store,
      n.service,
      n.environment,
      n.sha,
      n.previousSha,
    );

    // Read BEFORE store.record below overwrites it: is this a sha we already processed?
    //
    // It is the discriminator for the guard in processFlag. A NEW sha carries a new intent —
    // a dev who fixed a regression and deployed again legitimately wants a fresh release —
    // whereas a repeat evaluation of a sha we have already handled carries none. We cannot
    // get this from LaunchDarkly: `AutomatedRelease` has no target-variation field, so
    // "re-release of the same thing" and "release of the fix" are indistinguishable there.
    const shaAlreadyProcessed = store.get(n.service, n.environment).last === n.sha;

    let discovered;
    try {
      discovered = await discoverNewReleaseFlags(gh, service.repo, cfg.releaseFlagsDir, n.sha, previousSha);
    } catch (e) {
      // Don't record the SHA: the next notification should retry this diff.
      console.warn(`[beacon] discovery failed for ${n.service}@${n.sha}: ${String(e)}`);
      return { status: 502, body: { error: "discovery failed", detail: String(e) } };
    }
    console.log(
      `[beacon] discovery: ${discovered.length} new release flag(s) in ${n.sha}` +
        ` (previousSha=${previousSha ?? "none"} from ${previousShaSource})` +
        (discovered.length ? ` → ${discovered.map((f) => f.flagKey).join(", ")}` : ""),
    );
    store.record(n.service, n.environment, n.sha);

    const outcomes: FlagOutcome[] = [];
    // Set ONLY when the idempotency check could not be verified: the one case where we
    // know nothing was started, so answering 503 cannot cause a duplicate release.
    //
    // READ THIS BEFORE RELYING ON THE 503. It is a REFUSAL, not a retry. Nothing in the
    // shipped configuration redelivers it:
    //
    //  - the Notifier (`auto-factory-notify`, notify.ts) is non-blocking BY CONTRACT so it
    //    can never fail a deploy: a non-2xx becomes one `console.warn` and `exit 0`. No
    //    retry, and the status reaches no operator.
    //  - Railway's own webhooks document no retry policy, backoff, or delivery guarantee
    //    (docs.railway.com/observability/webhooks), so that path must not be relied on
    //    either.
    //
    // The 503 is still correct — it refuses to guess "no active release" and write, which
    // is what caused a double-start — and it works for any CD system that does retry, which
    // the provider-agnostic /flag-releases contract invites. But recovery today is a HUMAN
    // re-POST, and the re-evaluation ledger (docs/loop-seam.md) is the only thing that would
    // make it automatic.
    //
    // Deliberately NOT set by the other two unfinished outcomes — an incomplete fullstack
    // readiness check, and a trigger that threw. Both were briefly made retriable and then
    // REVERTED, because "redelivery is safe by construction, a landed patch comes back as
    // `already_running`" is false once a release reaches a terminal state:
    // `findActiveRelease` excludes TERMINAL (`completed`/`reverted`/`monitoring_stopped`),
    // so after LaunchDarkly REVERTS a guarded release on a metric regression, a redelivery
    // finds no active release, the noop guard sees served(original) != target, and
    // `triggerRelease` starts a SECOND release of the variation the guardrail just rolled
    // back — the outcome state.ts calls out as destructive. Provider backoff routinely
    // outlasts a short revert, so this is not a narrow race.
    //
    // Until the re-evaluation ledger exists (docs/loop-seam.md), an unfinished release
    // STRANDS with a 200 and a log that asks for a re-POST. A stranded release is
    // recoverable by a human; re-releasing a reverted flag is not.
    let guardUnverifiable = false;
    /**
     * Flags this notification has WRITTEN to LaunchDarkly for.
     *
     * The ledger is keyed by manifest ADDRESS, which is right for remembering work — but the
     * TARGET of an action is `(flagKey, environment)`, because only one variation of a flag can
     * be releasing at a time. Keying the memory correctly and leaving the action unguarded let
     * two manifests naming one flag both reach `triggerRelease` in a single notification: the
     * releases listing is eventually consistent right after a start (see monitor.ts, which
     * retries five times for exactly that), so the second could miss the first and start a
     * SECOND release on the same flag.
     *
     * The second manifest is deferred with a NON-FINAL outcome, deliberately. Reporting
     * `already_running` would be final, and a final outcome clears the ledger entry — which
     * discarded the newer manifest's unreleased work and reported it as success.
     *
     * ONLY A WRITE CLAIMS THE SLOT, and that is the whole point of the set. It used to be
     * claimed before `triggerRelease` was even called, so a manifest that wrote NOTHING — `held`
     * on a future `notBefore`, `noop` because a newer variation superseded it — still consumed
     * the flag's only slot and deferred every other manifest for that flag. In the documented
     * steady state (several never-deleted manifests per flag, the ledger keeping the unreleased
     * ones alive) that deadlocked: the same non-writing manifest claimed the slot on every
     * deploy, forever, and the releasable one was deferred forever. Zero releases, reported as
     * two ordinary outcomes.
     *
     * `already_running` deliberately does NOT claim it either: it wrote nothing, and a second
     * manifest's own idempotency read sees the very same active release, which is the correct
     * answer for it too.
     *
     * AND A WRITE WHOSE OUTCOME IS UNKNOWN CLAIMS IT TOO. There are three states — wrote, did
     * not write, don't know — and a trigger that THREW is the third: the patch may have landed
     * and the response been lost. See the catch at the end of `evaluateManifest`.
     */
    const actedOnFlag = new Set<string>();

    /**
     * Evaluate ONE manifest, returning its outcome rather than pushing it.
     *
     * Returning is what lets the ledger below re-run the IDENTICAL logic instead of a
     * second copy that drifts — the scope decision, the readiness check, the idempotency
     * guard and the trigger are subtle enough that two copies would disagree within a
     * release or two.
     */
    const evaluateManifest = async (flag: DiscoveredFlag): Promise<FlagOutcome> => {
      const scope = flag.scope ?? "frontend";
      const decision = decideScope(scope, service.side);

      if (decision === "skip") {
        return { flag: flag.flagKey, sourceFile: flag.sourceFile, scope, action: "skipped", detail: "other side handles this scope" };
      }
      if (decision === "check_fullstack") {
        // TRI-STATE (see fullstack.ts). The classifier is kept for the DIAGNOSIS, which
        // is where the original defect actually did its damage: `absent` is a real
        // verdict — the other side's own deploy notification is the retry — while
        // `unknown` (status endpoint down, GitHub rate limit) is not a verdict at all.
        // Collapsing them logged a rate-limit blip as "the other side hasn't deployed",
        // which sends an operator to inspect the wrong service.
        //
        // Both ACK. `unknown` deliberately does not answer retriably — see
        // guardUnverifiable above for why redelivery is not currently safe — so it
        // reports `error` rather than `waiting`: `waiting` is a normal, expected,
        // non-actionable state during bootstrap, and an unverifiable check is none of
        // those. It needs a human, and the log says exactly which human action.
        const readiness = await otherSideHasFile(cfg, gh, service.side, flag.sourceFile);
        if (readiness.state === "unknown") {
          console.warn(
            `[beacon] fullstack readiness UNVERIFIED for '${flag.flagKey}' (file=${flag.sourceFile}) — this is ` +
              `NOT a verdict on whether the other side deployed. The release was NOT started, and nothing ` +
              `will retry it automatically: re-POST /flag-releases for this service once both sides are ` +
              `deployed. Cause: ${readiness.reason}`,
          );
          return {
            flag: flag.flagKey,
            sourceFile: flag.sourceFile,
            scope,
            action: "error",
            detail: `fullstack readiness could not be VERIFIED (not a verdict on the other side) — release not started; the ledger will re-check on a later deploy, or re-POST to retry now: ${readiness.reason}`,
          };
        }
        if (readiness.state === "absent") {
          // The other side's own deploy notification normally releases this; the ledger
          // now also re-checks it on ANY later deploy, so a lost notification is no longer
          // permanent. A re-POST still works and is faster.
          console.warn(
            `[beacon] WAITING: flag '${flag.flagKey}' (scope=${scope}, file=${flag.sourceFile}) — ` +
              `service '${n.service}' deployed at ${n.sha} but the other side hasn't yet. ` +
              `If its notification never arrives, re-POST /flag-releases for this service once both are deployed.`,
          );
          return { flag: flag.flagKey, sourceFile: flag.sourceFile, scope, action: "waiting", detail: "other service not deployed yet" };
        }
      }
      try {
        if (actedOnFlag.has(flag.flagKey)) {
          // Another manifest for this flag already WROTE this round. Defer rather than
          // discard: the ledger keeps this entry and the next deploy re-evaluates it, by
          // which time the lineage guard can see what actually got served.
          console.warn(
            `[beacon] DEFERRED: '${flag.sourceFile}' also targets '${flag.flagKey}', which another manifest ` +
              `already released in this notification. Left pending for the next deploy.`,
          );
          return {
            flag: flag.flagKey,
            sourceFile: flag.sourceFile,
            scope,
            action: "held",
            detail: `deferred — another manifest released '${flag.flagKey}' in this notification; still pending`,
          };
        }
        // Idempotency: a re-delivered notification must not double-trigger.
        //
        // FAIL CLOSED. This was `.catch(() => null)`, which answered the question "does
        // this flag already have an active release?" with "no" whenever the read failed —
        // and then performed a write. That is the destructive branch: the read fails
        // precisely during rate limiting and outages, which is exactly when providers
        // redeliver. Skipping and asking for a redelivery risks a delayed release; guessing
        // "none" risks a SECOND concurrent release on a live flag, and (via a `noop`
        // result) repointing child flags to a variation the running release may still
        // revert.
        let active: AutomatedRelease | null;
        try {
          active = await findActiveRelease(ld, flag.flagKey, n.environment);
        } catch (e) {
          guardUnverifiable = true;
          console.warn(
            `[beacon] idempotency check failed for '${flag.flagKey}' — release NOT started. Answering 503, but ` +
              `NOTHING RETRIES THAT AUTOMATICALLY (the Notifier logs and exits 0; Railway documents no retry): ` +
              `re-POST /flag-releases for this service to retry. Cause: ${String(e)}`,
          );
          return {
            flag: flag.flagKey,
            sourceFile: flag.sourceFile,
            scope,
            action: "error",
            detail: `idempotency check failed — release NOT started (answered 503; the ledger will re-check on a later deploy, or re-POST to retry now): ${String(e)}`,
          };
        }
        if (active) {
          onReleaseStarted(flag.flagKey, n.environment); // re-attach monitoring (e.g. after a Beacon restart)
          return { flag: flag.flagKey, sourceFile: flag.sourceFile, scope, action: "already_running", detail: { releaseId: active.id } };
        }
        // A REPEAT evaluation of an already-processed sha must not re-release a flag whose
        // release LaunchDarkly already reverted. `findActiveRelease` above excludes terminal
        // statuses, so it answers "nothing running" for a reverted release, and the noop
        // guard does not fire either — a revert restores the ORIGINAL variation, so
        // served != target and the trigger proceeds. That undoes a guardrail's rollback.
        //
        // Gated on `shaAlreadyProcessed` deliberately: on a new sha this same check would
        // block the legitimate fix-and-redeploy, which is the normal way out of a revert.
        if (shaAlreadyProcessed) {
          let latest: AutomatedRelease | null;
          try {
            latest = await findLatestRelease(ld, flag.flagKey, n.environment);
          } catch (e) {
            guardUnverifiable = true;
            return {
              flag: flag.flagKey,
              sourceFile: flag.sourceFile,
              scope,
              action: "error",
              detail: `re-evaluating an already-processed sha and the release history could not be read — NOT re-triggering: ${String(e)}`,
            };
          }
          const refusal = terminalHistoryRefusal(latest, `this sha (${n.sha}) was already processed`);
          if (refusal) {
            console.warn(`[beacon] NOT re-releasing '${flag.flagKey}': ${refusal.detail}`);
            return {
              flag: flag.flagKey,
              sourceFile: flag.sourceFile,
              scope,
              action: "error",
              needsHuman: true,
              detail: refusal.detail,
            };
          }
        }
        const result = await triggerRelease(ld, flag, n.environment);
        // THE SLOT IS CLAIMED HERE, not before the trigger — see `actedOnFlag`. A `held` or
        // `noop` return wrote nothing, so it must leave the flag available to the manifest that
        // can actually release it, in this same notification.
        if (performedAWrite(result.method)) actedOnFlag.add(flag.flagKey);
        // Only staged rollouts get release monitoring: "held"/"noop" started
        // nothing, "prerequisites"/"immediate" have no automated release to watch.
        if (result.method === "progressive" || result.method === "guarded") {
          onReleaseStarted(flag.flagKey, n.environment);
        }
        // An immediate release moves the fallthrough right here — re-point any
        // auto-factory children pinned on the previous variation (staged
        // releases do this when monitoring sees them complete).
        //
        // `noop` means the environment ALREADY serves the target variation — which is what
        // a release completing outside our watch looks like (paused on a regression,
        // resumed by a human, finished after monitoring stopped). Repointing here is the
        // only moment that external completion is visible to Beacon.
        //
        // No longer partial in the way it was: discovery is a manifest DIFF, so a flag whose
        // manifest exists at both SHAs is never rediscovered — but the ledger below now
        // re-checks unfinished flags independently of discovery, which is what reaches an
        // externally-completed release. Idempotent: already-pointed children are skipped.
        if (result.method === "immediate" || result.method === "noop") {
          await repointDependentPrerequisites(ld, flag.flagKey, n.environment);
        }
        return {
          flag: flag.flagKey,
          sourceFile: flag.sourceFile,
          scope,
          action: result.method === "held" ? "held" : result.method === "noop" ? "noop" : "released",
          detail: result,
        };
      } catch (e) {
        // THREE STATES, NOT TWO: this manifest WROTE, it did NOT write, or WE DO NOT KNOW.
        // This is "we do not know", and it belongs with "wrote" — not, as it used to, with
        // "did not write" (the claim above runs only on the success return).
        //
        // `triggerRelease` → `startRelease` → `await fetch` → `await res.text()`: a lost
        // response, a proxy 5xx or a truncated body throws AFTER LaunchDarkly applied the
        // patch. Leaving the slot open then lets a SIBLING manifest for the same flag release
        // a variation BEHIND the one that may now be live, and neither lineage guard can stop
        // it — mid-rollout `servedVariation` still answers `control`, so `servedIndex` is
        // undefined and both backwards guards fall through. Claiming the slot defers the
        // sibling NON-FINALLY (it stays in the ledger and is re-evaluated on the next deploy,
        // by which time the releases listing shows what actually happened), so the cost of
        // being wrong here is a delay; the cost of the other direction is a rollout backwards.
        actedOnFlag.add(flag.flagKey);
        // ACKS 200, and this STRANDS the flag. Deliberate, and the reverse of the guard
        // above — the asymmetry is the point.
        //
        // A 503 here was tried and reverted. The argument for it was "retrying is safe by
        // construction: a patch that landed comes back as `already_running`". That is only
        // true while the release is RUNNING. The dangerous case is precisely the one a
        // provider's backoff produces: the trigger patch landed, the response was lost, the
        // guarded release ran, a metric regressed, LaunchDarkly REVERTED it. `reverted` is
        // terminal, so a redelivery's idempotency check finds nothing active and starts a
        // second release of the variation the guardrail just rolled back.
        //
        // Stranding is the lesser failure: a human re-POST recovers it, and the log below
        // asks for one. Undoing a guardrail's rollback unattended does not recover.
        console.warn(
          `[beacon] release trigger ERROR for '${flag.flagKey}' — release NOT started. The ledger will re-check ` +
            `it on a later deploy; re-POST /flag-releases to retry now: ${String(e)}`,
        );
        return {
          flag: flag.flagKey,
          sourceFile: flag.sourceFile,
          scope,
          action: "error",
          detail: `release trigger failed — not started; ledger will re-check on a later deploy, or re-POST to retry now: ${String(e)}`,
        };
      }
    };

    /**
     * `evaluateManifest`, plus the manifest's target variation stamped onto whatever it returned.
     *
     * One place rather than ten return sites, and REPORTING ONLY — nothing downstream reads it
     * back as a fact (see `FlagOutcome.targetVariation`).
     */
    const processFlag = async (flag: DiscoveredFlag): Promise<FlagOutcome> => ({
      ...(await evaluateManifest(flag)),
      ...targetOf(flag.targetVariation),
    });

    /** How a ledger entry is named in a log: the manifest, then what it last knew about itself. */
    const ledgerTag = (entry: PendingEntry): string =>
      `${entry.sourceFile} (last named ${entry.flagKey}, pending since ${entry.firstSeenSha.slice(0, 8)}, attempt ${entry.attempts + 1})`;

    /**
     * Re-evaluate one LEDGER entry: a manifest whose release was left unfinished by an earlier
     * deploy. Discovery cannot surface it (its file exists at both SHAs), so this is the only path
     * that reaches it. `parsed` is that manifest AS IT READS NOW, at this notification's sha — read
     * by the pass below, which needs the fresh target to order the entries.
     *
     * NOTE WHAT IS NOT HERE: a `entry.needsHuman` short-circuit. It used to be the first thing this
     * function did, which made the field a LATCH rather than a conclusion — it preceded the manifest
     * re-read and was not sha-gated, so nothing on any code path could clear it and the entry
     * reported `ACTION REQUIRED` on every deploy until someone hand-edited the ledger file.
     *
     * That became reachable for manifests that WROTE NOTHING once `already_running` stopped being
     * final: `config/services.yaml` puts four `side: backend` services on one repo, so one merge
     * produces four notifications that discover the same manifest — one releases, three answer
     * `already_running` and are kept, and one revert then stamps `needsHuman` on all three.
     *
     * So the entry takes the normal path and concludes `needsHuman` AGAIN if the flag is still
     * terminal-not-completed. Same report, DERIVED FROM CURRENT STATE, so it clears by itself when
     * a human completes the release, starts a new one, or the flag moves on. The stored field stays
     * reporting metadata (last known) and is never control flow again.
     */
    const reEvaluate = async (entry: PendingEntry, parsed: ReleaseFlagFile): Promise<FlagOutcome> => {
      const tag = ledgerTag(entry);

      // THE GUARD THAT MAKES THIS SAFE TO AUTOMATE. Re-evaluation is a write path, and
      // `findActiveRelease` (inside processFlag) excludes TERMINAL statuses — so on its own it
      // would answer "nothing running" for a release LaunchDarkly already REVERTED, and
      // triggerRelease would start a second rollout of the variation the guardrail just rolled
      // back. Manual re-POST had the same hazard; the ledger would have made it automatic.
      //
      // IT MUST GUARD THE FLAG WE ARE ABOUT TO ACT ON, which is the one the manifest names
      // NOW — `parsed.flagKey`, not `entry.flagKey`. An earlier revision used the remembered
      // key, so a human correcting a wrong flagKey (exactly the fix an `error` entry invites)
      // had the guard inspect the old flag while the trigger fired on the new one. Keying the
      // ledger on the manifest's address rather than its content is what makes these the same
      // value in the normal case and makes the difference visible in the abnormal one.
      const actingOn = parsed.flagKey;
      if (actingOn !== entry.flagKey) {
        console.log(
          `[beacon] ledger: ${entry.sourceFile} now names '${actingOn}' (was '${entry.flagKey}') — ` +
            `guarding and acting on the CURRENT flag`,
        );
      }
      let latest: AutomatedRelease | null;
      try {
        latest = await findLatestRelease(ld, actingOn, n.environment);
      } catch (e) {
        // Fail closed: no terminal history means no permission to trigger. Reports `actingOn`,
        // not the remembered key — otherwise the fold-back writes the stale name back and
        // freezes it there.
        return {
          flag: actingOn,
          sourceFile: entry.sourceFile,
          ...targetOf(parsed.targetVariation),
          scope: "ledger",
          action: "error",
          viaLedger: true,
          detail: `could not read release history — NOT re-triggering, still pending: ${String(e)}`,
        };
      }
      // ONLY the non-completed terminal statuses gate re-evaluation here, and the asymmetry is
      // the point: this question is asked about a FLAG, while the ledger remembers a MANIFEST,
      // and one flag routinely has several manifests wanting different variations.
      //
      // A `completed` branch used to live here, treating "some release of this flag finished" as
      // "this entry's work is done" — returning a final `noop` that cleared the entry. So a
      // manifest asking for v2 was discarded because v1's release completed, and reported as a
      // success. It is also REDUNDANT: `triggerRelease` answers the same question properly, per
      // manifest, from what the environment serves right now — served === target → `noop`
      // (final), target behind served → `noop` (final, superseded), target ahead → it releases,
      // which is the case the deleted branch got wrong. The useful side effect survives too:
      // a `noop` result repoints dependent prerequisites in `evaluateManifest` above, so a
      // release that finished unwatched still reaches its children.
      //
      // `reverted`/`monitoring_stopped` stays flag-level and stays conservative: a guardrail
      // rejecting one variation blocks re-triggering ANY manifest for that flag until a human
      // decides. Arguably too broad — v2 is different work from a reverted v1 — but the error is
      // in the blocking direction, which is the safe one.
      //
      // The deleted branch's SIDE EFFECT is kept, just below: what was wrong about it was the
      // VERDICT, not the repointing.
      const refusal = terminalHistoryRefusal(latest, `${entry.sourceFile} is still pending`);
      if (refusal) {
        console.warn(`[beacon] ledger: ${tag} — ${refusal.detail}`);
        return {
          flag: actingOn,
          sourceFile: entry.sourceFile,
          ...targetOf(parsed.targetVariation),
          scope: "ledger",
          action: "error",
          viaLedger: true,
          needsHuman: true,
          detail: refusal.detail,
        };
      }

      // AN UNWATCHED COMPLETION: REPOINT, AND DO NOT RETURN A VERDICT.
      //
      // The deleted `completed` branch answered "is this manifest done?" with a flag-level fact,
      // which was wrong and is not reinstated — `served`-vs-`target` inside `triggerRelease` is
      // still the only answer to that. But it also carried a side effect that IS flag-level and
      // was correct: a completed release moved the fallthrough forward, so any child flag
      // prerequisite'd on the previous variation is now dark, and repointing it is the whole
      // reason the ledger watches for unwatched completions. Because the branch ran BEFORE
      // `processFlag`, ANY entry for the flag triggered the repoint — including one held by its
      // own intent, which was therefore its own trigger.
      //
      // Without this, every path that returns before `triggerRelease` reaches its LD read loses
      // it: intent `hold`/`manual`, a future `notBefore`, `segments`, an unintelligible intent,
      // `waiting`, readiness `unknown`, the idempotency read failure, the `actedOnFlag` deferral,
      // and — being final, so it is the LAST chance ever — scope `skipped` and manifest-absent.
      // The reachable failure is the one the ledger exists for: Beacon restarts mid-rollout, no
      // deploy arrives before the release completes, and the flag's only pending manifest is an
      // iteration awaiting approval (the documented steady state). The child stays dark
      // indefinitely.
      //
      // Idempotent by contract (`repoint.ts` skips already-pointed children and never throws), so
      // the `noop`/`immediate` repoint inside `evaluateManifest` doing it again costs one read.
      if (latest?.status === "completed") {
        await repointDependentPrerequisites(ld, actingOn, n.environment);
      }

      console.log(`[beacon] ledger: re-evaluating ${tag}`);
      const outcome = await processFlag({ ...parsed, sourceFile: entry.sourceFile });
      return { ...outcome, viaLedger: true };
    };

    // HIGHEST TARGET VARIATION FIRST, in both passes — see `highestTargetFirst`. Only one
    // variation of a flag can be releasing at a time, so whichever manifest is evaluated first
    // decides what production gets; filename order and Map insertion order both mean "oldest
    // wins", which for a lineage is exactly backwards.
    for (const flag of highestTargetFirst(discovered, (f) => f.targetVariation)) {
      outcomes.push(await processFlag(flag));
    }

    // The ledger pass: unfinished work from EARLIER deploys, re-checked on this one. Skips
    // anything discovery already handled this round, so a flag is evaluated at most once.
    // Keyed on the manifest ADDRESS, matching the ledger. This was the last flagKey-keyed
    // identity comparison in Beacon, and it was wrong in both directions: an entry for
    // pr-41.json was skipped whenever a DIFFERENT manifest naming the same flag was
    // discovered (so its re-check silently stopped and its `lastSha` froze), while a genuine
    // same-manifest duplicate slipped through whenever the flagKey had been corrected.
    // Same-flag collisions are handled by `actedOnFlag` above, which is the right axis for it.
    const handledThisRound = new Set(discovered.map((f) => f.sourceFile));
    const candidates = pending.list(n.service, n.environment).filter((e) => !handledThisRound.has(e.sourceFile));

    // READ FIRST, ORDER SECOND, ACT THIRD.
    //
    // The ordering key has to be the target each manifest asks for NOW, because the order decides
    // which manifest takes the flag's single action slot — i.e. what production gets. Ordering on
    // the REMEMBERED target hands the slot to the wrong manifest whenever a human has edited one:
    // an entry moved from v1 to v3 still ranks as v1 and loses to a sibling's v2, so this deploy
    // releases v2 and v3 waits for the next one.
    //
    // Same number of GitHub reads as before, just moved ahead of the sort — and it leaves the stored
    // `targetVariation` with no job but reporting, which is what `pending.ts` documents it as.
    const acting: Array<{ entry: PendingEntry; parsed: ReleaseFlagFile }> = [];
    for (const entry of candidates) {
      // RE-READ THE MANIFEST AT THE CURRENT SHA. This is the property that makes a human's fix take
      // effect — editing a bad `releaseIntent` used to be a no-op, because the file existed at both
      // SHAs and discovery never looked at it again.
      let parsed: ReleaseFlagFile | null;
      try {
        parsed = await gh.getFileJson<ReleaseFlagFile>(service.repo, entry.sourceFile, n.sha);
      } catch (e) {
        // KEPT, REPORTED, AND LEFT OUT OF THE ORDERING: with no fresh manifest there is no current
        // target to rank it by, and ranking it on the stored one is the staleness this pass exists
        // to avoid. `error` is non-final, so the entry stays and the next deploy re-reads it.
        outcomes.push({
          flag: entry.flagKey,
          sourceFile: entry.sourceFile,
          ...targetOf(entry.targetVariation),
          scope: "ledger",
          action: "error",
          viaLedger: true,
          detail: `could not re-read ${entry.sourceFile} at ${n.sha} — still pending: ${String(e)}`,
        });
        continue;
      }
      if (!parsed?.flagKey) {
        // The manifest is gone (or is no longer a release manifest): the release was withdrawn, so
        // stop tracking it. `skipped` is final, so recordOutcome clears the entry.
        console.log(`[beacon] ledger: ${ledgerTag(entry)} — manifest absent at ${n.sha}, no longer pending`);
        outcomes.push({
          flag: entry.flagKey,
          sourceFile: entry.sourceFile,
          ...targetOf(entry.targetVariation),
          scope: "ledger",
          action: "skipped",
          viaLedger: true,
          detail: `manifest ${entry.sourceFile} is absent at ${n.sha} — release withdrawn, dropped from the ledger`,
        });
        continue;
      }
      acting.push({ entry, parsed });
    }
    const ordered = highestTargetFirst(acting, (a) => a.parsed.targetVariation);
    if (ordered.length > 0) {
      console.log(
        `[beacon] ledger: ${ordered.length} unfinished manifest(s) from earlier deploys → ` +
          // The MANIFEST, then the flag and variation it asks for AS READ NOW (so a human's edit
          // shows up here), then the action last recorded. Naming only the flag rendered four
          // manifests for one flag as four identical entries. Entries whose manifest could not be
          // read, or has been withdrawn, were answered above and are not in this list.
          ordered
            .map(
              ({ entry, parsed }) =>
                `${entry.sourceFile} [${parsed.flagKey}→${parsed.targetVariation ?? "tip"}]=${entry.lastAction}`,
            )
            .join(", "),
      );
    }
    for (const { entry, parsed } of ordered) {
      outcomes.push(await reEvaluate(entry, parsed));
    }

    // Fold every outcome back into the ledger: remember what is unfinished, forget what is
    // done. Runs for discovery outcomes too, so a flag that finally releases stops being
    // tracked — and one that has just become unfinished starts being.
    for (const o of outcomes) {
      recordOutcome(pending, {
        service: n.service,
        environment: n.environment,
        sha: n.sha,
        flagKey: o.flag,
        ...targetOf(o.targetVariation),
        sourceFile: o.sourceFile,
        action: o.action,
        ...(o.detail !== undefined ? { detail: typeof o.detail === "string" ? o.detail : JSON.stringify(o.detail) } : {}),
        ...(o.needsHuman ? { needsHuman: true } : {}),
      });
    }

    if (outcomes.length) {
      // Identified by MANIFEST, because the flag key is not unique: several manifests per flag is
      // the documented steady state, so `f=held, f=held` named neither the work nor which PR to
      // fix. The address is the identity everywhere else in Beacon; this line was the exception.
      console.log(
        `[beacon] outcomes: ${outcomes
          .map((o) => `${o.sourceFile} [${o.flag}→${o.targetVariation ?? "tip"}]=${o.action}`)
          .join(", ")}`,
      );
    }

    return {
      // 503 ONLY when an idempotency check could not be verified — the one case where
      // nothing was started, so a retry (whoever performs it) cannot duplicate a release.
      // It is an honest status, not a working retry: see guardUnverifiable above for why
      // nothing in the shipped configuration redelivers it. Every other unfinished outcome
      // acks 200 and strands, because a redelivery can re-release a flag LaunchDarkly
      // already reverted, which is worse than a strand a human can fix.
      status: guardUnverifiable ? 503 : 200,
      body: {
        service: n.service,
        environment: n.environment,
        sha: n.sha,
        previousSha: previousSha ?? null,
        previousShaSource,
        discovered: discovered.length,
        outcomes,
      },
    };
  }

  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // Generic, provider-agnostic deploy notification.
  app.post("/flag-releases", async (req: Request, res: Response) => {
    if (!secretMatches(presentedSecret(req), cfg.secret)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const body = req.body ?? {};
    const sha: string | undefined = body.sha;
    const service: string | undefined = body.service;
    if (!sha || !service) {
      return res.status(400).json({ error: "missing required fields: sha, service" });
    }
    const { status, body: out } = await handleDeploy({
      service,
      sha,
      previousSha: body.previousSha ?? body.previous_sha,
      environment: body.environment ?? cfg.ldEnvironmentKey,
    });
    return res.status(status).json(out);
  });

  // Railway adapter: translate Railway's deploy webhook into the same handling.
  app.post("/webhooks/railway", async (req: Request, res: Response) => {
    if (!secretMatches(presentedSecret(req), cfg.secret)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const parsed = parseRailwayWebhook(req.body);
    if (parsed.kind === "ignored") {
      return res.status(200).json({ ignored: true, reason: parsed.reason });
    }
    if (parsed.kind === "unrecognized") {
      // Log the full payload: deploy events aren't sensitive, and the exact
      // shape is what's needed to extend the parser for a new schema.
      console.warn(
        `[beacon] unrecognized Railway webhook: ${parsed.reason} — payload: ${JSON.stringify(req.body).slice(0, 2000)}`,
      );
      return res.status(422).json({ error: "unrecognized Railway payload", reason: parsed.reason });
    }
    // Railway environment names are Railway-side concepts; releases target the
    // configured LD environment. (Map per-environment here if that ever differs.)
    const { status, body: out } = await handleDeploy({
      service: parsed.service,
      sha: parsed.sha,
      environment: cfg.ldEnvironmentKey,
    });
    return res.status(status).json(out);
  });

  return app;
}

/** Entry point when run directly (e.g. in a container). */
function main(): void {
  const cfg = loadBeaconConfig();
  const ld = new LdClient(targetConnection());
  const app = createApp(cfg, ld);
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => console.log(`Beacon listening on :${port}`));
}

// Run when this module is the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
