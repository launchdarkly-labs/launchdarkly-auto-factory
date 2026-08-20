/**
 * Release-flag discovery: a file is "new" if it exists in the release-flags
 * directory at the current SHA but not at the previous SHA. Mirrors the
 * reference (GitHub Contents API diff of `.release-flags/`).
 */

import type { DiscoveredFlag, ReleaseFlagFile } from "@auto-factory/shared";
import type { GitHubClient, RepoRef } from "./github.js";

export async function discoverNewReleaseFlags(
  gh: GitHubClient,
  repo: RepoRef,
  dir: string,
  currentSha: string,
  previousSha: string | undefined,
): Promise<DiscoveredFlag[]> {
  const current = await gh.listDir(repo, dir, currentSha);
  const previous = previousSha ? new Set(await gh.listDir(repo, dir, previousSha)) : new Set<string>();

  const newJsonFiles = current.filter((name) => name.endsWith(".json") && !previous.has(name));

  const discovered: DiscoveredFlag[] = [];
  const cleanDir = dir.replace(/^\/+|\/+$/g, "");
  for (const name of newJsonFiles) {
    const filePath = `${cleanDir}/${name}`;
    let parsed: ReleaseFlagFile | null;
    try {
      parsed = await gh.getFileJson<ReleaseFlagFile>(repo, filePath, currentSha);
    } catch (e) {
      // A syntactically invalid manifest is a PERMANENT property of this SHA: letting
      // it throw made the handler 502 without recording the SHA, so every later
      // notification re-diffed the same range, hit the same file, and 502'd again —
      // blocking every OTHER manifest in the range forever, with a log that never
      // named the culprit. A manifest that never parsed cannot have a release to
      // protect, so skipping it (by name) is the safe branch. Anything that is NOT a
      // parse failure (network, GitHub 5xx) is transient and still aborts discovery —
      // the 502 path exists precisely so those retry.
      if (!(e instanceof SyntaxError)) throw e;
      console.warn(
        `[beacon] skipping malformed release manifest ${filePath}@${currentSha} (not valid JSON — ` +
          `no release can be triggered for it until the file is fixed in a later commit): ${e.message}`,
      );
      continue;
    }
    if (!parsed?.flagKey) continue; // not a valid release-flag file
    discovered.push({ ...parsed, sourceFile: filePath });
  }
  return discovered;
}
