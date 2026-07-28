# beacon

Phase 2 release orchestrator. Receives deploy notifications, discovers
newly-added release flags, routes by scope, triggers releases by calling the
LaunchDarkly release API **directly** (no CD-pipeline hop — see
[ADR 0002](../../docs/adr/0002-release-via-ld-api.md)), and monitors each
release to completion.

## Design: open contract, thin adapters

Beacon's front door is a **provider-agnostic webhook**: anything that can POST
`{service, sha}` with the shared secret can announce a deploy — a CI step, a
provider's native webhook (via an adapter), the bundled Notifier CLI, or a
human with `curl`. Provider specifics live in small translator endpoints, so
supporting a new CD system is a parser, not a Beacon change.

## Layout

Flat `src/`:

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `POST /flag-releases`, `POST /webhooks/railway`, `GET /health` |
| `src/notify.ts` | The `auto-factory-notify` bin — a post-deploy hook services run to POST the deployed SHA |
| `src/discovery.ts` | Diff `.release-flags/` (current vs. previous SHA) to find newly-added flags |
| `src/state.ts` | Deploy-state store: last-seen SHA per service/environment (file-backed default) |
| `src/railway.ts` | Railway webhook payload → generic deploy notification |
| `src/scope.ts` | Route by scope — frontend / backend / fullstack |
| `src/fullstack.ts` | Fullstack cross-service SHA check (stateless, re-derived per notification) |
| `src/github.ts` | GitHub Contents API client (list/read `.release-flags/` at a SHA) |
| `src/trigger.ts` | Resolve variations + rollout shape, execute via the shared release adapter |
| `src/monitor.ts` | Poll a triggered release to a terminal state (completed / reverted / stopped) |
| `src/seerAutofix.ts` | On `reverted`, optionally find a Sentry issue and start Seer Autofix (ADR 0014) |
| `src/config.ts` | Load config from the YAML files + env |

## HTTP contract

- `POST /flag-releases` — the generic contract: `{service, sha, previousSha?, environment?}`.
- `POST /webhooks/railway` — Railway's deploy webhook, translated into the same
  handling. Only `SUCCESS` deploy events act; everything else is acknowledged
  and ignored. The Railway **service name** must match a `services.yaml` key.
- `GET /health` — `{ ok: true }`.

Auth: every POST must carry `BEACON_WEBHOOK_SECRET`, either in the
`x-beacon-secret` header or a `?secret=` query parameter (for providers whose
webhooks can't set custom headers — configure Railway's webhook URL as
`https://<beacon-host>/webhooks/railway?secret=<secret>`).

## previousSha: explicit, else tracked

Discovery diffs `.release-flags/` between the deployed SHA and the previous
one. An explicit `previousSha` in the notification always wins. When absent,
Beacon falls back to its **deploy-state store** — the last SHA it processed for
that service/environment (two-deep, so a re-delivered notification re-diffs the
same range instead of the empty one). First-ever deploy: no previous SHA, all
current release-flag files are treated as new.

The store is file-backed (`BEACON_STATE_FILE`, default `beacon-state.json`);
mount persistent storage there if the host's filesystem is ephemeral. The
`DeployStateStore` interface is the seam for a KV/DB store in multi-instance
deployments.

## Release monitoring

After triggering a guarded/progressive release, Beacon resolves the release id
and polls it to a terminal state — `completed` (rolled out to 100%),
`reverted` (a guardrail metric regressed; LaunchDarkly rolled the flag back),
or `monitoring_stopped` (human intervened) — logging the outcome. Monitoring is
detached from the HTTP request and never affects the release itself (which
runs server-side in LaunchDarkly regardless). Re-delivered notifications are
idempotent: a flag whose release is already running reports `already_running`
and re-attaches monitoring instead of double-triggering.

On `reverted`, when `BEACON_SEER_AUTOFIX=true` and Sentry credentials are set,
Beacon searches for a related Sentry issue and starts Seer Autofix
(`stopping_point: open_pr` by default) — see ADR 0014 / `src/seerAutofix.ts`.

**Seer token scopes.** `SENTRY_AUTH_TOKEN` must allow listing issues
(`project:read`, `event:read`) and starting Autofix (`event:write` / Seer
entitlement). A 403 on issue search is logged explicitly — it used to look like
"no matching issue". Matching prefers `feature:<slug>` / `flag:<flagKey>` tags
(e.g. flag `enable-broken-sign-in` → search `feature:broken-sign-in`).

## Config surface

Read from the repo `config/` dir + env:

- `config/services.yaml` — service → side/repo/status-endpoint registry.
- `config/scopes.yaml` — scope routing rules.
- `config/release-source.yaml` — where release-flag files are read from.
- Env:
  - `BEACON_WEBHOOK_SECRET` (required) — shared webhook secret.
  - `GITHUB_TOKEN` (required) — reads `.release-flags/` via the Contents API.
  - LD connection: `LD_API_KEY`, `LD_PROJECT_KEY` (the **app** project),
    `LD_BASE_URL` (optional), `LD_ENVIRONMENT_KEY` (default `production`).
  - `BEACON_STATE_FILE` (default `beacon-state.json`).
  - `BEACON_MONITOR` (`false` disables), `BEACON_MONITOR_POLL_MS` (default
    10000), `BEACON_MONITOR_TIMEOUT_MS` (default 24h).

## Deploying

Host it anywhere that runs a container and gives it an HTTPS URL:

```sh
docker build -f packages/beacon/Dockerfile -t auto-factory-beacon .   # from the repo root
docker run -p 8080:8080 --env-file beacon.env auto-factory-beacon
```

`PORT` is honored (default 8080). The image bundles the repo's `config/` dir;
point deploy webhooks/notifiers at `https://<host>/flag-releases` (generic) or
`https://<host>/webhooks/railway?secret=…` (Railway).

## Fullstack coordination

On each notification, Beacon checks whether the **other** service's
currently-deployed SHA already contains the same `.release-flags/` file. If yes,
both services have the code and the release triggers; if no, it waits for the
other service's deploy notification to re-evaluate.

> **No retry queue (prototype).** A "waiting" flag is released only when the OTHER
> service's deploy notification arrives and re-evaluates. Beacon logs each waiting
> outcome (`[beacon] WAITING: …`) with the flag, file, and service so a lost
> notification is visible. **Manual re-trigger:** once both services are deployed,
> re-POST `/flag-releases` for the service (same `sha`/`service`) to re-run discovery
> and release the now-ready flag — the state store re-resolves the same diff range.
