#!/usr/bin/env node
/**
 * Config bridge CLI.
 *
 *   bridge provision [--ai-configs <dir>] [--graphs <dir>]
 *       Provision AI-configs + graphs into the TARGET LD project (LD_* env).
 *       Defaults: config/agentcontrol/ai-configs, config/agentcontrol/graphs
 *
 *   bridge sync --out <dir> [--tags a,b] [--graphs key1,key2]
 *       Pull AI-configs (optionally tag-filtered) + named graphs FROM the SOURCE
 *       LD project (LD_SOURCE_* env) into <dir>. Output is for inspection; the
 *       SOURCE project is the sanitization boundary for runtime-pulled configs.
 *
 *   bridge seed [--graphs key1,key2] [--staging <dir>] [--dry-run]
 *       Plug-and-play setup: pull the graph(s) + the AI-configs they reference
 *       FROM the SOURCE project into a gitignored staging dir, then provision
 *       them straight INTO the TARGET project. No commit step.
 *       Default graph: gha-auto-factory; default staging: .agentcontrol-cache.
 *
 *   bridge upgrade [--ai-configs <dir>] [--graphs <dir>] [--flags <dir>] [--dry-run]
 *       Bring an EXISTING install up to the repo's committed definitions:
 *       provision anything missing, then sync existing variation instructions
 *       and graph edges to the committed copies. Never touches flag targeting,
 *       model choices, or extra live variations — drift there is reported.
 */

import { LdClient, appConnection, sourceConnection, targetConnection } from "@auto-factory/shared";
import { provision } from "./provision.js";
import { seed } from "./seed.js";
import { sync } from "./sync.js";
import { upgrade } from "./upgrade.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function tryAppLd(): LdClient | undefined {
  try {
    return new LdClient(appConnection());
  } catch {
    return undefined;
  }
}

function logProvision(r: Awaited<ReturnType<typeof provision>>): void {
  console.log(`Configs:    ${r.configsCreated.length} created, ${r.configsExisting.length} existing`);
  console.log(`Variations: ${r.variationsCreated} created, ${r.variationsExisting} existing`);
  console.log(`Graphs:     ${r.graphsCreated.length} created, ${r.graphsExisting.length} existing`);
  console.log(`Flags:      ${r.flagsCreated.length} created, ${r.flagsExisting.length} existing`);
  console.log(`Tools:      ${r.toolsCreated.length} created, ${r.toolsExisting.length} existing`);
  console.log(`Metrics:    ${r.metricsCreated.length} created, ${r.metricsExisting.length} existing (APP project)`);
  if (r.toolsStripped.length) {
    console.log(`⚠ tools stripped from ${r.toolsStripped.length} variation(s) — our snapshots hold only tool/snippet references, not definitions, so re-attach them in LD if the provider needs them`);
  }
  if (r.failures.length) {
    console.log(`✗ ${r.failures.length} failure(s):`);
    for (const f of r.failures) console.log(`    ${f.resource} [${f.status}]: ${JSON.stringify(f.message)}`);
    process.exitCode = 1;
  } else {
    console.log("Done.");
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "provision") {
    const ld = new LdClient(targetConnection());
    const appLd = tryAppLd();
    const aiConfigsDir = flag(args, "ai-configs") ?? "config/agentcontrol/ai-configs";
    const graphsDir = flag(args, "graphs") ?? "config/agentcontrol/graphs";
    const flagsDir = flag(args, "flags") ?? "config/agentcontrol/flags";
    const toolsDir = flag(args, "tools") ?? "config/agentcontrol/tools";
    const metricsDir = flag(args, "metrics") ?? "config/agentcontrol/metrics";
    const dryRun = args.includes("--dry-run");
    console.log(`Provisioning into project '${ld.projectKey}'${dryRun ? " (DRY RUN — no writes)" : ""}`);
    if (appLd) console.log(`  APP metrics → '${appLd.projectKey}'`);
    console.log(`  ai-configs: ${aiConfigsDir}\n  graphs:     ${graphsDir}\n  flags:      ${flagsDir}\n  tools:      ${toolsDir}\n  metrics:    ${metricsDir}\n`);
    const r = await provision(ld, { aiConfigsDir, graphsDir, flagsDir, toolsDir, metricsDir, appLd, dryRun });
    logProvision(r);
    return;
  }

  if (cmd === "sync") {
    const conn = sourceConnection();
    if (!conn) throw new Error("Source not configured — set LD_SOURCE_API_KEY / LD_SOURCE_BASE_URL / LD_SOURCE_PROJECT_KEY");
    const out = flag(args, "out");
    if (!out) throw new Error("sync requires --out <dir>");
    const tags = flag(args, "tags")?.split(",").map((t) => t.trim()).filter(Boolean);
    const graphKeys = flag(args, "graphs")?.split(",").map((t) => t.trim()).filter(Boolean);
    const ld = new LdClient(conn);
    console.log(`Syncing from project '${ld.projectKey}' → ${out}`);
    const r = await sync(ld, { outDir: out, tags, graphKeys });
    console.log(`Pulled ${r.aiConfigs.length} ai-config(s), ${r.graphs.length} graph(s).`);
    console.log("⚠ Pulled instructions may reference internal tools/repos — review/sanitize before committing to this PUBLIC repo (or keep them only in the source LD project).");
    return;
  }

  if (cmd === "seed") {
    const srcConn = sourceConnection();
    if (!srcConn) throw new Error("Source not configured — set LD_SOURCE_API_KEY / LD_SOURCE_BASE_URL / LD_SOURCE_PROJECT_KEY");
    const source = new LdClient(srcConn);
    const target = new LdClient(targetConnection());
    const appLd = tryAppLd();
    const graphKeys = (flag(args, "graphs")?.split(",").map((t) => t.trim()).filter(Boolean)) ?? ["gha-auto-factory"];
    const stagingDir = flag(args, "staging") ?? ".agentcontrol-cache";
    const dryRun = args.includes("--dry-run");
    console.log(`Seeding from source '${source.projectKey}' → target '${target.projectKey}'${dryRun ? " (DRY RUN — no writes)" : ""}`);
    console.log(`  graphs:  ${graphKeys.join(", ")}\n  staging: ${stagingDir}\n`);
    const r = await seed({ source, target, graphKeys, stagingDir, dryRun, appLd });
    console.log(`Pulled ${r.graphsPulled.length} graph(s), ${r.configsPulled.length} ai-config(s) into ${stagingDir}.`);
    if (!r.graphsPulled.length) {
      console.log("⚠ No graphs pulled from source — nothing to provision. Check --graphs and source project.");
    }
    logProvision(r.provision);
    return;
  }

  if (cmd === "upgrade") {
    const ld = new LdClient(targetConnection());
    const appLd = tryAppLd();
    const aiConfigsDir = flag(args, "ai-configs") ?? "config/agentcontrol/ai-configs";
    const graphsDir = flag(args, "graphs") ?? "config/agentcontrol/graphs";
    const flagsDir = flag(args, "flags") ?? "config/agentcontrol/flags";
    const toolsDir = flag(args, "tools") ?? "config/agentcontrol/tools";
    const metricsDir = flag(args, "metrics") ?? "config/agentcontrol/metrics";
    const dryRun = args.includes("--dry-run");
    console.log(`Upgrading project '${ld.projectKey}' to committed definitions${dryRun ? " (DRY RUN — no writes)" : ""}`);
    if (appLd) console.log(`  APP metrics → '${appLd.projectKey}'`);
    console.log(`  ai-configs: ${aiConfigsDir}\n  graphs:     ${graphsDir}\n  flags:      ${flagsDir}\n`);
    const r = await upgrade(ld, { aiConfigsDir, graphsDir, flagsDir, toolsDir, metricsDir, appLd, dryRun });
    const p = r.provision;
    console.log(`Created:  ${p.configsCreated.length} config(s), ${p.variationsCreated} variation(s), ${p.graphsCreated.length} graph(s), ${p.flagsCreated.length} flag(s), ${p.toolsCreated.length} tool(s), ${p.metricsCreated.length} metric(s)`);
    console.log(`Updated:  ${r.variationsUpdated.length} variation(s), ${r.graphsUpdated.length} graph(s), ${r.toolsUpdated.length} tool definition(s)`);
    for (const v of r.variationsUpdated) console.log(`    ~ ${v}`);
    for (const g of r.graphsUpdated) console.log(`    ~ graph ${g}`);
    for (const tl of r.toolsUpdated) console.log(`    ~ tool ${tl}`);
    if (p.toolsStripped.length) {
      console.log(`⚠ tools stripped from ${p.toolsStripped.length} created variation(s) — re-attach in LD if the provider needs them`);
    }
    if (r.drift.length) {
      console.log(`Drift (reported, NOT changed):`);
      for (const d of r.drift) console.log(`    ! ${d}`);
    }
    const failures = [...p.failures.map((f) => `${f.resource} [${f.status}]: ${JSON.stringify(f.message)}`), ...r.failures.map((f) => `${f.resource}: ${JSON.stringify(f.message)}`)];
    if (failures.length) {
      console.log(`✗ ${failures.length} failure(s):`);
      for (const f of failures) console.log(`    ${f}`);
      process.exitCode = 1;
    } else {
      console.log(dryRun ? "Dry run complete — no writes performed." : "Done.");
    }
    return;
  }

  console.error("Usage: bridge <provision|sync|seed|upgrade> [options]");
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
