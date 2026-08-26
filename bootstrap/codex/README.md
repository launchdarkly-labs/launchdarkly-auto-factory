# AutoFactory in a Codex session

Phase 1 front end #5: the `autofactory` skill (`$autofactory`) in OpenAI Codex
runs the full agent chain on your current change set. Same design as the
[Claude Code front end](../claude-code/) (Option C of its plan): a thin skill
that drives the headless [`autofactory` CLI](../../packages/phase1-cli/), so
the run has full fidelity (judges with verified evidence, AI Config
monitoring, gen_ai spans, per-agent models, code-enforced approval gates and
write ceiling, knowledge-graph and cross-repo tools). Codex's role is
chauffeur: run the CLI, relay progress, relay gate questions, summarize.

**Installing?** Follow the standalone step-by-step guide:
[INSTALL-CODEX.md](../../INSTALL-CODEX.md). The setup summary below covers the
same ground.

## Setup (in your app repo)

1. Have a checkout of this tooling repo, bootstrapped per the
   [root README](../../README.md) (LaunchDarkly configs provisioned, the five
   secrets in the tooling repo's `.env`), and built:
   `npm install && npm run build`.
2. Copy [`skills/autofactory/`](skills/autofactory/) into your app repo at
   `.agents/skills/autofactory/` (Codex's repo-scoped skill location; or
   `~/.agents/skills/autofactory/` for a personal, cross-repo install).
3. Point the skill at the tooling checkout: set `AUTOFACTORY_HOME` in your
   environment (e.g. `export AUTOFACTORY_HOME=~/src/launchdarkly-auto-factory`),
   or Codex will ask on first run.

Then, in a Codex session in your app repo: `$autofactory` (or "run AutoFactory
on my changes"). The CLI needs network access (LaunchDarkly + model APIs) and
runs from the tooling checkout outside the workspace, so Codex will ask you to
approve escalated execution for that one command.

### Optional: run it automatically before every PR

Two committed layers make AutoFactory the default path to a PR for **every
user of the repo** (repo config, not per-user memory):

1. **`AGENTS.md` nudge** (advisory): merge [`AGENTS.md.snippet`](AGENTS.md.snippet)
   into your app repo's `AGENTS.md` — every session reads it and runs
   `$autofactory` before pushing.
2. **Pre-push gate** (deterministic): copy [`hooks/autofactory-gate.mjs`](hooks/autofactory-gate.mjs)
   to `.codex/hooks/` and merge [`hooks.json`](hooks.json) into
   `.codex/hooks.json`. The hook intercepts `git push` / `gh pr create` and
   checks the run record the CLI writes at `.git/autofactory-last-run.json`:
   **denies** if AutoFactory hasn't run on the current branch (dry runs don't
   count), allows otherwise, and fails open on its own errors. Project-local
   Codex hooks load only after the user trusts them (`/hooks` in the CLI).
   Branch-granular by design — committing the agents' edits after a run
   doesn't re-trip it; "re-run after significant changes" stays advisory in
   layer 1.

One deliberate divergence from the Claude Code gate: when the last run ended
**rejected / verification-failed / incomplete**, Claude Code's gate *asks* the
human (a red verdict is a review opinion, not a pipeline failure). Codex
parses but does not yet support the `ask` decision, so this gate **denies**
with instructions instead: the agent surfaces the verdict to the human, and an
explicit `AUTOFACTORY_ACK_RED=1` prefix on the re-run is the human's override.

Label-gated mode (optional): set `AUTOFACTORY_REQUIRE_LABEL=true` in the
hook's environment (and the matching repo variable for the GitHub Action) to
scope both to PRs labeled `autofactory`; unlabeled bugfix/chore PRs then skip
the gate and the Action.

The GitHub Action remains the server-side backstop for anything that bypasses
both.

## What you get

The chain works from your branch's diff against its base (committed +
uncommitted). On a flag-worthy change: a flag (targeting off, **maintained by
you** — resolved from your git email to your LaunchDarkly member) and three
guarded-release metrics in the app project, the behavior wired behind the
flag, metric instrumentation, flag-on/flag-off tests, and a release manifest
under `.release-flags/` — all left **uncommitted in your working tree** to
review and commit yourself. Nothing is pushed.

Approval gates (the `auto-factory-approval-mode` / `-risk-threshold` /
`-approval-gates` flags) are **code-enforced**: the CLI halts before a gated
step with exit code 3, Codex asks you in the session, and on a yes re-runs
past the gate with `--approve <nodeKey>`.

## Costs and caveats

- **Codex runs execute on OpenAI models by default** (ADR 0018): the
  `auto-factory-ai-provider` flag routes the `codex` surface to the OpenAI
  runner (`gpt-5.2` agents, `gpt-5-mini` judges), billed to
  `OPENAI_API_KEY`/`CODEX_API_KEY` in the tooling repo's `.env` — separate
  from your ChatGPT/Codex subscription. Retarget the flag in LaunchDarkly to
  run the same chain on Anthropic/Bedrock instead. The CLI only ever runs the
  sandboxed runners (Anthropic/Bedrock/OpenAI) — the providers structurally
  unable to commit or push.
- The run is a process Codex watches, not an agent you steer mid-run.
- Judge evidence is the node-scoped working-tree diff (agents don't commit in
  this mode) — same ground-truth property as the Action's commit-scoped diff.
