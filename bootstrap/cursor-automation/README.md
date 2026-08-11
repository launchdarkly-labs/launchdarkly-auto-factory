# Native Cursor automation

This adapter runs the Build flow inside Cursor's native agent. It uses the Cursor model
subscription and LaunchDarkly MCP tools instead of the shared TypeScript runner.

Use it locally to leave edits in your working tree, or use Cursor cloud automation to open
a PR.

## How it works

The `.cursor` rule fetches each agent's instructions from LaunchDarkly at run time and maps
the factory's tools to Cursor capabilities:

- flag and metric writes use LaunchDarkly MCP
- file edits, diffs, and tests use Cursor tools
- commit and push are omitted from the local path

This directory contains configuration artifacts, not compiled application code.

## Install it locally

You need Cursor, Node.js, and a LaunchDarkly API token with access to the factory and app
projects.

1. Copy `dot-cursor/` into the app repository as `.cursor/`.
2. Configure the LaunchDarkly MCP server without committing a real API token.
3. Update the factory and app project keys in `.cursor/rules/autofactory.mdc`.
4. Enable LaunchDarkly MCP in Cursor.

On a feature branch, run `/autofactory`. Review and commit the resulting flag wiring,
metrics, tests, manifest, and verdict yourself.

## Run it in Cursor cloud

After committing the `.cursor` artifacts to the app repository:

1. Update `.cursor/environment.json` so the cloud sandbox installs the app dependencies.
2. Connect LaunchDarkly MCP in the Cursor agents interface.
3. Create an automation triggered by a pull request.
4. Use `cloud-automation-prompt.md` as the prompt.
5. Enable the LaunchDarkly MCP, Open PR, and Comment on PR tools.

The prompt skips changes that already contain a release manifest, preventing a PR loop.

## Choose this path when

- You want to use Cursor's models without a separate Anthropic key.
- You accept Cursor's native tool permissions.
- Advisory review and approval are sufficient.

Choose the GitHub Action or CLI when you need the code-enforced sandbox, approval gates,
Judges, and complete LaunchDarkly generation monitoring.

## Current boundaries

- Local runs leave edits uncommitted; cloud runs open a PR.
- Approval and review verdicts are advisory.
- Cursor must reliably fetch and follow each LaunchDarkly-hosted instruction.
- Cursor does not emit the same per-agent LaunchDarkly metrics as the Node runtimes.

The local and cloud paths share the rule, command, and environment under `dot-cursor/`.
