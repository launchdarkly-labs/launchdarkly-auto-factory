# Shared factory core

This package contains the runtime used by every AutoFactory entry point. It turns
LaunchDarkly configuration into constrained agent execution and shared release behavior.

## What it owns

| Area | Responsibility |
|---|---|
| **Runners** | Execute one graph node through Anthropic, Cursor, or Vega |
| **Sandbox tools** | Limit file, Git, flag, and metric operations available to an agent |
| **LaunchDarkly clients** | Resolve flags, Agent Configs, Tools, graphs, and monitoring |
| **Judges** | Score agent output against verified, node-scoped diffs |
| **Knowledge graph** | Combine service telemetry, Code References, and repository context |
| **Release adapter** | Normalize policies and call the LaunchDarkly release API |
| **Shared types and config** | Define handoffs, approvals, manifests, and connections |

The entry points decide when a run starts and where edits land. This package decides how the
graph executes.

## Extend it

### Add an execution provider

Implement `AgentRunner` in `src/agentRunner.ts`, then wire it into the entry point's runner
selection. The Cursor implementation shows model mapping, lazy loading, and custom-tool reuse.

### Change agent capabilities

Edit `src/anthropic/sandboxTools.ts` and the graph's per-node capabilities together. Runtime
code is the maximum write boundary. LaunchDarkly configuration may narrow access but must not
expand it beyond that boundary.

### Add production context

Extend `src/graph/`. The current graph combines:

- service relationships from observability spans
- flag locations from Code References
- services and related repositories declared by the application

Each source fails softly and reports missing coverage.

### Change release behavior

Use `src/releaseAdapter.ts` for LaunchDarkly release policy resolution and API calls. Beacon
owns deploy notifications and discovery; LaunchDarkly owns rollout execution.

## Find the main modules

| Path | Purpose |
|---|---|
| `src/agentRunner.ts` | Provider-neutral execution contract |
| `src/anthropic/` | Local tool-use runner and sandbox |
| `src/cursor/` | Cursor SDK runner and model selection |
| `src/vegaAgentRunner.ts` | Vega adapter |
| `src/judges.ts` and `src/judgeEvidence.ts` | Quality evaluation |
| `src/graph/` | Knowledge-graph assembly and queries |
| `src/ldSdk.ts` and `src/ldClient.ts` | LaunchDarkly SDK and REST access |
| `src/releaseAdapter.ts` | Release API integration |

See [ADR 0005](../../docs/adr/0005-provider-seam-local-anthropic-execution.md) for the
runner boundary and [ADR 0010](../../docs/adr/0010-knowledge-graph-ld-native-composition.md)
for the knowledge graph.
