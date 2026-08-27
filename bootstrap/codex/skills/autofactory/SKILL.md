---
name: autofactory
description: Run LaunchDarkly AutoFactory Phase 1 on the current change set — create a feature flag (targeting off), wire the behavior behind it, add guarded-release metrics + instrumentation, flag-on/flag-off tests, a release manifest, and a review verdict. Use when the user says "run AutoFactory", "$autofactory", or asks to flag/instrument their current changes.
---

# AutoFactory Phase 1 (via the `autofactory` CLI)

You drive a **headless CLI** that executes the real AutoFactory chain (agents,
instructions, and models resolved from LaunchDarkly). Your job is chauffeur:
run it, relay progress, relay approval-gate questions, and summarize. Do NOT
perform the chain's work yourself — the CLI's agents create the flag, metrics,
code edits, tests, and manifest.

## Locating the CLI

The CLI lives in a checkout of the `launchdarkly-auto-factory` tooling repo at
`packages/phase1-cli/dist/cli.js`. Resolve the checkout path in this order:

1. the `AUTOFACTORY_HOME` environment variable;
2. ask the user where their `launchdarkly-auto-factory` checkout is.

If `packages/phase1-cli/dist/cli.js` is missing, build it first:
`npm install && npm run build` in the tooling repo.

## Running

Run from the **tooling repo** (its `.env` holds the LaunchDarkly + model keys)
with `--root` pointing at the user's repo:

```bash
cd "$AUTOFACTORY_HOME" && AUTOFACTORY_SURFACE=codex node packages/phase1-cli/dist/cli.js run --root "<absolute path to the user's repo>"
```

Always include `AUTOFACTORY_SURFACE=codex` — LaunchDarkly targets the
execution provider and models by surface (Codex runs route to OpenAI models).
Never set it to another value.

This command **needs network access** (LaunchDarkly + model APIs) and runs
from the tooling checkout **outside your workspace** — the default sandbox
will block it. Request escalated/unsandboxed execution for this command with
that justification; the user approves it once.

Run it as **one foreground command and wait** — the chain takes several
minutes across 5–6 agents and streams progress as it goes. Don't kill it for
being slow, and don't impose a short timeout. When it finishes, relay the
interesting events from the output — in one short sentence per event, not raw
logs:

- `▶ step N: <agent>` — an agent started ("Step 2: the flag implementer
  created the flag and wired the code…").
- `■ step N done: …` — it finished; surface the interesting tags (flag key,
  metric keys, review verdict), not the whole JSON.
- `⛊` / `⛔` — a deterministic check passed/failed after a step (⛔ ends
  the run — explain what it re-derived and why it failed).
- `⏸` — paused at an approval gate (see below).
- `⚠` — warnings (config drift, knowledge-graph gaps): mention once, briefly.

Then handle the exit code (below).

Other rules:

- NEVER re-run the chain after a failure (exit 1, a ⛔ deterministic check, or
  a rejected review) unless the user explicitly asks — a re-run bills a full
  chain, and when the cause is systemic it fails identically. Report what
  failed and wait. (Observed live: an unattended retry loop ran the same
  failing chain four times.)
- NEVER set the `APPROVAL_MODE` or `RISK_THRESHOLD` environment variables —
  they silently override the LaunchDarkly approval flags.
- `--dry-run` gives a read-only preview (no flags created, no edits) if the
  user asks for one.
- Don't run other git commands in the user's repo while the chain is running
  (the agents are editing that working tree).

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | Reviewer approved, or clean no-op (change needs no flag) | Summarize (below) |
| 1 | Review REJECTED, chain incomplete, or a deterministic check failed | Summarize; a rejection is a **review verdict, not a pipeline failure** |
| 2 | Usage/configuration problem (missing env, nothing to process) | Fix or ask the user; don't retry blindly |
| 3 | **Paused at an approval gate** | See below |
| 4 | **Paused on an agent's question** (needs a human answer) | See below |

## Approval gates (exit 3)

The chain paused BEFORE a gated step — nothing was created for that step or
anything after it. The output names the node and prints the exact re-run
command (`--approve <nodeKey>`, accumulating every previously approved step).

1. Ask the user: approve `<nodeKey>` and continue, or stop here?
2. On approval, re-run using the printed command (same `cd` + `--root` shape).
3. On stop, summarize what ran and note the chain is paused; a later re-run
   with `--approve` resumes it.

Never approve a gate yourself — that decision is the human's.

## Agent questions (exit 4)

An agent (the metrics author) paused the chain on a question it could not
answer from the repo — typically "do this service's OpenTelemetry traces
actually reach LaunchDarkly?" when wiring the LD evaluation hook for the first
time. Nothing was created for that step or anything after it.

1. Relay the question to the user VERBATIM (the CLI prints it; the agent's full
   analysis is in the step output above it).
2. When the user answers, write their answer into the release manifest the CLI
   names (`.release-flags/pr-<N>.json`) as `"humanInput": {"answer": "<their
   answer>"}` — keep the existing `question` field beside it.
3. Re-run the same command. The fresh run reads the answer and completes.

Never invent or assume the answer yourself — if the user says they don't know,
suggest answering `use track()` (the agent then falls back to event metrics).

## Summarizing a finished run

Relay from the CLI's final summary block, verbatim where possible:

- the verdict line;
- flag and metric links (LaunchDarkly URLs) — the flag is created with the
  user as maintainer (from their git email);
- the manifest path under `.release-flags/`;
- judge scores, stall or deterministic-check failures if present;
- the fenced JSON verdict block as-is;
- remind the user the edits are **uncommitted in their working tree** to
  review and commit themselves — nothing was pushed. Do not commit them
  unless the user asks.
