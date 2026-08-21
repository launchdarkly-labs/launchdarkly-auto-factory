# ADR 0017 — Observability-first metric backing, and an agent-initiated human-input pause (M14)

**Status:** accepted (2026-08-21). Extends the metrics author's Metric Backing rules and
[ADR 0009](0009-release-intent-and-manifest-steward.md)'s manifest-as-human-channel pattern.

**Context.** The metrics author's original backing rules treated LaunchDarkly's observability
SDK as the *only* valid trace-metric source and pre-aggregated OTel data as the blanket reason
to distrust OpenTelemetry. That conflated two things: pre-aggregated OTel **metrics**
(counters/histograms) genuinely can't back a guarded release — they aggregate before flag
attribution — but span-level **traces** attribute fine wherever a LaunchDarkly flag-evaluation
hook enriches the active span, and that hook works in generic OTel estates too (the standalone
OTel tracing hook), with delivery to LaunchDarkly via direct export or a forwarding Collector.
Meanwhile `track()` was framed as the default rather than the floor, so the pipeline
under-invested in telemetry that feeds the whole estate (impact analysis, the dependency
graph, future metrics) in favor of events that feed exactly one metric each.

**Decision.**

1. **Backing priority becomes: reuse → ride the installed observability stack → new `track()`.**
   Per metric category: (1) reuse existing data — an existing `track()` event, or existing
   spans covering the flagged path where attribution *and* delivery are already verified
   (defining a trace metric on them is code-free; it doesn't matter whether one exists in LD
   yet); (2) ride whatever observability stack is installed — LD o11y SDK (direct export, no
   delivery validation needed: the credentials are already in place) or generic OTel
   (register the LD evaluation hook — encouraged, code changes and all); (3) instrument a new
   `track()` call — the guaranteed floor, and the only backing when no telemetry stack exists.
   **Installing a new observability/OTel package stays forbidden** (M10): that's a platform
   decision with estate-wide cost/data-governance consequences; the agent rides what's there
   and records the gap. Adding the LD hook to an *existing* OTel setup is not an install.
2. **Two validity conditions for trace metrics, verified not assumed:** ATTRIBUTION (a
   LaunchDarkly evaluation hook enriches spans in the trace that evaluates this flag) and
   DELIVERY (those traces demonstrably reach LaunchDarkly — `query_dependencies` trace-derived
   edges are the evidence; hook presence in code proves attribution, never delivery).
3. **Footprint decoupled from guardrail choice** (M10 rewrite): wherever a telemetry stack
   exists the flagged path gets span coverage and flag attribution — even when `track()` is
   the chosen guardrail. Telemetry richness around new functionality is the standing duty;
   which metric gates the release is a separate decision.
4. **Agent-initiated pause (M14) instead of silent no-op guardrails.** When the agent wires
   the hook for the *first* time in a generic-OTel service and cannot verify delivery (the
   collector/exporter config lives outside the repo), it must not guess and must not ship an
   unverifiable trace guardrail. It stops **before any instrumentation or metric creation**,
   writes `humanInput.question` into the release manifest (`write_manifest`; the human-owned
   `humanInput.answer` is structurally protected — agents can never write or clear it), tags
   `needs_human_input=true` + `human_question`, and the walker halts before edge selection
   (`WalkResult.pendingInput`, mirroring the approval-gate pause: no graph-level metrics, no
   downstream nodes). The human answers by editing `humanInput.answer` on the PR branch — on
   GitHub that push re-triggers the workflow — and the fresh walk's re-run finds the answer in
   the manifest and completes (falling back to `track()` if the answer says delivery is
   unavailable). Front ends surface the question: CLI exit 4 + printed question, PR comment +
   `action_required` check run, editor toast. No prompt injection, no per-front-end answer
   plumbing: the manifest is the human-text channel, exactly as ADR 0009 established for
   `releaseIntent`, and re-run-from-root idempotency is what makes it safe.
5. **The research planner pre-scouts a `telemetry_inventory`** (packages, hooks wired,
   `track()` calls, span coverage, `ld_trace_delivery` verified/unverified via
   `query_dependencies`, plus an advisory `recommended_backing`). It is evidence, not routing:
   the metrics author verifies it against the repo and may override with a note. We considered
   and rejected per-telemetry-type config *variations* — the backing decision depends on
   checkout facts the deciding step must verify anyway, and near-identical instruction copies
   multiply maintenance (the sentry variation already demonstrates the cost). Variations stay
   reserved for estate-level targeting and deliberate instruction A/Bs.

**Consequences.** The metrics author can now pause a run; operators see a fourth terminal
state (CLI exit 4 / `action_required` check) that is a question, not a failure. Trace-backed
and reused-global guardrails remain outside the deterministic event-key grep (they have no
in-repo emitter) — the verifier gap is unchanged by this ADR and stays a known limitation.
The `humanInput` block is schema 1.2-compatible (unknown-key tolerant readers; `write_manifest`
merges and protects it). Live A/B arms on the metrics author were re-synced to the new default
instructions, so arms again differ only by model.
