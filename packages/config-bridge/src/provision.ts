/**
 * Provision agent AI-configs + agent graphs into a target LaunchDarkly project.
 *
 * Idempotent: GETs each resource first and only creates what's missing (backfills
 * variations). Ports the proven one-off behavior:
 *  - the first variation becomes the config's inline `defaultVariation`
 *  - `tools` / `toolKeys` are STRIPPED: our snapshots hold only references
 *    (`{key, version}` / `{{snippet.x}}`), not the tool/snippet definitions, so
 *    they can't be recreated verbatim — re-attach them in LD if needed
 *  - variations that fail (e.g. missing prompt snippet) are reported, not fatal
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeConfigHash, stampDescription, type LdApiError, type LdClient } from "@auto-factory/shared";

/** Fields the variation POST accepts; copy whichever are present. */
const VAR_FIELDS = [
  "key", "name", "comment", "description", "instructions",
  "messages", "model", "modelConfigKey", "judgeConfiguration",
] as const;

export interface ProvisionResult {
  configsCreated: string[];
  configsExisting: string[];
  variationsCreated: number;
  variationsExisting: number;
  toolsStripped: Array<{ config: string; variation: string }>;
  /** Tools-library definitions (config/agentcontrol/tools/) created / found. */
  toolsCreated: string[];
  toolsExisting: string[];
  failures: Array<{ resource: string; status: number; message: unknown }>;
  graphsCreated: string[];
  graphsExisting: string[];
  flagsCreated: string[];
  flagsExisting: string[];
  /** APP-project metrics (config/agentcontrol/metrics/) created / found. */
  metricsCreated: string[];
  metricsExisting: string[];
}

/** A tool-definition file (config/agentcontrol/tools/<key>.json), in the
 *  shape the ai-tools API consumes. Generated from the code registry by
 *  `scripts/export-tools.mjs`; editable in the LD UI after provisioning. */
export interface ToolFile {
  key: string;
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
}

/**
 * Ensure every committed tool definition exists in the project's tools
 * library. Create-only (existing definitions are never touched here — the LD
 * copy is the editable one; `upgrade` owns syncing drift). Returns key →
 * live version, which variation attachment needs (`tools: [{key, version}]`).
 */
export async function provisionTools(
  ld: LdClient,
  toolsDir: string,
  result: ProvisionResult,
  dryRun: boolean,
): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  for (const file of listJson(toolsDir)) {
    const tool = JSON.parse(readFileSync(file, "utf8")) as ToolFile;
    try {
      const existing = await ld.getAiTool<{ version?: number }>(tool.key);
      if (existing.status === 200) {
        result.toolsExisting.push(tool.key);
        versions.set(tool.key, existing.data.version ?? 1);
        continue;
      }
      if (!dryRun) {
        const created = await ld.createAiTool<{ version?: number }>({
          key: tool.key,
          name: tool.name ?? tool.key,
          description: tool.description ?? "",
          ...(tool.schema ? { schema: tool.schema } : {}),
        });
        versions.set(tool.key, created.data.version ?? 1);
      } else {
        versions.set(tool.key, 1);
      }
      result.toolsCreated.push(tool.key);
    } catch (e) {
      const err = e as LdApiError;
      result.failures.push({ resource: `ai-tool ${tool.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
    }
  }
  return versions;
}

interface AiVariation {
  key: string;
  tools?: unknown;
  toolKeys?: unknown;
  [k: string]: unknown;
}
interface AiConfigFile {
  key: string;
  name: string;
  description?: string;
  mode?: string;
  tags?: string[];
  /** Required by the API for mode "judge" (e.g. "$ld:ai:judge:<config-key>"). */
  evaluationMetricKey?: string;
  variations?: AiVariation[];
}
interface AgentGraphFile {
  key: string;
  name: string;
  description?: string;
  rootConfigKey?: string;
  edges?: Array<{ key: string; sourceConfig: string; targetConfig: string; handoff?: unknown }>;
}
/** A flag-creation body (the operational flags the runtime reads, e.g. the
 *  provider selector and the approval gates). Provisioned off/default so the
 *  flag exists and is discoverable in the consumer's LD UI without changing
 *  behavior until they flip it. */
interface FlagFile {
  key: string;
  name: string;
  [k: string]: unknown;
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function mapVariation(
  v: AiVariation,
  configKey: string,
  result: ProvisionResult,
  toolVersions?: Map<string, number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of VAR_FIELDS) if (v[f] !== undefined) out[f] = v[f];
  // Committed variations declare tools as a NAME array; resolve to the
  // {key, version} refs the API wants (ADR 0011). Anything else (e.g. raw
  // refs pulled from a source project by seed) is stripped as before —
  // those reference a DIFFERENT project's tool library.
  const named = Array.isArray(v.tools) && v.tools.every((t) => typeof t === "string") ? (v.tools as string[]) : undefined;
  if (named && toolVersions) {
    const refs = named
      .filter((n) => {
        if (toolVersions.has(n)) return true;
        result.failures.push({ resource: `${configKey}/${v.key} tool '${n}'`, status: 0, message: "no such tool in config/agentcontrol/tools/ — attachment skipped" });
        return false;
      })
      .map((n) => ({ key: n, version: toolVersions.get(n) as number }));
    if (refs.length > 0) out.tools = refs;
  } else if (v.tools !== undefined || v.toolKeys !== undefined) {
    result.toolsStripped.push({ config: configKey, variation: v.key });
  }
  return out;
}

/**
 * The create-config endpoint's inline `defaultVariation` silently DROPS
 * `judgeConfiguration` (verified against the API), so judge attachments on a
 * newly created variation must land via a follow-up variation PATCH. Only runs
 * for variations this provision created — existing variations are never touched.
 */
async function attachJudges(
  ld: LdClient,
  configKey: string,
  v: AiVariation,
  result: ProvisionResult,
  dryRun: boolean,
): Promise<void> {
  if (v.judgeConfiguration === undefined) return;
  try {
    if (!dryRun) await ld.updateAiConfigVariation(configKey, v.key, { judgeConfiguration: v.judgeConfiguration });
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `${configKey}/${v.key} judgeConfiguration`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

/** Mirror of attachJudges for tool attachments: the inline defaultVariation
 *  may drop `tools` the same way it drops judgeConfiguration, so newly created
 *  variations get their tool refs via a follow-up PATCH. Create-path only. */
async function attachTools(
  ld: LdClient,
  configKey: string,
  varKey: string,
  refs: unknown,
  result: ProvisionResult,
  dryRun: boolean,
): Promise<void> {
  if (!Array.isArray(refs) || refs.length === 0) return;
  try {
    if (!dryRun) await ld.updateAiConfigVariation(configKey, varKey, { tools: refs });
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `${configKey}/${varKey} tools`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

async function provisionAiConfig(
  ld: LdClient,
  cfg: AiConfigFile,
  result: ProvisionResult,
  dryRun: boolean,
  toolVersions?: Map<string, number>,
): Promise<void> {
  const variations = cfg.variations ?? [];
  const existing = await ld.getAiConfig<{ variations?: { key: string }[] }>(cfg.key);

  let existingVarKeys = new Set<string>();
  if (existing.status === 200) {
    existingVarKeys = new Set((existing.data.variations ?? []).map((v) => v.key));
    result.configsExisting.push(cfg.key);
  } else {
    const body: Record<string, unknown> = {
      key: cfg.key,
      name: cfg.name,
      description: cfg.description ?? "",
      mode: cfg.mode ?? "agent",
      tags: cfg.tags ?? [],
      // Judge mode requires the evaluation metric key at creation time.
      ...(cfg.evaluationMetricKey ? { evaluationMetricKey: cfg.evaluationMetricKey } : {}),
    };
    let defaultMapped: Record<string, unknown> | undefined;
    if (variations[0]) {
      defaultMapped = mapVariation(variations[0], cfg.key, result, toolVersions);
      body.defaultVariation = defaultMapped;
    }
    try {
      if (!dryRun) await ld.createAiConfig(body);
      result.configsCreated.push(cfg.key);
      result.variationsCreated += variations[0] ? 1 : 0;
      if (variations[0]) {
        existingVarKeys.add(variations[0].key);
        // The inline defaultVariation drops judgeConfiguration — re-attach.
        await attachJudges(ld, cfg.key, variations[0], result, dryRun);
        await attachTools(ld, cfg.key, variations[0].key, defaultMapped?.tools, result, dryRun);
      }
    } catch (e) {
      const err = e as LdApiError;
      result.failures.push({ resource: `ai-config ${cfg.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
      return;
    }
  }

  for (const v of variations) {
    if (existingVarKeys.has(v.key)) {
      result.variationsExisting += 1;
      continue;
    }
    try {
      const mapped = mapVariation(v, cfg.key, result, toolVersions);
      if (!dryRun) await ld.createAiConfigVariation(cfg.key, mapped);
      result.variationsCreated += 1;
      await attachJudges(ld, cfg.key, v, result, dryRun);
      await attachTools(ld, cfg.key, v.key, mapped.tools, result, dryRun);
    } catch (e) {
      const err = e as LdApiError;
      result.failures.push({ resource: `${cfg.key}/${v.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
    }
  }
}

async function provisionGraph(
  ld: LdClient,
  g: AgentGraphFile,
  result: ProvisionResult,
  dryRun: boolean,
  configHash?: string,
): Promise<void> {
  const existing = await ld.getAgentGraph(g.key);
  if (existing.status === 200) {
    result.graphsExisting.push(g.key);
    return;
  }
  const body = {
    key: g.key,
    name: g.name,
    // The [cfg:…] stamp records which repo version provisioned this project;
    // the GHA action compares it against its own checkout to warn on drift.
    description: configHash ? stampDescription(g.description, configHash) : (g.description ?? ""),
    ...(g.rootConfigKey ? { rootConfigKey: g.rootConfigKey } : {}),
    edges: (g.edges ?? []).map((e) => ({
      key: e.key,
      sourceConfig: e.sourceConfig,
      targetConfig: e.targetConfig,
      handoff: e.handoff ?? {},
    })),
  };
  try {
    if (!dryRun) await ld.createAgentGraph(body);
    result.graphsCreated.push(g.key);
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `graph ${g.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

/** Create an operational flag if absent (idempotent; existing flag left untouched). */
async function provisionFlag(ld: LdClient, flag: FlagFile, result: ProvisionResult, dryRun: boolean): Promise<void> {
  // 404-tolerant existence check, so an already-configured flag (and its
  // targeting) is never overwritten.
  const existing = await ld.request({ path: `/api/v2/flags/${ld.projectKey}/${flag.key}`, okStatuses: [404] });
  if (existing.status === 200) {
    result.flagsExisting.push(flag.key);
    return;
  }
  try {
    if (!dryRun) await ld.createFlag(flag);
    result.flagsCreated.push(flag.key);
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `flag ${flag.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

/**
 * Shared APP-project metric definition (config/agentcontrol/metrics/*.json).
 * Written to LD_APP_PROJECT_KEY via a separate LdClient — never the factory project.
 */
export interface MetricFile {
  key: string;
  name?: string;
  description?: string;
  kind?: string;
  eventKey?: string;
  isNumeric?: boolean;
  successCriteria?: string;
  randomizationUnits?: string[];
  tags?: string[];
  unit?: string;
  unitAggregationType?: string;
}

/** Create a shared metric in the APP project if absent (idempotent). */
async function provisionMetric(appLd: LdClient, metric: MetricFile, result: ProvisionResult, dryRun: boolean): Promise<void> {
  try {
    // Existence via create with 409-as-ok (same pattern as runtime ldWriter).
    if (dryRun) {
      const list = await appLd.listMetrics<{ items?: Array<{ key: string }> }>(200);
      if ((list.data.items ?? []).some((m) => m.key === metric.key)) {
        result.metricsExisting.push(metric.key);
      } else {
        result.metricsCreated.push(metric.key);
      }
      return;
    }
    const body: Record<string, unknown> = {
      key: metric.key,
      name: metric.name ?? metric.key,
      ...(metric.description ? { description: metric.description } : {}),
      kind: metric.kind ?? "custom",
      ...(metric.eventKey ? { eventKey: metric.eventKey } : {}),
      isNumeric: metric.isNumeric ?? false,
      ...(metric.successCriteria ? { successCriteria: metric.successCriteria } : {}),
      randomizationUnits: metric.randomizationUnits ?? ["user"],
      tags: metric.tags ?? ["auto-factory"],
      ...(metric.unit ? { unit: metric.unit } : {}),
      ...(metric.unitAggregationType ? { unitAggregationType: metric.unitAggregationType } : {}),
    };
    const res = await appLd.createMetric(body);
    if (res.status === 409) {
      result.metricsExisting.push(metric.key);
    } else {
      result.metricsCreated.push(metric.key);
    }
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `metric ${metric.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

export interface ProvisionOptions {
  /** Directory of AI-config JSON files. */
  aiConfigsDir: string;
  /** Directory of agent-graph JSON files. */
  graphsDir: string;
  /**
   * Directory of operational-flag JSON files. Default
   * `config/agentcontrol/flags`. These are repo-owned operational defaults (NOT
   * pulled from a source project), so the seed path provisions them too.
   */
  flagsDir?: string;
  /**
   * Directory of tool-definition JSON files (the AgentControl tools library,
   * ADR 0011). Default `config/agentcontrol/tools`. Repo-owned defaults, like
   * the flags — provisioned for both `provision` and `seed`.
   */
  toolsDir?: string;
  /**
   * Directory of shared APP-project metric defs (ADR 0014 Sentry guardrails).
   * Default `config/agentcontrol/metrics`. Provisioned into `appLd`, not factory.
   */
  metricsDir?: string;
  /**
   * LdClient for the APP / data-plane project. Required to provision shared
   * metrics (sentry-errors*). When omitted, metrics are skipped with a log.
   */
  appLd?: LdClient;
  /** When true, perform reads only — report what would be created without writing. */
  dryRun?: boolean;
}

export async function provision(ld: LdClient, opts: ProvisionOptions): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    configsCreated: [], configsExisting: [], variationsCreated: 0, variationsExisting: 0,
    toolsStripped: [], toolsCreated: [], toolsExisting: [],
    failures: [], graphsCreated: [], graphsExisting: [], flagsCreated: [], flagsExisting: [],
    metricsCreated: [], metricsExisting: [],
  };
  const dryRun = opts.dryRun ?? false;
  const toolsDir = opts.toolsDir ?? "config/agentcontrol/tools";

  // Tools first: variations reference them as {key, version}, so the library
  // must exist before any variation create.
  const toolVersions = await provisionTools(ld, toolsDir, result, dryRun);

  // Judge-mode configs next: agent variations may carry a `judgeConfiguration`
  // that references a judge by key, so the judges must exist before the agents.
  const aiConfigs = listJson(opts.aiConfigsDir)
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as AiConfigFile)
    .sort((a, b) => Number(b.mode === "judge") - Number(a.mode === "judge"));
  for (const cfg of aiConfigs) {
    await provisionAiConfig(ld, cfg, result, dryRun, toolVersions);
  }
  // Graphs after configs — they reference config keys.
  const configHash = computeConfigHash({
    aiConfigsDir: opts.aiConfigsDir,
    graphsDir: opts.graphsDir,
    flagsDir: opts.flagsDir ?? "config/agentcontrol/flags",
    toolsDir,
  });
  for (const file of listJson(opts.graphsDir)) {
    const g = JSON.parse(readFileSync(file, "utf8")) as AgentGraphFile;
    await provisionGraph(ld, g, result, dryRun, configHash);
  }
  // Operational flags (provider selector, approval gates). Always from the
  // repo's committed defs, so this runs for both `provision` and `seed`.
  for (const file of listJson(opts.flagsDir ?? "config/agentcontrol/flags")) {
    const flag = JSON.parse(readFileSync(file, "utf8")) as FlagFile;
    await provisionFlag(ld, flag, result, dryRun);
  }
  // Shared APP metrics (Sentry-backed guardrails). Separate project.
  const metricsDir = opts.metricsDir ?? "config/agentcontrol/metrics";
  const metricFiles = listJson(metricsDir);
  if (metricFiles.length > 0 && opts.appLd) {
    for (const file of metricFiles) {
      const metric = JSON.parse(readFileSync(file, "utf8")) as MetricFile;
      await provisionMetric(opts.appLd, metric, result, dryRun);
    }
  } else if (metricFiles.length > 0 && opts.metricsDir) {
    // Caller explicitly asked for a metrics dir but didn't pass appLd.
    console.warn(
      `[provision] ${metricFiles.length} metric def(s) in ${metricsDir} skipped — pass appLd (LD_APP_PROJECT_KEY) to provision APP metrics`,
    );
  }
  return result;
}
