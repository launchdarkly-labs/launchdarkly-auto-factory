# Configure the factory

This directory is the versioned source for agent behavior. Config Bridge provisions it into
LaunchDarkly, and factory runs resolve the live configuration.

Use it to change prompts, models, tools, routing, permissions, and shared metrics without
rewriting the orchestration code.

## What is configured

| Path | Owns |
|---|---|
| `ai-configs/` | Six agent roles and two Judges |
| `tools/` | Tool names, descriptions, and schemas |
| `graphs/` | Role order, handoffs, conditions, and capabilities |
| `flags/` | Provider, approval, and context controls |
| `metrics/` | Shared application metrics |
| `tags.json` | Machine-readable handoff signals |

Tool execution and the maximum write boundary remain in code. LaunchDarkly configuration can
narrow an agent's capabilities, but it cannot grant capabilities the runtime does not expose.

## How the agent graph flows

| Order | Config | Output |
|---|---|---|
| 1 | `autofactory-research-planner.json` | Classification, risk, implementation brief, initial manifest |
| 2 | `autofactory-manifest-steward.json` | Structured human release intent |
| 3 | `autofactory-flag-implementer.json` | Flag action, code wiring, corrected manifest |
| 4 | `autofactory-metrics-author.json` | Metrics, instrumentation, manifest metric keys |
| 5 | `autofactory-flag-testing.json` | Passing tests for control and treatment paths |
| 6 | `autofactory-code-reviewer.json` | Read-only verdict over the complete change |

Judges are committed as `autofactory-judge-implementation-quality.json` and
`autofactory-judge-metrics-quality.json`.

The default variations and Judge attachments are committed. Live projects may add model or
provider variations through targeting. Re-export intentional changes so the repository
remains the public source of truth.

## Change the configuration

1. Edit the committed JSON definitions.
2. Validate them with `npm run check:configs`.
3. Preview the update with `npm run bridge -- upgrade --dry-run`.
4. Apply it with `npm run bridge -- upgrade`.
5. Record behavior changes in `CHANGELOG.md`.

After adding or renaming a sandbox tool, regenerate its definitions:

```bash
npm run export:tools
```

Instructions and tool descriptions can also be edited in LaunchDarkly for immediate use.
Export those changes before a later upgrade replaces the committed fields.

## Canonical agent tags

Agents emit tags to route work and report verified outcomes. `tags.json` is the source used
by configuration checks.

| Tag | Produced by | Meaning |
|---|---|---|
| `skip_flagging` | Research planner | Stop when the change needs no flag |
| `flag_worthy` | Research planner | Advisory classification |
| `flag_action` | Research planner | `create`, `extend_variation`, `ride_existing`, `child_flag`, or `none` |
| `risk_score` | Research planner | Numeric risk from `0.0` to `1.0` |
| `flag_ready` | Flag tools | A verified flag outcome exists |
| `flag_created` | Flag tools | A new flag was created |
| `flag_key` | Flag tools | Application flag key |
| `flag_variation` | Flag tools | Treatment variation for this change |
| `metrics_created` | Metric tools | One or more metrics exist |
| `metric_keys` | Metric tools | Attached metric keys |
| `metric_event_keys` | Metric tools | Event keys that require emitters |
| `sentry_guardrail` | Metrics author | A Sentry-backed error metric is attached |
| `needs_tests` | Metrics author | Route to flag testing |
| `tests_last_run` | Test tool | `pass` or `fail` from the last execution |
| `review_approved` | Code reviewer | Final review decision |
| `risk_level` | Code reviewer | Low, medium, or high companion to risk score |

Tools set tags that claim side effects. Agents do not establish their own write success.

## Handoff fields

Graph edges can define:

| Field | Purpose |
|---|---|
| `require_tags` | Follow the edge only when every tag matches |
| `skip_if_tags` | Skip the edge when every tag matches |
| `max_turns` | Limit the target agent's turns |
| `request_type` | Pass an execution hint to the provider |
| `capabilities` | Grant the target agent a bounded set of tools |

## Capabilities

| Capability | Allows |
|---|---|
| `create_flag` | Create, extend, or reuse an application flag |
| `flag_state` | Read flag type, variations, and environment state |
| `create_metric` | Create application metrics |
| `edit_files` | Edit code, run tests, and use the entry point's Git behavior |
| `write_manifest` | Create or update agent-owned manifest fields |
| `steward_manifest` | Normalize human-owned release intent |
| `query_graph` | Query dependencies and blast radius |
| `query_repos` | Research registered sibling repositories |
| `query_sentry` | Read optional Sentry estate context |
| `read_docs` | Read allowlisted LaunchDarkly documentation |

Capability grants are intersected with the global flag-creation and code-change toggles.
Missing optional context tools fail softly.

## Shared application metrics

`metrics/` currently contains Sentry-backed error metrics provisioned into the app project.
The Metrics Author can reuse them when LaunchDarkly targeting serves its Sentry variation.

## Naming

Use **AutoFactory** in prose, `autofactory-` for Agent Config keys, and `auto-factory-` for
operational flag keys.
