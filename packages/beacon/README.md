# Beacon

Beacon connects a successful deployment to a LaunchDarkly release. It discovers the release
manifests in the deployed commit, honors human intent, starts the release, and records the
outcome.

Beacon does not replace CD or run rollout logic. Your CD platform deploys the code.
LaunchDarkly controls exposure, evaluates guardrails, and rolls back when needed.

## How it works

1. A deploy system posts the service and deployed SHA.
2. Beacon compares that SHA with the previous deployment.
3. It finds new `.release-flags/*.json` manifests.
4. It checks scope, prerequisites, dates, and holds.
5. It calls the LaunchDarkly release API.
6. It observes the release until it completes, reverts, or stops.

Repeated notifications are safe. Beacon reattaches to a running release instead of starting
another one.

## Deploy Beacon

From the repository root:

```bash
docker build -f packages/beacon/Dockerfile -t auto-factory-beacon .
docker run -p 8080:8080 --env-file beacon.env auto-factory-beacon
```

Configure:

| Setting | Purpose |
|---|---|
| `BEACON_WEBHOOK_SECRET` | Authenticates deploy notifications |
| `GITHUB_TOKEN` | Reads manifests from the deployed commit |
| `LD_API_KEY` | Starts and reads releases |
| `LD_PROJECT_KEY` | Application project |
| `LD_ENVIRONMENT_KEY` | Release environment, default `production` |
| `BEACON_STATE_FILE` | Deploy-state file, default `beacon-state.json` |

Register services in `config/services.yaml`. Scope and manifest-source settings live in
`config/scopes.yaml` and `config/release-source.yaml`.

Beacon currently stores deploy state in a local file. Mount persistent storage and run one
instance, or replace the `DeployStateStore` implementation with shared storage.

## Notify Beacon

Use the provider-neutral endpoint from any post-deploy step:

```http
POST /flag-releases
x-beacon-secret: <BEACON_WEBHOOK_SECRET>
content-type: application/json

{"service":"backend","sha":"<deployed-sha>","environment":"production"}
```

Include `previousSha` when the deploy system knows it. Otherwise Beacon uses its state store.
On the first deploy, all manifests at the current SHA are considered new.

Available endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /flag-releases` | Generic deploy notification |
| `POST /webhooks/railway` | Railway `SUCCESS` event adapter |
| `GET /health` | Health check |

Every POST requires the shared secret in `x-beacon-secret` or the `secret` query parameter.

## Coordinate multiple services

For a full-stack manifest, Beacon checks whether every required service has deployed the
same manifest. It waits when one service is missing and reevaluates when the next deploy
notification arrives.

There is no retry queue. If a notification is lost, send the same notification again after
all services are deployed.

## Respond to a reverted release

Set `BEACON_SEER_AUTOFIX=true` and provide Sentry credentials to start Seer Autofix after a
guardrail reverts a release. `SENTRY_AUTH_TOKEN` needs issue-read and Autofix-write access.
Issue matching prefers `feature:<slug>` and `flag:<flagKey>` tags.

## Find the code

| Area | Files |
|---|---|
| HTTP and adapters | `src/server.ts`, `src/railway.ts`, `src/notify.ts` |
| Manifest discovery | `src/discovery.ts`, `src/github.ts`, `src/state.ts` |
| Scope coordination | `src/scope.ts`, `src/fullstack.ts` |
| Release lifecycle | `src/trigger.ts`, `src/monitor.ts` |
| Optional Autofix | `src/seerAutofix.ts` |

See [ADR 0002](../../docs/adr/0002-release-via-ld-api.md) for why Beacon calls the
LaunchDarkly API directly.
