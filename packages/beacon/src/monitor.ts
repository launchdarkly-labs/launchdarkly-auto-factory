/**
 * Post-trigger release monitoring. `startRelease` is fire-and-forget at the
 * API level; this module closes the loop: resolve the just-started release's
 * id, then poll it to a terminal state (completed / reverted /
 * monitoring_stopped) and log the outcome.
 *
 * Runs detached from the HTTP request (a guarded release takes as long as its
 * stages say — minutes to days), so the deploy notification responds
 * immediately and monitoring continues in-process. By contract it NEVER
 * throws: a monitoring failure is an observability gap, not a release failure
 * — the release itself proceeds server-side in LaunchDarkly either way.
 */

import {
  isReleaseFinished,
  isReleaseRunning,
  findActiveRelease,
  findLatestRelease,
  monitorRelease,
  type AutomatedRelease,
  type LdClient,
} from "@auto-factory/shared";
import { repointDependentPrerequisites } from "./repoint.js";

export interface MonitorSettings {
  enabled: boolean;
  pollMillis: number;
  timeoutMillis: number;
}

export function monitorSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): MonitorSettings {
  return {
    enabled: env.BEACON_MONITOR !== "false",
    pollMillis: Number(env.BEACON_MONITOR_POLL_MS) || 10_000,
    timeoutMillis: Number(env.BEACON_MONITOR_TIMEOUT_MS) || 24 * 60 * 60 * 1000,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a per-(flag, environment) async task so at most ONE runs at a time per key.
 *
 * Exists for redelivered `already_running` notifications: monitoring is re-attached
 * on each one (deliberately — that is how a restarted Beacon picks a release back
 * up), but every redelivery used to attach ANOTHER detached 24h poll loop for the
 * same release — duplicate polling and duplicate (idempotent) repoints. Keyed
 * in-process: once the running task settles, the key frees, so a genuine re-attach
 * after a completed/abandoned watch still works.
 */
export function dedupeMonitors(
  run: (flagKey: string, environmentKey: string) => Promise<unknown>,
): (flagKey: string, environmentKey: string) => void {
  const inFlight = new Set<string>();
  return (flagKey, environmentKey) => {
    const key = `${flagKey}/${environmentKey}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void run(flagKey, environmentKey).finally(() => inFlight.delete(key));
  };
}

/**
 * Resolve the active release's id for a flag (retrying briefly — the listing
 * is eventually consistent right after the start), then poll to completion.
 */
export async function monitorTriggeredRelease(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
  settings: MonitorSettings,
): Promise<AutomatedRelease | null> {
  const tag = `[beacon] release ${flagKey}/${environmentKey}`;
  try {
    let active: AutomatedRelease | null = null;
    for (let attempt = 0; attempt < 5 && !active; attempt++) {
      // Never longer than the poll interval, so tests (and short stages) aren't
      // pinned to a hardcoded 2s; production settings keep the original 2s.
      if (attempt > 0) await sleep(Math.min(2_000, settings.pollMillis));
      active = await findActiveRelease(ld, flagKey, environmentKey);
    }
    if (!active) {
      // findActiveRelease filters to NOT-finished, so a release that completed
      // inside this retry envelope is invisible to it. One unfiltered look: if the
      // newest release is already `completed`, run the completion path — otherwise
      // "it may have completed instantly" was exactly the case that skipped the
      // child-flag repointing it names.
      const latest = await findLatestRelease(ld, flagKey, environmentKey);
      if (latest?.status === "completed") {
        console.log(`${tag}: COMPLETED before monitoring could attach (release ${latest.id}) — rolled out to 100%`);
        await repointDependentPrerequisites(ld, flagKey, environmentKey);
        return latest;
      }
      console.warn(`${tag}: started but no in-progress release found to monitor (it may have completed instantly)`);
      return null;
    }

    console.log(`${tag}: monitoring ${active.kind} release ${active.id} (stage ${active.latestStageIndex})`);
    const final = await monitorRelease(ld, environmentKey, active.id, {
      pollMillis: settings.pollMillis,
      timeoutMillis: settings.timeoutMillis,
    });

    if (final.status === "completed") {
      console.log(`${tag}: COMPLETED — rolled out to 100%`);
      // A completed variation release may strand children prerequisite'd on
      // the PREVIOUS variation — re-point auto-factory children to what the
      // environment serves now. Never throws (logs its own outcomes).
      await repointDependentPrerequisites(ld, flagKey, environmentKey);
    } else if (isReleaseFinished(final.status)) {
      // reverted = a guardrail metric regressed and LD rolled the flag back;
      // monitoring_stopped = a human intervened. Both are end states for us.
      console.warn(`${tag}: ended ${final.status.toUpperCase()} (stage ${final.latestStageIndex})`);
    } else if (isReleaseRunning(final.status)) {
      // Still legitimately running when the window closed. A guarded rollout's stages can
      // outlast the monitoring timeout, so this is a slow release, NOT a paused one —
      // diagnosing it as paused sent the operator looking for a human decision that nobody
      // was asked to make.
      console.warn(
        `${tag}: stopped watching release ${final.id} — still ${final.status} (stage ` +
          `${final.latestStageIndex}) after the monitoring window. The release continues in ` +
          `LaunchDarkly; nothing here is waiting on a human.`,
      );
    } else {
      // Neither running nor finished: most plausibly PAUSED on a regression, which
      // `rollbackOnRegression: false` asks for. The poll loop keeps watching such a release
      // (a human may resume it), so reaching here means it was still unresolved at the
      // deadline. Per-metric detail is printed VERBATIM — we do not know LaunchDarkly's
      // vocabulary for this state, and quoting beats guessing.
      console.warn(
        `${tag}: stopped watching release ${final.id} — still '${final.status}' (stage ` +
          `${final.latestStageIndex}) after the monitoring window. Most likely PAUSED awaiting a human.`,
      );
      for (const m of final.metricConfigurations ?? []) {
        console.warn(`${tag}:   metric ${m.metricKey} status='${m.status}' autoRollback=${m.autoRollback}`);
      }
      // Deliberately NOT promising that a later deploy repoints child flags: discovery is a
      // manifest DIFF, so a flag whose manifest exists at both SHAs is never rediscovered
      // and `triggerRelease` never runs for it again. See docs/release-policy-metrics.md.
      console.warn(
        `${tag}:   note: if this release later completes outside this window, child flags pinned to the ` +
          `previous variation are NOT repointed automatically — see the deferred watch-ledger item.`,
      );
    }
    return final;
  } catch (e) {
    console.warn(`${tag}: monitoring error (release proceeds in LaunchDarkly regardless): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
