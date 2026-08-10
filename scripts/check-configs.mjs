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
const instructionsOf = (p) => JSON.parse(readFileSync(p, "utf8")).variations?.[0]?.instructions ?? "";
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

// --- Check 6: loop-back budgets + walker tag-class sync -------------------
// 6a: `max_visits` on any edge must be an integer in [1, 10]. 6b: removing every
// max_visits-tagged edge must leave an ACYCLIC graph — i.e. every cycle carries a
// budget on at least one edge, so the walker can't run it to the node-run cap.
const MAX_VISITS_HARD_CAP = 10;
for (const file of listJson(GRAPH_DIR)) {
  const graph = JSON.parse(readFileSync(file, "utf8"));
  const adjUntagged = new Map(); // source -> [target] for edges WITHOUT max_visits
  // 6d: `loop_if_judge_below` must be a number in [0, 1] and only on a budgeted edge
  // (an unbudgeted judge loop would run to the node-run cap). 6e: ANY loop edge must
  // be declared BEFORE the other edges from the same source — the walker takes the
  // first passing edge, so a loop declared after a forward edge that can pass is dead
  // config with no runtime signal. This applies to every max_visits edge, not just
  // judge-driven ones: a plain verdict loop is equally killable by a forward edge
  // added above it.
  const seenSourceEdge = new Set();      // any edge seen from this source
  const seenNonLoopSource = new Set();   // a NON-loop edge seen from this source
  for (const edge of graph.edges ?? []) {
    const mv = edge.handoff?.max_visits;
    const below = edge.handoff?.loop_if_judge_below;
    if (below !== undefined) {
      if (typeof below !== "number" || !Number.isFinite(below) || below < 0 || below > 1) {
        fail(`graph: edge ${edge.sourceConfig} → ${edge.targetConfig} has loop_if_judge_below=${JSON.stringify(below)} (must be a number in [0, 1]).`);
      }
      if (mv === undefined) {
        fail(`graph: edge ${edge.sourceConfig} → ${edge.targetConfig} has loop_if_judge_below but no max_visits — an unbudgeted quality loop runs to the node-run cap.`);
      }
    }
    // 6f: a LOOP edge's conditions on ROUTING tags must name tags its SOURCE node can
    // produce. The walker matches loop-edge routing conditions against the source
    // run's own tags (so a stale verdict can't re-fire the loop), which means a
    // condition on another node's llm tag can never be satisfied — the loop would be
    // dead config with no runtime signal. Fact tags are exempt: they're never rewound
    // and legitimately come from upstream.
    if (mv !== undefined) {
      for (const kind of ["require_tags", "skip_if_tags"]) {
        for (const tag of Object.keys(edge.handoff?.[kind] ?? {})) {
          const def = registry[tag];
          if (!def || def.production !== "llm") continue;
          if (def.producedBy !== edge.sourceConfig) {
            // The consequence is opposite per kind, so say the right one: an unsatisfiable
            // require_tags means the loop never fires; an unreachable skip_if exit means it
            // fires every pass until budget. Printing "never fires" for both would send a
            // reader looking for the wrong symptom.
            const consequence =
              kind === "require_tags"
                ? "this condition can never be satisfied, so the loop would never fire"
                : "this exit can never match, so the loop would run to its full budget every time";
            fail(
              `graph: loop edge ${edge.sourceConfig} → ${edge.targetConfig} gates on '${tag}' (${kind}), ` +
                `which is produced by '${def.producedBy}', not by the edge's source. The walker matches a loop edge's ` +
                `routing conditions against the source run's OWN tags, so ${consequence}.`,
            );
          }
        }
      }
    }
    // Multiple loop edges from one source are legitimate (each has its own condition
    // and budget), so only a preceding NON-loop edge is a problem.
    if (mv !== undefined && seenNonLoopSource.has(edge.sourceConfig)) {
      fail(
        `graph: the loop edge ${edge.sourceConfig} → ${edge.targetConfig} (max_visits: ${mv}) is declared AFTER a non-loop edge from '${edge.sourceConfig}'. ` +
          `The walker takes the first passing edge, so this loop may never fire. Move it above the forward edges — a loop edge's own ` +
          `conditions decide whether it fires, so ordering it first is always safe.`,
      );
    }
    seenSourceEdge.add(edge.sourceConfig);
    if (mv === undefined) seenNonLoopSource.add(edge.sourceConfig);
    if (mv !== undefined) {
      if (!Number.isInteger(mv) || mv < 1 || mv > MAX_VISITS_HARD_CAP) {
        fail(`graph: edge ${edge.sourceConfig} → ${edge.targetConfig} has max_visits=${JSON.stringify(mv)} (must be an integer in [1, ${MAX_VISITS_HARD_CAP}]).`);
      }
    } else {
      if (!adjUntagged.has(edge.sourceConfig)) adjUntagged.set(edge.sourceConfig, []);
      adjUntagged.get(edge.sourceConfig).push(edge.targetConfig);
    }
  }
  // DFS cycle detection over the untagged subgraph (white/gray/black).
  const color = new Map();
  let cycleNode = null;
  const visit = (n) => {
    color.set(n, "gray");
    for (const m of adjUntagged.get(n) ?? []) {
      const c = color.get(m);
      if (c === "gray") { cycleNode = m; return true; }
      if (c === undefined && visit(m)) return true;
    }
    color.set(n, "black");
    return false;
  };
  for (const n of adjUntagged.keys()) {
    if (color.get(n) === undefined && visit(n)) break;
  }
  if (cycleNode) {
    fail(`graph ${basename(file)}: a cycle through '${cycleNode}' has no max_visits on any of its edges — the walker would run it to the node-run cap. Tag the loop-back edge with max_visits.`);
  }
}
// 6c: the walker's hard-coded ROUTING_TAGS/FACT_TAGS (graphWalker.ts) must match
// tags.json `production` (llm → routing/rewound, tool → fact/inventory), or a
// loop rewind would drop/keep the wrong tags.
try {
  const walkerSrc = readFileSync("packages/shared/src/graphWalker.ts", "utf8");
  const parseSet = (name) => {
    const m = walkerSrc.match(new RegExp(`const ${name} = new Set<string>\\(\\[([\\s\\S]*?)\\]\\)`));
    return m ? new Set([...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])) : null;
  };
  const routing = parseSet("ROUTING_TAGS");
  const fact = parseSet("FACT_TAGS");
  if (!routing || !fact) {
    fail("graphWalker.ts: could not parse ROUTING_TAGS/FACT_TAGS for the tag-class sync check.");
  } else {
    for (const [tag, def] of Object.entries(registry)) {
      if (def.production === "llm" && !routing.has(tag)) fail(`graphWalker ROUTING_TAGS is missing '${tag}' (tags.json production:"llm").`);
      if (def.production === "tool" && !fact.has(tag)) fail(`graphWalker FACT_TAGS is missing '${tag}' (tags.json production:"tool").`);
    }
    for (const t of routing) if (registry[t]?.production !== "llm") fail(`graphWalker ROUTING_TAGS has '${t}', not production:"llm" in tags.json.`);
    for (const t of fact) if (registry[t]?.production !== "tool") fail(`graphWalker FACT_TAGS has '${t}', not production:"tool" in tags.json.`);
  }
} catch (e) {
  fail(`graphWalker.ts: could not run tag-class sync check: ${e.message}`);
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
