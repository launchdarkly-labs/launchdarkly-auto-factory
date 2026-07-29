# config/agentcontrol

The customization surface for the agents: each agent's instructions and the
shape of the agent graph (root, nodes, edges/handoffs). These are what the
`config-bridge` provisions into a LaunchDarkly project (`npm run bootstrap`).

Editing these is the supported way to tune, add, split, or reorder agents
without touching code.

## ai-configs/

One JSON file per agent, in the shape `provision` consumes
(`key`, `name`, `description`, `mode`, `tags`, `variations`). These are the
canonical public copies of the six agents:

| File | Chain position | Role |
|------|----------------|------|
| `autofactory-research-planner.json` | 1 | classify the PR, research the flag landscape (existence + targeting/released-ness), decide the `flag_action`, produce the implementation brief, create the release manifest (+ intent skeleton) |
| `autofactory-manifest-steward.json` | 2 | normalize human `releaseIntent` edits (notes → structured fields), carry holds forward on iteration PRs; pass the brief through |
| `autofactory-flag-implementer.json` | 3 | execute the flag action (create multivariate flag / add vN variation / verify ride-existing / child flag w/ prerequisite), wire the code, correct the manifest flagKey + targetVariation |
| `autofactory-metrics-author.json` | 4 | create guarded-release metrics, instrument events, write metricKeys into the manifest |
| `autofactory-flag-testing.json` | 5 | flag-on/flag-off tests, run to green |
| `autofactory-code-reviewer.json` | 6 | independent verdict + risk level |

Only the `default` variation (the Anthropic tool-use surface, on
`claude-sonnet-4-6`) is committed. The live prototype project also carries
per-provider/per-model variations (e.g. a Vega runtime variant, and a Composer
variation on the coding agents for the Cursor A/B); those are not committed here —
the Composer variation waits on Composer becoming a built-in LD model.

The two **judge** configs (`autofactory-judge-implementation-quality.json`,
`autofactory-judge-metrics-quality.json`, mode `judge`, ADR 0007) ARE committed here and
provisioned by bootstrap, including their `judgeConfiguration` attachments on the
flag-implementer / metrics-author `default` variations — so a fresh install gets
evidence-based judging out of the box. Judge-instruction edits reset score
comparability — log them in the CHANGELOG.

Two-way convention: after provisioning, instructions are editable in the
LaunchDarkly UI and take effect on the next run. If you change them in LD,
re-export to these files so the repo stays canonical, and log the change in
`CHANGELOG.md`.

## tools/

One JSON file per sandbox tool (`key`, `name`, `description`, `schema`) — the
AgentControl tools-library definitions (ADR 0011). Generated from the code
registry with `npm run export:tools` (run it after adding/renaming a tool in
`sandboxTools.ts`); provisioned into LaunchDarkly by the bridge and attached to
each agent variation per the variation's `tools` name array in `ai-configs/`.
After provisioning, descriptions/schemas are editable in the LD UI (Library →
Tools) and take effect on the next run — the same two-way convention as
instructions: re-export edits here, or `upgrade` reverts them. Execution and
write-gating stay in code; attachments can narrow or re-describe an agent's
tools but never grant powers the graph's `capabilities` don't.

## graphs/

`auto-factory.json` defines the chain: root config, edge order, routing
conditions, and per-agent write capabilities. Note that the **action resolves
the graph live from LaunchDarkly at run time**; this file is what gets
provisioned, not what gets executed, so graph changes must be made in LD (or
re-provisioned into a fresh project) to take effect.

## metrics/

Shared **APP-project** metric definitions (ADR 0014). Provisioned into
`LD_APP_PROJECT_KEY` (not the factory project) by `npm run bridge -- provision|upgrade`.
Today: `sentry-errors-binary` and `sentry-errors-count` — fed by the
LaunchDarkly↔Sentry metrics integration on event key `sentry-errors`. The
metrics author's **`sentry` variation** (served via LD targeting; the `default`
variation is the unchanged non-Sentry path) reuses these as the error killswitch.

## Canonical agent tags

Agents drive routing and approval by emitting tags (via `tag_conversation`).
These are the canonical keys the pipeline reads; emit exactly these. The
machine-readable source of truth is [`tags.json`](tags.json) (producer, how it's
produced, consuming edges) — `npm run check:configs` enforces that this table,
the registry, the graph, and the instructions all agree.

| Tag | Set by | Meaning |
|-----|--------|---------|
| `skip_flagging` | research-planner | `"true"`: this PR needs no flag (short-circuits the chain) |
| `flag_worthy` | research-planner | the planner's flag-worthiness recommendation; advisory (no edge consumes it), but always recorded |
| `flag_action` | research-planner | the flag decision: `create` \| `extend_variation` \| `ride_existing` \| `child_flag` \| `none` — the implementer executes it, the metrics author picks its mode from it |
| `flag_ready` | flag-implementer | `"true"`: a VERIFIED flag outcome exists (set automatically by `create_flag`, `add_variation`, or `use_existing_flag`) — gates the hand-off to the metrics author |
| `flag_created` | flag-implementer | `"true"`: `create_flag` succeeded (informational; `flag_ready` does the routing) |
| `flag_key` | flag-implementer | the flag's key (set automatically by the flag tools) |
| `flag_variation` | flag-implementer | the variation this PR's code path lives under (`v1` fresh, `vN` on iterations; set automatically by the flag tools) |
| `needs_tests` | metrics-author | `"true"`: route to the testing agent |
| `review_approved` | code-reviewer | `"approve"`/`"approved"`/`"true"`: the change is approved |
| `metrics_created` | metrics-author | `"true"` if any metric was created/reused (set automatically by `create_metric`) |
| `metric_keys` | metrics-author | comma-separated metric keys attached (set automatically by `create_metric`) |
| `metric_event_keys` | metrics-author | comma-separated event keys of event-backed metrics (set automatically by `create_metric`; the deterministic handoff shim greps the code for an emitter of each; Sentry integration key `sentry-errors` is exempt) |
| `sentry_guardrail` | metrics-author | `"true"` when a shared Sentry-backed LD metric was attached as the error killswitch — verifier checks for `launchdarklyContext` in the checkout (ADR 0014) |
| `tests_last_run` | flag-testing | `pass`/`fail` — outcome of the last real `run_tests` execution (set automatically by `run_tests`; a `fail` at handoff mechanically fails the run) |
| `risk_level` | code-reviewer | `low` / `medium` / `high`; categorical companion to `risk_score` (fallback mapping when the score is missing) |
| `risk_score` | research-planner | numeric `0.0`–`1.0`; in `risk-threshold` approval mode, steps gate when it meets the `auto-factory-risk-threshold` flag (fail-closed when absent) |

`interpretWalk` (`packages/shared/src/approval.ts`) reads
`review_approved` / `risk_level` first and accepts a few legacy keys
(`review_decision`/`decision`/`approved`, `risk`) only as fallbacks.

## Handoff fields the walker honors

Each graph edge's `handoff` object may carry: `require_tags`, `skip_if_tags`,
`max_turns`, `request_type`, and `capabilities`.

`capabilities` is a string array granting the **target** node tool access on the
Anthropic provider:

- `"create_flag"`: the flag-action suite in the app project — `create_flag`
  (real STRING MULTIVARIATE flags: `control` + `v1`, created dark; AutoFactory
  never creates booleans), `add_variation` (append `vN` to an existing
  multivariate flag — the iteration path when its treatment is already
  released), and `use_existing_flag` (verify an unreleased variation covers the
  PR with no LD change).
- `"flag_state"`: the `get_flag_state` tool — a flag's kind, variation lineage,
  and per-environment targeting/released-ness. Read-only; the evidence behind
  the planner's `flag_action` decision and the implementer's verification.
- `"create_metric"`: real guarded-release metric creation in the app project
  (off a custom event the agent instruments with `track()`).
- `"edit_files"`: `write_file` / `edit_file` / `run_tests` / `commit_and_push`.
- `"write_manifest"`: the `write_manifest` tool — the ONLY writer of
  `.release-flags/` manifests (`write_file`/`edit_file` refuse those paths).
  Creates the `releaseIntent` skeleton but never updates an existing intent.
- `"steward_manifest"`: `write_manifest` in steward grade — may UPDATE the
  human-editable `releaseIntent` block (the manifest steward only).
- `"query_graph"`: the `query_dependencies` tool (ADR 0010) — blast-radius and
  dependency queries over the per-run knowledge graph. Read-only; only offered
  when the `auto-factory-knowledge-graph` flag enabled graph composition for
  the run, so a grant on a flag-off run is inert.
- `"query_sentry"`: the `query_sentry` tool (ADR 0015) — Sentry estate picture
  (issues, error volume, `launchdarklyContext` gap, dual-export hints). Soft when
  SENTRY_* env is unset (`available: false`).
- `"read_docs"`: the `read_ld_docs` tool — LaunchDarkly docs pages fetched as
  markdown (the docs site serves `.md` for any page; `llms.txt` is the
  directory). Allowlisted to launchdarkly.com/docs, size-capped, budgeted at 8
  fetches per node run, and fail-soft. Each granted agent's instructions carry
  a curated page shortlist.

Put grants here so "which agent can write" is config, not code. When an edge
omits `capabilities`, the runner falls back to a built-in per-config-key map
(`autofactory-research-planner`: write_manifest+flag_state+query_graph — the ROOT
node has no inbound edge, so this is its only grant path; `autofactory-manifest-steward`:
steward_manifest; `autofactory-flag-implementer`: create_flag+flag_state+edit_files+
write_manifest+read_docs; `autofactory-flag-testing`: edit_files;
`autofactory-metrics-author`: create_metric+edit_files+write_manifest+read_docs+query_graph+query_sentry;
`autofactory-code-reviewer`: read_docs);
everything else is read-only. Grants are always intersected with the global
`ENABLE_FLAG_CREATION` / `ENABLE_CODE_CHANGES` toggles.

## Naming convention

Prose form is **AutoFactory**. New resource keys use the `autofactory-` prefix
for AI configs and `auto-factory-` for flags. Existing live LD resources are not
renamed.

## Changelog

Changes to the AI configs, the agent graph, or operational flags are logged in
`CHANGELOG.md` (this directory).
