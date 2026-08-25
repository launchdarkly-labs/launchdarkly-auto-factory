/**
 * Maintainer attribution for LOCALLY-driven runs (CLI / Claude Code / Codex).
 *
 * Flags the pipeline creates should belong to the human whose working tree it
 * ran on, not to whoever owns the shared `LD_API_KEY` (LaunchDarkly's default
 * for API-created flags). Identity comes from `AUTOFACTORY_MAINTAINER_EMAIL`
 * when set, else `git config user.email` in the target repo; the email is
 * resolved to a member id via the account members API and passed to the flag
 * create payload as `maintainerId`.
 *
 * Fail-open by design: an email that resolves to no member (personal git
 * email, member removed) means no `maintainerId` — today's token-owner
 * behavior — never a blocked run. New flags only; a 409 reuse keeps the
 * existing flag's maintainer.
 */

import { execFileSync } from "node:child_process";
import type { LdClient } from "./ldClient.js";

/** The developer's email: env override first, else git identity in the repo. */
export function localMaintainerEmail(repoRoot: string): string | undefined {
  const override = process.env.AUTOFACTORY_MAINTAINER_EMAIL?.trim();
  if (override) return override;
  try {
    const email = execFileSync("git", ["-C", repoRoot, "config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an email to a LaunchDarkly member id (exact match, case-insensitive
 * — the members `query` filter is fuzzy). Undefined when no member matches or
 * the lookup fails (e.g. the token lacks member-read access).
 */
export async function resolveMaintainerId(ld: LdClient, email: string): Promise<string | undefined> {
  try {
    const res = await ld.findMembers<{ items?: Array<{ _id?: string; email?: string }> }>(email);
    const match = (res.data.items ?? []).find((m) => m.email?.toLowerCase() === email.toLowerCase());
    return match?._id;
  } catch {
    return undefined;
  }
}
