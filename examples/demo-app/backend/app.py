"""
Demo backend (Python / Flask). Two endpoints:
  GET /api/status   -> { service, version }   (version = deployed SHA; used by
                       Beacon's fullstack cross-service check)
  GET /api/greeting -> response gated by the boolean flag "new-greeting"

LaunchDarkly is optional: if the SDK or LD_SDK_KEY is absent, the flag defaults
to false and the app still runs.

Sentry is optional (ADR 0014 / 0015): when SENTRY_DSN is set, the baseline is
errors + tracing + logging. Errors carry Sentry custom context named exactly
`launchdarklyContext` so the LaunchDarkly↔Sentry metrics integration can
attribute them. For LD `otel*` autogens / knowledge-graph spans, also send
OTel to LaunchDarkly (dual-export) — Sentry does not export OTLP outbound.
"""

import logging
import os

from flask import Flask, jsonify

SHA = os.environ.get("RAILWAY_GIT_COMMIT_SHA", "dev")
SDK_KEY = os.environ.get("LD_SDK_KEY")
SENTRY_DSN = os.environ.get("SENTRY_DSN")

app = Flask(__name__)
log = logging.getLogger("demo-backend")

_ld_client = None
_sentry_ready = False


def _init_sentry() -> None:
    """Initialize Sentry once when SENTRY_DSN is present. Never raises."""
    global _sentry_ready
    if _sentry_ready or not SENTRY_DSN:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.flask import FlaskIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration

        integrations = [
            FlaskIntegration(),
            LoggingIntegration(
                level=logging.INFO,
                event_level=logging.ERROR,
            ),
        ]
        # Optional: flag evaluations on issues (helps Seer after a revert).
        try:
            from sentry_sdk.integrations.launchdarkly import LaunchDarklyIntegration

            integrations.append(LaunchDarklyIntegration())
        except Exception:  # noqa: BLE001
            pass

        # enable_logs / metrics: available on recent sentry-sdk builds; ignore if unknown.
        init_kwargs = {
            "dsn": SENTRY_DSN,
            "integrations": integrations,
            "traces_sample_rate": float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "1.0")),
            "environment": os.environ.get("SENTRY_ENVIRONMENT", "development"),
            "release": SHA,
            "send_default_pii": False,
        }
        try:
            init_kwargs["enable_logs"] = True
        except Exception:  # noqa: BLE001
            pass

        sentry_sdk.init(**init_kwargs)
        _sentry_ready = True
        log.info("Sentry initialized for demo-backend (errors+tracing+logging)")
    except Exception:  # noqa: BLE001 - demo: degrade without Sentry
        _sentry_ready = False


_init_sentry()


def _ld():
    """Lazily initialize the LaunchDarkly client (or return None if unavailable)."""
    global _ld_client
    if _ld_client is not None:
        return _ld_client
    if not SDK_KEY:
        return None
    try:
        import ldclient
        from ldclient.config import Config

        ldclient.set_config(Config(SDK_KEY))
        _ld_client = ldclient.get()
        return _ld_client
    except Exception:  # noqa: BLE001 - demo: degrade gracefully without LD
        return None


def _ld_context():
    """Build the LD evaluation context used for flags + Sentry attribution."""
    from ldclient.context import Context

    return Context.builder("demo-user").kind("user").build()


def _set_launchdarkly_context(ctx) -> None:
    """
    Attach LD evaluation keys to Sentry as custom context `launchdarklyContext`.
    The name MUST be exact — the LD Sentry integration ignores other names.
    """
    if not _sentry_ready:
        return
    try:
        import sentry_sdk

        sentry_sdk.set_context(
            "launchdarklyContext",
            {
                "key": getattr(ctx, "key", "demo-user"),
                "kind": "user",
            },
        )
    except Exception:  # noqa: BLE001
        pass


def _flag(key: str, default: bool = False) -> bool:
    client = _ld()
    if client is None:
        return default
    ctx = _ld_context()
    _set_launchdarkly_context(ctx)
    return bool(client.variation(key, ctx, default))


@app.get("/api/status")
def status():
    return jsonify({"service": "demo-backend", "version": SHA})


@app.get("/api/greeting")
def greeting():
    use_new = _flag("new-greeting", False)
    log.info("greeting served flag_new_greeting=%s", use_new)
    return jsonify(
        {
            "greeting": "Hello from the future! 🚀" if use_new else "Hello, world.",
            "flag_new_greeting": use_new,
            "version": SHA,
        }
    )


@app.get("/api/boom")
def boom():
    """
    Demo endpoint that raises so Sentry (when configured) captures an error
    with launchdarklyContext — useful for verifying the LD↔Sentry integration
    and guarded-release auto-rollback.
    """
    _flag("new-greeting", False)  # stamps launchdarklyContext when Sentry is on
    raise RuntimeError("demo-app intentional error for Sentry / guarded-release testing")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
