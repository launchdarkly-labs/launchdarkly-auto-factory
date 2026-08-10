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

/**
 * A calendar date at the START of the string, cleanly terminated (end of string, or
 * followed by `T`/whitespace before a time). This prefix IS the answer — see below.
 */
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?=$|[T\s])/;
/** Starts ISO-shaped but may not terminate cleanly (`2026-08-011`). */
const LOOKS_ISO_RE = /^\d{4}-\d{2}-\d{2}/;
/** A year-month with no day. V8 parses this in UTC. */
const ISO_YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

/** Is `ymd` a real calendar day? `2026-02-30` is not, and V8 rolls it to March 2. */
function isRealCalendarDay(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/**
 * Parse a notBefore value into ISO YYYY-MM-DD, or report it as an issue.
 *
 * `notBefore` is a CALENDAR DATE, and the calendar date is whatever the human
 * wrote. So when the string carries an ISO date prefix, that prefix is the answer
 * and no reference-frame arithmetic happens at all:
 *
 *   2026-08-01                  → 2026-08-01
 *   2026-08-01T00:00:00Z        → 2026-08-01
 *   2026-08-01T00:00:00+02:00   → 2026-08-01   (the author meant Aug 1, in +02:00)
 *   2026-08-01 00:00 UTC        → 2026-08-01
 *   2026-08-01T12:00:00         → 2026-08-01
 *
 * Three earlier attempts got this wrong by picking a frame to FORMAT in, and each
 * traded one off-by-one-day for another: `toISOString()` shifted "Aug 1 2026" to
 * 07-31 east of UTC; local getters then shifted "2026-08-01T00:00:00Z" to 07-31 west
 * of it; choosing UTC for zone-suffixed strings was wrong for every non-`Z` offset
 * (`+02:00` midnight is 07-31 in UTC); and a word zone (`… UTC`, `… GMT`) wasn't
 * detected as a zone at all, so non-ISO shapes carrying one stayed zone-dependent.
 *
 * The rule that ends it: never compute a calendar date from an instant. Read what was
 * written — the ISO prefix where there is one, and for non-ISO a UTC REINTERPRETATION
 * (see below), which recovers the written fields regardless of the frame the string
 * named. Every branch is then identical in every runtime timezone.
 *
 * Both non-prefix branches also validate the parse rather than trusting it, because
 * V8's leniency fails OPEN — it rolls "2026-02-30" to March 2 and reads "Aug 1" as the
 * year 2001, either of which would release EARLIER than intended, silently.
 */
function normalizeNotBefore(v: unknown, issues: string[]): { value: string; coerced: boolean } {
  if (v === undefined || v === null || v === "") return { value: "", coerced: false };
  const raw = String(v).trim();
  const prefix = ISO_DATE_PREFIX_RE.exec(raw)?.[1];
  if (prefix) {
    // The prefix must be a real day (V8 rolls 2026-02-30 to March 2 rather than
    // rejecting it) AND the whole string must parse, so trailing junk is refused.
    if (isRealCalendarDay(prefix) && !Number.isNaN(new Date(raw).getTime())) {
      return { value: prefix, coerced: prefix !== raw };
    }
  } else if (LOOKS_ISO_RE.test(raw)) {
    // ISO-shaped but not cleanly terminated (`2026-08-011`). V8 parses it anyway,
    // into a zone-dependent instant — so refuse rather than guess.
  } else if (ISO_YEAR_MONTH_RE.test(raw)) {
    // No day component. Parsed in UTC by spec, so read it back in UTC: deterministic
    // across zones, and normalises to the first of the month.
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return { value: parsed.toISOString().slice(0, 10), coerced: true };
    }
  } else {
    // Non-ISO ("Aug 1 2026", "Fri, 01 Aug 2026 00:00:00 GMT", "8/1/2026").
    //
    // Reinterpreting in UTC recovers the date the author WROTE, whatever frame the
    // string named — appending " UTC" re-anchors the written fields and overrides any
    // zone token, so the result is identical in every runtime timezone. That matters
    // because local-field formatting was only right for ZONELESS input: a string
    // carrying `GMT`/`UTC`/`EST`/an offset is an instant, and reading its local fields
    // shifted the date by a day west of UTC. Deliberately vocabulary-free — V8's
    // accepted zone tokens are implementation-defined (it takes `UT` but rejects
    // `CEST`), so any regex over them would be a guess about the parser's table.
    const asWritten = new Date(`${raw} UTC`);
    if (!Number.isNaN(new Date(raw).getTime()) && !Number.isNaN(asWritten.getTime())) {
      const iso = asWritten.toISOString().slice(0, 10);
      // Validate against the numbers actually written, because this branch has no ISO
      // prefix to check and V8's leniency fails OPEN: "Feb 30 2026" becomes March 2 and
      // "Aug 1" becomes the year 2001 — both would release EARLIER than intended,
      // silently. Require the written text to contain the resulting year and day.
      const written: string[] = raw.match(/\d+/g) ?? [];
      const year = iso.slice(0, 4);
      const day = String(Number(iso.slice(8, 10)));
      const hasYear = written.includes(year);
      const hasDay = written.some((n) => n.length <= 2 && String(Number(n)) === day);
      if (hasYear && hasDay) return { value: iso, coerced: iso !== raw };
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
