/**
 * Amazon Bedrock implementation of the `AgentRunner` seam.
 *
 * Bedrock serves the SAME Anthropic Messages API (via the Bedrock Mantle
 * endpoint, `https://bedrock-mantle.<region>.api.aws/anthropic`), so this is a
 * thin wrapper: it constructs an `AnthropicBedrockMantle` client and delegates
 * to `AnthropicAgentRunner` — the whole tool loop (sandbox tools, transient
 * retries, forced routing tags, LD trackers, gen_ai spans) is shared, so agent
 * behavior is IDENTICAL to the Anthropic provider and only the transport +
 * billing account differ. That also means this runner is structurally confined
 * to the sandbox tools, so it is safe everywhere the Anthropic runner is
 * (including the CLI/extension's working-tree "nothing is committed" contract).
 *
 * Auth/region come from the standard AWS credential chain — AWS_REGION (or
 * AWS_DEFAULT_REGION), and AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY,
 * AWS_SESSION_TOKEN, AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK, or an ambient role
 * (e.g. GitHub OIDC → configure-aws-credentials). Nothing is validated at
 * construction; a missing region/credential surfaces on the first API call.
 *
 * Dependency note: @anthropic-ai/bedrock-sdk is pinned to 0.32.0 EXACTLY —
 * 0.32.1 requires @anthropic-ai/sdk >=0.115.1, which would nest a second copy
 * of the core SDK and break the runner's `instanceof Anthropic.APIError`
 * transient-retry checks. Bump both SDKs together.
 */

import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { AgentNodeRequest, AgentNodeResult, AgentRunner } from "../agentRunner.js";
import {
  AnthropicAgentRunner,
  type AnthropicAgentRunnerOptions,
  type AnthropicMessagesClient,
  anthropicModelId,
} from "../anthropic/anthropicAgentRunner.js";

/**
 * Map a LaunchDarkly model name to a Bedrock Mantle model id: the first-party
 * Anthropic id with an `anthropic.` provider prefix (e.g. "claude-sonnet-4-6"
 * → "anthropic.claude-sonnet-4-6"). Reuses `anthropicModelId` for the
 * normalization, so provider-qualified ("Anthropic.claude-…") and
 * region-qualified ("us.anthropic.claude-…") LD names all converge on one
 * canonical Bedrock id — the SAME LD AI configs work on both providers.
 */
export function bedrockModelId(name: string | undefined): string {
  return `anthropic.${anthropicModelId(name)}`;
}

export interface BedrockAgentRunnerOptions
  extends Omit<AnthropicAgentRunnerOptions, "apiKey" | "client" | "providerName" | "modelIdMapper"> {
  /** AWS region for the Bedrock Mantle endpoint; falls back to AWS_REGION / AWS_DEFAULT_REGION. */
  awsRegion?: string;
}

/** An `AnthropicBedrockMantle` client, typed to the runner's Messages slice. */
export function createBedrockClient(awsRegion?: string): AnthropicMessagesClient {
  return new AnthropicBedrockMantle(awsRegion ? { awsRegion } : {});
}

export class BedrockAgentRunner implements AgentRunner {
  private readonly inner: AnthropicAgentRunner;

  constructor(opts: BedrockAgentRunnerOptions) {
    const { awsRegion, ...rest } = opts;
    this.inner = new AnthropicAgentRunner({
      ...rest,
      client: createBedrockClient(awsRegion),
      providerName: "bedrock",
      modelIdMapper: bedrockModelId,
    });
  }

  runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    return this.inner.runNode(req);
  }
}
