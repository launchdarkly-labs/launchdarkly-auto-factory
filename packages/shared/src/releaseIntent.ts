/**
 * Release intent: the human approver's instructions for HOW/WHEN a flag
 * releases, captured in the manifest's `releaseIntent` block (schema 1.1).
 *
 * Precedence chain: releasePolicy (LD) ← releasePlan (agent, manifest) ←
 * releaseIntent (human). Structured fields are what deterministic execution
 * reads; `notes` is free text a steward agent promotes into structured fields
 * on the PR (visibly, pre-merge) — never interpreted at deploy time.
 *
 * This module owns the canonical skeleton (injected by the `write_manifest`
 * tool so pre-fill is structural, not an agent behavior) and the DETERMINISTIC
 * normalizer: tolerant of case/synonyms/shape sloppiness, FAIL-CLOSED on
 * anything unintelligible (an unreadable intent must never cause a release —
 * only prevent one). The LLM steward handles what this cannot; Beacon runs only
 * this, never the steward.
 */

import type { IntentAction, IntentPrerequisite, ReleaseIntent } from "./types.js";

/** Guidance embedded where the human edits (underscore keys are ignored by all consumers). */
export const INTENT_INSTRUCTIONS =
  "Human approver: edit freely. action: auto (release on deploy) | hold (do not release yet) | manual (a human runs the release). " +
  "Structured fields execute; anything else goes in notes (an agent will structure it on the PR for your review). " +
  "Blank fields = default auto-release on deploy. prerequisites: [{\"flagKey\": \"flag-xyz\", \"variation\": \"on\"}]. " +
  "notBefore: YYYY-MM-DD. reference: ticket/doc URL.";

/** The canonical pre-fill skeleton — every field present so humans see what's expressible. */
export function intentSkeleton(): Record<string, unknown> {
  return {
    _instructions: INTENT_INSTRUCTIONS,
    action: "auto",
    notBefore: "",
    segments: [],
    prerequisites: [],
    releaseWith: [],
    reference: "",
    approvedBy: "",
    notes: "",
  };
}

export interface NormalizedIntent {
  intent: ReleaseIntent;
  /** Human-readable problems found (empty = clean). */
  issues: string[];
  /** True when normalization changed something (synonyms mapped, shapes coerced). */
  healed: boolean;
}

const ACTION_SYNONYMS: Record<string, IntentAction> = {
  auto: "auto", automatic: "auto", yes: "auto", go: "auto", ship: "auto", release: "auto", proceed: "auto",
  hold: "hold", pause: "hold", wait: "hold", stop: "hold", block: "hold", "don't": "hold", defer: "hold",
  manual: "manual", human: "manual", later: "manual", manually: "manual",
};

function asStringArray(v: unknown): { value: string[]; coerced: boolean } {
  if (Array.isArray(v)) {
    return { value: v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()), coerced: false };
  }
  if (typeof v === "string" && v.trim() !== "") {
    return { value: v.split(",").map((s) => s.trim()).filter(Boolean), coerced: true };
  }
  return { value: [], coerced: false };
}

function normalizePrerequisites(v: unknown, issues: string[]): { value: IntentPrerequisite[]; coerced: boolean } {
  if (v === undefined || v === null || v === "") return { value: [], coerced: false };
  const arr = Array.isArray(v) ? v : [v];
  const out: IntentPrerequisite[] = [];
  let coerced = !Array.isArray(v);
  for (const entry of arr) {
    if (typeof entry === "string" && entry.trim() !== "") {
      out.push({ flagKey: entry.trim(), variation: "on" });
      coerced = true;
    } else if (entry && typeof entry === "object" && typeof (entry as { flagKey?: unknown }).flagKey === "string") {
      const e = entry as { flagKey: string; variation?: unknown };
      const rawVar = String(e.variation ?? "on").toLowerCase().trim();
      const variation = rawVar === "off" || rawVar === "false" || rawVar === "disabled" ? "off" : "on";
      if (rawVar !== String(e.variation ?? "on")) coerced = true;
      out.push({ flagKey: e.flagKey.trim(), variation });
    } else if (entry !== undefined && entry !== null && entry !== "") {
      issues.push(`prerequisites entry not understood: ${JSON.stringify(entry).slice(0, 80)}`);
    }
  }
  return { value: out, coerced };
}

/** A bare calendar date — no time, no zone. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a notBefore value into ISO YYYY-MM-DD, or report it as an issue.
 *
 * Timezone-safe deliberately, because `Date` parses the two shapes we accept in
 * DIFFERENT reference frames: a bare `YYYY-MM-DD` is UTC midnight per spec, while a
 * non-ISO string like "Aug 1 2026" is LOCAL midnight. Formatting either with
 * `toISOString()` therefore shifts the calendar date by a day depending on the
 * offset's sign — "Aug 1 2026" became 2026-07-31 anywhere east of UTC, and
 * formatting the ISO form with local getters would break the same way west of it.
 * A `notBefore` is a calendar date, not an instant, so: an already-ISO date is
 * validated and passed through untouched, and anything else is formatted from the
 * LOCAL fields it was parsed into. No path round-trips through a different frame.
 */
function normalizeNotBefore(v: unknown, issues: string[]): { value: string; coerced: boolean } {
  if (v === undefined || v === null || v === "") return { value: "", coerced: false };
  const raw = String(v).trim();
  if (ISO_DATE_RE.test(raw)) {
    // The regex admits impossible dates (2026-02-30), so confirm it round-trips as
    // a real calendar day. Compared in UTC, matching how the string parses.
    const utc = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(utc.getTime()) && utc.toISOString().slice(0, 10) === raw) {
      return { value: raw, coerced: false };
    }
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const iso = [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, "0"),
        String(parsed.getDate()).padStart(2, "0"),
      ].join("-");
      return { value: iso, coerced: iso !== raw };
    }
  }
  issues.push(`notBefore '${raw}' is not a parseable date (use YYYY-MM-DD) — treated as unintelligible`);
  return { value: raw, coerced: false };
}

/**
 * Deterministically normalize a raw releaseIntent value. FAIL-CLOSED: an
 * unintelligible `action` (or an unparseable `notBefore`) normalizes to
 * `hold`, with the problem reported in `issues` — never silently to `auto`.
 */
export function normalizeReleaseIntent(raw: unknown): NormalizedIntent {
  const issues: string[] = [];
  let healed = false;

  if (raw === undefined || raw === null) {
    return { intent: { action: "auto" }, issues, healed };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      intent: { action: "hold", notes: String(raw) },
      issues: ["releaseIntent is not an object — held (fail-closed)"],
      healed: true,
    };
  }

  const o = raw as Record<string, unknown>;

  // action — synonym-mapped; blank = auto; unintelligible = hold (fail-closed).
  const rawAction = String(o.action ?? "").toLowerCase().trim();
  let action: IntentAction;
  if (rawAction === "") {
    action = "auto";
  } else if (ACTION_SYNONYMS[rawAction]) {
    action = ACTION_SYNONYMS[rawAction];
    if (rawAction !== action) healed = true;
  } else {
    action = "hold";
    healed = true;
    issues.push(`action '${o.action}' not understood — held (fail-closed); use auto | hold | manual`);
  }

  const nb = normalizeNotBefore(o.notBefore, issues);
  if (nb.coerced) healed = true;

  const segments = asStringArray(o.segments);
  const releaseWith = asStringArray(o.releaseWith);
  if (segments.coerced || releaseWith.coerced) healed = true;

  const prereqIssuesBefore = issues.length;
  const prereqs = normalizePrerequisites(o.prerequisites, issues);
  if (prereqs.coerced || issues.length > prereqIssuesBefore) healed = true;

  // An unparseable notBefore is a timing instruction we can't honor → hold.
  if (issues.some((i) => i.startsWith("notBefore")) && action === "auto") {
    action = "hold";
  }

  return {
    intent: {
      action,
      notBefore: nb.value,
      segments: segments.value,
      prerequisites: prereqs.value,
      releaseWith: releaseWith.value,
      reference: String(o.reference ?? "").trim(),
      approvedBy: String(o.approvedBy ?? "").trim(),
      notes: String(o.notes ?? "").trim(),
    },
    issues,
    healed,
  };
}

/**
 * Does this intent ask for anything beyond a plain auto-release? Used by
 * Beacon to decide between the normal path and intent handling, and by the
 * steward to fast-path clean manifests.
 */
export function intentIsDefault(intent: ReleaseIntent): boolean {
  return (
    (intent.action ?? "auto") === "auto" &&
    !intent.notBefore &&
    (intent.segments?.length ?? 0) === 0 &&
    (intent.prerequisites?.length ?? 0) === 0 &&
    (intent.releaseWith?.length ?? 0) === 0 &&
    !(intent.notes ?? "").trim()
  );
}
