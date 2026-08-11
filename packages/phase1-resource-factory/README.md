# AutoFactory GitHub Action

The GitHub Action turns a pull request into a release-ready change. It resolves the Agent
Graph from LaunchDarkly, executes each agent, enforces approval gates, commits approved work,
and reports the result on the PR.

This is the primary end-to-end Build entry point.

## Use it

Follow the [setup guide](../../REFERENCE.md#2-add-the-build-workflow) or copy a workflow:

- `bootstrap/github-action-template/auto-factory.yml` for Anthropic or Vega
- `bootstrap/github-action-template/auto-factory-cursor.yml` for Cursor

The `auto-factory-ai-provider` flag selects the runner. Agent instructions, Tools, graph
routing, and per-agent models still come from LaunchDarkly.

## What a run does

1. Build the pull request context.
2. Resolve provider, Agent Configs, Tools, and Agent Graph.
3. Walk the graph and enforce its handoff conditions.
4. Pause before any step that requires human approval.
5. Commit allowed agent edits to the PR branch.
6. Run Judges against the agents' actual diffs.
7. Post the verdict, evidence, and next action to the PR.

Vega does not run the local Judge hook. Anthropic and Cursor do.

## Handoff conditions

Each graph edge can define:

| Field | Meaning |
|---|---|
| `require_tags` | Continue only when every tag matches |
| `skip_if_tags` | Skip the edge when every tag matches |
| `max_turns` | Limit the target agent's turns |
| `request_type` | Provide a provider-specific execution hint |

The graph is stored in `config/agentcontrol/graphs/`, not in this package.

## Approval gates

LaunchDarkly flags control whether gates apply, how much risk triggers them, and which agent
steps require approval. The action stops before the gated step and posts an
`action_required` check. Add the requested `af-approve:<nodeKey>` label to continue.

A rejected review remains a review result. It is distinct from an approval pause or runtime
failure.

## Change the action

| File | Responsibility |
|---|---|
| `src/action.ts` | Initialize the run and report the outcome |
| `src/graphWalker.ts` | Execute graph nodes and handoffs |
| `src/approval.ts` | Interpret risk, verdicts, and gates |
| `src/prContext.ts` | Build pull request context |
| `src/comment.ts` | Publish the PR summary |
| `action.yml` | Define public action inputs |

After changing `src/`, rebuild the committed action bundle:

```bash
npm run bundle -w @auto-factory/phase1-resource-factory
```

Keep `action.yml`, input mapping, workflow templates, and `.env.example` aligned.
