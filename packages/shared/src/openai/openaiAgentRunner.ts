/**
 * OpenAI implementation of the `AgentRunner` seam (5th provider).
 *
 * Same contract as the Anthropic runner — LD-resolved instructions are the
 * agent, the sandbox tool set is the hands — but driven through the OpenAI
 * Chat Completions API (function calling) instead of Anthropic Messages, so
 * unlike Bedrock this cannot inject a client into the Anthropic loop: the
 * message/tool wire shapes differ. Everything provider-agnostic is imported
 * from the Anthropic runner (grants, required tags, mode note, tool overlay,
 * executor) so agents behave identically across providers; only the model
 * brain and transport differ.
 *
 * Selected by the `auto-factory-ai-provider` flag value "openai" — the
 * intended default for the Codex front end (surface targeting). Sandbox-
 * confined like Anthropic/Bedrock: tools are the only hands, so workingTree
 * mode's "nothing committed or pushed" contract holds.
 *
 * Uses global `fetch` (Node 18+) rather than the `openai` package — the loop
 * needs one endpoint and explicit retry control, same trade as ldClient.ts.
 */

import type { AgentNodeRequest, AgentNodeResult, AgentRunner, AgentStatus } from "../agentRunner.js";
import { startAiSpan } from "../observability.js";
import { RelatedReposClient } from "../github/relatedRepos.js";
import {
  type AnthropicAgentRunnerOptions,
  missingRequiredTags,
  modeNote,
  resolveGrant,
} from "../anthropic/anthropicAgentRunner.js";
import { SandboxToolExecutor, type ToolCapabilities, applyLdToolOverlay, buildSandboxTools } from "../anthropic/sandboxTools.js";

const DEFAULT_MODEL = "gpt-5.2";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Backstops matching the Anthropic runner's sizing rationale (not budgets).
const DEFAULT_MAX_TURNS = 100;
const MAX_COMPLETION_TOKENS = 32_000;
const TRANSIENT_RETRIES = 3;
const TRANSIENT_BACKOFF_MS = [5_000, 15_000, 45_000];

/** Chat Completions wire types — the slices this loop reads/writes. */
interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OaiAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OaiToolCall[];
}
type OaiMessage =
  | { role: "system" | "user"; content: string }
  | OaiAssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };
interface OaiResponse {
  choices: Array<{ message: OaiAssistantMessage; finish_reason: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`OpenAI API ${status}: ${body.slice(0, 500)}`);
  }
}

function isTransient(e: unknown): boolean {
  if (e instanceof OpenAiApiError) return e.status === 408 || e.status === 429 || e.status >= 500;
  // fetch network failures (TypeError) and aborts are transient.
  return e instanceof TypeError || (e instanceof Error && e.name === "AbortError");
}

/** One Chat Completions call with backoff retries on transient errors. */
export async function openaiChat(
  apiKey: string,
  baseUrl: string,
  body: Record<string, unknown>,
  label: string,
): Promise<OaiResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new OpenAiApiError(res.status, text);
      return JSON.parse(text) as OaiResponse;
    } catch (e) {
      if (!isTransient(e) || attempt >= TRANSIENT_RETRIES) throw e;
      const delay = TRANSIENT_BACKOFF_MS[attempt] ?? 45_000;
      console.warn(
        `[node] ${label} transient OpenAI error (${e instanceof Error ? e.message : e}) — retry ${attempt + 1}/${TRANSIENT_RETRIES} in ${delay / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** The API key for OpenAI execution: explicit, else OPENAI_API_KEY, else CODEX_API_KEY
 *  (the same platform key users already hold for Codex CLI auth). */
export function openaiApiKey(explicit?: string): string | undefined {
  return explicit || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
}

export interface OpenAiAgentRunnerOptions
  extends Omit<AnthropicAgentRunnerOptions, "apiKey" | "client" | "providerName" | "modelIdMapper"> {
  /** OpenAI API key; falls back to OPENAI_API_KEY, then CODEX_API_KEY. */
  apiKey?: string;
  /** API base (e.g. a proxy); default https://api.openai.com/v1. */
  baseUrl?: string;
}

export class OpenAiAgentRunner implements AgentRunner {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAiAgentRunnerOptions) {
    const key = openaiApiKey(opts.apiKey);
    if (!key) throw new Error("OpenAI provider requires OPENAI_API_KEY (or CODEX_API_KEY) to be set");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    // Effective capabilities = this node's grant ∩ globally-enabled features
    // (identical policy to the Anthropic runner — see its runNode for rationale).
    const { grant, source } = resolveGrant(req.configKey, req.capabilities);
    const caps: ToolCapabilities = {
      createFlag: grant.createFlag && this.opts.writer !== undefined,
      flagState: grant.flagState === true && this.opts.writer !== undefined,
      createMetric: grant.createMetric && this.opts.writer !== undefined,
      editFiles: grant.editFiles && this.opts.codeChangesEnabled === true,
      writeManifest: grant.writeManifest === true && this.opts.codeChangesEnabled === true,
      stewardManifest: grant.stewardManifest === true && this.opts.codeChangesEnabled === true,
      queryGraph: grant.queryGraph === true && this.opts.knowledgeGraph !== undefined,
      querySentry: grant.querySentry === true,
      readDocs: grant.readDocs === true,
      queryRepos:
        grant.queryRepos === true &&
        (this.opts.relatedRepos?.length ?? 0) > 0 &&
        Boolean(this.opts.githubToken ?? process.env.GITHUB_TOKEN),
    };
    console.log(
      `[node] ${req.configKey} grant(${source}): createFlag=${grant.createFlag} editFiles=${grant.editFiles} → effective createFlag=${caps.createFlag} editFiles=${caps.editFiles} (openai)`,
    );
    const writer = caps.createFlag || caps.createMetric || caps.flagState ? this.opts.writer : undefined;

    const model = openaiModelId(req.model);
    console.log(`[node] ${req.configKey} openai model → '${model}'${req.model && req.model !== model ? ` (LD: '${req.model}')` : ""}`);
    const executor = new SandboxToolExecutor(
      this.opts.sandboxRoot,
      writer,
      caps.editFiles,
      this.opts.prBranch,
      this.opts.prBaseRef,
      this.opts.gitMode ?? "push",
      caps.writeManifest === true && this.opts.codeChangesEnabled === true,
      caps.stewardManifest === true && this.opts.codeChangesEnabled === true,
      this.opts.skipCi ?? true,
    );
    if (caps.queryGraph && this.opts.knowledgeGraph) {
      executor.provideKnowledgeGraph(this.opts.knowledgeGraph, this.opts.changedFiles ?? []);
    }
    if (caps.queryRepos && this.opts.relatedRepos) {
      executor.provideRelatedRepos(
        new RelatedReposClient(this.opts.relatedRepos, this.opts.githubToken ?? process.env.GITHUB_TOKEN ?? ""),
      );
    }
    const overlay = applyLdToolOverlay(buildSandboxTools(caps), req.ldTools);
    if (overlay.unknown.length > 0) {
      console.warn(
        `[node] ${req.configKey} LD variation attaches tool(s) with no local implementation: ${overlay.unknown.join(", ")} — ignored`,
      );
    }
    // Sandbox tools carry Anthropic's {name, description, input_schema} shape;
    // Chat Completions wants {type:"function", function:{…, parameters}}.
    const tools = overlay.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const offered = new Set(overlay.tools.map((t) => t.name));
    const system =
      (req.instructions ?? "") + modeNote({ ...caps, querySentry: caps.querySentry && offered.has("query_sentry") });
    const toolCallsUsed = new Set<string>();
    const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;

    const messages: OaiMessage[] = [
      { role: "system", content: system },
      { role: "user", content: req.prompt },
    ];
    let finalText = "";
    let status: AgentStatus = "completed";
    let inputTokens = 0;
    let outputTokens = 0;
    const started = Date.now();
    const span = startAiSpan(`chat ${req.configKey}`, { op: "gen_ai.chat" });

    const executeCalls = async (calls: OaiToolCall[]): Promise<OaiMessage[]> => {
      const results: OaiMessage[] = [];
      for (const c of calls) {
        toolCallsUsed.add(c.function.name);
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* malformed arguments → run the tool with {}; its own validation reports the miss */
        }
        const r = await executor.execute(c.function.name, input);
        results.push({
          role: "tool",
          tool_call_id: c.id,
          // Chat Completions has no is_error flag on tool results — prefix so
          // the model can't mistake a failure payload for success.
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
      return results;
    };

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const resp = await openaiChat(
          this.apiKey,
          this.baseUrl,
          { model, max_completion_tokens: MAX_COMPLETION_TOKENS, messages, tools },
          req.configKey,
        );
        inputTokens += resp.usage?.prompt_tokens ?? 0;
        outputTokens += resp.usage?.completion_tokens ?? 0;
        const choice = resp.choices[0];
        if (!choice) break;
        messages.push(choice.message);
        finalText = choice.message.content?.trim() || finalText;

        if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) break;
        messages.push(...(await executeCalls(choice.message.tool_calls)));
        if (turn === maxTurns - 1) status = "stopped";
      }

      // Same safety net as the Anthropic runner: force the node's required
      // routing tags so a silent finish can't stall the chain.
      const missing = missingRequiredTags(req.configKey, executor.tags);
      if (missing.length > 0) {
        try {
          messages.push({
            role: "user",
            content:
              `Before finishing you MUST record your routing decision. You have not set the required tag(s): ${missing.join(", ")}. ` +
              "Call `tag_conversation` now with a `tags` object, choosing the correct value(s) per your instructions.",
          });
          const forced = await openaiChat(
            this.apiKey,
            this.baseUrl,
            {
              model,
              max_completion_tokens: MAX_COMPLETION_TOKENS,
              messages,
              tools,
              tool_choice: { type: "function", function: { name: "tag_conversation" } },
            },
            req.configKey,
          );
          inputTokens += forced.usage?.prompt_tokens ?? 0;
          outputTokens += forced.usage?.completion_tokens ?? 0;
          const calls = forced.choices[0]?.message.tool_calls ?? [];
          if (forced.choices[0]) messages.push(forced.choices[0].message);
          await executeCalls(calls);
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
        provider: "openai",
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

/**
 * Map a LaunchDarkly model name to an OpenAI model id: strip a single
 * "openai." provider prefix (LD model configs are provider-qualified, e.g.
 * "OpenAI.gpt-5.2"); everything else passes through unchanged.
 */
export function openaiModelId(name: string | undefined): string {
  if (!name) return DEFAULT_MODEL;
  const id = name.trim().replace(/^openai\./i, "");
  return id.trim() || DEFAULT_MODEL;
}
