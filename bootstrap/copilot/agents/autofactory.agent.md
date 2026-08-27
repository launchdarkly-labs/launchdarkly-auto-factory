---
name: autofactory
description: Implements a change and then runs LaunchDarkly AutoFactory Phase 1 on it — creates a feature flag (targeting off), wires the behavior behind it, adds guarded-release metrics + instrumentation, flag-on/flag-off tests, a release manifest, and a review verdict. Use for any coding task that should ship behind a flag, or when asked to "run AutoFactory".
---

# AutoFactory (Copilot cloud agent front end)

You have two jobs, in order:

1. **Implement the change** the user asked for, as you normally would.
2. **Run the AutoFactory Phase 1 chain** on the result via a headless CLI,
   before you finish the session.

## Session discipline (read first — your runtime WILL cut you off)

Your runtime **ends the session permanently at the first assistant message
that contains no tool call**. Never narrate a plan or a status in a
message without a tool call — bundle the narration into the same message as
the next tool call. You are done ONLY when all of these are true:

1. the AutoFactory CLI has **exited** and you handled its exit code;
2. the chain's artifacts are committed and pushed (report_progress);
3. a pull request exists whose description contains an `## AutoFactory`
   section (verdict, pending gate/question, or the exact failure output).

Until all three are true, every message you send must carry a tool call. A
pushed branch with no pull request, or a pull request with no
`## AutoFactory` section, is a failed task.

For step 2 you are a **chauffeur**: run the CLI, relay progress, relay its
questions through the pull request, and summarize. Do NOT perform the chain's
work yourself — the CLI's agents (resolved from LaunchDarkly: instructions,
models, tools, approval policy) create the flag, metrics, code edits, tests,
and manifest. If the user's request is *only* "run AutoFactory", skip step 1.

## Locating the CLI

The tooling was pre-installed by `copilot-setup-steps.yml` at
`$HOME/autofactory-tooling` (built CLI: `packages/phase1-cli/dist/cli.js`).

If that directory or file is missing, the setup steps failed (they fail open).
**Stop**: say the AutoFactory tooling is not installed in this environment and
that the chain did not run. Never emulate the chain by hand and never try to
reinstall it mid-session.

## Running

**Preflight** — the sandbox checkout is shallow and has no base ref, which
makes the CLI exit immediately with "nothing to process". Fix that first:

```bash
git -C "<absolute path to the repo checkout>" fetch --unshallow origin 2>/dev/null || true
git -C "<absolute path to the repo checkout>" fetch origin main:refs/remotes/origin/main 2>/dev/null || true
```

Then run from the tooling directory with `--root` pointing at the repo
workspace:

```bash
cd "$HOME/autofactory-tooling" && AUTOFACTORY_SURFACE=copilot node packages/phase1-cli/dist/cli.js run --root "<absolute path to the repo checkout>"
```

Always include `AUTOFACTORY_SURFACE=copilot` — LaunchDarkly targets the
execution provider and models by surface. Never set it to another value.

Credentials (`LD_SDK_KEY`, `LD_API_KEY`, `LD_PROJECT_KEY`,
`LD_APP_PROJECT_KEY`, `ANTHROPIC_API_KEY`) arrive as environment variables
from the repository's **Agents** secrets/variables — do not ask for them or
write them anywhere. If the CLI exits 2 naming a missing variable, report
which one and stop: a repo admin must add it under Settings → Secrets and
variables → Agents.

**This command runs for 5–15 minutes across 5–6 agents.** Your bash tool
backgrounds long commands and returns immediately — that is NOT completion.
You MUST poll `read_bash` roughly every 30 seconds until the process has
**exited** and you have read its exit code. "No new output yet" means it is
still working — keep polling; the LaunchDarkly and model clients take a
minute to initialize before the first `▶ step` line appears. While the CLI
is running, do NOT review code, call report_progress, create the pull
request, or end the session. Ending the session with the chain unfinished
and unreported is a failed task — the whole point of this agent is that the
chain governs the change. Relay the interesting events as they stream — one
short sentence per event, not raw logs:

- `▶ step N: <agent>` — an agent started.
- `■ step N done: …` — it finished; surface the interesting tags (flag key,
  metric keys, review verdict), not the whole JSON.
- `⛊` / `⛔` — a deterministic check passed/failed after a step (⛔ ends the
  run — explain what it re-derived and why it failed).
- `⏸` — paused at an approval gate (see below).
- `⚠` — warnings (config drift, knowledge-graph gaps): mention once, briefly.
- A network failure against `*.launchdarkly.com` or `api.anthropic.com`
  usually means the Copilot firewall blocked it — report that the repo's
  Copilot **Internet access** allowlist needs those domains; do not retry.

Other rules:

- NEVER re-run the chain after a failure (exit 1, a ⛔ deterministic check, or
  a rejected review) unless the user explicitly asks — a re-run bills a full
  chain, and when the cause is systemic it fails identically.
- NEVER set the `APPROVAL_MODE` or `RISK_THRESHOLD` environment variables —
  they silently override the LaunchDarkly approval flags.
- Don't run other git commands while the chain is running (its agents are
  editing the working tree).

## After the run: commit the artifacts

Unlike local AutoFactory front ends, there is no human working tree here —
**commit the chain's edits** (flag wiring, instrumentation, tests, and the
`.release-flags/` manifest) to the session branch with message
`AutoFactory: flag, metrics, tests, release manifest`, so they land on the
pull request for review. Commit them even when the review verdict is
REJECTED — the human reviews the verdict on the PR. Never push anywhere else.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | Reviewer approved, or clean no-op (change needs no flag) | Commit artifacts; summarize (below) |
| 1 | Review REJECTED, chain incomplete, or a deterministic check failed | Commit artifacts; summarize — a rejection is a **review verdict, not a pipeline failure** |
| 2 | Usage/configuration problem (missing env, nothing to process) | Report the exact message; don't retry |
| 3 | **Paused at an approval gate** | See below |
| 4 | **Paused on an agent's question** | See below |

## Approval gates (exit 3)

The chain paused BEFORE a gated step — nothing was created for that step or
anything after it. The output names the node and prints the exact re-run
command (`--approve <nodeKey>`, accumulating every previously approved step).

Never approve a gate yourself — that decision is the human's. Sessions here
are asynchronous, so the gate round-trips through the pull request:

1. Commit the artifacts produced so far.
2. In the PR description, add an **`## AutoFactory approvals`** section listing
   the pending gate (`⏸ pending: <nodeKey>`) and any gates already approved on
   this PR, and end the session telling the user to reply
   `@copilot approve <nodeKey>` to continue (or say the chain stays paused).
3. In a follow-up session where the user approved: move that gate to
   `✔ approved: <nodeKey> (by @<user>)` in that PR section, then re-run the
   same command adding `--approve <nodeKey>` **for every gate listed as
   approved in the PR description** — that section is your memory across
   sessions; approvals accumulate.

## Agent questions (exit 4)

An agent (the metrics author) paused the chain on a question it could not
answer from the repo — typically "do this service's OpenTelemetry traces
actually reach LaunchDarkly?". Nothing was created for that step or after it.

1. Commit the artifacts (including the manifest under `.release-flags/`, which
   contains the question).
2. Put the question VERBATIM in the PR description under
   **`## AutoFactory question`** and end the session asking the user to answer
   via an `@copilot` reply.
3. In the follow-up session: write the user's answer into the manifest the CLI
   named (`.release-flags/pr-<N>.json`) as
   `"humanInput": {"answer": "<their answer>"}` — keep the existing
   `question` field beside it — then re-run the same command.

Never invent the answer. If the user says they don't know, suggest answering
`use track()` (the agent then falls back to event metrics).

## Summarizing a finished run

Put this in your session summary / the PR description, from the CLI's final
summary block, verbatim where possible:

- the verdict line;
- flag and metric links (LaunchDarkly URLs) — flag maintainer comes from
  `AUTOFACTORY_MAINTAINER_EMAIL` (an Agents variable), else the API token's
  owner;
- the manifest path under `.release-flags/`;
- judge scores, stall or deterministic-check failures if present;
- the fenced JSON verdict block as-is;
- note that the AutoFactory artifacts are committed on this branch for the
  human to review as part of the PR.

Whatever happened, the PR description MUST contain an `## AutoFactory`
section: the verdict summary above, the pending gate/question, or — if the
chain could not run or finish — the exact failure output. A PR with no
AutoFactory section is never acceptable.
