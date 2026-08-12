/**
 * Thin wrapper around the GitHub CLI (`gh`) for init/doctor. All GitHub-side
 * setup goes through `gh` so we ride the user's existing auth (no PAT to
 * collect or store). Secrets are passed via stdin, never argv.
 */

import { execFileSync } from "node:child_process";

export interface GhResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

export function gh(args: string[], input?: string): GhResult {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      return { ok: false, status: -1, stdout: "", stderr: "gh: command not found" };
    }
    return {
      ok: false,
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? String(e),
    };
  }
}

export function ghAvailable(): boolean {
  return gh(["--version"]).ok;
}

export function ghAuthenticated(): boolean {
  return gh(["auth", "status"]).ok;
}

/** `gh api <path> …` parsed as JSON; undefined on any failure. */
export function ghJson<T = unknown>(args: string[]): T | undefined {
  const r = gh(["api", ...args]);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return undefined;
  }
}

/** Set an Actions secret (value via stdin so it never appears in argv/ps). */
export function ghSetSecret(repo: string, name: string, value: string): GhResult {
  return gh(["secret", "set", name, "--repo", repo], value);
}

/** Set an Actions variable (non-secret). */
export function ghSetVariable(repo: string, name: string, value: string): GhResult {
  return gh(["variable", "set", name, "--repo", repo, "--body", value]);
}

/** List Actions secret names; undefined when the token can't list them. */
export function ghListSecrets(repo: string): string[] | undefined {
  const data = ghJson<{ secrets?: Array<{ name: string }> }>([`repos/${repo}/actions/secrets`, "--paginate"]);
  return data?.secrets?.map((s) => s.name);
}

/** List Actions variables (name → value); undefined when unavailable. */
export function ghListVariables(repo: string): Map<string, string> | undefined {
  const data = ghJson<{ variables?: Array<{ name: string; value: string }> }>([
    `repos/${repo}/actions/variables`,
    "--paginate",
  ]);
  if (!data?.variables) return undefined;
  return new Map(data.variables.map((v) => [v.name, v.value]));
}

/** Fetch a file's decoded content from a repo (contents API); undefined if absent. */
export function ghGetFile(repo: string, path: string, ref?: string): { content: string; sha: string } | undefined {
  const data = ghJson<{ content?: string; sha?: string }>([
    `repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
  ]);
  if (!data?.content || !data.sha) return undefined;
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

/** Create or update a file on a branch via the contents API. */
export function ghPutFile(repo: string, path: string, content: string, message: string, branch: string): GhResult {
  const existing = ghGetFile(repo, path, branch);
  const args = [
    "api",
    "-X",
    "PUT",
    `repos/${repo}/contents/${path}`,
    "-f",
    `message=${message}`,
    "-f",
    `content=${Buffer.from(content, "utf8").toString("base64")}`,
    "-f",
    `branch=${branch}`,
  ];
  if (existing) args.push("-f", `sha=${existing.sha}`);
  return gh(args);
}
