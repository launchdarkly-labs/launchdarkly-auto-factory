# LaunchDarkly AutoFactory

Prototype of autonomous, safe software releases. A chain of LaunchDarkly-defined AI agents
turns a plain pull request into a feature-flagged, metric-instrumented, tested change, and a
release orchestrator turns the eventual deploy into a guarded rollout that monitors itself.

Status: working prototype, shared with design partners. Phase 1 and Phase 2 both run
end-to-end against a live demo repo. Not a product.

## How it works

- **Phase 1 (per change):** resolve an agent graph and six agent configs from LaunchDarkly
  and walk the chain: research and classify the change, normalize any human-stated release
  intent, create a feature flag (targeting off), wire the new behavior behind it, create
  guarded-release metrics and instrument their events, write flag-on/flag-off tests, and
  produce a review verdict. A release manifest
  (`.release-flags/…json`) records the flag, metrics, and rollout parameters. LaunchDarkly
  **judges** attached to the coding agents score each output 0..1 against the agent's actual
  git diff — a sampled, non-blocking evaluation layer (the reviewer remains the gate; see
  [ADR 0007](docs/adr/0007-judges-for-coding-agents.md)). Phase 1 has four
  interchangeable front ends over one shared core (see [Phase 1 front ends](#phase-1-front-ends)):
  a **GitHub Action**, a **Cursor/VS Code extension**, a **native Cursor automation**,
  and a **headless CLI** driven from a terminal or a Claude Code session.
- **Phase 2 (after deploy):** Beacon, a small HTTP service, receives deploy webhooks,
  diffs `.release-flags/` between the deployed SHA and the previous one, and starts a
  guarded release for each new manifest (turning the flag on atomically). It then monitors
  the release to a terminal state: completed, reverted by a guardrail metric, or stopped.
  When Sentry is wired (ADR 0014), shared `sentry-errors-*` metrics can killswitch the
  rollout; on `reverted`, Beacon can start Seer Autofix (`BEACON_SEER_AUTOFIX`).
- **Phase 3 (flag cleanup):** out of scope; existing LaunchDarkly functionality.

Sentry layer (optional — nothing changes until you opt in): [ADR 0014](docs/adr/0014-sentry-guardrails-and-agent-monitoring.md) —
app error killswitches via the LD↔Sentry metrics integration, factory LLM traces in Sentry
AI agent monitoring, Seer on revert (`BEACON_SEER_AUTOFIX`). [ADR 0015](docs/adr/0015-sentry-estate-and-dual-export.md) —
Metrics Author `query_sentry` estate picture at author time; dual-export so the same spans
reach Sentry **and** LD (Sentry does not OTLP-export outbound; `otel*` / KG still need LD o11y).
The agent-side path lives in a **`sentry` variation** of the Metrics Author AI config —
LaunchDarkly targeting selects it; the `default` variation is unchanged from the
non-Sentry factory. Runtime pieces key off `SENTRY_*` env and soft-disable without it.

Node-by-node detail with the exact mechanics: [docs/pipeline-overview.html](docs/pipeline-overview.html).
Design history: [docs/adr/](docs/adr/).

## Repository layout

| Path | What it is |
|------|------------|
| `packages/shared/` | LD clients (REST + native SDK), the `AgentRunner` provider seam, the Anthropic / Vega / Cursor runners and agent tools, LLM-observability spans (LD + Sentry AI monitoring), the release adapter, and the provider-agnostic Phase 1 orchestration (graph walk + approval) |
| `packages/phase1-resource-factory/` | Phase 1 front end #1 (GitHub Action): code; its drop-in workflow lives in `bootstrap/github-action-template/` |
| `packages/phase1-cursor-extension/` | Phase 1 front end #2 (Cursor/VS Code extension): working-tree edits from the editor, calls Anthropic directly |
| `bootstrap/cursor-automation/` | Phase 1 front end #3 (native Cursor automation): a drop-in `.cursor/` rule + command + MCP config; runs in Cursor's own agent (local prototype) |
| `packages/phase1-cli/` | Phase 1 front end #4 (headless `autofactory` CLI): the full chain against a local working tree; the drop-in Claude Code skill that drives it lives in `bootstrap/claude-code/` |
| `packages/beacon/` | Phase 2 release orchestrator (webhooks, discovery, trigger, monitor, optional Seer Autofix on revert) |
| `packages/config-bridge/` | CLI that provisions/syncs the agent configs, graph, operational flags, and shared APP metrics between LD projects |
| `config/agentcontrol/ai-configs/` | The six agent + two judge definitions (instructions live here and in LD) |
| `config/agentcontrol/tools/` | The agents' tool definitions (descriptions + schemas), provisioned into LaunchDarkly's tools library and attached per variation — editable in the LD UI; execution stays in code (ADR 0011) |
| `config/agentcontrol/graphs/` | The agent graph: chain order, routing conditions, per-agent write capabilities |
| `config/agentcontrol/metrics/` | Shared APP-project metrics (Sentry-backed `sentry-errors-*` guardrails, ADR 0014) |
| `bootstrap/` | One-command setup, plus the drop-in front-end templates (GitHub Action workflow, Cursor automation) |
| `examples/demo-app/` | Local sandbox the agents run against in dry-run mode |
| `docs/` | Pipeline overview, ADRs, design docs |

## Phase 1 front ends

The same six-agent chain (one shared core in `packages/shared`) runs from four entry points;
pick whichever fits where you work. All four create the same flag/metrics/tests and write the
same release manifest — they differ only in trigger, output, and which models run the agents.

| Front end | Trigger | Output | Models | Status |
|-----------|---------|--------|--------|--------|
| **GitHub Action** — [`packages/phase1-resource-factory`](packages/phase1-resource-factory/), template in [`bootstrap/github-action-template/`](bootstrap/github-action-template/) | a pull request, in CI | commits to the PR branch | Anthropic / Vega / Cursor (flag-selected; model per agent from the AI config) | primary, verified path |
| **Cursor/VS Code extension** — [`packages/phase1-cursor-extension`](packages/phase1-cursor-extension/) | a button or a new commit, in the editor | edits left in your working tree | Anthropic API (Cursor can't expose its models to extensions) | working |
| **Native Cursor automation** — [`bootstrap/cursor-automation`](bootstrap/cursor-automation/) | the `/autofactory` command in Cursor | edits left in your working tree | Cursor's own models (no API key) | local prototype; cloud (auto, PR-based) is a later phase |
| **Headless CLI / Claude Code** — [`packages/phase1-cli`](packages/phase1-cli/), skill in [`bootstrap/claude-code/`](bootstrap/claude-code/) | `autofactory run` in a terminal, or `/autofactory` in Claude Code | edits left in your working tree | Anthropic API only (model per agent from the AI config; the working-tree ceiling requires the sandboxed runner — see the CLI README) | new; full fidelity (judges, monitoring, gates) |

Setup for the GitHub Action is below; the extension, the automation, and the CLI each have their
own README. For the Claude Code path there is a standalone install guide:
[INSTALL-CLAUDE-CODE.md](INSTALL-CLAUDE-CODE.md).

## Phase 1 setup (GitHub Action)

### Prerequisites

- Node 20+ for local tooling (the GitHub Action itself runs on Node 24; the Cursor provider requires Node ≥22.13)
- A LaunchDarkly account with **two projects**:
  - a **factory** project, which holds the agent configs and graph (the pipeline reads from it)
  - an **app** project, where the agents create flags and metrics (the pipeline writes to it)
- A LaunchDarkly server SDK key for the factory project's environment, and an API access
  token with write access to both projects
- An Anthropic API key (the default agent execution backend), or a Cursor API key to run on the Cursor provider
- A GitHub repository for your application

### 1. Provision the agent configs, graph, and operational flags

```bash
git clone <this repo> && cd launchdarkly-auto-factory
npm install
cp .env.example .env    # fill in LD_SDK_KEY, LD_API_KEY, LD_PROJECT_KEY, LD_APP_PROJECT_KEY, ANTHROPIC_API_KEY
npm run bootstrap       # prompts for the execution provider (anthropic or cursor)
```

Bootstrap runs preflight checks, then creates, in your factory project from the committed
definitions in `config/agentcontrol/`: the six agent AI configs, the two **judge**
configs (attached to the flag-implementer and metrics-author, so evidence-based quality
scoring works out of the box), the `gha-auto-factory` agent graph, and the operational
flags (`auto-factory-ai-provider`, the approval trio: `auto-factory-approval-mode`,
`auto-factory-risk-threshold`, `auto-factory-approval-gates`, and
`auto-factory-knowledge-graph`) — approvals default to `yolo` and the knowledge graph to
off, so they're visible and ready to toggle in your LD UI without changing behavior.
It is idempotent: existing
resources are left untouched (your targeting is never overwritten). After provisioning, the
agent instructions are editable in the LaunchDarkly UI; the pipeline reads them at run time,
so instruction changes take effect on the next PR without redeploying anything.

**Already bootstrapped?** Pull config updates from a newer version of this repo with:

```bash
npm run bridge -- upgrade            # add --dry-run to preview first
```

`upgrade` creates anything missing (new agents, graph edges, flags) and syncs existing
agent *instructions* to the committed copies. It never touches your flag targeting, model
choices, or variations it doesn't recognize (e.g. an A/B arm you added) — drift there is
reported, not overwritten.

You don't have to remember to run it: `provision`/`upgrade` stamp a config-version marker
(`[cfg:…]`) on the agent graph's description, and the action compares it against its own
checkout at the start of every run. When your LD configs fall behind the action code, the
run warns — in the Actions log and the PR summary comment — and points you back at
`upgrade`. Editing agent instructions in the LD UI does *not* trip the warning; the stamp
tracks which repo version last provisioned the project, not live content.

### 2. Add the workflow to your app repo

Copy `bootstrap/github-action-template/auto-factory.yml` into your app repo at
`.github/workflows/auto-factory.yml` and replace `<owner>` with the org or user hosting this
repo. Then set, in the app repo:

| Kind | Name | Value |
|------|------|-------|
| secret | `LD_SDK_KEY` | factory project server SDK key |
| secret | `LD_API_KEY` | LD API token (writes flags/metrics in the app project) |
| secret | `ANTHROPIC_API_KEY` | Anthropic API key |
| variable | `LD_APP_PROJECT_KEY` | your app project key |

`GITHUB_TOKEN` is provided by Actions automatically. The workflow needs
`contents: write`, `pull-requests: write`, and `checks: write` (the last for the
approval-gate check run; all already set in the template).

**Optional — knowledge-graph enrichment** (`auto-factory-knowledge-graph` flag, off by
default): when enabled, each run composes an impact graph from LaunchDarkly-native sources —
service dependencies derived from your **observability** traces, and flag→code wrap points
from **code references** — and gives the research planner a `query_dependencies` tool for
blast-radius analysis. To light up all sources: commit an `.autofactory/services.yaml`
service registry to your app repo (see the demo app for the shape), instrument your services
with the LaunchDarkly observability SDKs, keep the `ld-find-code-refs` install step from the
workflow template, and drop `bootstrap/github-action-template/find-code-refs.yml` into your
app repo for the standard on-merge code-references scan (no LaunchDarkly-side setup — the
scanner registers the repository itself). Missing sources degrade to warnings, never
failures.

**Optional — cross-repo research** (split-repo estates): if parts of your product
live in other repositories (a mobile app consuming this repo's API, a platform
library you depend on), register them in `.autofactory/services.yaml`:

```yaml
relatedRepos:
  mobile-app:
    repo: your-org/mobile-app
    relationship: downstream   # consumes this repo's surfaces (upstream = we consume theirs)
    description: React Native app calling the gateway API
```

The research planner then gets a `query_related_repos` tool (list/search/read over
the GitHub API) to establish upstream/downstream impact of each PR across the
estate, reported as `cross_repo_impact` in its brief. When a cross-repo dependency
means a feature must not go live before another flag, the planner recommends a
**prerequisite flag** and the flag implementer wires it at creation time (the flag
stays off; the dependency binds at release — same-project flags only, see
[ADR 0012](docs/adr/0012-cross-repo-research-and-prerequisites.md)). The default
`GITHUB_TOKEN` reads public and same-repo code; set an `AUTOFACTORY_REPOS_TOKEN`
secret (and pass it through the workflow env) for private sibling repos. No
registry, no tool — and failures degrade to warnings, never failed runs.

To run on the **Cursor** provider instead, copy `bootstrap/github-action-template/auto-factory-cursor.yml`
(it checks the tool out and `npm ci`s it, because the Cursor SDK can't run via the bare
`uses:` form), set a `CURSOR_API_KEY` secret in place of `ANTHROPIC_API_KEY`, and serve
`cursor` from the provider flag (below).

### 3. Open a pull request

Write the change normally, with no flag. The chain runs on every PR
(opened/synchronize/reopened/labeled) and takes a few minutes. Optional: set the
repo variable `AUTOFACTORY_REQUIRE_LABEL=true` to gate it on the `autofactory`
PR label instead (feature PRs only, not docs/chores). On a flag-worthy PR you get:

- a string multivariate flag in the app project (`control` + `v1`), targeting **off** in all
  environments — follow-up PRs iterate it with new variations (`v2`, `v3`, …) or ride an
  unreleased one instead of stalling
- commits on the PR branch: flag wiring, metric instrumentation plus the release manifest,
  and flag-on/flag-off tests
- three guarded-release metrics (error, latency, business) wired to the instrumented events
- a summary comment on the PR and a check status

The check is green when the code reviewer approves and red when it rejects. A red check is a
review verdict, not a pipeline failure. PRs that do not need a flag (docs, dependency bumps,
config changes) short-circuit after the first agent.

### Behavior toggles

| Input | Default | Effect |
|-------|---------|--------|
| `enable_flag_creation` | `false` in the action, `true` in the template | create real flags/metrics vs. read-only dry run |
| `enable_code_changes` | `false` in the action, `true` in the template | allow agent commits to the PR branch |
| `approval_mode` / `risk_threshold` | unset | env OVERRIDES for the approval flags below; normally control via flags |
| `graph_key` | `gha-auto-factory` | which agent graph to walk |

The `auto-factory-ai-provider` flag (factory project, string variations
`anthropic`/`vega`/`cursor`) selects the execution backend per run. Bootstrap provisions it
**off** (serves `anthropic`); flip it to serve `vega` or `cursor`. (If the flag is ever
absent, the runtime defaults to `anthropic`.) The graph, instructions, and per-agent model are
the same across providers — only the model brain changes. The model for each agent is read
from its AI config, so reasoning agents (research, review) and coding agents can run different
models and be compared per agent.

The runtime stamps the **resolved provider** on the run context (`run.provider`), so AI config
targeting rules can serve provider-compatible models — e.g. a Cursor-catalog model only when
`provider` is `cursor`, an Anthropic-only model otherwise. Optional: with no rules, fallthrough
serves as before.

### Observability

Every agent run records duration, tokens, and success/error to LaunchDarkly **AI Config
monitoring**, and emits a `gen_ai` OpenTelemetry span to **LLM Observability** (cost derived
from each model's configured token pricing). On by default; set `DISABLE_LD_OBSERVABILITY=true`
to opt out. Spans and metrics are correlated to the AgentControl config and to a per-run id.

**Judges** add the quality dimension: LaunchDarkly judge configs attached to the
flag-implementer and metrics-author variations score each run 0..1 (with reasoning) against
**verified evidence** — the node-scoped git diff of what the agent actually committed, gathered
by the pipeline rather than claimed by the agent. Scores record per-variation under the judge's
`$ld:ai:judge:…` metric (each config's Monitoring tab, or Metrics → Judge metrics), which is
what makes the per-agent model A/B a cost-vs-quality comparison. Judges run on the Anthropic
and Cursor providers; Vega skips them.

### Approvals: three flags, compiled into pre-execution gates

Human approval is controlled by three LaunchDarkly flags in the factory project that
**compile into gates which pause the chain before a step runs** (so nothing is created or
pushed for that step until a human approves — there is no post-hoc "approval" of work
already done):

| Flag | Question it answers | Values |
|------|---------------------|--------|
| `auto-factory-approval-mode` | whether approvals happen | `yolo` (default: no gates, unattended) · `risk-threshold` · `always` |
| `auto-factory-risk-threshold` | how sensitive | number 0–1 (default 0.6); in risk-threshold mode a step gates when the research agent's `risk_score` ≥ this |
| `auto-factory-approval-gates` | where | array of agent node keys (min: the flag implementer); entries may be `{step, threshold}` objects to override the threshold per step |

In **risk-threshold** mode the research planner's numeric `risk_score` (0–1, emitted on
every run) decides per run whether the gated steps need a human; unknown risk **fails
closed** (gates apply). A non-yolo mode with no configured steps defaults to gating the
flag implementer. Tune the threshold up/down based on what you see run.

When a gate holds, the **GitHub Action** halts before the step, comments which PR label to
add (`af-approve:<nodeKey>`), and posts a distinct `action_required` check run (**AutoFactory
— Approval gate**) rather than a red failure. Adding the label re-runs the chain past that
gate (the template listens for the `labeled` event; approval persists across pushes). In the
**Cursor extension**, a modal asks to approve or stop at each gate.

## Phase 2 setup (Beacon)

Phase 2 works end-to-end but is not yet a self-serve install; expect to read code. Summary
of what a deployment involves (details in [packages/beacon/README.md](packages/beacon/README.md)):

1. **Host Beacon** anywhere that runs a container:
   `docker build -f packages/beacon/Dockerfile .` from the repo root. Required env:
   `BEACON_WEBHOOK_SECRET`, `GITHUB_TOKEN` (reads `.release-flags/` via the contents API),
   `LD_API_KEY`, `LD_PROJECT_KEY` (the app project), `LD_ENVIRONMENT_KEY`.
2. **Register your services** in `config/services.yaml`: side (frontend/backend), repo,
   and a status URL that returns the deployed SHA.
3. **Point a deploy webhook at it.** Generic contract: POST `/flag-releases` with
   `{service, sha, previousSha?, environment?}` and the shared secret. A Railway adapter
   exists at `/webhooks/railway` (secret as a query parameter, since Railway webhooks cannot
   set headers). Other CD systems need a similar small adapter or a curl step in the
   pipeline.
4. Beacon resolves `previousSha` from its own deploy-state store when the notification does
   not carry one, diffs the manifests, triggers releases (method precedence: manifest
   overrides, then the flag's release policy, then guarded-if-metrics), and monitors each
   release to completion.

Known limitations: the deploy-state store is a local JSON file (single instance, mount a
volume to survive redeploys).

## Development

```bash
npm run build        # tsc project build
npm test             # unit + integration tests
npm run typecheck    # build + tests typecheck
npm run check:public # guard against committing internal material
npm run check:configs # validate agent configs/graph consistency (tags, routing, README)
```

Changes to the agent configs, the graph, or operational flags are logged in
`config/agentcontrol/CHANGELOG.md`. The committed config files are the canonical public
copies; if you edit instructions in LaunchDarkly, re-export them here.

## Note: this repo is public

`reference-private/` and `sources/repos/` are gitignored. Internal material must never be
committed; `npm run check:public` enforces the obvious cases.
