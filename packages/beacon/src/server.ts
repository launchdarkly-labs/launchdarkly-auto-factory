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
import { LdClient, findActiveRelease, targetConnection } from "@auto-factory/shared";
import express, { type Express, type Request, type Response } from "express";
import { type BeaconConfig, loadBeaconConfig } from "./config.js";
import { discoverNewReleaseFlags } from "./discovery.js";
import { otherSideHasFile } from "./fullstack.js";
import { GitHubClient } from "./github.js";
import { monitorSettingsFromEnv, monitorTriggeredRelease } from "./monitor.js";
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
  onReleaseStarted?: (
    flagKey: string,
    environmentKey: string,
    ctx?: { repoFullName?: string; sha?: string; targetVariation?: string },
  ) => void;
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
  const onReleaseStarted =
    deps.onReleaseStarted ??
    ((flagKey: string, environmentKey: string, ctx?): void => {
      if (!monitorSettings.enabled) return;
      // Detached on purpose: a guarded release runs for minutes-to-days; the
      // notification response must not wait on it.
      void monitorTriggeredRelease(ld, flagKey, environmentKey, monitorSettings, ctx);
    });

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
    for (const flag of discovered) {
      const scope = flag.scope ?? "frontend";
      const decision = decideScope(scope, service.side);

      if (decision === "skip") {
        outcomes.push({ flag: flag.flagKey, scope, action: "skipped", detail: "other side handles this scope" });
        continue;
      }
      if (decision === "check_fullstack") {
        const ready = await otherSideHasFile(cfg, gh, service.side, flag.sourceFile).catch(() => false);
        if (!ready) {
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
        // Best-effort check (on read failure, proceed to trigger).
        const active = await findActiveRelease(ld, flag.flagKey, n.environment).catch(() => null);
        if (active) {
          outcomes.push({ flag: flag.flagKey, scope, action: "already_running", detail: { releaseId: active.id } });
          onReleaseStarted(flag.flagKey, n.environment, {
            repoFullName: `${service.repo.owner}/${service.repo.name}`,
            sha: n.sha,
            ...(flag.targetVariation ? { targetVariation: flag.targetVariation } : {}),
          }); // re-attach monitoring (e.g. after a Beacon restart)
          continue;
        }
        const result = await triggerRelease(ld, flag, n.environment);
        // Only staged rollouts get release monitoring: "held"/"noop" started
        // nothing, "prerequisites"/"immediate" have no automated release to watch.
        if (result.method === "progressive" || result.method === "guarded") {
          onReleaseStarted(flag.flagKey, n.environment, {
            repoFullName: `${service.repo.owner}/${service.repo.name}`,
            sha: n.sha,
            ...(flag.targetVariation ? { targetVariation: flag.targetVariation } : {}),
          });
        }
        // An immediate release moves the fallthrough right here — re-point any
        // auto-factory children pinned on the previous variation (staged
        // releases do this when monitoring sees them complete).
        if (result.method === "immediate") {
          await repointDependentPrerequisites(ld, flag.flagKey, n.environment);
        }
        outcomes.push({
          flag: flag.flagKey,
          scope,
          action: result.method === "held" ? "held" : result.method === "noop" ? "noop" : "released",
          detail: result,
        });
      } catch (e) {
        console.warn(`[beacon] release trigger ERROR for '${flag.flagKey}': ${String(e)}`);
        outcomes.push({ flag: flag.flagKey, scope, action: "error", detail: String(e) });
      }
    }
    if (outcomes.length) {
      console.log(`[beacon] outcomes: ${outcomes.map((o) => `${o.flag}=${o.action}`).join(", ")}`);
    }

    return {
      status: 200,
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
