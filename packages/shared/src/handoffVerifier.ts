/**
 * Deterministic handoff shims — mechanical verification BETWEEN agent nodes.
 *
 * The tool-owned-tag layer (sandboxTools.ts) already guarantees that a routing
 * tag like `flag_ready` derives from a real LaunchDarkly API response, never
 * from an agent's claim. These shims close the remaining gap: a tag can be
 * TRUE while the work is still wrong — the flag can exist in LaunchDarkly yet
 * never be referenced in the pushed code, or a multivariate flag can be
 * evaluated through a boolean helper so its control path is unreachable
 * (observed live: app PR #12's first implementation). Each shim re-derives the
 * claim from primary evidence — the LaunchDarkly API and the checkout itself —
 * with zero model involvement, and a failed shim halts the chain exactly like
 * an unmet handoff.
 *
 * Checks attach to the CLAIMS a node's run emitted (its tags), not to node
 * names, so they survive graph renames and apply identically across providers:
 *  - `flag_ready` + `flag_key`  → the flag (and claimed variation) exists in
 *    LaunchDarkly, the key is referenced in the code, and a vN variation is
 *    referenced (quoted) in a file that evaluates the flag.
 *  - `metric_event_keys`        → every event-backed metric's event key has an
 *    emitter (`track(...)` call) in the code — except Sentry integration event
 *    keys (ADR 0014), which are fed by Sentry→LD, not track().
 *  - `tests_last_run`           → the last real `run_tests` execution at this
 *    handoff was green.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LdResourceWriter } from "./anthropic/ldWriter.js";
import { SENTRY_INTEGRATION_EVENT_KEYS } from "./sentryMetrics.js";

export interface HandoffCheck {
  /** Stable check id, e.g. "flag-exists-in-ld", "flag-wired-in-code". */
  name: string;
  detail: string;
}

export interface HandoffVerification {
  node: string;
  ok: boolean;
  passed: HandoffCheck[];
  failures: HandoffCheck[];
}

/** Runs after a node completes; null = no deterministic checks applied to this node. */
export type HandoffVerifier = (run: {
  configKey: string;
  tags: Record<string, string>;
}) => Promise<HandoffVerification | null>;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", ".release-flags"]);
const MAX_FILE_BYTES = 400_000;
const VN_RE = /^v\d+$/;

/** Repo-relative paths of text files containing `needle` (literal match). */
export function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, relPath);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        try {
          if (readFileSync(abs, "utf8").includes(needle)) hits.push(relPath);
        } catch {
          /* binary/unreadable — skip */
        }
      }
    }
  };
  walk(root, "");
  return hits;
}

/** A variation value counts as "wired" only when it appears QUOTED — the shape
 *  of an actual string comparison in any language — not as an incidental
 *  substring (e.g. "v1" inside a URL or a lockfile version). */
function quotedOccurrence(content: string, value: string): boolean {
  for (const q of ["'", '"', "`"]) {
    if (content.includes(`${q}${value}${q}`)) return true;
  }
  return false;
}

export interface HandoffVerifierOptions {
  /** Checkout the agents worked in (grep evidence). */
  sandboxRoot: string;
  /** LD reader for existence checks; omitted → LD-side checks are skipped, code-side still run. */
  writer?: LdResourceWriter;
}

export function buildHandoffVerifier(opts: HandoffVerifierOptions): HandoffVerifier {
  return async (run) => {
    const t = run.tags;
    const passed: HandoffCheck[] = [];
    const failures: HandoffCheck[] = [];
    const check = (ok: boolean, name: string, okDetail: string, failDetail: string): void => {
      (ok ? passed : failures).push({ name, detail: ok ? okDetail : failDetail });
    };

    // ---- Flag claims (implementer handoff) ---------------------------------
    if (t.flag_ready === "true" && t.flag_key) {
      const flagKey = t.flag_key;
      const variation = t.flag_variation ?? "";

      if (opts.writer) {
        try {
          const state = await opts.writer.getFlagState(flagKey);
          check(
            state.exists,
            "flag-exists-in-ld",
            `'${flagKey}' exists in project '${opts.writer.projectKey}'`,
            `'${flagKey}' does NOT exist in project '${opts.writer.projectKey}' despite flag_ready`,
          );
          if (state.exists && variation) {
            check(
              state.variations.some((v) => v.value === variation),
              "variation-exists-in-ld",
              `variation '${variation}' exists on '${flagKey}'`,
              `variation '${variation}' does NOT exist on '${flagKey}'`,
            );
          }
        } catch (e) {
          // A read failure is inconclusive, not a verdict — report it as a
          // failure so the run doesn't go green on unverifiable claims.
          failures.push({
            name: "flag-exists-in-ld",
            detail: `could not verify '${flagKey}' in LaunchDarkly: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      const referencing = filesContaining(opts.sandboxRoot, flagKey);
      check(
        referencing.length > 0,
        "flag-wired-in-code",
        `'${flagKey}' referenced in ${referencing.length} file(s) (${referencing.slice(0, 3).join(", ")})`,
        `'${flagKey}' is not referenced anywhere in the code — a flag that exists in LaunchDarkly but gates nothing`,
      );

      // Multivariate lineage only (boolean rides carry flag_variation "true").
      if (VN_RE.test(variation) && referencing.length > 0) {
        const wired = referencing.some((rel) => {
          try {
            return quotedOccurrence(readFileSync(join(opts.sandboxRoot, rel), "utf8"), variation);
          } catch {
            return false;
          }
        });
        check(
          wired,
          "variation-wired-in-code",
          `'${variation}' compared (quoted) alongside '${flagKey}'`,
          `'${variation}' never appears (quoted) in any file referencing '${flagKey}' — multivariate flag evaluated through a boolean helper? Every string variation is truthy, so the control path would be unreachable`,
        );
      }
    }

    // ---- Metric instrumentation claims (metrics-author handoff) ------------
    if (t.metric_event_keys) {
      for (const eventKey of t.metric_event_keys.split(",").filter(Boolean)) {
        // Sentry→LD integration events are not LD track() emitters (ADR 0014).
        if (SENTRY_INTEGRATION_EVENT_KEYS.has(eventKey)) {
          passed.push({
            name: "metric-event-instrumented",
            detail: `event '${eventKey}' is Sentry-integration-backed (no track() emitter required)`,
          });
          continue;
        }
        const emitters = filesContaining(opts.sandboxRoot, eventKey);
        check(
          emitters.length > 0,
          "metric-event-instrumented",
          `event '${eventKey}' emitted in ${emitters.slice(0, 2).join(", ")}`,
          `metric event '${eventKey}' has no emitter in the code — the metric exists in LaunchDarkly but will never receive data. ` +
            `This check greps for the LITERAL key: if the code builds it dynamically (e.g. \`\${FLAG_KEY}-suffix\` or concatenation), ` +
            `rewrite the emitter to pass the literal string — deterministic verification and LaunchDarkly code references both need greppable literals`,
        );
      }
    }

    // ---- Sentry launchdarklyContext (when Sentry path was chosen) ----------
    if (t.sentry_guardrail === "true") {
      const ctxFiles = filesContaining(opts.sandboxRoot, "launchdarklyContext");
      check(
        ctxFiles.length > 0,
        "sentry-launchdarkly-context",
        `launchdarklyContext set in ${ctxFiles.slice(0, 2).join(", ")}`,
        `sentry_guardrail=true but no 'launchdarklyContext' string in the checkout — ` +
          `the LD↔Sentry metrics integration ignores error events without that exact Sentry custom context name`,
      );
    }

    // ---- Test execution claims (testing handoff) ---------------------------
    if (t.tests_last_run === "fail") {
      failures.push({
        name: "tests-green-at-handoff",
        detail: "the last real run_tests execution FAILED — the node handed off with a red suite",
      });
    } else if (t.tests_last_run === "pass") {
      passed.push({ name: "tests-green-at-handoff", detail: "last run_tests execution passed" });
    }

    if (passed.length === 0 && failures.length === 0) return null;
    return { node: run.configKey, ok: failures.length === 0, passed, failures };
  };
}
