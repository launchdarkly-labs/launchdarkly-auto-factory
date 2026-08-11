# AutoFactory CLI

The CLI runs the Build stage against a local working tree. It uses the same graph, tools,
gates, Judges, and observability as the GitHub Action, but leaves every edit uncommitted.

Use it directly from a terminal or through the [Claude Code skill](../../INSTALL-CLAUDE-CODE.md).

## Run it

Configure these values in `.env` in the AutoFactory repository:

```dotenv
LD_SDK_KEY=
LD_API_KEY=
LD_PROJECT_KEY=
LD_APP_PROJECT_KEY=
ANTHROPIC_API_KEY=
```

Build once from the repository root:

```bash
npm install
npm run build
```

Then run against an application repository:

```bash
npx autofactory run --root <app-repo>
```

Available options:

```text
autofactory run [--graph gha-auto-factory] [--approve <nodeKey>]... [--dry-run] [--base <ref>] [--root <dir>]
```

The CLI evaluates committed and uncommitted changes against the base reference. A successful,
flag-worthy run can add the flag wiring, metrics, instrumentation, tests, manifest, and review
verdict to the working tree. It never commits or pushes.

## Continue after an approval gate

When policy requires approval, the CLI stops before the gated agent, exits with code `3`,
and prints the next command. Approve by rerunning with the requested node:

```bash
npx autofactory run --root <app-repo> --approve <nodeKey>
```

Include every previously approved node on later reruns. Leave `APPROVAL_MODE` and
`RISK_THRESHOLD` unset if LaunchDarkly flags should remain the control plane.

## Interpret the result

| Code | Meaning |
|---|---|
| `0` | Review approved, or the change needs no factory work |
| `1` | Review rejected, graph incomplete, or a handoff check failed |
| `2` | Configuration or usage error, or no change to process |
| `3` | Approval required before the next agent runs |

Completed non-dry runs write `.git/autofactory-last-run.json` in the app repository. The
optional Claude Code pre-push hook uses this record without dirtying the working tree.

## Understand the local safety boundary

The CLI always uses the Anthropic runner because its sandbox tools can enforce the
working-tree-only contract. Cursor agents have native shell and Git access, and Vega runs
server-side. Use the GitHub Action for those providers.

Judges evaluate each agent's node-scoped working-tree diff. They see the change that occurred,
not the agent's description of it.
