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
 * followed by `T`/whitespace before a time). This prefix IS the answer — never compute a
 * calendar date from an instant.
 */
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?=$|[T\s])/;
/** A year-month with no day. Strict, unambiguous, and V8 parses it in UTC. */
const ISO_YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

/** Is `ymd` a real calendar day? `2026-02-30` is not, and V8 rolls it to March 2. */
function isRealCalendarDay(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/**
 * Parse a notBefore value into ISO YYYY-MM-DD, or report it as an issue.
 *
 * ISO ONLY. `YYYY-MM-DD` (optionally followed by a time and any zone), or `YYYY-MM`.
 * Anything else — `Aug 1 2026`, `1/12/2026`, RFC 1123 — is refused, which holds the
 * release and says so on the PR.
 *
 * That refusal replaces four successive attempts to HEAL free-form dates, each of which
 * shipped a way to release EARLY:
 *
 *  - formatting via `toISOString()` moved "Aug 1 2026" to 07-31 east of UTC;
 *  - formatting via local getters then moved "2026-08-01T00:00:00Z" to 07-31 west of it;
 *  - reading zone-suffixed strings in UTC was wrong for every non-`Z` offset, and word
 *    zones (`UTC`, `GMT`) weren't detected as zones at all;
 *  - reinterpreting in UTC and validating the result against digit runs in the input was
 *    defeated by time tokens — V8 rolls an impossible day onto day 1-3, exactly what an
 *    hour or minute supplies, so "Feb 30 2026 02:00" healed silently to March 2. That
 *    heuristic also could not see month-position ambiguity: "1/12/2026" from a D/M/Y
 *    author became January 12, eleven months early.
 *
 * The lesson is that healing a free-form date requires recovering the author's intent from
 * an ambiguous string, and every shortcut for that fails open. The documented format is
 * `YYYY-MM-DD` (see INTENT_INSTRUCTIONS); a steward agent's job is to promote free text
 * into structured fields ON THE PR, where a human can see it — not at deploy time.
 */
function normalizeNotBefore(v: unknown, issues: string[]): { value: string; coerced: boolean } {
  if (v === undefined || v === null || v === "") return { value: "", coerced: false };
  const raw = String(v).trim();
  const prefix = ISO_DATE_PREFIX_RE.exec(raw)?.[1];
  if (prefix) {
    // BOTH checks matter: the prefix must be a real day (V8 rolls 2026-02-30 to March 2
    // rather than rejecting it), AND the whole string must parse, so trailing junk like
    // "2026-08-10 garbage" or "…T25:00" is refused rather than silently truncated.
    if (isRealCalendarDay(prefix) && !Number.isNaN(new Date(raw).getTime())) {
      return { value: prefix, coerced: prefix !== raw };
    }
  } else if (ISO_YEAR_MONTH_RE.test(raw)) {
    // Kept deliberately: strict, unambiguous, no rollover exposure, and normalises to the
    // first of the month. Parsed in UTC by spec, so read back in UTC — deterministic.
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return { value: parsed.toISOString().slice(0, 10), coerced: true };
    }
  }
  // The "notBefore" prefix is load-bearing: normalizeReleaseIntent flips action auto→hold
  // on an issue starting with it. Reword this and the fail-closed hold disappears.
  issues.push(
    `notBefore '${raw}' is not an ISO date (use YYYY-MM-DD) — treated as unintelligible`,
  );
  return { value: raw, coerced: false };
}

/**
 * Does a `notBefore` still hold the release at `now`?
 *
 * ANYWHERE-ON-EARTH: the gate opens once the stated calendar date has begun in the LAST
 * timezone on Earth (UTC−12), i.e. at `notBefore`T12:00Z. The author's timezone is
 * unknown and unknowable from a bare date, and `notBefore` forbids EARLY while tolerating
 * late — so the only safe reading is the latest interpretation.
 *
 * The previous comparison (`new Date(notBefore).getTime() > Date.now()`) opened at 00:00
 * UTC, which is the *earliest* interpretation: an author in Los Angeles writing
 * `2026-08-10` got a release at 17:00 on Aug 9 their time. That contradicts this module's
 * contract — an intent must never CAUSE a release, only prevent one.
 *
 * Operational caveat worth knowing: Beacon has no scheduler. A held release is only
 * re-evaluated on the next deploy notification, so `notBefore` means "held until someone
 * deploys again on or after that date", not "released at midnight".
 */
export function notBeforeHolds(notBefore: string, now: number = Date.now()): boolean {
  if (!notBefore) return false;
  const AOE_OFFSET_MS = 12 * 60 * 60 * 1000;
  return new Date(now - AOE_OFFSET_MS).toISOString().slice(0, 10) < notBefore;
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
