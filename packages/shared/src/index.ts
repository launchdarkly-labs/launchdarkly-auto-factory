/** Public surface of @auto-factory/shared. */

export * from "./types.js";
export * from "./env.js";
export * from "./config.js";
export * from "./ldClient.js";
export * from "./releaseAdapter.js";
export * from "./releaseIntent.js";
export * from "./configVersion.js";
// Provider-agnostic Phase 1 orchestration, shared by every front end (the
// GitHub Action and the Cursor extension). Front ends supply the context and a
// reporter; the walk + approval logic lives here.
export * from "./graphWalker.js";
export * from "./workingTree.js";
export * from "./handoffVerifier.js";
export * from "./approval.js";
export * from "./approvalGates.js";
export * from "./approvalPolicy.js";
export * from "./vegaClient.js";
export * from "./vegaTransport.js";
export * from "./ldSdk.js";
export * from "./agentRunner.js";
// Re-export the LaunchDarkly AI SDK types the graph walker consumes, so the
// phase-1 package depends only on @auto-factory/shared.
export type {
  AgentGraphDefinition,
  AgentGraphNode,
  LDAgentGraphFlagValue,
  LDAIAgentConfig,
  LDAIConfigTracker,
  LDGraphEdge,
  LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
export * from "./vegaAgentRunner.js";
export * from "./providerFlag.js";
export * from "./anthropic/sandboxTools.js";
export * from "./anthropic/ldWriter.js";
export * from "./anthropic/anthropicAgentRunner.js";
export * from "./cursor/cursorModel.js";
export * from "./cursor/cursorAgentRunner.js";
export * from "./observability.js";
export * from "./sentryInit.js";
export * from "./sentryMetrics.js";
export * from "./sentry/index.js";
// Judges: provider-agnostic hook + per-provider judge completions + evidence.
export * from "./judges.js";
export * from "./judgeEvidence.js";
export * from "./anthropic/judgeCompletion.js";
export * from "./cursor/judgeCompletion.js";
// Knowledge graph (ADR 0010): LD-native composition + agent queries.
export * from "./graph/index.js";
// Cross-repo research for split-repo estates (query_related_repos).
export * from "./github/relatedRepos.js";
