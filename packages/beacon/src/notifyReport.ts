/**
 * How a deploy notification's result is reported to whoever is looking at the deploy log.
 *
 * Separate from notify.ts because that file is a bin: it calls `main()` at import, so
 * nothing can import it to test it. The decision of WHAT to say lives here, where it can be.
 *
 * Why this exists at all. Every recovery path in Phase 2 ends in "a human re-POSTs", and
 * until now no human was ever told:
 *
 *  - the Notifier is non-blocking BY CONTRACT (it must never fail a deploy), so a failure
 *    became one `console.warn` beside a green deploy;
 *  - and — the larger gap, which has nothing to do with failures — **an HTTP 200 can carry
 *    stranded flags.** Beacon acks the notification and reports per-flag outcomes in the
 *    body, so `held`, `waiting`, and `error` all arrive inside a 200 and used to be logged
 *    as success. Nothing in the shipped configuration retries any of them.
 *
 * "Do not fail the deploy" and "do not tell anyone" are separable. This keeps the first.
 */

/**
 * Outcome actions meaning nothing was released and nothing will retry it.
 *
 * `waiting` is included deliberately, even though the counterpart's own deploy usually
 * releases it: that only happens if the counterpart deploys AFTER this one, and if its
 * notification is lost there is no other event. Reporting it is cheap; a silent strand is not.
 */
export const NON_FINAL_ACTIONS: readonly string[] = ["held", "waiting", "error"];

/**
 * Actions that need nobody: the release happened, was correctly not this service's job, or is
 * already under way.
 *
 * `already_running` is in HERE and ALSO in `pending.ts`'s `PENDING_ACTIONS`, which is not a
 * contradiction — the lists answer different questions ("must a human act?" vs "should the
 * ledger keep re-checking?"). A redelivery landing on a release that is already rolling out is
 * the expected shape of a normal deploy and pages nobody; the ledger still keeps the entry,
 * because a release of v1 does not finish a manifest that asked for v2.
 */
export const FINAL_ACTIONS: readonly string[] = ["released", "noop", "skipped", "already_running"];

interface RawOutcome {
  flag?: unknown;
  /** The MANIFEST. Present from server.ts; absent-tolerant so a partial body still reports. */
  sourceFile?: unknown;
  targetVariation?: unknown;
  action?: unknown;
  detail?: unknown;
}

export interface NotifyReport {
  /** True when a human must act. The caller uses it to pick the log level and marker. */
  attention: boolean;
  /** Lines to print, in order. Never empty. */
  lines: string[];
}

function outcomes(body: unknown): RawOutcome[] {
  if (!body || typeof body !== "object") return [];
  const list = (body as { outcomes?: unknown }).outcomes;
  return Array.isArray(list) ? (list as RawOutcome[]) : [];
}

/** The re-POST an operator must run. Stated in full: a half-remembered curl is no recovery. */
function rePostHint(beaconUrl: string, service: string, sha: string): string {
  return (
    `  RECOVER: re-POST once the cause is resolved —\n` +
    `    curl -fsS -X POST '${beaconUrl}/flag-releases' \\\n` +
    `      -H 'content-type: application/json' -H "x-beacon-secret: $BEACON_WEBHOOK_SECRET" \\\n` +
    `      -d '{"service":"${service}","sha":"${sha}","previousSha":"<sha deployed before this one>"}'\n` +
    `    previousSha matters: without it Beacon re-diffs from its own last recorded SHA, which` +
    ` this notification already advanced.`
  );
}

/**
 * Decide what to report for one notification result.
 *
 * NOTE the ordering: a non-2xx is reported even when the body parses, and a 2xx is still
 * inspected for non-final outcomes. Neither subsumes the other — a 200 with three `error`
 * outcomes is the case that used to read as success.
 */
export function describeNotifyResult(input: {
  status: number;
  /** Raw response text. Parsed defensively: Beacon may be behind a proxy that returns HTML. */
  body: string;
  service: string;
  sha: string;
  beaconUrl: string;
}): NotifyReport {
  const { status, body, service, sha, beaconUrl } = input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const all = outcomes(parsed);
  const stranded = all.filter((o) => NON_FINAL_ACTIONS.includes(String(o.action)));
  const ok = status >= 200 && status < 300;
  const lines: string[] = [];

  if (!ok) {
    // Classify, because the recovery differs and neither fixes itself.
    const kind =
      status >= 500
        ? `Beacon could not complete the work (HTTP ${status}). THIS NOTIFICATION IS NOT REDELIVERED:` +
          ` the Notifier cannot fail a deploy, and Railway documents no webhook retry. Beacon records` +
          ` unfinished flags and re-checks them on the NEXT deploy, so this is not permanent — but` +
          ` nothing happens before then.`
        : `Beacon REJECTED the notification (HTTP ${status}) — a configuration problem, not a transient one.` +
          ` Check the service name against config/services.yaml and BEACON_WEBHOOK_SECRET.`;
    lines.push(`notify: ACTION REQUIRED — ${kind}`);
    lines.push(`  service=${service} sha=${sha}`);
    lines.push(`  response: ${body.slice(0, 400) || "(empty)"}`);
    if (status >= 500) lines.push(rePostHint(beaconUrl, service, sha));
    return { attention: true, lines };
  }

  if (stranded.length > 0) {
    // `needsHuman` USED TO BE A LATCH and this line still described one: "a flag marked
    // needsHuman is never retried" was read straight off a stored field that nothing could
    // clear. It is now re-derived on every pass from the flag's newest release
    // (`terminalHistoryRefusal`), so the honest statement is CONDITIONAL: the refusal lasts
    // exactly as long as its cause. Saying otherwise sent an operator looking for a ledger file
    // to hand-edit.
    lines.push(
      `notify: ACTION REQUIRED — Beacon accepted the deploy (HTTP ${status}) but ` +
        `${stranded.length} of ${all.length} flag(s) did NOT release. Beacon will re-check them on the ` +
        `next deploy; nothing happens before then. A flag reported needsHuman is refused for as long as ` +
        `its newest release is still terminal-without-completing (reverted / monitoring_stopped) — that ` +
        `is re-decided on every deploy, so it retries by itself once the release is completed, replaced, ` +
        `or the flag moves on.`,
    );
    for (const o of stranded) {
      lines.push(`  ${label(o)}: ${String(o.action)} — ${detailText(o.detail)}`);
    }
    lines.push(rePostHint(beaconUrl, service, sha));
    return { attention: true, lines };
  }

  if (parsed === undefined) {
    // A 2xx whose body we cannot read: probably a proxy in front of Beacon. Not a failure,
    // but we cannot claim the flags released either — say exactly that much.
    lines.push(
      `notify: Beacon answered HTTP ${status} but the body was not JSON — cannot confirm what released.`,
    );
    lines.push(`  response: ${body.slice(0, 200) || "(empty)"}`);
    return { attention: true, lines };
  }

  const summary = all.length === 0 ? "no new release manifests in this deploy" : all.map(describeOne).join(", ");
  lines.push(`notify: Beacon HTTP ${status} — ${summary}`);
  return { attention: false, lines };
}

/**
 * How one outcome is named to an operator: the MANIFEST first, then the flag, then the variation
 * it wants.
 *
 * The flag key alone is ambiguous, and ambiguous in exactly the case that needs reading: one flag
 * routinely has several manifests (one per PR, never deleted) each wanting a different variation,
 * so two outcomes rendered as `checkout-flow=held, checkout-flow=held` and an operator could not
 * tell which PR to fix — or that there were two. The address is the identity everywhere else in
 * Beacon; the reporting surface should not be the one place that uses the content.
 *
 * Absent fields are tolerated rather than printed as "undefined": the notifier parses a response
 * body it did not build, and a body from an older Beacon (or a proxy's partial JSON) must still
 * produce a readable line.
 */
function label(o: RawOutcome): string {
  const file = typeof o.sourceFile === "string" && o.sourceFile ? `${o.sourceFile} ` : "";
  const target = typeof o.targetVariation === "string" && o.targetVariation ? `→${o.targetVariation}` : "";
  return `${file}${String(o.flag)}${target}`;
}

function describeOne(o: RawOutcome): string {
  return `${label(o)}=${String(o.action)}`;
}

function detailText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail === undefined || detail === null) return "(no detail)";
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
