# Config Bridge

Config Bridge keeps the factory's LaunchDarkly configuration reproducible. It provisions,
updates, or copies Agent Configs, Judges, Agent Graphs, and operational flags through the
LaunchDarkly REST API. It does not run agents.

The canonical public definitions live in `config/agentcontrol/`.

## Choose a command

| Command | Use it when |
|---|---|
| `provision` | The target project is new. Create anything missing. |
| `upgrade` | The target exists. Add missing resources and sync committed instructions and graph edges. |
| `sync` | You want to inspect selected resources from another project locally. |
| `seed` | You want to copy a graph and its configs between projects without committing the intermediate files. |

```bash
bridge provision [--ai-configs <dir>] [--graphs <dir>] [--dry-run]
bridge upgrade [--ai-configs <dir>] [--graphs <dir>] [--flags <dir>] [--dry-run]
bridge sync --out <dir> [--tags a,b] [--graphs key1,key2]
bridge seed [--graphs key1,key2] [--staging <dir>] [--dry-run]
```

Use `LD_*` variables for the target project and `LD_SOURCE_*` variables for the source.
See `.env.example` for the complete connection settings.

## What it changes

- `provision` creates only missing resources. Repeated runs are safe.
- `upgrade` synchronizes known instructions, judge attachments, and graph structure.
- Neither command overwrites targeting, live model choices, or unrecognized variations.
- Configuration stamps make repository drift visible to factory runs.

Preview changes with `--dry-run` before updating a shared project.

## Public repository boundary

`sync` can retrieve instructions that contain private references. `seed` keeps intermediate
content in a gitignored staging directory, but the source LaunchDarkly project remains the
sanitization boundary. Inspect exported content before committing it.

Tool and snippet snapshots retain references, not complete definitions. Reattach any missing
definitions in LaunchDarkly after a cross-project copy.

## Find the code

| File | Responsibility |
|---|---|
| `src/provision.ts` | Create missing target resources |
| `src/upgrade.ts` | Reconcile committed configuration |
| `src/sync.ts` | Export selected source resources |
| `src/seed.ts` | Export to staging, then provision |
| `src/cli.ts` | Parse and dispatch commands |
