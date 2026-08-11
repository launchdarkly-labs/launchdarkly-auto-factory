# Claude Code adapter

The `/autofactory` skill lets Claude Code drive the AutoFactory CLI. Claude Code starts the
run, reports progress, relays approval questions, and summarizes the result. The CLI retains
the safety boundary and leaves all edits uncommitted.

For installation, follow [Run AutoFactory from Claude Code](../../INSTALL-CLAUDE-CODE.md).

## How it fits

```text
Claude Code session
        ↓
/autofactory skill
        ↓
AutoFactory CLI
        ↓
LaunchDarkly Agent Graph and local Anthropic runner
        ↓
Uncommitted working-tree changes
```

This preserves the same Judges, monitoring, approval gates, per-agent models, knowledge
graph, and cross-repository tools as the CLI.

## Install the adapter

After bootstrapping and building AutoFactory:

1. Copy `skills/autofactory/` into the app repository at `.claude/skills/autofactory/`.
2. Set `AUTOFACTORY_HOME` to the AutoFactory checkout.
3. Run `/autofactory` from a Claude Code session in the app repository.

## Make it part of the PR path

Two optional repository-level controls are included:

- `CLAUDE.md.snippet` tells Claude Code to run AutoFactory before pushing.
- `hooks/autofactory-gate.mjs` and `settings.json` check the CLI run record before
  `git push` or `gh pr create`.

The hook blocks when AutoFactory has not run on the branch. It asks for confirmation after a
rejected or incomplete result and fails open if the hook itself errors.

Set `AUTOFACTORY_REQUIRE_LABEL=true` in both the hook environment and GitHub repository
variables to apply the local gate and Action only to PRs labeled `autofactory`.

## Understand the boundary

- The CLI uses `ANTHROPIC_API_KEY`, not the Claude Code subscription.
- Claude Code watches the process; it does not steer an agent mid-run.
- The local runner cannot commit or push through its sandbox tools.
- Judges score the node-scoped working-tree diff.
- Approval gates stop the CLI before a gated agent runs.

See the [CLI reference](../../packages/phase1-cli/README.md) for commands and exit codes.
