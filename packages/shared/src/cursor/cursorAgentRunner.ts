/**
 * Cursor implementation of the `AgentRunner` seam (the third provider, alongside
 * Anthropic and Vega; see ADR 0006).
 *
 * Runs the AutoFactory agent graph LOCALLY through the Cursor Agent SDK
 * (`@cursor/sdk`). The graph walker still deterministically resolves the LD
 * agent graph and dispatches one node at a time; this runner just executes each
 * node as one Cursor agent run. The agent's instructions, model, and model
 * parameters are resolved NATIVELY by the LaunchDarkly AI SDK and passed in via
 * `AgentNodeRequest` — so the agents are LaunchDarkly-authored regardless of
 * which provider runs them.
 *
 * Three SDK realities shape this (documented inline + in ADR 0006):
 *   1. The Cursor SDK has no system-prompt parameter, so the LD instructions are
 *      PREPENDED to the message (with the same `modeNote` the Anthropic path
 *      appends, so behavior matches across providers).
 *   2. Routing tags + LD writes have no built-in equivalent, so the existing
 *      `SandboxToolExecutor` tools are registered as Cursor `customTools`
 *      (local-only — hence `local: { cwd }`, not a cloud agent). Reusing the same
 *      executor keeps flag/metric idempotency and the git/commit semantics
 *      identical to the Anthropic path; only the model brain changes.
 *   3. The model id is mapped from the LD config to Cursor's catalog
 *      (see cursorModel.ts). Inference runs on Cursor's hosted models, NOT
 *      LaunchDarkly's Bedrock instance.
 *
 * Measurement: per-node generation metrics (duration, token usage, success/
 * error) are recorded to LaunchDarkly through the AI-config `tracker`, exactly
 * as the Anthropic runner does — so Cursor runs show up in the same AI Config
 * monitoring dashboards as the other providers.
 */

import type { ModelListItem, SDKAgent, SDKCustomTool, SDKJsonValue, TokenUsage } from "@cursor/sdk";
import type { AgentNodeRequest, AgentNodeResult, AgentRunner, AgentStatus } from "../agentRunner.js";
import { missingRequiredTags, modeNote, resolveGrant } from "../anthropic/anthropicAgentRunner.js";
import type { KnowledgeGraph } from "../graph/schema.js";
import { type RelatedRepo, RelatedReposClient } from "../github/relatedRepos.js";
import type { LdResourceWriter } from "../anthropic/ldWriter.js";
import {
  type AnthropicToolDef,
  type GitMode,
  SandboxToolExecutor,
  type ToolCapabilities,
  applyLdToolOverlay,
  buildSandboxTools,
} from "../anthropic/sandboxTools.js";
import { startAiSpan } from "../observability.js";
import { mapModelParameters, mapToCursorModel } from "./cursorModel.js";

/** Cursor model used when the LD-configured model can't be mapped to the catalog. */
const DEFAULT_FALLBACK_MODEL = "auto";

/**
 * `@cursor/sdk` is loaded LAZILY (dynamic import), for two reasons:
 *   - It's a webpack-style bundle with dynamic chunk loading + an optional
 *     `bun:sqlite`, so esbuild can't inline it — the action bundle marks it
 *     external and resolves it from node_modules at runtime.
 *   - Only the `cursor` provider needs it, so the Anthropic/Vega paths never
 *     load it (and don't require Node >=22.13 or the package to be installed).
 */
type CursorSdk = typeof import("@cursor/sdk");
let cursorSdkPromise: Promise<CursorSdk> | undefined;
function loadCursorSdk(): Promise<CursorSdk> {
  if (!cursorSdkPromise) cursorSdkPromise = import("@cursor/sdk");
  return cursorSdkPromise;
}

export interface CursorAgentRunnerOptions {
  /** Absolute path the agent + sandbox tools operate within (the repo / checkout). */
  sandboxRoot: string;
  /** Cursor API key; falls back to CURSOR_API_KEY in the env. */
  apiKey?: string;
  /** Fallback Cursor model id (CURSOR_MODEL) when the LD model can't be mapped. */
  model?: string;
  /** When provided, `create_flag` / `create_metric` are enabled for capable nodes. */
  writer?: LdResourceWriter;
  /** When true, file-edit + commit/push tools are enabled for capable nodes. */
  codeChangesEnabled?: boolean;
  /** PR head branch the git tools push to. */
  prBranch?: string;
  /** PR base ref the git_diff tool diffs against. */
  prBaseRef?: string;
  /** How `commit_and_push` finalizes edits: "push" (default) or "workingTree". */
  gitMode?: GitMode;
  /**
   * Composed knowledge graph for this run (ADR 0010). Presence is the global
   * enable for `query_dependencies` — same contract as the Anthropic runner.
   */
  knowledgeGraph?: KnowledgeGraph;
  /** Repo-relative files changed in this PR (blast-radius input). */
  changedFiles?: string[];
  /** Related repos (query_related_repos) — same contract as the Anthropic runner. */
  relatedRepos?: RelatedRepo[];
  /** Token for cross-repo reads; falls back to GITHUB_TOKEN in the env. */
  githubToken?: string;
}

/** Convert the shared sandbox tool defs into Cursor `customTools` backed by one executor. */
function toCursorTools(
  defs: AnthropicToolDef[],
  executor: SandboxToolExecutor,
  used?: Set<string>,
): Record<string, SDKCustomTool> {
  const tools: Record<string, SDKCustomTool> = {};
  for (const d of defs) {
    tools[d.name] = {
      description: d.description,
      inputSchema: d.input_schema as unknown as Record<string, SDKJsonValue>,
      execute: async (args: Record<string, SDKJsonValue>) => {
        used?.add(d.name);
        const r = await executor.execute(d.name, (args ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: r.content }], isError: r.isError ?? false };
      },
    };
  }
  return tools;
}

/** Field-wise sum of two token-usage snapshots (either may be undefined). */
function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export class CursorAgentRunner implements AgentRunner {
  private readonly apiKey?: string;
  private readonly fallbackModel: string;
  /** Cursor model catalog, loaded once on first use. */
  private catalog?: ModelListItem[];

  constructor(private readonly opts: CursorAgentRunnerOptions) {
    this.apiKey = opts.apiKey ?? process.env.CURSOR_API_KEY;
    this.fallbackModel = opts.model ?? process.env.CURSOR_MODEL ?? DEFAULT_FALLBACK_MODEL;
  }

  /** Lazy-load the model catalog; never throws (an empty catalog → fallback model). */
  private async loadCatalog(): Promise<ModelListItem[]> {
    if (this.catalog) return this.catalog;
    try {
      const { Cursor } = await loadCursorSdk();
      this.catalog = (await Cursor.models.list(this.apiKey ? { apiKey: this.apiKey } : undefined)) as ModelListItem[];
    } catch (e) {
      console.warn(`[cursor] could not list models (${e instanceof Error ? e.message : e}); using fallback '${this.fallbackModel}'`);
      this.catalog = [];
    }
    return this.catalog;
  }

  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    // Effective capabilities = this node's grant ∩ globally-enabled features.
    // Shared with the Anthropic runner so "which agent can write" is identical.
    const { grant, source } = resolveGrant(req.configKey, req.capabilities);
    const caps: ToolCapabilities = {
      createFlag: grant.createFlag && this.opts.writer !== undefined,
      // Read-only, but needs the LD connection the writer carries.
      flagState: grant.flagState === true && this.opts.writer !== undefined,
      createMetric: grant.createMetric && this.opts.writer !== undefined,
      editFiles: grant.editFiles && this.opts.codeChangesEnabled === true,
      // Manifest writes are code changes — same global toggle as editFiles.
      writeManifest: grant.writeManifest === true && this.opts.codeChangesEnabled === true,
      stewardManifest: grant.stewardManifest === true && this.opts.codeChangesEnabled === true,
      // Read-only; globally enabled by the presence of a composed graph (KG flag).
      queryGraph: grant.queryGraph === true && this.opts.knowledgeGraph !== undefined,
      // Read-only; soft when SENTRY_* unset (estate picture returns available:false).
      querySentry: grant.querySentry === true,
      // Read-only; no global gate (fetch failures degrade inside the tool).
      readDocs: grant.readDocs === true,
      // Read-only; globally enabled by a registered relatedRepos list + a token.
      queryRepos:
        grant.queryRepos === true &&
        (this.opts.relatedRepos?.length ?? 0) > 0 &&
        Boolean(this.opts.githubToken ?? process.env.GITHUB_TOKEN),
    };
    console.log(
      `[node] ${req.configKey} grant(${source}): createFlag=${grant.createFlag} flagState=${grant.flagState === true} createMetric=${grant.createMetric} editFiles=${grant.editFiles} readDocs=${grant.readDocs === true} queryGraph=${grant.queryGraph === true} querySentry=${grant.querySentry === true} queryRepos=${grant.queryRepos === true} → effective createFlag=${caps.createFlag} flagState=${caps.flagState === true} createMetric=${caps.createMetric} editFiles=${caps.editFiles} readDocs=${caps.readDocs === true} queryGraph=${caps.queryGraph === true} querySentry=${caps.querySentry === true} queryRepos=${caps.queryRepos === true}`,
    );
    const writer = caps.createFlag || caps.createMetric || caps.flagState ? this.opts.writer : undefined;

    const executor = new SandboxToolExecutor(
      this.opts.sandboxRoot,
      writer,
      caps.editFiles,
      this.opts.prBranch,
      this.opts.prBaseRef,
      this.opts.gitMode ?? "push",
      caps.writeManifest === true && this.opts.codeChangesEnabled === true,
      caps.stewardManifest === true && this.opts.codeChangesEnabled === true,
    );
    if (caps.queryGraph && this.opts.knowledgeGraph) {
      executor.provideKnowledgeGraph(this.opts.knowledgeGraph, this.opts.changedFiles ?? []);
    }
    if (caps.queryRepos && this.opts.relatedRepos) {
      executor.provideRelatedRepos(
        new RelatedReposClient(this.opts.relatedRepos, this.opts.githubToken ?? process.env.GITHUB_TOKEN ?? ""),
      );
    }
    // LD variation tool attachments shape the interface within the capability
    // ceiling (ADR 0011) — same overlay as the Anthropic runner.
    const overlay = applyLdToolOverlay(buildSandboxTools(caps), req.ldTools);
    if (overlay.unknown.length > 0) {
      console.warn(
        `[node] ${req.configKey} LD variation attaches tool(s) with no local implementation: ${overlay.unknown.join(", ")} — ignored`,
      );
    }
    const toolCallsUsed = new Set<string>();
    const customTools = toCursorTools(overlay.tools, executor, toolCallsUsed);

    // Resolve the Cursor model + parameters from the LaunchDarkly AI config.
    const catalog = await this.loadCatalog();
    const match = mapToCursorModel(req.model, catalog, this.fallbackModel);
    const modelDef = catalog.find((m) => m.id === match.id);
    const { params, dropped } = mapModelParameters(req.modelParameters, modelDef);
    const paramSummary =
      `params: ${params.map((p) => `${p.id}=${p.value}`).join(", ") || "none"}` +
      (dropped.length ? `; LD params with no Cursor equivalent: ${dropped.join(", ")}` : "");
    // The model SHOULD come from the LD AI config. When one IS configured but has
    // no Cursor-catalog match, warn loudly (we still proceed on the fallback — by
    // default 'auto', so Cursor selects the model) rather than silently swapping
    // the configured model. No configured model → just an info log.
    if (req.model && !match.matched) {
      console.warn(
        `[node] ${req.configKey} ⚠ LD-configured model '${req.model}' has no Cursor-catalog match — ` +
          `falling back to '${match.id}'${match.id === "auto" ? " (Cursor selects the model)" : ""}. ` +
          `Set a Cursor-recognized model on the AI config to pin it. ${paramSummary}`,
      );
    } else {
      console.log(`[node] ${req.configKey} cursor model → '${match.id}' (${match.reason}); ${paramSummary}`);
    }

    // No system-prompt param in the SDK → prepend the LD instructions + the
    // shared capability/tagging note, then the run prompt. The Sentry note is
    // keyed to the variation's offered tools, not the shared edge ceiling.
    const offered = new Set(overlay.tools.map((t) => t.name));
    const preamble =
      (req.instructions ?? "") + modeNote({ ...caps, querySentry: caps.querySentry && offered.has("query_sentry") });
    const message = `${preamble}\n\n---\n\n${req.prompt}`;

    let status: AgentStatus = "completed";
    let finalText = "";
    let usage: TokenUsage | undefined;
    let agent: SDKAgent | undefined;
    const started = Date.now();

    // Manual gen_ai span (Cursor hosts inference) — dual-write to LD + Sentry.
    const span = startAiSpan(`chat ${req.configKey}`, { op: "gen_ai.chat" });

    try {
      const { Agent } = await loadCursorSdk();
      agent = await Agent.create({
        ...(this.apiKey ? { apiKey: this.apiKey } : {}),
        model: { id: match.id, ...(params.length ? { params } : {}) },
        // Local agent: cwd is the repo under review. customTools (LD writes,
        // tagging, git) are local-only — the reason this provider isn't a cloud agent.
        //
        // settingSources: [] makes the run HERMETIC: a Cursor local agent would
        // otherwise load the analyzed repo's ambient `.cursor/` settings (rules +
        // mcp.json). That repo may ship its own AutoFactory rule and a LaunchDarkly
        // MCP server, which would run ALONGSIDE this agent — letting it follow extra
        // instructions or create flags via MCP, bypassing our idempotent writer and
        // routing tags. The agent's behavior must come from the LD AI config alone
        // (parity with the Anthropic path), so we load no ambient settings.
        local: { cwd: this.opts.sandboxRoot, customTools, settingSources: [] },
        mode: "agent",
      });

      const run = await agent.send(message);
      const result = await run.wait();
      finalText = result.result ?? "";
      usage = result.usage;
      if (result.status !== "finished") status = result.status === "cancelled" ? "cancelled" : "failed";

      // Safety net: if the agent finished without recording the routing tag(s)
      // its node owns, send one more turn forcing a `tag_conversation` call, so
      // the chain can't silently stall or yield a misleading verdict (issue #9).
      // Same intent as the Anthropic runner's forced final tag call.
      if (status === "completed") {
        const missing = missingRequiredTags(req.configKey, executor.tags);
        if (missing.length > 0) {
          try {
            const forcePrompt =
              `Before finishing you MUST record your routing decision. You have not set the required tag(s): ${missing.join(", ")}. ` +
              "Call `tag_conversation` now with a `tags` object, choosing the correct value(s) per your instructions.";
            const forcedRun = await agent.send(forcePrompt);
            const forced = await forcedRun.wait();
            usage = addUsage(usage, forced.usage);
            const stillMissing = missingRequiredTags(req.configKey, executor.tags);
            console.log(
              `[node] ${req.configKey} forced tag_conversation for missing [${missing.join(", ")}] → now ${
                stillMissing.length ? `still missing [${stillMissing.join(", ")}]` : "all present"
              }`,
            );
          } catch (e) {
            console.warn(`[node] ${req.configKey} forced tag call failed (non-fatal): ${e instanceof Error ? e.message : e}`);
          }
        }
      }

      if (status === "completed") req.tracker?.trackSuccess();
      else req.tracker?.trackError();
    } catch (e) {
      status = "failed";
      finalText = e instanceof Error ? e.message : String(e);
      req.tracker?.trackError();
      span.recordException(e);
    } finally {
      req.tracker?.trackDuration(Date.now() - started);
      // Tool-invocation telemetry (AI Config monitoring's tool dimension).
      if (toolCallsUsed.size > 0) {
        try {
          req.tracker?.trackToolCalls([...toolCallsUsed]);
        } catch {
          /* telemetry must never fail the node */
        }
      }
      if (usage) {
        req.tracker?.trackTokens({ input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens });
      }
      span.setGenAi({
        provider: "cursor",
        requestModel: match.id,
        agentName: req.configKey,
        ...(req.tracker ? { tracker: req.tracker } : {}),
        prompt: message,
        output: finalText,
        ...(usage ? { usage: { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens } } : {}),
      });
      span.end(status === "completed" ? "ok" : "error");
      if (agent) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          /* best-effort cleanup */
        }
      }
    }

    return {
      status,
      messages: [{ role: "assistant", content: finalText, isFinal: true }],
      tags: { ...executor.tags },
    };
  }
}
