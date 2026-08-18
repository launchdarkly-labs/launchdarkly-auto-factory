/**
 * Resolves which AI execution backend the Phase 1 chain uses, from the
 * `auto-factory-ai-provider` LaunchDarkly flag — evaluated NATIVELY through the
 * server SDK (`ldClient.variation`), not REST. Multivariate string flag
 * ("anthropic" | "bedrock" | "vega" | "cursor" | …, default "anthropic") so
 * providers can be added without code changes.
 */

import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";

export type AiProvider = "anthropic" | "bedrock" | "vega" | "cursor";

export const PROVIDER_FLAG_KEY = "auto-factory-ai-provider";
const DEFAULT_PROVIDER: AiProvider = "anthropic";

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<AiProvider>(["anthropic", "bedrock", "vega", "cursor"]);

export async function resolveAiProvider(
  ldClient: LDClient,
  context: LDContext,
  flagKey: string = PROVIDER_FLAG_KEY,
): Promise<AiProvider> {
  const value = await ldClient.variation(flagKey, context, DEFAULT_PROVIDER);
  return KNOWN_PROVIDERS.has(value) ? (value as AiProvider) : DEFAULT_PROVIDER;
}
