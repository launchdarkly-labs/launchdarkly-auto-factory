# ADR 0019: Issue intake — an optional entry point to the left of the PR

Date: 2026-09-04
Status: accepted

## Context

Phase 1 starts at a pull request: a human (or a vendor's coding agent) writes
the code, opens the PR, and the LaunchDarkly-defined chain decides on a flag,
wires it, adds metrics and tests, and reviews. That leaves the most expensive
and most variable step — *generating the code* — outside the factory. We
cannot answer "how many tokens did this feature cost?" or "which coding-agent
configuration causes the fewest regressions?" when the coding agent is not one
of ours and its run is not joined to the PR, the flag, or the release.

The goal is a linear proof of concept, not a full dark software factory: an
agent that picks up a GitHub issue, implements it, and hands the result to the
regular chain — optional, and invisible to the canonical demo (automatic PR
runs must not change).

## Decision

**One graph, two entry points.** The issue coder is a new AI config
(`autofactory-issue-coder`) added to the existing `gha-auto-factory` graph as
its **root**, with a single edge into the research planner marked
`handoff.intake: true`. The graph is re-rooted, not extended sideways, because
the LaunchDarkly AI SDK disables a graph whose nodes are not all reachable from
the root. The walker gains two options:

- `startAt` — the node to enter at. When unset, `defaultEntryNode()` returns
  the root *unless the root is an intake node*, in which case it follows the
  intake edge(s) forward to the first regular node. Every existing front end
  (Action, extension, `autofactory run`) therefore still starts at the planner
  with no code change at the call site.
- `stopAfter` — node keys after which the walk ends cleanly. The intake run
  executes only the coder; the hand-off to the rest of the chain is
  out-of-band, via the PR.

**Two runs, joined by the issue.** `autofactory intake --issue <n>`:

1. checks out `autofactory/issue-<n>` from the base (or resumes it),
2. runs the coder with the sandbox tools in `push` git mode, **without**
   `[skip ci]` on its commits (GitHub suppresses `pull_request` runs when the
   head commit says so, which would keep the chain from ever seeing the PR),
3. verifies from git that commits reached the remote, and
4. opens the PR: the coder's summary as the body, `Closes #<n>`, and an HTML
   comment **intent marker** carrying the intent id (`issue-<n>`), the intake
   run id, repo, graph, and node.

The PR-triggered run parses the marker: `TICKET_ID` defaults to the intent,
and `ticket`, `pr`, `repo`, `entry`, and `intake_run` are stamped as attributes
on the `run` context (`withRunAttributes`). The intake run stamps `ticket`,
`repo`, `entry=issue` on its own `run` context. Every AI-config evaluation and
metric event either run emits — tokens, duration, judge scores — now carries
the ticket, so a warehouse can sum cost per issue across both runs and join it
to the flag the chain created (the implementer already tags flags with
`{{TICKET_ID}}`).

**Thin by design.** The coder gets `edit_files`, `read_docs`, and
`query_repos` — no flag, metric, or manifest powers; those stay with the chain.
No approval gates or judges on the intake run in this iteration.

**Provider ceiling.** Same as `run`: Anthropic, Bedrock, or OpenAI (sandbox-
confined runners), since the coder edits a real checkout.

**Triggers.** The CLI is the primary surface (local, testable). A workflow
template (`bootstrap/github-action-template/auto-factory-intake.yml`) runs it
on `issues: labeled` with the `autofactory` label. In Actions the PR must be
opened with a PAT (`AUTOFACTORY_INTAKE_TOKEN`): PRs opened by a workflow's own
`GITHUB_TOKEN` do not trigger `pull_request` workflows.

## Consequences

- The canonical demo is unchanged in behavior. Its graph picture now shows the
  full lane (coder → planner → … → reviewer); the walker's `skipped` list
  excludes intake nodes a run legitimately entered past.
- Cost-per-issue and config-vs-outcome questions become joinable on `ticket`
  once AI-config events are exported (Data Export → Snowflake, separate work).
- A/B of the coder's model or prompt is one variation + targeting rule away,
  bucketed on the `run` key like the other agents.
- Re-rooting requires the code that understands `handoff.intake` to ship
  before the graph change is provisioned; `bridge upgrade` PATCHes the graph.
- Vendor cloud coding agents (Cursor background agents, Copilot coding agent,
  Codex cloud) are not addressed: their token accounting is not in-band. They
  can become a later provider variation of the coder node.
- Not addressed: Slack/ticket-system intake (open a GitHub issue from those
  first), gates/judges on the coder, single-process "coder then chain" runs.
