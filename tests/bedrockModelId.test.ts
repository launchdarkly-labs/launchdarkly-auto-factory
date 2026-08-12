import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bedrockModelId, resolveAiProvider } from "@auto-factory/shared";
import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";

describe("bedrockModelId", () => {
  it("prefixes a bare Anthropic model id with the Bedrock provider prefix", () => {
    assert.equal(bedrockModelId("claude-sonnet-4-6"), "anthropic.claude-sonnet-4-6");
  });

  it("normalizes an LD provider-qualified name (case-insensitive) to one canonical prefix", () => {
    assert.equal(bedrockModelId("Anthropic.claude-sonnet-4-6"), "anthropic.claude-sonnet-4-6");
    assert.equal(bedrockModelId("anthropic.claude-haiku-4-5"), "anthropic.claude-haiku-4-5");
  });

  it("normalizes a region-qualified Bedrock-style name, keeping multi-dot ids intact", () => {
    assert.equal(bedrockModelId("us.anthropic.claude-sonnet-4-6-v1:0"), "anthropic.claude-sonnet-4-6-v1:0");
  });

  it("falls back to a Bedrock-prefixed default for empty/undefined", () => {
    assert.match(bedrockModelId(undefined), /^anthropic\.claude-/);
    assert.equal(bedrockModelId(undefined), bedrockModelId(""));
  });
});

describe("resolveAiProvider", () => {
  const ctx: LDContext = { kind: "service", key: "test" };
  const stubClient = (served: unknown): LDClient =>
    ({ variation: async () => served }) as unknown as LDClient;

  it("accepts 'bedrock' as a known provider", async () => {
    assert.equal(await resolveAiProvider(stubClient("bedrock"), ctx), "bedrock");
  });

  it("still falls back to 'anthropic' for unknown values", async () => {
    assert.equal(await resolveAiProvider(stubClient("gpt-metal"), ctx), "anthropic");
  });
});
