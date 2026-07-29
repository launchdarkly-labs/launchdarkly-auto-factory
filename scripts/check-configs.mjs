#!/usr/bin/env node
/**
 * check-configs — validates the agent routing-tag contract against the registry,
 * so the failure modes in issue #9 can't silently regress.
 *
 * The tag registry (config/agentcontrol/tags.json) is the source of truth. This
 * guard checks everything else agrees with it:
 *
 *   1. Tool-signature lint — instructions must call `tag_conversation` with a
 *      single `tags` object, never `tag_conversation(key=…, value=…)` (the wrong
 *      form emits no tags and stalls the chain).
 *   2. Graph ⟷ registry (bidirectional) — every tag a graph edge gates on must
 *      be a registry tag that lists that exact edge, and every edge the registry
 *      claims must exist in the graph. (A required tag with no producer, or a
 *      drifted edge, can't hide.)
 *   3. Producers — each registry tag's `producedBy` agent must actually emit it:
 *      an `llm` tag's key must appear in that agent's instructions; a `tool` tag
 *      must be in the write-tool auto-set.
 *   4. README ⟷ registry — the "Canonical agent tags" table keys must equal the
 *      registry keys, so the human doc can't drift.
 *   5. README ⟷ ai-configs — every committed agent config file must appear in
 *      the README's agents table and vice versa (caught real drift: the
 *      manifest-steward config shipped without a README row).
 *
 * Run: node scripts/check-configs.mjs   (wired as `npm run check:configs`)
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const AI_CONFIG_DIR = "config/agentcontrol/ai-configs";
const GRAPH_DIR = "config/agentcontrol/graphs";
const REGISTRY = "config/agentcontrol/tags.json";
const README = "config/agentcontrol/README.md";

/**
 * Tags set automatically by the sandbox write tools (sandboxTools.ts:
 * create_flag / add_variation / use_existing_flag → flag_ready/flag_created/
 * flag_key/flag_variation; create_metric → metrics_created/metric_keys).
 * A registry tag declared `production: "tool"` must be one of these.
 */
const TOOL_AUTO_TAGS = new Set(["flag_created", "flag_ready", "flag_key", "flag_variation", "metrics_created", "metric_keys", "metric_event_keys", "tests_last_run"]);

function listJson(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
// All variations' instructions, joined: a tag counts as produced by the agent
// when ANY variation mentions it (e.g. the metrics author's `sentry` variation).
const instructionsOf = (p) =>
  (JSON.parse(readFileSync(p, "utf8")).variations ?? []).map((v) => v?.instructions ?? "").join("\n");
const edgeId = (from, to, kind) => `${from} -${kind}-> ${to}`;

const violations = [];
const fail = (m) => violations.push(m);

// --- Load registry --------------------------------------------------------
let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY, "utf8")).tags ?? {};
} catch (e) {
  console.error(`✗ could not read tag registry ${REGISTRY}: ${e.message}`);
  process.exit(1);
}
const registryKeys = new Set(Object.keys(registry));

// --- Gather instructions --------------------------------------------------
const configFiles = listJson(AI_CONFIG_DIR);
const instructionsByKey = new Map(); // configKey -> instructions text
for (const file of configFiles) instructionsByKey.set(basename(file, ".json"), instructionsOf(file));

// --- Check 1: invalid tag_conversation signature --------------------------
for (const [name, text] of instructionsByKey) {
  for (const call of text.match(/tag_conversation\(\s*key\b[^)]*\)/g) ?? []) {
    fail(`${name}: invalid tag_conversation signature \`${call.slice(0, 70)}\` — pass a single tags object, e.g. tag_conversation({"tags": {"needs_tests": "true"}})`);
  }
}

// --- Check 2: graph ⟷ registry (bidirectional) ----------------------------
const graphEdgeConditions = new Set(); // `${tag}@${edgeId}` for every gated condition in the graph
for (const file of listJson(GRAPH_DIR)) {
  const graph = JSON.parse(readFileSync(file, "utf8"));
  for (const edge of graph.edges ?? []) {
    const h = edge.handoff ?? {};
    for (const kind of ["require_tags", "skip_if_tags"]) {
      for (const tag of Object.keys(h[kind] ?? {})) {
        graphEdgeConditions.add(`${tag}@${edgeId(edge.sourceConfig, edge.targetConfig, kind)}`);
        const reg = registry[tag];
        if (!reg) {
          fail(`graph: edge ${edge.sourceConfig} → ${edge.targetConfig} gates on '${tag}' (${kind}), which is not in the tag registry.`);
          continue;
        }
        const declared = (reg.edges ?? []).some(
          (e) => e.from === edge.sourceConfig && e.to === edge.targetConfig && e.kind === kind,
        );
        if (!declared) {
          fail(`registry: tag '${tag}' does not list the graph edge ${edge.sourceConfig} -${kind}-> ${edge.targetConfig} in its \`edges\`.`);
        }
      }
    }
  }
}
// Reverse: every edge the registry claims must exist in the graph.
for (const [tag, def] of Object.entries(registry)) {
  for (const e of def.edges ?? []) {
    if (!graphEdgeConditions.has(`${tag}@${edgeId(e.from, e.to, e.kind)}`)) {
      fail(`registry: tag '${tag}' claims edge ${e.from} -${e.kind}-> ${e.to}, but no such edge condition exists in the graph.`);
    }
  }
}

// --- Check 3: producers actually produce ----------------------------------
for (const [tag, def] of Object.entries(registry)) {
  if (def.production === "tool") {
    if (!TOOL_AUTO_TAGS.has(tag)) {
      fail(`registry: tag '${tag}' is declared production:"tool" but no write tool auto-sets it (${[...TOOL_AUTO_TAGS].join(", ")}).`);
    }
  } else if (def.production === "llm") {
    const text = instructionsByKey.get(def.producedBy);
    if (text === undefined) {
      fail(`registry: tag '${tag}' producedBy '${def.producedBy}', which has no config under ${AI_CONFIG_DIR}.`);
    } else if (!text.includes(tag)) {
      fail(`registry: tag '${tag}' is declared produced by '${def.producedBy}', but that agent's instructions never mention it.`);
    }
  } else {
    fail(`registry: tag '${tag}' has invalid production '${def.production}' (expected "llm" or "tool").`);
  }
}

// --- Check 4: README ⟷ registry -------------------------------------------
try {
  const md = readFileSync(README, "utf8");
  const section = md.slice(md.indexOf("Canonical agent tags"));
  const end = section.indexOf("\n## ", 1);
  const table = end === -1 ? section : section.slice(0, end);
  const tableKeys = new Set([...table.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]));
  for (const k of registryKeys) if (!tableKeys.has(k)) fail(`README: tag '${k}' is in the registry but missing from the "Canonical agent tags" table.`);
  for (const k of tableKeys) if (!registryKeys.has(k)) fail(`README: tag '${k}' is in the README table but not in the registry.`);
} catch (e) {
  fail(`README: could not cross-check ${README}: ${e.message}`);
}

// --- Check 5: README ⟷ ai-config files -------------------------------------
try {
  const md = readFileSync(README, "utf8");
  // Filenames referenced anywhere in the README as `autofactory-….json`.
  const readmeFiles = new Set([...md.matchAll(/`(autofactory-[a-z-]+\.json)`/g)].map((m) => m[1]));
  const diskFiles = new Set(configFiles.map((f) => basename(f)));
  for (const f of diskFiles) {
    if (!readmeFiles.has(f)) fail(`README: committed config '${f}' is not mentioned in ${README} (add it to the agents/judges tables).`);
  }
  for (const f of readmeFiles) {
    if (!diskFiles.has(f)) fail(`README: mentions '${f}' but no such file exists under ${AI_CONFIG_DIR}.`);
  }
} catch (e) {
  fail(`README: could not cross-check config files against ${README}: ${e.message}`);
}

// --- Report ---------------------------------------------------------------
// --- Tools (ADR 0011): every variation "tools" name must have a committed
// definition file; every definition file's key must match its filename.
try {
  const TOOLS_DIR = "config/agentcontrol/tools";
  const toolFiles = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".json"));
  const toolKeys = new Set();
  for (const f of toolFiles) {
    const def = JSON.parse(readFileSync(join(TOOLS_DIR, f), "utf8"));
    if (def.key !== f.replace(/\.json$/, "")) fail(`tools: ${f} has key '${def.key}' (must match its filename).`);
    if (!def.description) fail(`tools: ${f} has no description.`);
    toolKeys.add(def.key);
  }
  for (const file of configFiles) {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    for (const v of cfg.variations ?? []) {
      if (v.tools === undefined) continue;
      if (!Array.isArray(v.tools) || !v.tools.every((x) => typeof x === "string")) {
        fail(`${basename(file)}/${v.key}: 'tools' must be an array of tool NAMES.`);
        continue;
      }
      for (const name of v.tools) {
        if (!toolKeys.has(name)) fail(`${basename(file)}/${v.key}: references tool '${name}' with no file under ${TOOLS_DIR}.`);
      }
      if (!v.tools.includes("tag_conversation")) fail(`${basename(file)}/${v.key}: 'tools' must include tag_conversation (chain routing depends on it).`);
    }
  }
} catch (e) {
  fail(`tools: could not validate config/agentcontrol/tools: ${e.message}`);
}

if (configFiles.length === 0) {
  console.error(`✗ no agent configs found under ${AI_CONFIG_DIR}`);
  process.exit(1);
}
if (violations.length) {
  console.error("✗ check-configs found routing-contract violations:\n");
  for (const v of violations) console.error(`    ${v}`);
  console.error(`\ncheck-configs FAILED with ${violations.length} issue(s).`);
  process.exit(1);
}
console.log(`check-configs passed ✓ (${registryKeys.size} registry tags, ${configFiles.length} configs, graph + README consistent)`);
