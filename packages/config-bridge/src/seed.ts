/**
 * Seed: pull the agent graph + the AI-configs it references FROM the source LD
 * project (LD_SOURCE_*) into a local staging dir, then provision them straight
 * INTO the target project (LD_*). No commit step — the staging dir is gitignored.
 *
 * This is the plug-and-play setup path: a design partner who runs `bootstrap`
 * with LD_SOURCE_* configured gets the current graph shape AND the configs the
 * graph references, so the pipeline can actually run. (Without it, bootstrap only
 * provisions the committed graph, whose referenced AI-configs don't exist in the
 * target project.)
 *
 * Sanitization note: runtime-pulled configs bypass `check-public`. The source LD
 * project is the sanitization boundary — keep internal names/tools out of the
 * live config instructions there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LdClient } from "@auto-factory/shared";
import { provision, type ProvisionResult } from "./provision.js";
import { sync } from "./sync.js";

interface GraphFileShape {
  rootConfigKey?: string;
  edges?: Array<{ sourceConfig?: string; targetConfig?: string }>;
}

/** Collect every AI-config key a synced graph file references (root + edges). */
function configKeysFromGraph(graphPath: string): string[] {
  const g = JSON.parse(readFileSync(graphPath, "utf8")) as GraphFileShape;
  const keys = new Set<string>();
  if (g.rootConfigKey) keys.add(g.rootConfigKey);
  for (const e of g.edges ?? []) {
    if (e.sourceConfig) keys.add(e.sourceConfig);
    if (e.targetConfig) keys.add(e.targetConfig);
  }
  return [...keys];
}

export interface SeedOptions {
  /** Source LD client (LD_SOURCE_* connection). */
  source: LdClient;
  /** Target LD client (LD_* connection). */
  target: LdClient;
  /** Graph keys to pull from source and walk for config references. */
  graphKeys: string[];
  /** Gitignored staging dir for the pulled copies. */
  stagingDir: string;
  /** When true, the provision step reports without writing. */
  dryRun?: boolean;
  /** APP-project client for shared metrics (ADR 0014). */
  appLd?: LdClient;
}

export interface SeedResult {
  graphsPulled: string[];
  configsPulled: string[];
  provision: ProvisionResult;
}

export async function seed(opts: SeedOptions): Promise<SeedResult> {
  // 1. Pull the graph(s) into staging.
  const graphSync = await sync(opts.source, { outDir: opts.stagingDir, graphKeys: opts.graphKeys });

  // 2. Read the pulled graph(s) for their referenced config keys, then pull those.
  const configKeys = new Set<string>();
  for (const key of graphSync.graphs) {
    for (const ck of configKeysFromGraph(join(opts.stagingDir, "graphs", `${key}.json`))) {
      configKeys.add(ck);
    }
  }
  const configSync = await sync(opts.source, {
    outDir: opts.stagingDir,
    configKeys: [...configKeys],
  });

  // 3. Provision the staged copies into the target project.
  const provisionResult = await provision(opts.target, {
    aiConfigsDir: join(opts.stagingDir, "ai-configs"),
    graphsDir: join(opts.stagingDir, "graphs"),
    ...(opts.appLd ? { appLd: opts.appLd } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  });

  return {
    graphsPulled: graphSync.graphs,
    configsPulled: configSync.aiConfigs,
    provision: provisionResult,
  };
}
