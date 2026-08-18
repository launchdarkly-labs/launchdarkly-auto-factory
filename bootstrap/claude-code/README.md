# AutoFactory in a Claude Code session

Phase 1 front end #4: `/autofactory` in Claude Code runs the full agent chain
on your current change set. This is **Option C** of [plan.md](plan.md) — a thin
skill that drives the headless [`autofactory` CLI](../../packages/phase1-cli/),
so the run has full fidelity (judges with verified evidence, AI Config
monitoring, gen_ai spans, per-agent models, code-enforced approval gates and
write ceiling, knowledge-graph and cross-repo tools). Claude Code's role is
chauffeur: run the CLI, relay progress, relay gate questions, summarize.

**Installing?** Follow the standalone step-by-step guide:
[INSTALL-CLAUDE-CODE.md](../../INSTALL-CLAUDE-CODE.md). The setup summary below
covers the same ground; the rest of this file is design detail.

## Setup (in your app repo)

1. Have a checkout of this tooling repo, bootstrapped per the
   [root README](../../README.md) (LaunchDarkly configs provisioned, the five
   secrets in the tooling repo's `.env`), and built:
   `npm install && npm run build`.
2. Copy [`skills/autofactory/`](skills/autofactory/) into your app repo at
   `.claude/skills/autofactory/`.
3. Point the skill at the tooling checkout: set `AUTOFACTORY_HOME` in your
   environment (e.g. `export AUTOFACTORY_HOME=~/src/launchdarkly-auto-factory`),
   or Claude Code will ask on first run.

Then, in a Claude Code session in your app repo: `/autofactory` (or "run
AutoFactory on my changes").

### Optional: run it automatically before every PR

Two committed layers make AutoFactory the default path to a PR for **every
user of the repo** (repo config, not per-user memory):

1. **`CLAUDE.md` nudge** (advisory): merge [`CLAUDE.md.snippet`](CLAUDE.md.snippet)
   into your app repo's `CLAUDE.md` — every session reads it and runs
   `/autofactory` before pushing.
2. **Pre-push gate** (deterministic): copy [`hooks/autofactory-gate.mjs`](hooks/autofactory-gate.mjs)
   to `.claude/hooks/` and merge [`settings.json`](settings.json) into
   `.claude/settings.json`. The hook intercepts `git push` / `gh pr create`
   and checks the run record the CLI writes at
   `.git/autofactory-last-run.json`: **denies** if AutoFactory hasn't run on
   the current branch (dry runs don't count), **asks the human** when the last
   run ended rejected/incomplete/verification-failed (a red verdict is a
   review opinion, not a pipeline failure), allows otherwise, and fails open
   on its own errors. Branch-granular by design — committing the agents'
   edits after a run doesn't re-trip it; "re-run after significant changes"
   stays advisory in layer 1.

Label-gated mode (optional): set `AUTOFACTORY_REQUIRE_LABEL=true` (env for the
hook — e.g. in `.claude/settings.json` `"env"` — and the matching repo variable
for the GitHub Action) to scope both to PRs labeled `autofactory`; unlabeled
bugfix/chore PRs then skip the gate and the Action.

The GitHub Action remains the server-side backstop for anything that bypasses
both.

## What you get

The chain works from your branch's diff against its base (committed +
uncommitted). On a flag-worthy change: a flag (targeting off) and three
guarded-release metrics in the app project, the behavior wired behind the
flag, metric instrumentation, flag-on/flag-off tests, and a release manifest
under `.release-flags/` — all left **uncommitted in your working tree** to
review and commit yourself. Nothing is pushed.

Approval gates (the `auto-factory-approval-mode` / `-risk-threshold` /
`-approval-gates` flags) are **code-enforced**: the CLI halts before a gated
step with exit code 3, Claude Code asks you in the session, and on a yes
re-runs past the gate with `--approve <nodeKey>`.

## Costs and caveats

- Agent execution is billed to your `ANTHROPIC_API_KEY`, separate from the
  Claude Code subscription — the tradeoff for full fidelity (see the plan's
  comparison table). The CLI always runs the Anthropic runner: it is the only
  provider structurally unable to commit or push (Vega is server-side; Cursor
  local agents carry native git that escapes the working-tree ceiling).
- The run is a process Claude Code watches, not an agent you steer mid-run.
- Judge evidence is the node-scoped working-tree diff (agents don't commit in
  this mode) — same ground-truth property as the Action's commit-scoped diff.
