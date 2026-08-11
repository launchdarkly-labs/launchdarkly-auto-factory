# Run AutoFactory from Claude Code

Use `/autofactory` to turn your current change into a release-ready change. The agents can
add a flag, metrics, instrumentation, tests, and a release manifest. Everything stays
uncommitted for you to review. Nothing is pushed.

This path uses Claude Code as the interface and the AutoFactory CLI as the controlled
execution layer.

## Before you start

You need Node.js 20 or later, Claude Code, and:

- a factory LaunchDarkly project
- an app LaunchDarkly project
- a factory-project server SDK key
- an API token with write access to both projects
- an Anthropic API key

Agent execution is billed to the Anthropic key, separate from your Claude Code subscription.

## 1. Prepare AutoFactory

```bash
git clone <this-repo-url>
cd launchdarkly-auto-factory
npm install
cp .env.example .env
```

Set these values in `.env`:

```dotenv
LD_SDK_KEY=
LD_API_KEY=
LD_PROJECT_KEY=
LD_APP_PROJECT_KEY=
ANTHROPIC_API_KEY=
```

Provision the factory:

```bash
npm run bootstrap
```

Choose `anthropic` when prompted. Bootstrap creates the Agent Configs, Tools, Judges, Agent
Graph, and operational flags without overwriting existing resources.

## 2. Add the Claude Code skill to your app

From the AutoFactory repository:

```bash
mkdir -p <app-repo>/.claude/skills
cp -R bootstrap/claude-code/skills/autofactory <app-repo>/.claude/skills/autofactory
export AUTOFACTORY_HOME="$(pwd)"
```

Add `AUTOFACTORY_HOME` to your shell profile if you want it to persist. Commit the skill in
the app repository if the whole team should use it.

## 3. Run the factory

Open Claude Code in the app repository on a branch with changes, then run:

```text
/autofactory
```

Ask for a dry run first if you want a read-only preview.

For a flag-worthy change, review these outputs:

- a flag that starts off
- error, latency, and business metrics
- flag wiring and metric instrumentation
- tests for both flag variations
- `.release-flags/pr-<PR-number>.json`, or `pr-<sanitized-branch>.json` when no PR exists
- an independent review verdict

An approval policy may pause the run before an agent acts. Claude Code will ask whether to
continue. A rejected review is an opinion to inspect, not an execution error.

## Optional: require a run before pushing

The repository includes two controls under `bootstrap/claude-code/`:

- Merge `CLAUDE.md.snippet` into the app repository's `CLAUDE.md` to remind every session.
- Install `hooks/autofactory-gate.mjs` and merge `settings.json` to check for a completed run
  before `git push` or `gh pr create`.

## Troubleshooting

| Symptom | Action |
|---|---|
| A required key is missing | Check the five values in the AutoFactory repository's `.env`. |
| The graph is unavailable | Use the factory project's server SDK key and rerun `npm run bootstrap`. |
| There is nothing to process | Make a branch change or choose another base with `--base <ref>`. |
| The run exits with code `3` | Approve the requested gate and use the printed rerun command. |
| The configuration version differs | Preview and run `npm run bridge -- upgrade`. |
| Code References is unavailable | Install `ld-find-code-refs`, or continue without that optional context. |

For implementation details, see the [Claude Code adapter](bootstrap/claude-code/README.md)
and the [CLI reference](packages/phase1-cli/README.md).
