# AutoFactory Cursor and VS Code extension

The extension runs AutoFactory against the current working tree. It resolves the same
LaunchDarkly graph as the GitHub Action, then leaves every agent edit uncommitted for review
in the editor.

## What changes in the editor path

| | GitHub Action | Extension |
|---|---|---|
| Trigger | Pull request event | Button, command, or feature-branch commit |
| Input | Pull request diff | Working tree against the base branch |
| Agent edits | Committed to the PR branch | Left uncommitted |
| Result | PR comment and check | Sidebar, output log, and notification |

Both paths use the shared graph walker, agents, tools, Judges, and approval policy.

## Run the extension

Build it from the repository root:

```bash
npm install
npm run build
npm run bundle -w launchdarkly-autofactory
```

Open `packages/phase1-cursor-extension/` in Cursor or VS Code and launch an Extension
Development Host with F5. Then open an application repository in that host.

Set credentials with **LaunchDarkly AutoFactory: Set API Keys**:

- factory-project server SDK key
- LaunchDarkly API token
- Anthropic API key

Secrets use the editor's SecretStorage. Environment variables named `LD_SDK_KEY`,
`LD_API_KEY`, and `ANTHROPIC_API_KEY` are fallback values.

Start a run from the AutoFactory sidebar, status bar, Source Control title bar, or the
**LaunchDarkly AutoFactory: Run on Current Changes** command.

`launchdarkly-autofactory.autoRun` controls runs after a new feature-branch commit:

- `off`
- `prompt`, the default
- `auto`

## Review the result

The extension can add flag wiring, metrics, instrumentation, tests, and a release manifest.
Inspect the edits in Source Control and decide what to commit. Nothing is pushed.

Approval is advisory in this path because the working tree remains under your control.

## Package a VSIX

```bash
cd packages/phase1-cursor-extension
../../node_modules/.bin/vsce package --no-dependencies
cursor --install-extension <absolute-path-to-vsix> --force
```

The extension is not published to a marketplace.

## Current model boundary

The extension uses a direct Anthropic API call. Cursor does not expose its own models through
the VS Code Language Model API, so the extension cannot use the Cursor subscription. Use the
[native Cursor automation](../../bootstrap/cursor-automation/) when that is the goal.

The shared `AgentRunner` seam allows an editor-model runner to be added later without changing
the graph.
