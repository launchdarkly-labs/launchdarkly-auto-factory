# bootstrap

The easy-setup surface. The goal: a design partner goes from clone to a working
flow with as few manual steps as possible ("simple, but not simpler").

| Item | Purpose |
|------|---------|
| `create.*` | One command: prompts for the provider (anthropic / cursor), wires CI, provisions the LD env (via `config-bridge`), sets up the secrets shape, and prints provider-specific next steps |
| `github-action-template/` | Phase 1 front end #1: drop-in PR workflows — `auto-factory.yml` (anthropic/vega, bare `uses:`), `auto-factory-cursor.yml` (cursor; checks the tool out + `npm ci`, since `@cursor/sdk` needs node_modules), and `find-code-refs.yml` (optional on-merge LaunchDarkly code-references scan; also lights up the knowledge graph's wrap points). Both Phase 1 workflows run on every PR by default; set the repo variable `AUTOFACTORY_REQUIRE_LABEL=true` to gate them on the `autofactory` PR label. |
| `cursor-automation/` | Phase 1 front end #3: drop-in `.cursor/` rule + command + MCP config that runs the chain in Cursor's own agent |
| `checks/` | Preflight: tokens present, LD reachable, scopes valid — fail loudly with fixes |

**Defaults are one layer deep:** bootstrap generates real, legible config files
the partner can then edit, rather than magic that only works on the golden path.
