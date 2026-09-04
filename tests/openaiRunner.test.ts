import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createOpenAiJudgeCompletion, openaiApiKey, openaiModelId, pipelineContext, resolveAiProvider } from "@auto-factory/shared";

describe("pipelineContext surface attribute (ADR 0018)", () => {
  const saved = process.env.AUTOFACTORY_SURFACE;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTOFACTORY_SURFACE;
    else process.env.AUTOFACTORY_SURFACE = saved;
  });

  it("stamps AUTOFACTORY_SURFACE on the run and service contexts", () => {
    process.env.AUTOFACTORY_SURFACE = "codex";
    const ctx = pipelineContext() as unknown as { run: { surface?: string }; service: { surface?: string } };
    assert.equal(ctx.run.surface, "codex");
    assert.equal(ctx.service.surface, "codex");
  });

  it("omits the attribute when the env var is unset", () => {
    delete process.env.AUTOFACTORY_SURFACE;
    const ctx = pipelineContext() as unknown as { run: { surface?: string } };
    assert.equal(ctx.run.surface, undefined);
  });
});

describe("openaiModelId", () => {
  it("strips a single OpenAI provider prefix, case-insensitively", () => {
    assert.equal(openaiModelId("OpenAI.gpt-5.2"), "gpt-5.2");
    assert.equal(openaiModelId("openai.gpt-5-mini"), "gpt-5-mini");
  });

  it("passes unprefixed ids through and defaults when absent", () => {
    assert.equal(openaiModelId("gpt-5.2"), "gpt-5.2");
    assert.equal(openaiModelId(undefined), "gpt-5.2");
    assert.equal(openaiModelId("  "), "gpt-5.2");
  });
});

describe("openaiApiKey fallback chain", () => {
  const saved = { o: process.env.OPENAI_API_KEY, c: process.env.CODEX_API_KEY };
  afterEach(() => {
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.o;
    if (saved.c === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = saved.c;
  });

  it("explicit > OPENAI_API_KEY > CODEX_API_KEY", () => {
    process.env.OPENAI_API_KEY = "env-openai";
    process.env.CODEX_API_KEY = "env-codex";
    assert.equal(openaiApiKey("explicit"), "explicit");
    assert.equal(openaiApiKey(), "env-openai");
    delete process.env.OPENAI_API_KEY;
    assert.equal(openaiApiKey(), "env-codex");
    delete process.env.CODEX_API_KEY;
    assert.equal(openaiApiKey(), undefined);
  });
});

describe("provider flag accepts openai", () => {
  it("resolves 'openai' as a known provider and falls back on unknowns", async () => {
    const client = (value: string) =>
      ({ variation: async () => value }) as unknown as Parameters<typeof resolveAiProvider>[0];
    const ctx = { kind: "user", key: "t" } as Parameters<typeof resolveAiProvider>[1];
    assert.equal(await resolveAiProvider(client("openai"), ctx), "openai");
    assert.equal(await resolveAiProvider(client("no-such"), ctx), "anthropic");
  });
});

describe("createOpenAiJudgeCompletion", () => {
  const savedFetch = globalThis.fetch;
  const saved = { o: process.env.OPENAI_API_KEY };
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.o;
  });

  it("parses the forced record_evaluation function call", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "record_evaluation", arguments: '{"score":0.9,"reasoning":"solid"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      )) as typeof fetch;
    const judge = createOpenAiJudgeCompletion();
    const r = await judge({ model: "OpenAI.gpt-5-mini", system: "s", input: "i", schema: { type: "object" } });
    assert.equal(r.success, true);
    assert.deepEqual(r.parsed, { score: 0.9, reasoning: "solid" });
    assert.deepEqual(r.tokens, { input: 10, output: 5, total: 15 });
  });

  it("discards a length-truncated evaluation", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "record_evaluation", arguments: '{"score":0.' } }],
              },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const judge = createOpenAiJudgeCompletion();
    const r = await judge({ model: "gpt-5-mini", system: "s", input: "i", schema: { type: "object" } });
    assert.equal(r.success, false);
    assert.equal(r.parsed, undefined);
    assert.match(r.content, /truncated/);
  });
});
