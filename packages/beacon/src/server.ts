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
import { type AutomatedRelease, LdClient, findActiveRelease, targetConnection } from "@auto-factory/shared";
import express, { type Express, type Request, type Response } from "express";
import { type BeaconConfig, loadBeaconConfig } from "./config.js";
import { discoverNewReleaseFlags } from "./discovery.js";
import { otherSideHasFile } from "./fullstack.js";
import { GitHubClient } from "./github.js";
import { dedupeMonitors, monitorSettingsFromEnv, monitorTriggeredRelease } from "./monitor.js";
import { repointDependentPrerequisites } from "./repoint.js";
import { parseRailwayWebhook } from "./railway.js";
import { decideScope } from "./scope.js";
import { FileDeployStateStore, resolvePreviousSha, type DeployStateStore } from "./state.js";
import { triggerRelease } from "./trigger.js";

interface FlagOutcome {
  flag: string;
  scope: string;
  action: "released" | "held" | "noop" | "already_running" | "skipped" | "waiting" | "error";
  detail?: unknown;
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
  /** Hook fired when a release is started (or found already running); the
   *  default monitors it to a terminal state. Injectable for tests. */
  onReleaseStarted?: (flagKey: string, environmentKey: string) => void | Promise<unknown>;
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
    for (const flag of discovered) {
      const scope = flag.scope ?? "frontend";
      const decision = decideScope(scope, service.side);

      if (decision === "skip") {
        outcomes.push({ flag: flag.flagKey, scope, action: "skipped", detail: "other side handles this scope" });
        continue;
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
          outcomes.push({
            flag: flag.flagKey,
            scope,
            action: "error",
            detail: `fullstack readiness could not be VERIFIED (not a verdict on the other side) — release not started, no automatic retry; re-POST to retry: ${readiness.reason}`,
          });
          continue;
        }
        if (readiness.state === "absent") {
          outcomes.push({ flag: flag.flagKey, scope, action: "waiting", detail: "other service not deployed yet" });
          // No retry queue in the prototype: a "waiting" flag is released when
          // the OTHER service's deploy notification arrives and re-evaluates.
          // If that notification is lost, re-POST this one (same sha/service)
          // — the state store resolves the same previousSha range again.
          console.warn(
            `[beacon] WAITING: flag '${flag.flagKey}' (scope=${scope}, file=${flag.sourceFile}) — ` +
              `service '${n.service}' deployed at ${n.sha} but the other side hasn't yet. ` +
              `If its notification never arrives, re-POST /flag-releases for this service once both are deployed.`,
          );
          continue;
        }
      }
      try {
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
          outcomes.push({
            flag: flag.flagKey,
            scope,
            action: "error",
            detail: `idempotency check failed — release NOT started (answered 503; nothing retries this automatically, re-POST to retry): ${String(e)}`,
          });
          continue;
        }
        if (active) {
          outcomes.push({ flag: flag.flagKey, scope, action: "already_running", detail: { releaseId: active.id } });
          onReleaseStarted(flag.flagKey, n.environment); // re-attach monitoring (e.g. after a Beacon restart)
          continue;
        }
        const result = await triggerRelease(ld, flag, n.environment);
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
        // PARTIAL by construction, and worth being honest about: discovery is a manifest
        // DIFF between two SHAs, so a flag whose manifest exists at both is never
        // rediscovered and never reaches this code. This helps a re-POST of the same sha
        // range and nothing else; closing the gap needs a ledger of releases we stopped
        // watching, checked independently of discovery (deferred — see
        // docs/release-policy-metrics.md). Idempotent: already-pointed children are skipped.
        if (result.method === "immediate" || result.method === "noop") {
          await repointDependentPrerequisites(ld, flag.flagKey, n.environment);
        }
        outcomes.push({
          flag: flag.flagKey,
          scope,
          action: result.method === "held" ? "held" : result.method === "noop" ? "noop" : "released",
          detail: result,
        });
      } catch (e) {
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
          `[beacon] release trigger ERROR for '${flag.flagKey}' — release NOT started, and nothing will retry ` +
            `it automatically; re-POST /flag-releases for this service to retry: ${String(e)}`,
        );
        outcomes.push({
          flag: flag.flagKey,
          scope,
          action: "error",
          detail: `release trigger failed — not started, no automatic retry; re-POST to retry: ${String(e)}`,
        });
      }
    }
    if (outcomes.length) {
      console.log(`[beacon] outcomes: ${outcomes.map((o) => `${o.flag}=${o.action}`).join(", ")}`);
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
