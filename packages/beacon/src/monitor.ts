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
  findActiveRelease,
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
      if (attempt > 0) await sleep(2_000);
      active = await findActiveRelease(ld, flagKey, environmentKey);
    }
    if (!active) {
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
    } else {
      // Not running and not finished: a state we do not model — most plausibly a release
      // PAUSED on a regression, which is what `rollbackOnRegression: false` asks for.
      // Say so loudly with the per-metric detail, because the whole point of choosing
      // pause-over-rollback is that a human steps in, and nothing else here would tell
      // them. Statuses are printed verbatim rather than interpreted: we do not know
      // LaunchDarkly's vocabulary for this, and guessing it would be worse than quoting.
      console.warn(
        `${tag}: release ${final.id} is neither running nor finished (status '${final.status}', stage ` +
          `${final.latestStageIndex}) — most likely PAUSED awaiting a human. Monitoring stopped.`,
      );
      for (const m of final.metricConfigurations ?? []) {
        console.warn(`${tag}:   metric ${m.metricKey} status='${m.status}' autoRollback=${m.autoRollback}`);
      }
    }
    return final;
  } catch (e) {
    console.warn(`${tag}: monitoring error (release proceeds in LaunchDarkly regardless): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
