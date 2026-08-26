/**
 * OpenAI implementation of the judge completion: one structured completion via
 * a FORCED function call whose parameters are the judge's evaluation schema
 * ({score, reasoning}) — the Chat Completions analog of the Anthropic
 * forced-tool judge (see ../anthropic/judgeCompletion.ts, incl. the truncation
 * rationale: a length-stop truncates the function arguments mid-JSON, which
 * must be discarded, never parsed as a real evaluation).
 */

import type { JudgeCompletion } from "../judges.js";
import { OpenAiApiError, openaiApiKey, openaiChat, openaiModelId } from "./openaiAgentRunner.js";

const MAX_COMPLETION_TOKENS = 16_000;

export function createOpenAiJudgeCompletion(apiKey?: string, baseUrl = "https://api.openai.com/v1"): JudgeCompletion {
  const key = openaiApiKey(apiKey);
  if (!key) throw new OpenAiApiError(0, "OpenAI judge requires OPENAI_API_KEY (or CODEX_API_KEY)");
  return async (req) => {
    const resp = await openaiChat(
      key,
      baseUrl.replace(/\/+$/, ""),
      {
        model: openaiModelId(req.model),
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.input },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "record_evaluation",
              description: "Record the evaluation result for the response under review.",
              parameters: req.schema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "record_evaluation" } },
      },
      "judge",
    );
    const choice = resp.choices[0];
    const call = choice?.message.tool_calls?.[0];
    const truncated = choice?.finish_reason === "length";
    if (truncated) {
      console.warn(`[judge] completion hit max_completion_tokens (${MAX_COMPLETION_TOKENS}) — evaluation discarded as truncated`);
    }
    let parsed: Record<string, unknown> | undefined;
    if (call && !truncated) {
      try {
        parsed = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        /* malformed arguments → success: false below */
      }
    }
    const ok = parsed !== undefined;
    return {
      ...(ok ? { parsed } : {}),
      content: truncated
        ? `judge output truncated at max_completion_tokens=${MAX_COMPLETION_TOKENS}; partial: ${call?.function.arguments ?? null}`
        : (call?.function.arguments ?? "null"),
      success: ok,
      tokens: {
        input: resp.usage?.prompt_tokens ?? 0,
        output: resp.usage?.completion_tokens ?? 0,
        total: (resp.usage?.prompt_tokens ?? 0) + (resp.usage?.completion_tokens ?? 0),
      },
    };
  };
}
