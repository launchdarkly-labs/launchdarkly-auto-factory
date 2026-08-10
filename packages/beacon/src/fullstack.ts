/**
 * Fullstack coordination — stateless. For a fullstack-scoped flag, check whether
 * the OTHER side's currently-deployed SHA already contains the same release-flag
 * file. If yes, both sides have the code → release. If definitively no → wait;
 * the other side's Notifier will re-evaluate when it deploys.
 *
 * TRI-STATE, deliberately. "The other side has not deployed" and "we could not
 * find out" must not collapse into one answer: `absent` is acked (the other
 * side's own deploy notification is the retry), but `unknown` — a status
 * endpoint down, a GitHub rate limit — has NO later event that retries it, so
 * the caller must answer retriably (503 → provider redelivery) instead of
 * acking a release into a permanent "waiting". Same shape as `PolicyRead` in
 * releaseAdapter.ts: the uncertain branch routes to the safe outcome.
 */

import { otherSideServices, type BeaconConfig, type Side } from "./config.js";
import type { GitHubClient } from "./github.js";

type ShaRead = { sha: string } | { error: string };

/** Read a service's currently-deployed SHA from its status endpoint. */
async function fetchDeployedSha(statusUrl: string, shaField: string): Promise<ShaRead> {
  try {
    const res = await fetch(statusUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) return { error: `status endpoint ${statusUrl} answered HTTP ${res.status}` };
    const json = (await res.json()) as Record<string, unknown>;
    const sha = json[shaField];
    return typeof sha === "string" && sha
      ? { sha }
      : { error: `status endpoint ${statusUrl} has no usable '${shaField}' field` };
  } catch (e) {
    return { error: `status endpoint ${statusUrl} unreachable: ${String(e)}` };
  }
}

export type FullstackReadiness =
  /** At least one opposite-side service has the file at its deployed SHA. */
  | { state: "present" }
  /** Every opposite-side service was checked and definitively lacks the file. */
  | { state: "absent" }
  /** At least one check could not be COMPLETED — not a verdict on the other side. */
  | { state: "unknown"; reason: string };

/**
 * Whether at least one service on the opposite side has the release-flag file in
 * its currently-deployed SHA. Never throws.
 *
 * `absent` requires POSITIVE evidence for every opposite-side service (a readable
 * deployed SHA and a definitive 404 from GitHub). Any failed read makes the whole
 * answer `unknown` — one unreachable status endpoint means the file could be
 * deployed somewhere we couldn't see, and guessing "absent" is what used to
 * strand fullstack releases behind a rate-limit blip.
 */
export async function otherSideHasFile(
  cfg: BeaconConfig,
  gh: GitHubClient,
  callerSide: Side,
  sourceFile: string,
): Promise<FullstackReadiness> {
  const others = otherSideServices(cfg, callerSide);
  const failures: string[] = [];
  for (const svc of others) {
    const read = await fetchDeployedSha(svc.statusUrl, svc.statusShaField);
    if ("error" in read) {
      failures.push(read.error);
      continue;
    }
    try {
      // fileExists answers false only on a definitive 404; any other GitHub
      // error (403 rate limit, 5xx, network) throws and is recorded here.
      if (await gh.fileExists(svc.repo, sourceFile, read.sha)) return { state: "present" };
    } catch (e) {
      failures.push(`GitHub check failed for ${svc.repo.owner}/${svc.repo.name}@${read.sha}: ${String(e)}`);
    }
  }
  if (failures.length > 0) return { state: "unknown", reason: failures.join("; ") };
  return { state: "absent" };
}
