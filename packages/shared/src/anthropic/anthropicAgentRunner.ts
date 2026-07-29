/**
 * Anthropic implementation of the `AgentRunner` seam.
 *
 * Runs the AutoFactory agent graph LOCALLY. The agent's instructions and model
 * are resolved NATIVELY by the LaunchDarkly AI SDK (the graph walker passes the
 * already-interpolated `instructions`, `model`, and a per-node `tracker` from the
 * `LDAIAgentConfig`). This runner just executes: it drives an Anthropic tool-use
 * loop with a read-only sandbox tool set (see sandboxTools.ts) and records
 * generation metrics to LaunchDarkly via the tracker.
 *
 * This is the piece Vega's `agentDispatch` does NOT do — Vega runs built-in
 * personas and ignores the AI config's instructions. Here the LD-authored
 * instructions ARE the agent.
 *
 * Sandbox / dry-run: the agents cannot write to LaunchDarkly, git, or the repo.
 * They inspect the code and emit routing tags via `tag_conversation`, which is
 * what the graph walker needs to advance the chain. Promote to write tools (LD
 * flag creation, git) for in-pipeline runs without touching the walker.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentNodeRequest, AgentNodeResult, AgentRunner, AgentStatus } from "../agentRunner.js";
import { startAiSpan } from "../observability.js";
import type { KnowledgeGraph } from "../graph/schema.js";
import { type RelatedRepo, RelatedReposClient } from "../github/relatedRepos.js";
import type { LdResourceWriter } from "./ldWriter.js";
import { type GitMode, SandboxToolExecutor, type ToolCapabilities, applyLdToolOverlay, buildSandboxTools } from "./sandboxTools.js";

const TAGGING_NOTE = `

You MUST call \`tag_conversation\` with the routing tag(s) your instructions specify
(e.g. skip_flagging, flag_worthy, flag_action, needs_tests, review_approved,
risk_level). The downstream chain advances on these tags — a step that sets no tags
stalls the pipeline. (flag_ready/flag_created/flag_key/flag_variation are set by the
flag tools themselves on success, never via tag_conversation.)`;

/**
 * Build the execution-mode note appended to the agent's instructions, per
 * capabilities. Exported so every provider (Anthropic, Cursor) appends the SAME
 * capability + tagging guidance — the agents must behave identically across
 * providers so only the model brain differs, not the instructions.
 */
export function modeNote(caps: ToolCapabilities): string {
  const lines = [
    "\n\n---\n## EXECUTION MODE",
    "You have read-only repo tools (`read_file`, `list_dir`, `grep`).",
  ];
  if (caps.queryGraph) {
    lines.push(
      "You have `query_dependencies` — the estate's knowledge graph (service call edges observed from LaunchDarkly telemetry + flag→code wrap points). Call it with NO arguments EARLY to get this PR's blast radius (changed services, dependent services at risk, upstream contracts, flags already on the changed code) and let it inform your classification and risk_score. Treat any entry in its `gaps` list as UNKNOWN coverage — a thin graph is never evidence of low impact.",
    );
  }
  if (caps.querySentry) {
    lines.push(
      "You have `query_sentry` — a Sentry estate picture (top issues, error volume, whether recent errors carry `launchdarklyContext`, dual-export hints for otel*). Call it EARLY when choosing error killswitches or when the repo has Sentry. It does not create LD metrics; attach sentry-errors-* / otel* via list_metrics + write_manifest. Never treat Sentry Explore aggregates as guarded-release backings (ADR 0015).",
    );
  }
  if (caps.queryRepos) {
    lines.push(
      "You have `query_related_repos` — the estate's OTHER repositories, registered by this repo (relatedRepos in .autofactory/services.yaml). Call op='list' EARLY, then establish upstream/downstream impact of the concrete surfaces this PR touches (endpoint paths, event names, shared types, flag keys). EVIDENCE PROTOCOL: op='search' first; when search rate-limits or returns nothing, NAVIGATE instead — op='list_dir' the repo, op='read_file' the module serving the consumed surface; flag gates read like isEnabled(\"<flag-key>\") with the key declared as a constant near the top of the gated module. A flag key you report MUST be the exact string from the code — never a guess, never prose. If your output contract includes cross_repo_impact / prerequisite_flag_recommendation sections, ground them in this evidence (repo+path); if you are CONSUMING a brief's cross-repo claim (e.g. a parent flag key), verify it here before acting on it or downgrading it. No search hits is weak evidence, never proof of no impact.",
    );
  }
  if (caps.readDocs) {
    lines.push(
      "You have `read_ld_docs` — LaunchDarkly documentation pages as markdown. Consult it when UNCERTAIN about LaunchDarkly semantics or SDK syntax (never guess `track()`/evaluation syntax for a language the repo doesn't demonstrate); your instructions list the relevant pages, and 'llms.txt' is the full directory. Budget your fetches; a failed fetch must never block the task — fall back to the repo's existing patterns.",
    );
  }
  if (caps.flagState) {
    lines.push(
      "You have `get_flag_state` — a LaunchDarkly flag's existence, kind (boolean vs multivariate), variation lineage (control/v1/v2…), and per-environment TARGETING state including a computed released-ness verdict per treatment variation. Call it for EVERY flag key gating code this PR touches (grep the diff for evaluation calls): whether the flagged behavior is already serving real traffic is what separates 'ride the existing variation' from 'iterate with a new one'. If the tool is unavailable or fails, treat targeting state as UNKNOWN and say so — never assume.",
    );
  }
  if (caps.createFlag) {
    lines.push(
      "You have the flag-action suite (all idempotent; safe on PR re-runs): `create_flag` — creates a REAL string-multivariate flag (control + v1, dark) in the LaunchDarkly app project; `add_variation` — appends the next vN to an existing multivariate flag (the iteration path when its treatment is already released; pass the target value from the brief/manifest); `use_existing_flag` — VERIFIES an existing unreleased variation covers this PR with no LaunchDarkly change (it refuses if the variation is released). Execute the flag_action your brief decided with the matching tool — the chain advances only on a successful call (they set flag_ready/flag_key/flag_variation).",
    );
  }
  if (caps.createMetric) {
    lines.push(
      "You have `create_metric` — creates a REAL guarded-release metric in the LaunchDarkly app project (idempotent). Event-backed (default): FIRST instrument the event in code (a LaunchDarkly `track(event_key, …)` call on the path the flag wraps, via `edit_file`), then call `create_metric` with the matching `event_key`. Trace-backed: pass `trace_query` instead when your Metric Backing rules allow it (flag evaluated inside the matched spans) — no instrumentation needed. You also have `list_metrics` — check for EXISTING global/autogenerated metrics before minting feature-specific ones (net-new feature paths should be guarded by global metrics; see Metric Backing). Creating the metric before signals flow is expected.",
    );
  }
  if (caps.writeManifest || caps.stewardManifest) {
    lines.push(
      caps.stewardManifest
        ? "You have `write_manifest` (STEWARD grade): you may create/update the release manifest INCLUDING an existing `releaseIntent` — you are the only agent allowed to touch a human's intent, and only to normalize/structure it, never to broaden it (e.g. never flip hold→auto)."
        : "You have `write_manifest` — create/update the release manifest (.release-flags/pr-<N>.json) by passing only the fields you own (flagKey, scope, releasePlan.*). It merges, auto-initializes the human-editable `releaseIntent` skeleton, PRESERVES any existing intent, and commits automatically. Never write manifests with other tools.",
    );
  }
  if (caps.editFiles) {
    lines.push(
      "You have `write_file`, `edit_file`, `run_tests`, and `commit_and_push`. EXECUTE your job for real: make the file changes your instructions describe (e.g. wire the flag into the code, or add the test file). If you wrote or changed tests, call `run_tests` to confirm they pass and FIX any failures before committing. Then call `commit_and_push` ONCE to land your changes on the PR branch. Match the existing code patterns you find.",
    );
  } else {
    lines.push("You CANNOT edit files or push commits — describe what you would change and tag accordingly.");
  }
  lines.push("Keep exploration focused, then finish with a short brief for the next agent.");
  return lines.join("\n") + TAGGING_NOTE;
}

const DEFAULT_MAX_TURNS = 12;
const MAX_TOKENS = 4096;
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * FALLBACK per-node capability grants, used only when the graph edge doesn't
 * declare a `capabilities` array (see `resolveGrant`). Prefer putting grants on
 * the graph edges so "which agent can write" is config, not code — this map is a
 * safety net for graphs that predate that and is keyed by config key (so it
 * silently misses renamed agents; the per-node log makes that diagnosable).
 */
const NODE_CAPABILITIES: Record<string, ToolCapabilities> = {
  // ROOT node: edges can't grant capabilities to it (grants ride inbound
  // handoffs), so the research planner's narrow manifest-write power lives here.
  // queryGraph: the planner's blast-radius input (ADR 0010) — only offered when
  // a graph was actually composed for the run (the KG flag gates that upstream).
  // queryRepos: cross-repo impact for split-repo estates — only offered when the
  // app repo registers relatedRepos in .autofactory/services.yaml.
  // flagState: the planner's targeting evidence for the flag_action decision
  // (ride_existing vs extend_variation hinges on released-ness, not existence).
  "autofactory-research-planner": { createFlag: false, flagState: true, createMetric: false, editFiles: false, writeManifest: true, queryGraph: true, queryRepos: true },
  // The steward normalizes the human-edited releaseIntent — the only node that
  // may UPDATE an existing intent block.
  "autofactory-manifest-steward": { createFlag: false, createMetric: false, editFiles: false, stewardManifest: true },
  "autofactory-flag-implementer": { createFlag: true, flagState: true, createMetric: false, editFiles: true, writeManifest: true, readDocs: true },
  "autofactory-flag-testing": { createFlag: false, createMetric: false, editFiles: true },
  // The metrics author creates LD metrics and instruments the event (track()) that
  // feeds them — so it needs create_metric AND edit_files (+ manifest updates).
  "autofactory-metrics-author": { createFlag: false, createMetric: true, editFiles: true, writeManifest: true, readDocs: true, queryGraph: true, querySentry: true },
  // The reviewer is read-only but verifies LaunchDarkly semantics — docs access
  // lets it check claims against the source instead of trusting the chain.
  "autofactory-code-reviewer": { createFlag: false, createMetric: false, editFiles: false, readDocs: true },
};

/**
 * Routing tags each node MUST emit for the chain to advance, keyed by config
 * key. These are the deterministic ones (a node's own decision / hand-off) — NOT
 * the conditional ones (e.g. `skip_flagging`, set only when no flag is needed)
 * nor the tool-auto ones (`flag_created`/`metric_keys`, set by create_flag/
 * create_metric). If the agent finishes without these, the runner forces a final
 * `tag_conversation` call (see `runNode`) so a node can never silently stall the
 * chain or yield a misleading verdict (issue #9, failure modes #1 and #2). The
 * graph side is guarded separately by `npm run check:configs`.
 */
export const NODE_REQUIRED_TAGS: Record<string, string[]> = {
  // Always decides flag-worthiness, the flag ACTION (create / extend_variation /
  // ride_existing / child_flag / none — the implementer executes it, the
  // metrics author picks its mode from it), AND a numeric risk score —
  // risk-threshold gates fail closed when risk_score is missing, so force it.
  "autofactory-research-planner": ["flag_worthy", "flag_action", "risk_score"],
  "autofactory-metrics-author": ["needs_tests"], // always hands off to testing
  "autofactory-code-reviewer": ["review_approved"], // always produces a verdict
};

/** The required routing tags this node hasn't emitted yet (empty if all present). */
export function missingRequiredTags(configKey: string, tags: Record<string, string>): string[] {
  return (NODE_REQUIRED_TAGS[configKey] ?? []).filter((t) => !(t in tags));
}

/** Capability tokens recognized on a graph edge's `capabilities` array. */
export const CAP_CREATE_FLAG = "create_flag";
export const CAP_FLAG_STATE = "flag_state";
export const CAP_CREATE_METRIC = "create_metric";
export const CAP_EDIT_FILES = "edit_files";
export const CAP_WRITE_MANIFEST = "write_manifest";
export const CAP_STEWARD_MANIFEST = "steward_manifest";
export const CAP_QUERY_GRAPH = "query_graph";
export const CAP_QUERY_SENTRY = "query_sentry";
export const CAP_READ_DOCS = "read_docs";
export const CAP_QUERY_REPOS = "query_repos";

/**
 * Resolve a node's requested capability grant: from the edge `capabilities` list
 * when present, else the `NODE_CAPABILITIES` fallback, else read-only. Returns the
 * grant + its source for logging (NOT yet intersected with what's globally enabled).
 */
export function resolveGrant(
  configKey: string,
  capabilities: string[] | undefined,
): { grant: ToolCapabilities; source: "edge" | "fallback" | "none" } {
  if (capabilities) {
    return {
      grant: {
        createFlag: capabilities.includes(CAP_CREATE_FLAG),
        flagState: capabilities.includes(CAP_FLAG_STATE),
        createMetric: capabilities.includes(CAP_CREATE_METRIC),
        editFiles: capabilities.includes(CAP_EDIT_FILES),
        writeManifest: capabilities.includes(CAP_WRITE_MANIFEST),
        stewardManifest: capabilities.includes(CAP_STEWARD_MANIFEST),
        queryGraph: capabilities.includes(CAP_QUERY_GRAPH),
        querySentry: capabilities.includes(CAP_QUERY_SENTRY),
        readDocs: capabilities.includes(CAP_READ_DOCS),
        queryRepos: capabilities.includes(CAP_QUERY_REPOS),
      },
      source: "edge",
    };
  }
  const fallback = NODE_CAPABILITIES[configKey];
  if (fallback) return { grant: fallback, source: "fallback" };
  return { grant: { createFlag: false, createMetric: false, editFiles: false }, source: "none" };
}

export interface AnthropicAgentRunnerOptions {
  /** Absolute path the sandbox tools operate within (the repo under review / the checkout). */
  sandboxRoot: string;
  /** Anthropic API key; falls back to ANTHROPIC_API_KEY in the env. */
  apiKey?: string;
  /** When provided, `create_flag` is enabled for capable nodes (real flags in the app project). */
  writer?: LdResourceWriter;
  /** When true, file-edit + commit/push tools are enabled for capable nodes. */
  codeChangesEnabled?: boolean;
  /** PR head branch the git tools push to (passed to the sandbox executor). */
  prBranch?: string;
  /** PR base ref the git_diff tool diffs against (passed to the sandbox executor). */
  prBaseRef?: string;
  /**
   * How `commit_and_push` finalizes edits: "push" (default, GitHub Action) or
   * "workingTree" (Cursor extension — leave edits uncommitted for review).
   */
  gitMode?: GitMode;
  /**
   * Composed knowledge graph for this run (ADR 0010). Presence is the global
   * enable for `query_dependencies`: the front end only composes a graph when
   * the `auto-factory-knowledge-graph` flag serves true, so a granted node on
   * a flag-off run simply doesn't get the tool.
   */
  knowledgeGraph?: KnowledgeGraph;
  /** Repo-relative files changed in this PR (blast-radius input). */
  changedFiles?: string[];
  /**
   * Related repositories registered by the app repo (relatedRepos in
   * .autofactory/services.yaml). Presence + a GitHub token is the global enable
   * for `query_related_repos` — no registry, no tool.
   */
  relatedRepos?: RelatedRepo[];
  /** Token for cross-repo reads; falls back to GITHUB_TOKEN in the env. */
  githubToken?: string;
}

export class AnthropicAgentRunner implements AgentRunner {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicAgentRunnerOptions) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    // Effective capabilities = this node's grant ∩ globally-enabled features.
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
    // Per-node diagnostic: makes a renamed/added agent that silently lost its
    // grant (source "none", read-only) visible in the run logs.
    console.log(
      `[node] ${req.configKey} grant(${source}): createFlag=${grant.createFlag} flagState=${grant.flagState === true} createMetric=${grant.createMetric} editFiles=${grant.editFiles} readDocs=${grant.readDocs === true} queryGraph=${grant.queryGraph === true} querySentry=${grant.querySentry === true} queryRepos=${grant.queryRepos === true} → effective createFlag=${caps.createFlag} flagState=${caps.flagState === true} createMetric=${caps.createMetric} editFiles=${caps.editFiles} readDocs=${caps.readDocs === true} queryGraph=${caps.queryGraph === true} querySentry=${caps.querySentry === true} queryRepos=${caps.queryRepos === true}`,
    );
    const writer = caps.createFlag || caps.createMetric || caps.flagState ? this.opts.writer : undefined;

    const model = anthropicModelId(req.model);
    // Parity with the Cursor runner's model log: the served variation's model is
    // what makes A/B run logs attributable without querying LD monitoring.
    console.log(`[node] ${req.configKey} anthropic model → '${model}'${req.model && req.model !== model ? ` (LD: '${req.model}')` : ""}`);
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
    // ceiling (ADR 0011): restrict the offered set, override descriptions/schemas.
    const overlay = applyLdToolOverlay(buildSandboxTools(caps), req.ldTools);
    if (overlay.unknown.length > 0) {
      console.warn(
        `[node] ${req.configKey} LD variation attaches tool(s) with no local implementation: ${overlay.unknown.join(", ")} — ignored (execution lives in the runner; add the implementation or detach them)`,
      );
    }
    const tools = overlay.tools as Anthropic.Tool[];
    // The Sentry note only belongs in the prompt when the variation actually
    // attached query_sentry — the edge grant is a ceiling shared by variations
    // (e.g. the metrics author's non-Sentry default), not the offered set.
    const offered = new Set(overlay.tools.map((t) => t.name));
    const system =
      (req.instructions ?? "") + modeNote({ ...caps, querySentry: caps.querySentry && offered.has("query_sentry") });
    const toolCallsUsed = new Set<string>();
    const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.prompt }];
    let finalText = "";
    let status: AgentStatus = "completed";
    let inputTokens = 0;
    let outputTokens = 0;
    const started = Date.now();

    // Dual-write gen_ai span: LD LLM Observability (OTel) + Sentry AI monitoring.
    const span = startAiSpan(`chat ${req.configKey}`, { op: "gen_ai.chat" });

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const resp = await this.client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools,
          messages,
        });
        inputTokens += resp.usage.input_tokens;
        outputTokens += resp.usage.output_tokens;
        messages.push({ role: "assistant", content: resp.content });
        finalText = textOf(resp.content) || finalText;

        if (resp.stop_reason !== "tool_use") break;

        const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of toolUses) {
          toolCallsUsed.add(b.name);
          const r = await executor.execute(b.name, (b.input ?? {}) as Record<string, unknown>);
          results.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });

        if (turn === maxTurns - 1) status = "stopped"; // hit the turn cap mid-task
      }

      // Safety net: if the agent finished without recording the routing tag(s)
      // its node owns, force one `tag_conversation` call so the chain can't
      // silently stall or report a misleading verdict (issue #9). Best-effort —
      // a failure here doesn't fail the node.
      const missing = missingRequiredTags(req.configKey, executor.tags);
      if (missing.length > 0) {
        try {
          const forcePrompt =
            `Before finishing you MUST record your routing decision. You have not set the required tag(s): ${missing.join(", ")}. ` +
            "Call `tag_conversation` now with a `tags` object, choosing the correct value(s) per your instructions " +
            "(e.g. your flag-worthiness decision, the testing hand-off, or your APPROVE/REJECT verdict and risk level).";
          messages.push({ role: "user", content: forcePrompt });
          const forced = await this.client.messages.create({
            model,
            max_tokens: MAX_TOKENS,
            system,
            tools,
            messages,
            tool_choice: { type: "tool", name: "tag_conversation" },
          });
          inputTokens += forced.usage.input_tokens;
          outputTokens += forced.usage.output_tokens;
          for (const b of forced.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use")) {
            await executor.execute(b.name, (b.input ?? {}) as Record<string, unknown>);
          }
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
      req.tracker?.trackSuccess();
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
      if (inputTokens || outputTokens) {
        req.tracker?.trackTokens({ input: inputTokens, output: outputTokens, total: inputTokens + outputTokens });
      }
      span.setGenAi({
        provider: "anthropic",
        requestModel: model,
        agentName: req.configKey,
        ...(req.tracker ? { tracker: req.tracker } : {}),
        prompt: req.prompt,
        output: finalText,
        ...(inputTokens || outputTokens
          ? { usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens } }
          : {}),
      });
      span.end(status === "completed" ? "ok" : "error");
    }

    return {
      status,
      messages: [{ role: "assistant", content: finalText, isFinal: true }],
      tags: { ...executor.tags },
    };
  }
}

/** Concatenate the text blocks of an Anthropic response. */
function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Map a LaunchDarkly model name to an Anthropic model id. LD model names may be
 * provider-qualified (e.g. "Anthropic.claude-sonnet-4-6") or Bedrock-style
 * region-qualified (e.g. "us.anthropic.claude-sonnet-4-6-v1:0"). Strip at most an
 * optional leading region segment and a single "anthropic." prefix; everything
 * else (including multi-dot model ids like "...-v1:0") passes through unchanged.
 */
export function anthropicModelId(name: string | undefined): string {
  if (!name) return DEFAULT_MODEL;
  const id = name
    .trim()
    .replace(/^[a-z]{2}\./i, "") // optional region segment, e.g. "us."
    .replace(/^anthropic\./i, ""); // single provider prefix
  return id.trim() || DEFAULT_MODEL;
}
