import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeNotifyResult, FINAL_ACTIONS, NON_FINAL_ACTIONS } from "@auto-factory/beacon";

// ---------------------------------------------------------------------------
// The Notifier is the only thing an operator sees, and it used to say "HTTP 200"
// for a deploy in which nothing released.
//
// Two separate blind spots:
//  1. Non-blocking BY CONTRACT (it must never fail a deploy), so a 5xx became one
//     console.warn beside a green deploy.
//  2. The larger one, unrelated to failures: Beacon ACKS a notification and reports
//     per-flag outcomes in the body, so `held`/`waiting`/`error` arrive inside a 200.
//     Nothing REDELIVERS the notification (the Notifier exits 0; Railway documents no
//     webhook retry). The ledger (pending.ts) re-checks unfinished flags on the next
//     deploy, so they are no longer permanent — but nothing happens before then, and a
//     flag whose newest release is terminal-without-completing is refused rather than
//     retried, for as long as that stays true (server.ts, `terminalHistoryRefusal`).
//
// The exit code stays 0. What changes is that a human is told.
// ---------------------------------------------------------------------------

const BASE = { service: "demo-backend", sha: "abc123", beaconUrl: "https://beacon.example" };
const body = (o: unknown): string => JSON.stringify({ discovered: Array.isArray(o) ? o.length : 0, outcomes: o });

describe("describeNotifyResult", () => {
  it("a 200 carrying stranded flags demands attention — the case that read as success", () => {
    const r = describeNotifyResult({
      ...BASE,
      status: 200,
      body: body([
        { flag: "enable-one", action: "released" },
        { flag: "enable-two", action: "held", detail: "notBefore 2026-12-01" },
        { flag: "enable-three", action: "error", detail: "idempotency check failed" },
      ]),
    });
    assert.equal(r.attention, true, "HTTP 200 is not the same as 'the flags released'");
    const text = r.lines.join("\n");
    assert.match(text, /ACTION REQUIRED/, "the marker an alert can grep for");
    assert.match(text, /2 of 3 flag\(s\) did NOT release/);
    assert.match(text, /enable-two: held/);
    assert.match(text, /enable-three: error/);
    assert.doesNotMatch(text, /enable-one/, "a released flag is not noise for the operator");
    assert.match(text, /re-check them on the\s+next deploy/);
    assert.match(text, /nothing happens before then/);
  });

  it("names the recovery, including why previousSha is needed", () => {
    const r = describeNotifyResult({ ...BASE, status: 200, body: body([{ flag: "f", action: "waiting" }]) });
    const text = r.lines.join("\n");
    assert.match(text, /curl .*flag-releases/s, "a half-remembered curl is no recovery");
    assert.match(text, /previousSha/);
    // The trap: this notification already advanced Beacon's recorded SHA, so a re-POST
    // without previousSha diffs the wrong range and discovers nothing.
    assert.match(text, /already advanced/);
  });

  it("an all-final 200 is quiet", () => {
    const r = describeNotifyResult({
      ...BASE,
      status: 200,
      body: body([
        { flag: "a", action: "released" },
        { flag: "b", action: "skipped" },
        { flag: "c", action: "already_running" },
        { flag: "d", action: "noop" },
      ]),
    });
    assert.equal(r.attention, false, "nothing here needs a human");
    assert.match(r.lines.join("\n"), /a=released/);
  });

  it("a deploy with no new manifests is quiet, not empty", () => {
    const r = describeNotifyResult({ ...BASE, status: 200, body: body([]) });
    assert.equal(r.attention, false);
    assert.match(r.lines.join("\n"), /no new release manifests/);
    assert.ok(r.lines.length > 0, "silence is indistinguishable from a lost deploy");
  });

  it("a 5xx says the notification is not redelivered, but the ledger will re-check", () => {
    const r = describeNotifyResult({ ...BASE, status: 503, body: body([{ flag: "f", action: "error" }]) });
    assert.equal(r.attention, true);
    const text = r.lines.join("\n");
    assert.match(text, /NOT REDELIVERED/);
    assert.match(text, /re-checks them on the NEXT deploy/);
    assert.match(text, /curl/, "a 5xx is worth retrying, so state how");
  });

  it("a 4xx is classified as configuration, not transient", () => {
    const r = describeNotifyResult({ ...BASE, status: 400, body: '{"error":"unknown service \'demo-back\'"}' });
    assert.equal(r.attention, true);
    const text = r.lines.join("\n");
    assert.match(text, /REJECTED/);
    assert.match(text, /configuration problem, not a transient one/);
    assert.match(text, /services\.yaml/, "point at the file that is wrong");
    assert.doesNotMatch(text, /curl -fsS/, "re-POSTing an unchanged config would just fail again");
  });

  it("a 2xx with an unreadable body does not claim success", () => {
    // A proxy or CDN in front of Beacon returning HTML with a 200.
    const r = describeNotifyResult({ ...BASE, status: 200, body: "<html>gateway</html>" });
    assert.equal(r.attention, true);
    assert.match(r.lines.join("\n"), /cannot confirm what released/);
  });

  it("the action sets are disjoint and cover what the server emits", () => {
    // If server.ts gains an action that is in neither set it silently becomes "final",
    // which is the fail-OPEN direction — so this is pinned deliberately.
    for (const a of NON_FINAL_ACTIONS) assert.ok(!FINAL_ACTIONS.includes(a), `${a} in both sets`);
    const emitted = ["released", "held", "noop", "already_running", "skipped", "waiting", "error"];
    for (const a of emitted) {
      assert.ok(
        NON_FINAL_ACTIONS.includes(a) || FINAL_ACTIONS.includes(a),
        `server.ts emits '${a}' but notifyReport classifies it as neither`,
      );
    }
  });
});
