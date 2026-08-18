# ADR 0014 — Sentry for guarded-release errors, factory agent monitoring, and Seer on revert

**Status:** accepted (2026-07-24).

**Context.** AutoFactory already creates LaunchDarkly custom/trace metrics and starts
guarded releases via Beacon. Error killswitches today rely on app `track()` events or
LD-hosted OTel autogens. Separately, Phase 1 LLM traces export to LaunchDarkly LLM
Observability via `@launchdarkly/observability-node`. After a guardrail revert, Beacon
only logs — nothing opens a fix PR.

Sentry provides (1) an official **Sentry → LD metrics** integration that maps error
events into LD custom metrics for guarded rollouts, (2) **AI agent monitoring** on the
same `gen_ai.*` conventions we already emit, and (3) **Seer Autofix** (`POST
…/issues/{id}/autofix/`) for issue-scoped remediation.

**Decision.**

1. **App error killswitch = Sentry-backed LD metrics.** Prefer shared project metrics
   (event key `sentry-errors`, e.g. `sentry-errors-binary`) when the target app has
   Sentry. Metrics-author reuses them via `list_metrics` and attaches them in the
   release manifest; feature-scoped LD `track()` / trace metrics remain for latency and
   business. Apps must attach Sentry custom context named exactly `launchdarklyContext`
   with the LD evaluation keys so the integration can attribute events.

2. **Bootstrap provisions those shared metrics into the APP project**
   (`config/agentcontrol/metrics/` → `appConnection()`), create-only / idempotent.

3. **Factory LLM observability moves to Sentry AI agent monitoring** when `SENTRY_DSN`
   is set. Keep LaunchDarkly **AI Config / graph trackers** (tokens, duration, judges).
   Dual-write with LD LLM Observability until `DISABLE_LD_OBSERVABILITY=true` cuts over.
   Use a dedicated Sentry project for factory runners vs app error rates.

4. **On Beacon `reverted`**, optionally resolve a matching Sentry issue and start Seer
   Autofix with `stopping_point: "open_pr"` (`BEACON_SEER_AUTOFIX=true`). Never throw —
   same contract as monitoring.

**Consequences.** Guarded releases get production error attribution without inventing
per-feature error event keys when Sentry is present. Agent-chain debugging lands in
Sentry’s Agents dashboard (conversation id = pipeline run id). Rollback remediation
becomes issue-driven Autofix rather than a silent log line. Requires LD plan support
for the Sentry metrics integration, Seer entitlement, and correct env/project mapping.
App-estate LD o11y for knowledge-graph service edges (ADR 0010) is unchanged.

**Follow-up:** ADR 0015 adds the Sentry estate client (`query_sentry`) and the
dual-export playbook so Sentry-first estates can still fill LD `otel*` / KG
spans — Sentry does not OTLP-export outbound to LaunchDarkly.
