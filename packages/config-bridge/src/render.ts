/**
 * Pure rendering/parsing helpers for `bridge init` and `bridge doctor`:
 * .env upserts, app-repo workflow rendering from the committed templates, and
 * git-remote parsing. Kept side-effect-free so they're unit-testable; all file
 * and network I/O stays in init.ts / doctor.ts.
 */

export type Provider = "anthropic" | "bedrock" | "cursor";

/**
 * Update KEY=VALUE lines in a .env body, preserving comments, ordering, and
 * any keys we don't manage. Keys not present are appended at the end under an
 * "added by bridge init" marker. `undefined` values are left untouched.
 */
export function upsertEnv(existing: string, updates: Record<string, string | undefined>): string {
  const pending = new Map(Object.entries(updates).filter(([, v]) => v !== undefined) as [string, string][]);
  const lines = existing.length ? existing.split("\n") : [];
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) return line;
    const key = trimmed.slice(0, idx).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  if (pending.size) {
    if (out.length && out.at(-1)?.trim() !== "") out.push("");
    out.push("# --- added by `bridge init` ---");
    for (const [key, value] of pending) out.push(`${key}=${value}`);
  }
  let body = out.join("\n");
  if (!body.endsWith("\n")) body += "\n";
  return body;
}

/** Parse "owner/repo" out of a git remote URL (SSH or HTTPS forms). */
export function parseOwnerRepo(url: string): { owner: string; repo: string } | undefined {
  const m =
    url.trim().match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/) ??
    url.trim().match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  const [, owner, repo] = m ?? [];
  return owner && repo ? { owner, repo } : undefined;
}

/**
 * Render an app-repo workflow from the committed template: substitute the
 * `<owner>` placeholder, and on the bedrock provider swap the Anthropic key
 * input for the AWS credential inputs (matching the guidance already in the
 * template's comments — `aws_region` comes from a repo variable).
 */
export function renderWorkflow(template: string, opts: { toolOwner: string; provider: Provider }): string {
  let out = template.replaceAll("<owner>", opts.toolOwner);
  if (opts.provider === "bedrock") {
    out = out.replace(
      /^(\s*)anthropic_api_key:.*$/m,
      (_, indent: string) =>
        `${indent}aws_region:            \${{ vars.AWS_REGION }}\n` +
        `${indent}aws_access_key_id:     \${{ secrets.AWS_ACCESS_KEY_ID }}\n` +
        `${indent}aws_secret_access_key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}`,
    );
  }
  return out;
}

/** Render the find-code-refs workflow: substitute the app project key. */
export function renderFindCodeRefs(template: string, appProjectKey: string): string {
  return template.replaceAll("<your-app-project-key>", appProjectKey);
}

/** Render the cursor-automation MCP config with a real LD API key. */
export function renderMcpJson(template: string, ldApiKey: string): string {
  return template.replaceAll("REPLACE_WITH_LD_API_KEY", ldApiKey);
}

/** The workflow template + rendered app-repo path for a provider. */
export function workflowFileFor(provider: Provider): { templateName: string; appRepoPath: string } {
  return provider === "cursor"
    ? { templateName: "auto-factory-cursor.yml", appRepoPath: ".github/workflows/auto-factory.yml" }
    : { templateName: "auto-factory.yml", appRepoPath: ".github/workflows/auto-factory.yml" };
}
