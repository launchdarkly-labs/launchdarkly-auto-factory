import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { intentIsDefault, intentSkeleton, normalizeReleaseIntent } from "@auto-factory/shared";

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

  it("notBefore coerces to ISO; unparseable dates hold (fail-closed)", () => {
    assert.equal(normalizeReleaseIntent({ notBefore: "2026-08-01" }).intent.notBefore, "2026-08-01");
    const coerced = normalizeReleaseIntent({ notBefore: "Aug 1 2026" });
    assert.equal(coerced.intent.notBefore, "2026-08-01");
    assert.equal(coerced.healed, true);
    const bad = normalizeReleaseIntent({ action: "auto", notBefore: "next month" });
    assert.equal(bad.intent.action, "hold");
    assert.match(bad.issues.join(" "), /not a parseable date/);
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
  // Every shape the normalizer accepts. A `notBefore` is a CALENDAR DATE, so the
  // answer is whatever the author wrote — including for offsets and word zones,
  // which two earlier attempts got wrong in opposite directions.
  const CASES = [
    "2026-08-01",
    "Aug 1 2026",
    "2026-8-1",
    "2026-01-01",
    "Dec 31 2026",
    "2026-08-01T00:00:00Z",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00+02:00",
    "2026-08-01T09:00:00+10:00",
    "2026-07-31T23:00:00-10:00",
    "2026-08-01 00:00 UTC",
    "2026-08-01 00:00:00 GMT",
    "2026-08-01T12:00:00",
    "2026-08",
    // Non-ISO shapes CARRYING A ZONE — the gap the third attempt left open. These are
    // instants, so local-field formatting shifted them a day west of UTC.
    "Fri, 01 Aug 2026 00:00:00 GMT",
    "Aug 1 2026 UTC",
    "August 1, 2026 00:00 UTC",
    "Aug 1 2026 EST",
    "Aug 1 2026 00:00 +02:00",
    "8/1/2026",
  ];
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
    const expected = {
      "2026-08-01": "2026-08-01",
      "Aug 1 2026": "2026-08-01",
      "2026-8-1": "2026-08-01",
      "2026-01-01": "2026-01-01",
      "Dec 31 2026": "2026-12-31",
      "2026-08-01T00:00:00Z": "2026-08-01",
      "2026-08-01T00:00:00.000Z": "2026-08-01",
      // Offsets: the author wrote Aug 1. Formatting these in UTC gave 07-31 — the
      // regression that made this the third attempt.
      "2026-08-01T00:00:00+02:00": "2026-08-01",
      "2026-08-01T09:00:00+10:00": "2026-08-01",
      // …and the date is the one WRITTEN, not the UTC instant: this is Aug 1 09:00Z.
      "2026-07-31T23:00:00-10:00": "2026-07-31",
      // Word zones were never detected as zones at all, leaving them zone-dependent.
      "2026-08-01 00:00 UTC": "2026-08-01",
      "2026-08-01 00:00:00 GMT": "2026-08-01",
      "2026-08-01T12:00:00": "2026-08-01",
      // No day component: normalised to the first, deterministically.
      "2026-08": "2026-08-01",
      "Fri, 01 Aug 2026 00:00:00 GMT": "2026-08-01",
      "Aug 1 2026 UTC": "2026-08-01",
      "August 1, 2026 00:00 UTC": "2026-08-01",
      "Aug 1 2026 EST": "2026-08-01",
      "Aug 1 2026 00:00 +02:00": "2026-08-01",
      "8/1/2026": "2026-08-01",
    };
    for (const tz of ZONES) {
      assert.deepEqual(notBeforeIn(tz), expected, `notBefore drifted under TZ=${tz}`);
    }
  });

  it("malformed and impossible dates fail CLOSED, in every zone", () => {
    // 2026-02-30 with a time suffix is the nastier one: V8 does not reject it, it
    // rolls it to March 2 — so a run would have released two days early.
    // "Feb 30 2026" and "Aug 1" are the non-ISO fail-open cases: V8 rolls the former to
    // March 2 and reads the latter as the year 2001 — both release EARLIER than intended.
    for (const bad of [
      "2026-02-30",
      "2026-02-30T00:00:00Z",
      "2026-08-011",
      "not a date",
      "Feb 30 2026",
      "Aug 1",
      "2026",
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
