import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { intentIsDefault, intentSkeleton, normalizeReleaseIntent, notBeforeHolds } from "@auto-factory/shared";

describe("normalizeReleaseIntent (deterministic, fail-closed)", () => {
  it("absent intent → plain auto (legacy manifests unaffected)", () => {
    const r = normalizeReleaseIntent(undefined);
    assert.equal(r.intent.action, "auto");
    assert.deepEqual(r.issues, []);
  });

  it("the pristine skeleton normalizes clean and is 'default'", () => {
    const r = normalizeReleaseIntent(intentSkeleton());
    assert.equal(r.intent.action, "auto");
    assert.deepEqual(r.issues, []);
    assert.equal(intentIsDefault(r.intent), true);
  });

  it("action synonyms map (healed), case-insensitively", () => {
    for (const [raw, want] of [
      ["PAUSE", "hold"], ["wait", "hold"], ["ship", "auto"], ["Manual", "manual"], ["human", "manual"],
    ] as const) {
      const r = normalizeReleaseIntent({ action: raw });
      assert.equal(r.intent.action, want, raw);
    }
    assert.equal(normalizeReleaseIntent({ action: "pause" }).healed, true);
  });

  it("unintelligible action fails CLOSED to hold, with an issue", () => {
    const r = normalizeReleaseIntent({ action: "banana" });
    assert.equal(r.intent.action, "hold");
    assert.match(r.issues.join(" "), /not understood/);
  });

  it("notBefore accepts RFC 3339 full-date ONLY; everything else holds (fail-closed)", () => {
    // Accepted verbatim, never transformed.
    const ok = normalizeReleaseIntent({ notBefore: "2026-08-01" });
    assert.equal(ok.intent.notBefore, "2026-08-01");
    assert.equal(ok.healed, false, "nothing is healed — there is no transformation left");

    // Everything else holds. A datetime is refused rather than truncated: honouring only
    // its date would open the gate ~12h before an instant like T23:59:59Z.
    for (const rejected of [
      "2026-08-01T09:30:00+02:00",
      "2026-08-01T24:00:00Z",
      "Aug 1 2026",
      "1/12/2026",
      "Fri, 01 Aug 2026 00:00:00 GMT",
      "2026-08",
      "next month",
    ]) {
      const r = normalizeReleaseIntent({ action: "auto", notBefore: rejected });
      assert.equal(r.intent.action, "hold", rejected);
      assert.match(r.issues.join(" "), /YYYY-MM-DD/, rejected);
    }
  });

  it("prerequisites: strings coerce to {flagKey, variation:'on'}; variation synonyms map", () => {
    const r = normalizeReleaseIntent({ prerequisites: ["flag-xyz", { flagKey: "flag-abc", variation: "FALSE" }] });
    assert.deepEqual(r.intent.prerequisites, [
      { flagKey: "flag-xyz", variation: "on" },
      { flagKey: "flag-abc", variation: "off" },
    ]);
  });

  it("segments accept a comma-separated string", () => {
    const r = normalizeReleaseIntent({ segments: "beta-users, internal" });
    assert.deepEqual(r.intent.segments, ["beta-users", "internal"]);
    assert.equal(r.healed, true);
  });

  it("a non-object intent holds (fail-closed) and preserves the text as notes", () => {
    const r = normalizeReleaseIntent("release whenever");
    assert.equal(r.intent.action, "hold");
    assert.equal(r.intent.notes, "release whenever");
  });

  it("underscore/unknown keys are ignored, notes/reference/approvedBy carried", () => {
    const r = normalizeReleaseIntent({
      _instructions: "blah", zzz: 1, notes: "after Q3", reference: "JIRA-123", approvedBy: "tom",
    });
    assert.equal(r.intent.notes, "after Q3");
    assert.equal(r.intent.reference, "JIRA-123");
    assert.equal(r.intent.approvedBy, "tom");
    assert.equal(r.intent.action, "auto");
  });

  it("intentIsDefault is false when anything is asked", () => {
    assert.equal(intentIsDefault(normalizeReleaseIntent({ action: "hold" }).intent), false);
    assert.equal(intentIsDefault(normalizeReleaseIntent({ notes: "child of flag-xyz" }).intent), false);
    assert.equal(intentIsDefault(normalizeReleaseIntent({ prerequisites: ["flag-x"] }).intent), false);
  });
});

// ---------------------------------------------------------------------------
// `notBefore` is a CALENDAR date, so it must normalize identically in every
// timezone. The in-process cases above only catch the bug east of UTC (the
// original code turned "Aug 1 2026" into 2026-07-31 under BST but passed under
// UTC, which is why CI never saw it). TZ is read at interpreter start, so each
// zone gets its own child process.
// ---------------------------------------------------------------------------
describe("normalizeNotBefore is timezone-independent", () => {
  const MODULE = fileURLToPath(new URL("../packages/shared/dist/releaseIntent.js", import.meta.url));
  // The accepted set is now exactly RFC 3339 full-date. The matrix stays as a regression
  // guard: any reintroduction of `new Date()` into the parse path would make one of these
  // zone-dependent again, which is how the previous five revisions each broke.
  const CASES = ["2026-08-01", "2026-01-01", "2026-12-31", "2028-02-29", "2026-03-01"];
  // Sign, magnitude, a half-hour offset, and both extremes of the UTC range.
  const ZONES = [
    "UTC",
    "Europe/London",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "America/Los_Angeles",
    "Pacific/Kiritimati",
    "Etc/GMT+12",
  ];

  /** Normalize every case in a child process pinned to `tz`. */
  function notBeforeIn(tz: string): Record<string, string> {
    const script = `
      const { normalizeReleaseIntent } = await import(${JSON.stringify(MODULE)});
      const out = {};
      for (const c of ${JSON.stringify(CASES)}) out[c] = normalizeReleaseIntent({ notBefore: c }).intent.notBefore;
      process.stdout.write(JSON.stringify(out));
    `;
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    });
    return JSON.parse(raw) as Record<string, string>;
  }

  it("every accepted date shape yields the same calendar date in all zones", () => {
    // Identity: an accepted value is returned verbatim, never transformed.
    const expected = Object.fromEntries(CASES.map((c) => [c, c]));
    for (const tz of ZONES) {
      assert.deepEqual(notBeforeIn(tz), expected, `notBefore drifted under TZ=${tz}`);
    }
  });

  it("malformed and impossible dates fail CLOSED, in every zone", () => {
    // 2026-02-30 with a time suffix is the nastier one: V8 does not reject it, it
    // rolls it to March 2 — so a run would have released two days early.
    // "Feb 30 2026" and "Aug 1" are the non-ISO fail-open cases: V8 rolls the former to
    // March 2 and reads the latter as the year 2001 — both release EARLIER than intended.
    // One entry per way a previous revision failed open, plus the grammar's own limits.
    for (const bad of [
      // Calendar-invalid days that V8 ROLLS rather than rejecting.
      "2026-02-30",
      "2026-02-29", // 2026 is not a leap year
      "2026-04-31",
      "2026-02-30T00:00:00Z",
      // Hour 24: valid ISO 8601, forbidden by RFC 3339, and its instant is the NEXT day.
      "2026-08-01T24:00:00Z",
      // Datetimes are refused rather than truncated — honouring only the date would open
      // the gate ~12h before an instant like T23:59:59Z.
      "2026-08-01T00:00:00Z",
      "2026-08-01T23:59:59Z",
      "2026-08-01T00:00:00+02:00",
      // Free-form: healing these is what shipped four early-release bugs.
      "Feb 30 2026 02:00",
      "Sep 31 2026 01:00",
      "1/12/2026",
      "Aug 1 2026",
      // Shape errors the grammar rejects outright.
      "2026-8-1",
      "2026-08-011",
      "2026-13-01",
      "2026-00-01",
      "2026-08-00",
      "2026-08",
      "not a date",
    ]) {
      for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        const script = `
          const { normalizeReleaseIntent } = await import(${JSON.stringify(MODULE)});
          const r = normalizeReleaseIntent({ action: "auto", notBefore: ${JSON.stringify(bad)} });
          process.stdout.write(JSON.stringify({ action: r.intent.action, issues: r.issues.length }));
        `;
        const out = JSON.parse(
          execFileSync(process.execPath, ["--input-type=module", "-e", script], {
            encoding: "utf8",
            env: { ...process.env, TZ: tz },
          }),
        ) as { action: string; issues: number };
        assert.equal(out.action, "hold", `${bad} @ ${tz}`);
        assert.ok(out.issues > 0, `${bad} @ ${tz}`);
      }
    }
  });

  it("an impossible calendar date is still rejected, in every zone", () => {
    for (const tz of ZONES) {
      const script = `
        const { normalizeReleaseIntent } = await import(${JSON.stringify(MODULE)});
        const r = normalizeReleaseIntent({ action: "auto", notBefore: "2026-02-30" });
        process.stdout.write(JSON.stringify({ action: r.intent.action, issues: r.issues.length }));
      `;
      const out = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
          env: { ...process.env, TZ: tz },
        }),
      ) as { action: string; issues: number };
      // Fail-closed: an unparseable date holds the release and reports the problem.
      assert.equal(out.action, "hold", `TZ=${tz}`);
      assert.ok(out.issues > 0, `TZ=${tz}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate. Comparing instants (`new Date(notBefore) > Date.now()`) opened at 00:00 UTC —
// the EARLIEST reading — so an author west of UTC got a release on their previous
// calendar day. Anywhere-on-Earth is the only safe reading of a bare date whose author
// timezone is unknown: notBefore forbids early and tolerates late.
// ---------------------------------------------------------------------------
describe("notBeforeHolds (anywhere-on-earth)", () => {
  const at = (iso: string) => Date.parse(iso);

  it("opens at notBefore T12:00Z — when the date has begun in the last timezone", () => {
    assert.equal(notBeforeHolds("2026-08-10", at("2026-08-10T11:59:59Z")), true, "still held");
    assert.equal(notBeforeHolds("2026-08-10", at("2026-08-10T12:00:00Z")), false, "open");
  });

  it("does NOT open at 00:00 UTC — the bug this replaces", () => {
    // The old comparison released here, which is 17:00 on Aug 9 in Los Angeles.
    assert.equal(notBeforeHolds("2026-08-10", at("2026-08-10T00:00:00Z")), true);
  });

  it("is never early for any real timezone offset", () => {
    // For every offset from UTC-12 to UTC+14, the local calendar date at the moment the
    // gate opens must be >= the stated date. That is the property "never early".
    const open = at("2026-08-10T12:00:00Z");
    for (let offsetHours = -12; offsetHours <= 14; offsetHours++) {
      const localDate = new Date(open + offsetHours * 3600_000).toISOString().slice(0, 10);
      assert.ok(localDate >= "2026-08-10", `UTC${offsetHours >= 0 ? "+" : ""}${offsetHours} saw ${localDate}`);
    }
  });

  it("holds well before, opens well after, and treats an empty value as no gate", () => {
    assert.equal(notBeforeHolds("2026-08-10", at("2026-01-01T00:00:00Z")), true);
    assert.equal(notBeforeHolds("2026-08-10", at("2026-12-01T00:00:00Z")), false);
    assert.equal(notBeforeHolds("", at("2020-01-01T00:00:00Z")), false);
  });

  it("is independent of the runtime timezone", () => {
    // It must not matter where Beacon runs — only where the author might be.
    const t = at("2026-08-10T11:00:00Z");
    assert.equal(notBeforeHolds("2026-08-10", t), true);
  });
});
