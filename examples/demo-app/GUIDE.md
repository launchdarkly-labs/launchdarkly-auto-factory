# Demo app

A minimal monorepo demo for the full Auto-Factory flow: a **JS frontend** and a
**Python backend**, deployed as two independent Railway services.

> **What this is:** a reference/starting point. The Phase 1 action targets *whatever
> repo installs the workflow* (`bootstrap/github-action-template/auto-factory.yml`) —
> not this in-repo copy specifically. Use it to see the shape of an app the pipeline
> works on; the live demo runs against a separate app repo wired with that template.

```
demo-app/
├── frontend/        Node/Express — GET /api/status, serves a page
├── backend/         Python/Flask — GET /api/status, GET /api/greeting (flag-gated),
│                    optional Sentry baseline (errors+tracing+logging) +
│                    launchdarklyContext (ADR 0014 / 0015)
└── .release-flags/  release intent checked in alongside guarded code
```

## The status contract (Phase 2)

Each service exposes `GET /api/status` → `{ "service": "...", "version": "<deployed SHA>" }`.
Beacon's fullstack check reads the **other** service's `version` to confirm both sides have
deployed the same `.release-flags/` file before releasing.

`version` comes from `RAILWAY_GIT_COMMIT_SHA` at deploy time.

## How it ties together

1. **Phase 1** — open a PR that adds a feature behind a flag; the agents create the flag
   + metrics and wire it in. (The committed example uses `new-greeting`, but agents derive
   a flag key per-PR from the change — don't expect that exact key on your own PRs.)
   Optional Sentry path: serve the metrics author's `sentry` variation (LD targeting)
   and it calls `query_sentry` for an estate picture, prefers shared `sentry-errors-*`
   LD metrics as the error killswitch, and instruments `launchdarklyContext` for the
   LD↔Sentry integration. Latency still needs LD-backed metrics (`otel*` / `track()`),
   not Sentry Explore aggregates alone.
2. A `.release-flags/<flag-key>.json` lands (see `pr-1.json` for the shape) declaring the
   flag + scope + rollout (the Sentry path additionally attaches `sentry-errors-binary`).
3. **Phase 2** — on deploy, the Notifier pings Beacon, which discovers the new release flag and
   starts a guarded rollout via LaunchDarkly. On auto-revert, Beacon can start Seer Autofix
   (`BEACON_SEER_AUTOFIX=true`).

## Dual-export (why `otel*` needs LD, not only Sentry)

Sentry’s OpenTelemetry path is **ingest-only** (spans/logs into Sentry). There is no
product path for Sentry to stream stored spans out to LaunchDarkly’s OTLP endpoint
(ADR 0015).

This demo initializes Sentry (errors, tracing, logging) when `SENTRY_DSN` is set. That
feeds Sentry APM / issues and — with `launchdarklyContext` — the official error→LD
metrics. It does **not** by itself create LaunchDarkly `otel*` autogens or knowledge-graph
spans.

To fill LD hosted o11y (and thus `otel*` / `kind=trace` guardrails):

1. Keep Sentry as above, **and**
2. Also send the same app spans to LaunchDarkly (LD observability SDK **or** Collector
   fan-out: OTLP → Sentry exporter **and** LD OTLP).

Without step 2, Metrics Author should prefer feature-scoped `track()` for latency and
note the dual-export gap when `query_sentry` shows traffic but LD o11y is empty.

## Running locally

- Backend: `pip install -r backend/requirements.txt && python backend/app.py` (`:8000`)
- Frontend: `cd frontend && npm install && npm start` (`:3000`)
- Set `LD_SDK_KEY` to evaluate the flag for real; without it, flags default to `false`.
- Optional: set `SENTRY_DSN` so errors (including `GET /api/boom`) carry `launchdarklyContext`
  for the LaunchDarkly↔Sentry metrics integration. Session replay stays browser-only
  (this Flask API skips it).

## Deploying (Railway)

Create two services from this repo (root `frontend/` and `backend/`). Railway auto-detects Node
and Python. Add a post-deploy step running the Notifier (`auto-factory-notify`) per service.
Account/service setup is environment-specific (your Railway account, service creation, and the
actual deploy) — the app code + status endpoints here are a scaffold, not a verified deploy.
