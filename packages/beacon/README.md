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
| `src/pending.ts` | Re-evaluation ledger: unfinished releases, re-checked on any later deploy |
| `src/notifyReport.ts` | What the Notifier tells the operator (a 200 can still carry stranded flags) |
| `src/railway.ts` | Railway webhook payload → generic deploy notification |
| `src/scope.ts` | Route by scope — frontend / backend / fullstack |
| `src/fullstack.ts` | Fullstack cross-service SHA check (stateless, re-derived per notification) |
| `src/github.ts` | GitHub Contents API client (list/read `.release-flags/` at a SHA) |
| `src/trigger.ts` | Resolve variations + rollout shape, execute via the shared release adapter |
| `src/monitor.ts` | Poll a triggered release to a terminal state (completed / reverted / stopped) |
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
  - `BEACON_PENDING_FILE` (default `beacon-pending.json`) — the re-evaluation ledger.
    Persist it alongside the state file; losing it strands in-flight releases.
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

> A "waiting" flag normally releases when the OTHER service's deploy notification
> arrives. If that notification is lost, the **ledger** (below) re-checks it on any later
> deploy. Beacon logs each waiting outcome (`[beacon] WAITING: …`) with the flag, file, and
> service. **Manual re-trigger** is still faster: re-POST `/flag-releases` for the service
> once both are deployed.
>
> A counterpart whose `statusUrl` Beacon cannot reach (a private-network address) must be
> marked `privateNetwork: true` in `services.yaml`. The readiness check is tri-state, so an
> *unreadable* counterpart answers "unverified" rather than "not deployed" — without the
> marker, a permanently-unreachable service would turn every ordinary wait into a reported
> error.

> **Unfinished releases are re-checked on the next deploy (the ledger).** `pending.ts`
> persists an entry per non-final outcome (`held`/`waiting`/`error`) and re-evaluates it on
> any later deploy notification, independently of discovery — which cannot re-surface a
> manifest that exists at both SHAs. Re-evaluation re-reads the manifest at the CURRENT sha,
> so fixing a bad `releaseIntent` and deploying again is enough.
>
> It is **webhook-gated**: nothing fires on a timer, so a `notBefore` date passing does
> nothing until some deploy arrives. A release LaunchDarkly **reverted** is marked
> `needsHuman` and never re-triggered — re-releasing would undo the guardrail's rollback.
> `BEACON_PENDING_FILE` sets the ledger path (default `beacon-pending.json`).
>
> **The notification itself is never redelivered**, so alert on `notify: ACTION REQUIRED`.
> The Notifier is non-blocking by contract (a non-2xx is reported and it still exits 0, so
> it can never fail a deploy), and Railway documents no webhook retry policy.
>
> The Notifier prints `notify: ACTION REQUIRED` to **stderr** whenever a human must act,
> and names the recovery command. **Critically, that includes HTTP 200s**: Beacon acks a
> notification and reports per-flag outcomes in the body, so `held`, `waiting`, and
> `error` all arrive inside a successful response. A deploy log line reading "HTTP 200"
> is not evidence that the flags released.
>
> A log alert matching that marker is the cheapest way to notice a release that needs a
> human — including the cases the ledger deliberately will not retry. A clean deploy prints
> only to stdout and never uses the marker, so it does not cry wolf.
>
> When re-POSTing, pass `previousSha` explicitly — the original notification already
> advanced Beacon's recorded SHA, so a bare re-POST diffs the wrong range and discovers
> nothing.
