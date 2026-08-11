# Bootstrap AutoFactory

Bootstrap turns a fresh clone into a working Build stage. It validates credentials,
provisions LaunchDarkly resources, and supplies templates for the entry point you choose.

Start with the [setup guide](../REFERENCE.md#1-bootstrap-the-factory).

## What is here

| Path | Use it for |
|---|---|
| `create.*` | Run the guided setup and print provider-specific next steps |
| `checks/` | Validate Node.js, credentials, connectivity, and token scopes |
| `github-action-template/auto-factory.yml` | Run Anthropic or Vega agents on pull requests |
| `github-action-template/auto-factory-cursor.yml` | Run Cursor agents on pull requests |
| `github-action-template/find-code-refs.yml` | Add Code References context after merge |
| `claude-code/` | Run the factory from Claude Code |
| `cursor-automation/` | Run the factory through Cursor's native agent |

The generated configuration is intentionally visible and editable. Bootstrap provides a
starting point, not a hidden installation layer.

By default, GitHub workflows run on every pull request. Set
`AUTOFACTORY_REQUIRE_LABEL=true` to require the `autofactory` label.
