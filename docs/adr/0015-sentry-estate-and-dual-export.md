# ADR 0015 — Sentry estate client + OTel dual-export (not Sentry→LD OTLP)

**Status:** accepted (2026-07-24).

**Context.** ADR 0014 wired the official LaunchDarkly↔Sentry **error-event**
metrics integration as the guarded-release error killswitch, factory `gen_ai`
monitoring in Sentry, and Seer Autofix on Beacon revert. Partners naturally ask
whether richer Sentry telemetry (spans, failure rates, Apdex, logs) can replace
or feed LaunchDarkly’s OTel/`otel*` path the same way LD hosted observability
does today (ADR 0010).

Sentry’s OpenTelemetry story is **ingest-only**: OTLP traces/logs flow **into**
Sentry (SDK or Collector “Sentry Exporter”). There is **no** product path for
Sentry to stream stored spans/metrics **out** to LaunchDarkly’s OTLP endpoint.
Pre-aggregated Sentry Explore stats also cannot be attached as guarded-release
metrics as-is — the same rule as ADR 0010 (pre-aggregated OTel never valid):
guardrails need per-randomization-unit, per-variation attribution during the
release.

**Decision.**

1. **Dual-export at the app / collector** is how we “rewire” the LD OTel path
   when the estate is Sentry-first: one instrumentation pipeline fans out to
   Sentry **and** LD hosted o11y. That keeps `otel*` autogens, `kind=trace`
   metrics, and knowledge-graph `query-traces` (ADR 0010) working. Sentry remains
   the APM / issues / Seer plane.

2. **Sentry estate client (REST-first)** in `@auto-factory/shared` pulls a
   richer picture at **author time** (`query_sentry` tool) and shares issue
   matching with Beacon Seer. Shapes mirror Sentry MCP (`search_issues`, event
   aggregates) so CI works headlessly without MCP auth. Live guarded-release
   comparison still uses **LD metrics** (`sentry-errors*`, `otel*`, `track()`,
   trace metrics) — not Sentry aggregates streamed into the release API.

3. Knowledge-graph span fetch stays on LD MCP (`o11yClient`). When Sentry shows
   traffic but LD o11y returns no spans, agents surface a dual-export gap — we
   do not replace KG with Sentry traces in this iteration.

**Consequences.** Metrics-author can discover Sentry health (issues, failure
rates, p95) before choosing killswitches, while latency guardrails continue to
prefer LD-native `otel*` / `track()` / trace metrics. Estates that only send
OTLP to Sentry must dual-export (or run the LD o11y SDK alongside) to get
`otel*` and KG edges. Seer remediation remains **issue-scoped**; the estate
client improves match quality, not Autofix’s API shape.

**Related:** ADR 0010 (KG + guardrail backings), ADR 0014 (Sentry errors + Seer).
