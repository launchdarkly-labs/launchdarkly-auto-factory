# Install: AutoFactory in Claude Code

Run the full AutoFactory Phase 1 chain from a Claude Code session: `/autofactory`
researches your current change set and, when it's flag-worthy, creates a feature
flag (targeting off), wires the behavior behind it, adds guarded-release metrics
and instrumentation, writes flag-on/flag-off tests and a release manifest, and
produces a review verdict. All edits stay **uncommitted in your working tree**
for you to review; nothing is committed or pushed.

Two pieces: this tooling repo (holds the CLI and your secrets) and a small skill
you drop into your app repo. Setup is about 10 minutes.

## Prerequisites

- **Node 20+** (`node --version`)
- **Claude Code** ([install](https://claude.com/claude-code))
- A **LaunchDarkly account** and an **API access token** (`api-…`) with write
  access — the two projects and the SDK key are created/fetched by setup
- An **Anthropic API key** — agents execute on the Anthropic API directly, billed
  to this key (separate from your Claude Code subscription)

## 1 + 2. Clone and run the guided setup

```bash
git clone <this-repo> && cd launchdarkly-auto-factory
npm install
npm run init
```

`init` asks for the API token and Anthropic key (masked prompts), then: creates
or confirms the **factory** project (agent configs + graph — the pipeline reads
from it) and the **app** project (where agents create flags and metrics),
**fetches** the factory environment's server SDK key, writes `.env`, and
provisions the agent AI configs, judges, agent graph, and operational flags.
It's idempotent — re-running resumes, and existing resources are never
overwritten. Choose provider **anthropic** (default; or `bedrock` with AWS
credentials set) and front end **claude-code** — it copies the skill into the
app repo path you give it. Then persist the tooling path:

```bash
export AUTOFACTORY_HOME="$(pwd)"    # add to your shell profile to persist
```

(If `AUTOFACTORY_HOME` isn't set, Claude Code will ask for the checkout path on
first run instead. You can also run the setup conversationally: open a Claude
Code session in this repo and type `/autofactory-setup`.)

Commit `.claude/skills/autofactory/` to the app repo if you want every user of
the repo to have the skill. Validate the install any time with `npm run doctor`.

<details>
<summary>Manual alternative (what init automates)</summary>

Create the two LD projects and an API token + factory-environment server SDK key
by hand, then `cp .env.example .env` and fill in `LD_SDK_KEY`, `LD_API_KEY`,
`LD_PROJECT_KEY`, `LD_APP_PROJECT_KEY`, `ANTHROPIC_API_KEY`; run
`npm run bootstrap` (accept provider **anthropic**; its printed "Next steps" are
for the GitHub Action — skip them); finally copy the skill:

```bash
mkdir -p <your-app-repo>/.claude/skills
cp -R bootstrap/claude-code/skills/autofactory <your-app-repo>/.claude/skills/autofactory
```

</details>

## 3. First run

In your app repo, on a branch with some changes (committed or not), open a
Claude Code session and run:

```
/autofactory
```

The chain takes several minutes across 5–6 agents; Claude Code narrates progress
as each agent finishes. For a read-only preview first, ask for a dry run ("run
AutoFactory as a dry run") — no flags created, no files edited.

When it finishes you'll have, for a flag-worthy change: a flag (targeting off)
and three guarded-release metrics in your app project, the behavior wired behind
the flag, metric instrumentation, flag-on/flag-off tests, and a release manifest
under `.release-flags/` — all uncommitted in your working tree. Review and
commit them yourself.

**Approval gates:** depending on the `auto-factory-approval-mode` flag in your
factory project, the chain may pause before a step and ask you in the session
whether to proceed. The default mode (`yolo`) runs unattended.

**Verdicts:** a rejected review is the reviewer agent's opinion, not a pipeline
failure — read it and decide. Changes that don't need a flag (docs, dependency
bumps, config) short-circuit cleanly after the first agent.

## Optional: make AutoFactory the default path to a PR

Two committed layers in your app repo (both under `bootstrap/claude-code/` here):

1. **Advisory** — merge `bootstrap/claude-code/CLAUDE.md.snippet` into the app
   repo's `CLAUDE.md`: every Claude Code session is nudged to run `/autofactory`
   before pushing.
2. **Deterministic** — copy `bootstrap/claude-code/hooks/autofactory-gate.mjs`
   to the app repo's `.claude/hooks/` and merge `bootstrap/claude-code/settings.json`
   into its `.claude/settings.json`: a pre-push hook blocks `git push` /
   `gh pr create` on branches where AutoFactory hasn't run, and asks for
   confirmation when the last run was rejected. It fails open on its own errors.

## Troubleshooting

First move for anything below: `npm run doctor` in the tooling repo — it checks
all of these (and prints the fix next to each failing check).

| Symptom | Fix |
|---------|-----|
| `LD_SDK_KEY is not set` (or similar, exit 2) | The CLI reads `.env` from the tooling repo root — re-run `npm run init` (or fill the values by hand). |
| `Agent graph 'gha-auto-factory' is disabled or unavailable` | `LD_SDK_KEY` is usually the wrong project's key — it must be the **factory** project's server SDK key, not the app project's (`npm run doctor` verifies this exactly; `npm run init` fetches the right one). Also confirm provisioning completed. |
| `nothing to process` (exit 2) | The branch has no commits ahead of the base and no working-tree changes. Make a change first, or pass a different base (`--base <ref>`). |
| `⚠ knowledge graph: ld-find-code-refs binary not found on PATH` | Harmless — flag→code wrap-point edges are skipped, the run continues. Only appears when the `auto-factory-knowledge-graph` flag is on. To silence: `brew install launchdarkly/tap/ld-find-code-refs`, or grab a binary from [ld-find-code-refs releases](https://github.com/launchdarkly/ld-find-code-refs/releases). |
| `⚠ LaunchDarkly configs were provisioned from a different repo version` | Your LD configs pre-date this checkout. Run `npm run bridge -- upgrade` from the tooling repo (add `--dry-run` to preview). |
| Chain pauses and exits with code 3 | Not an error — an approval gate held. Claude Code asks you whether to approve; on yes it re-runs past the gate. |

More detail: [`bootstrap/claude-code/README.md`](bootstrap/claude-code/README.md)
(design, gates, fidelity notes) and [`packages/phase1-cli/README.md`](packages/phase1-cli/README.md)
(the underlying `autofactory` CLI, exit codes, run records).
