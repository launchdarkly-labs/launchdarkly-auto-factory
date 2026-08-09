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
| `metric_event_keys` | metrics-author | comma-separated event keys of event-backed metrics (set automatically by `create_metric`; the deterministic handoff shim greps the code for an emitter of each) |
| `tests_last_run` | flag-testing | `pass`/`fail` — outcome of the last real `run_tests` execution (set automatically by `run_tests`; a `fail` at handoff mechanically fails the run) |
| `risk_level` | code-reviewer | `low` / `medium` / `high`; categorical companion to `risk_score` (fallback mapping when the score is missing) |
| `risk_score` | research-planner | numeric `0.0`–`1.0`; in `risk-threshold` approval mode, steps gate when it meets the `auto-factory-risk-threshold` flag (fail-closed when absent) |

`interpretWalk` (`packages/shared/src/approval.ts`) reads
`review_approved` / `risk_level` first and accepts a few legacy keys
(`review_decision`/`decision`/`approved`, `risk`) only as fallbacks.

## Handoff fields the walker honors

Each graph edge's `handoff` object may carry: `require_tags`, `skip_if_tags`,
`max_turns`, `request_type`, `capabilities`, and `max_visits`.

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
- `"read_docs"`: the `read_ld_docs` tool — LaunchDarkly docs pages fetched as
  markdown (the docs site serves `.md` for any page; `llms.txt` is the
  directory). Allowlisted to launchdarkly.com/docs, size-capped, budgeted at 8
  fetches per node run, and fail-soft. Each granted agent's instructions carry
  a curated page shortlist.

### `max_visits` — bounded loop-back edges

`max_visits` is how you make the graph **iterate**. A loop-back edge (one whose
target has already run earlier in the chain — e.g. `code-reviewer →
research-planner` to re-plan a rejection, or `flag-testing → flag-implementer` to
fix failing tests) must carry `max_visits: N` to be allowed to loop: it may be
traversed at most N times (N re-runs; hard-capped at 10 in code) **per walk** —
see the scope caveat below. Identification
is **explicit** — the walker caps only edges that carry `max_visits`, never
untagged forward/rejoin edges — so tag exactly the loop-closing edge(s); nested
loops tag each loop edge. This is config, not code: the graph owns *which edges
loop and their budget*; the code owns the guarantees (the per-edge hard cap and a
run-level backstop) that a graph edit can't disable.

The committed graph ships **one** loop edge: `code-reviewer → flag-implementer`
with `max_visits: 2` and `require_tags: { review_approved: "false" }` — a rejected
review sends the work back to the implementer for at most one rework pass. Note the
polarity: it fires only on the literal `"false"`. The approval gate *normalizes* the
verdict (`reject`/`rejected` also count as a rejection), so a reviewer that drifts
off the instructed `true`/`false` still reports REJECTED but skips the rework. That
is the deliberate trade — `skip_if_tags: { review_approved: "approve" }` would loop
on anything that isn't the exact approval string, and reworking work the reviewer
*accepted* is the more expensive mistake. Also note the implementer is
`DEFAULT_GATED_STEPS`, so in non-`yolo` modes this loop halts at the approval gate on
re-entry rather than completing inside one walk.

When a loop re-enters a node, the walker **rewinds routing/verdict tags** (the
`production: "llm"` tags — `review_approved`, `risk_score`, …) to the state before
that node last ran, then overlays the loop source's routing tags as the trigger,
so the re-run starts clean rather than inheriting a stale downstream verdict.
**Tool-produced facts** (`production: "tool"` — `flag_key`, `metric_keys`, …) are
never rewound: they accumulate into a run *inventory* that reporting and the
approval guard read, so a rewind can't erase the record of resources that really
exist. A re-entered node's prompt gets a `REWORK ITERATION N` preamble listing
that inventory (see the agents' "Rework iterations" sections).

**Scope caveat — the budget is per walk, not per PR.** The traversal counter is
process-local (`edgeCounts` in `graphWalker.ts`), created fresh on every
`walkGraph` call and persisted nowhere. Since the Action re-runs on `synchronize`
and `labeled`, **each re-run starts with a full budget**: cumulative rework across
a PR's life is not bounded by `max_visits`. What `max_visits` guarantees is that
one walk terminates; it is not a per-PR iteration cap. This compounds with
label-based approval, which persists across pushes (see `labels.ts`) — an
already-approved gated node can be re-entered on every subsequent push, each time
preceded by a fresh re-plan. Making budgets cumulative requires persisting
traversal counts across runs (resumable walk state — see
`docs/phase4-judge-driven-loops.md` Step 2); until then, the run-level backstop and
the per-walk cap are the only ceilings.

An unmet loop edge is **convergence, not a stall.** When a `max_visits` edge's
conditions don't pass, the walker treats it like an intentional `skip_if_tags`
short-circuit rather than a blocked chain — so giving a previously-terminal node a
loop-back edge doesn't make every clean run report as stalled. Unmet *forward*
edges still stall (that's the "silently stalled" case the walker exists to
surface); only `max_visits` edges are exempt. This is the dual of the capping
rule: untagged forward edges are never budget-capped, and loop edges never
manufacture a stall.

If a loop does not converge within budget — or an untagged cycle runs to the
run-level cap — the run reports `loopExhausted`: a hard failure (red PR check,
non-zero exit), never a misleading "approved". Because the walker executes the
graph LaunchDarkly serves at runtime (not this committed copy), adding a
back-edge to a **served** graph is a live behavior change: previously such a
cycle terminated silently; now it iterates to budget then, if it hasn't
converged, goes red. `npm run check:configs` enforces that every cycle in the
*committed* graph carries a `max_visits` and that `max_visits ∈ [1, 10]`, but it
cannot see the runtime graph — the run-level cap is the backstop there.

Two behaviors worth knowing: (1) a tag that is neither `llm` nor `tool` in
`tags.json` is treated like a fact (never rewound) but is not inventoried, so
avoid routing on unregistered LLM-produced tags across a loop; (2) execution-
envelope inheritance (`max_turns`/`capabilities`/`request_type`) also applies when
a node is re-entered via any edge that omits those fields, including a forward
rejoin edge — grants widen to the first-entry values rather than the built-in
default.

Put grants here so "which agent can write" is config, not code. When an edge
omits `capabilities`, the runner falls back to a built-in per-config-key map
(`autofactory-research-planner`: write_manifest+flag_state+query_graph — the ROOT
node has no inbound edge, so this is its only grant path; `autofactory-manifest-steward`:
steward_manifest; `autofactory-flag-implementer`: create_flag+flag_state+edit_files+
write_manifest+read_docs; `autofactory-flag-testing`: edit_files;
`autofactory-metrics-author`: create_metric+edit_files+write_manifest+read_docs;
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
