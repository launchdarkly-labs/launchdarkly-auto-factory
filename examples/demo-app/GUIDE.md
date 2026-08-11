# Demo application

This small application makes the complete Build → Deploy → Release flow visible. It has a
Node.js frontend, a Python backend, and a feature that can be released across both services.

Use it as an example application shape. AutoFactory can run against any repository that
installs an entry point.

```text
demo-app/
├── frontend/        Node.js service and web page
├── backend/         Python API with flag and optional Sentry instrumentation
└── .release-flags/  Release manifests carried with the code
```

## What the demo proves

1. **Build:** agents can add a flag, metrics, instrumentation, tests, and a manifest.
2. **Deploy:** frontend and backend can deploy independently while the behavior stays off.
3. **Release:** Beacon can wait for the required services, then start a guarded release.

The committed example uses `new-greeting`. New runs derive their own flag key from the
change.

## Run it locally

Start the backend:

```bash
pip install -r backend/requirements.txt
python backend/app.py
```

Start the frontend:

```bash
cd frontend
npm install
npm start
```

The backend listens on port `8000`; the frontend listens on port `3000`.

Set `LD_SDK_KEY` to evaluate the real flag. Without it, the feature defaults off. Set
`SENTRY_DSN` to enable optional errors, tracing, and logging.

## Connect deployment to release

Each service exposes:

```http
GET /api/status

{"service":"<name>","version":"<deployed-sha>"}
```

Beacon uses this status contract to confirm that every service required by a full-stack
manifest has deployed the change. Railway supplies the SHA through
`RAILWAY_GIT_COMMIT_SHA`.

To deploy the example on Railway:

1. Create one service rooted at `frontend/`.
2. Create one service rooted at `backend/`.
3. Add `auto-factory-notify` as a post-deploy step for each service.

The code and status endpoints are a scaffold. Railway account and service configuration are
environment-specific.

## Understand the Sentry path

Sentry can provide application errors, traces, logs, and error-backed LaunchDarkly metrics.
It does not forward stored OpenTelemetry data to LaunchDarkly.

If you need LaunchDarkly trace metrics or knowledge-graph service dependencies, send the
same application spans to LaunchDarkly through its observability SDK or an OpenTelemetry
Collector fan-out. Without that path, use feature-scoped `track()` events for latency.

See [ADR 0014](../../docs/adr/0014-sentry-guardrails-and-agent-monitoring.md) and
[ADR 0015](../../docs/adr/0015-sentry-estate-and-dual-export.md) for the integration design.
