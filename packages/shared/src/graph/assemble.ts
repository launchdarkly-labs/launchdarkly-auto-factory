/**
 * Per-run knowledge-graph assembly (ADR 0010): the I/O half of the composer.
 * Gathers the three sources — the app repo's service registry, recent
 * observability spans, and find-code-refs wrap points at the PR SHA — then
 * hands plain data to `composeGraph`.
 *
 * DEGRADES, NEVER BLOCKS: every source is best-effort. A missing registry,
 * an uninstrumented estate, or an absent find-code-refs binary each produce a
 * warning + a `gaps` entry in the artifact; the run continues un- or
 * partially-enriched. Enrichment must never be the reason a PR check fails.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { type CodeRefRow, parseCodeRefsCsv } from "./codeRefs.js";
import { composeGraph } from "./compose.js";
import { fetchRecentSpans } from "./o11yClient.js";
import type { GraphService, KnowledgeGraph } from "./schema.js";
import type { SpanRecord } from "./traceEdges.js";

/** Repo-committed service registry the app declares (mirrors Beacon's shape). */
export const SERVICES_FILE = ".autofactory/services.yaml";

export interface AssembleOptions {
  /** The app repo checkout the agents operate on. */
  sandboxRoot: string;
  /** PR base ref for the changed-files diff (PR_BASE_REF fallback inside). */
  prBaseRef?: string;
  /** Head SHA, stamped on the artifact. */
  sha?: string;
  /** Span fetch; omit to skip the traces source (still composes, with a gap). */
  o11y?: { apiKey: string; projectKey: string; windowHours?: number; retryDelaysMs?: number[] };
  /** find-code-refs run; omit to skip the wrap-point source. */
  codeRefs?: { apiKey: string; projectKey: string; repoName?: string };
}

export interface AssembledGraph {
  graph: KnowledgeGraph;
  changedFiles: string[];
  /** Human-facing degradation notes — surface as ::warning:: + PR comment. */
  warnings: string[];
}

/** Parse `.autofactory/services.yaml` → GraphService[]. */
export function parseServicesRegistry(yamlText: string): GraphService[] {
  const doc = parseYaml(yamlText) as { services?: Record<string, Partial<GraphService> & { statusUrl?: string }> };
  const services: GraphService[] = [];
  for (const [key, def] of Object.entries(doc?.services ?? {})) {
    if (!def || typeof def !== "object") continue;
    const hosts = [...(def.hosts ?? [])];
    // The status URL's host also identifies the service in deployed-trace targets.
    if (def.statusUrl) {
      try {
        hosts.push(new URL(def.statusUrl).hostname);
      } catch {
        /* not a URL — skip */
      }
    }
    services.push({
      key,
      ...(def.side ? { side: def.side } : {}),
      ...(def.repo ? { repo: def.repo } : {}),
      ...(def.dir ? { dir: def.dir } : {}),
      ...(hosts.length ? { hosts } : {}),
    });
  }
  return services;
}

/** Changed files of the PR (base...HEAD), [] when not resolvable. */
export function changedFilesInCheckout(sandboxRoot: string, prBaseRef?: string): string[] {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: sandboxRoot, encoding: "utf8", timeout: 30_000 });
  const name = prBaseRef || process.env.PR_BASE_REF || "main";
  for (const ref of [`origin/${name}`, name, "origin/main", "main"]) {
    try {
      git(["rev-parse", "--verify", "--quiet", ref]);
      return git(["diff", "--name-only", `${ref}...HEAD`])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

/**
 * Run `ld-find-code-refs` at the checkout's current SHA (dry run — nothing is
 * pushed to LaunchDarkly from the pipeline; the app repo's own on-merge scan
 * owns that) and parse its CSV output.
 */
export function runFindCodeRefs(opts: {
  sandboxRoot: string;
  apiKey: string;
  projectKey: string;
  repoName?: string;
}): { rows: CodeRefRow[]; csvText?: string; warning?: string } {
  const probe = spawnSync("ld-find-code-refs", ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (probe.error || probe.status !== 0) {
    return {
      rows: [],
      warning:
        "ld-find-code-refs binary not found on PATH — flag→code wrap-point edges unavailable. " +
        "Install it in the workflow (see bootstrap/github-action-template) to light this up.",
    };
  }
  const outDir = mkdtempSync(join(tmpdir(), "af-coderefs-"));
  // The binary embeds the branch name in its CSV filename, so a branch with a
  // "/" (e.g. Copilot's copilot/* branches) makes the write fail with ENOENT.
  // Pass an explicit slash-free --branch instead of letting it auto-detect.
  const rawBranch =
    process.env.PR_BRANCH ||
    spawnSync("git", ["-C", opts.sandboxRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 15_000 }).stdout?.trim();
  const branch = (rawBranch && rawBranch !== "HEAD" ? rawBranch : "pr-checkout").replace(/[^A-Za-z0-9._-]+/g, "-");
  try {
    const run = spawnSync(
      "ld-find-code-refs",
      [
        "--dir", opts.sandboxRoot,
        "--projKey", opts.projectKey,
        "--repoName", opts.repoName ?? "pr-checkout",
        "--branch", branch,
        "--dryRun",
        "--outDir", outDir,
      ],
      { encoding: "utf8", timeout: 120_000, env: { ...process.env, LD_ACCESS_TOKEN: opts.apiKey } },
    );
    if (run.error || run.status !== 0) {
      const detail = `${run.stderr ?? ""}${run.stdout ?? ""}`.trim().slice(0, 300);
      return { rows: [], warning: `ld-find-code-refs failed (${detail || "unknown error"}) — wrap-point edges unavailable.` };
    }
    const csvFile = readdirSync(outDir).find((f) => f.endsWith(".csv"));
    if (!csvFile) return { rows: [], warning: "ld-find-code-refs produced no CSV — wrap-point edges unavailable." };
    const csvText = readFileSync(join(outDir, csvFile), "utf8");
    const rows = parseCodeRefsCsv(csvText);
    return rows.length
      ? { rows, csvText }
      : { rows, csvText, warning: "ld-find-code-refs found no flag references in this checkout." };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Assemble the per-run graph. Never throws; see module contract. */
export async function assembleKnowledgeGraph(opts: AssembleOptions): Promise<AssembledGraph> {
  const warnings: string[] = [];
  const root = resolve(opts.sandboxRoot);

  let services: GraphService[] = [];
  const registryPath = join(root, SERVICES_FILE);
  if (existsSync(registryPath)) {
    try {
      services = parseServicesRegistry(readFileSync(registryPath, "utf8"));
      if (services.length === 0) warnings.push(`${SERVICES_FILE} declares no services — file→service attribution unavailable.`);
    } catch (e) {
      warnings.push(`${SERVICES_FILE} could not be parsed (${e instanceof Error ? e.message : String(e)}).`);
    }
  } else {
    warnings.push(
      `no ${SERVICES_FILE} in the repo — service registry unavailable (service edges and file→service attribution off). ` +
        `Commit one to enable the knowledge graph's service view.`,
    );
  }

  let spans: SpanRecord[] = [];
  if (opts.o11y && services.length > 0) {
    const fetched = await fetchRecentSpans({
      apiKey: opts.o11y.apiKey,
      projectKey: opts.o11y.projectKey,
      ...(opts.o11y.windowHours !== undefined ? { windowHours: opts.o11y.windowHours } : {}),
      ...(opts.o11y.retryDelaysMs !== undefined ? { retryDelaysMs: opts.o11y.retryDelaysMs } : {}),
    });
    spans = fetched.spans;
    if (fetched.warning) warnings.push(fetched.warning);
  } else if (opts.o11y) {
    warnings.push("skipping observability span fetch — no service registry to resolve span targets against.");
  }

  let codeRefRows: CodeRefRow[] = [];
  if (opts.codeRefs) {
    const refs = runFindCodeRefs({ sandboxRoot: root, ...opts.codeRefs });
    codeRefRows = refs.rows;
    if (refs.warning) warnings.push(refs.warning);
  }

  const graph = composeGraph({
    services,
    spans,
    codeRefs: codeRefRows,
    ...(opts.sha ? { sha: opts.sha } : {}),
  });
  const changedFiles = changedFilesInCheckout(root, opts.prBaseRef);
  return { graph, changedFiles, warnings };
}
