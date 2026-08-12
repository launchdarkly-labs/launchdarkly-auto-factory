/**
 * Anthropic implementation of the judge completion: a single structured
 * completion for the SDK Judge class. Structured output is obtained with a
 * FORCED tool call whose input schema is the judge's evaluation schema
 * ({score, reasoning}) — no free-text JSON parsing needed.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { JudgeCompletion } from "../judges.js";
import { ANTHROPIC_TIMEOUT_MS, type AnthropicMessagesClient, anthropicModelId } from "./anthropicAgentRunner.js";

// Backstop, not a budget: the output is one {score, reasoning} tool call, but
// the reasoning is written against a large evidence diff. At 1024 a verbose
// judge hit max_tokens MID-TOOL-INPUT, which surfaces as a silent parse
// failure in the SDK Judge ("eval FAILED: unknown" — live CLI run,
// 2026-07-20). Sized so only a runaway judge trips it (truncation is still
// detected and discarded below); kept under the SDK's ~21k non-streaming
// threshold so it works even on clients without an explicit timeout.
const MAX_TOKENS = 16_000;

export function createAnthropicJudgeCompletion(apiKey?: string): JudgeCompletion {
  return createForcedToolJudgeCompletion(
    new Anthropic({ timeout: ANTHROPIC_TIMEOUT_MS, ...(apiKey ? { apiKey } : {}) }),
    anthropicModelId,
  );
}

/**
 * The client-agnostic core: any Anthropic-Messages-compatible client (direct
 * API or Bedrock Mantle) with the matching model-id mapper. Exported so the
 * Bedrock provider gets the exact same forced-tool judge behavior.
 */
export function createForcedToolJudgeCompletion(
  client: AnthropicMessagesClient,
  modelId: (name: string | undefined) => string,
): JudgeCompletion {
  return async (req) => {
    const resp = await client.messages.create({
      model: modelId(req.model),
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: "user", content: req.input }],
      tools: [
        {
          name: "record_evaluation",
          description: "Record the evaluation result for the response under review.",
          input_schema: req.schema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "record_evaluation" },
    });
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // A max_tokens stop truncates the tool input — whatever partially parsed is
    // NOT a trustworthy evaluation. Fail explicitly instead of letting the
    // truncated object die as an unexplained schema-parse failure downstream.
    const truncated = resp.stop_reason === "max_tokens";
    if (truncated) {
      console.warn(`[judge] completion hit max_tokens (${MAX_TOKENS}) — evaluation discarded as truncated`);
    }
    const ok = toolUse !== undefined && !truncated;
    return {
      ...(ok ? { parsed: toolUse.input as Record<string, unknown> } : {}),
      content: truncated
        ? `judge output truncated at max_tokens=${MAX_TOKENS}; partial: ${JSON.stringify(toolUse?.input ?? null)}`
        : JSON.stringify(toolUse?.input ?? null),
      success: ok,
      tokens: {
        input: resp.usage.input_tokens,
        output: resp.usage.output_tokens,
        total: resp.usage.input_tokens + resp.usage.output_tokens,
      },
    };
  };
}
