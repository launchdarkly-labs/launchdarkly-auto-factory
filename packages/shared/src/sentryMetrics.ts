/**
 * Shared Sentry→LD metric identifiers (ADR 0014).
 *
 * Event keys are fed by the LaunchDarkly↔Sentry metrics integration — NOT by
 * app `track()` calls. Metric keys are provisioned into the APP project via
 * config/agentcontrol/metrics/.
 */

/** Event keys that must match the LD Sentry integration "Metric event key". */
export const SENTRY_INTEGRATION_EVENT_KEYS = new Set(["sentry-errors"]);

/** Shared APP metric keys agents should reuse via list_metrics + write_manifest. */
export const SENTRY_SHARED_METRIC_KEYS = new Set(["sentry-errors-binary", "sentry-errors-count"]);
