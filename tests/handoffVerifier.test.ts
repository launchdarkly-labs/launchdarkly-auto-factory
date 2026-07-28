import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildHandoffVerifier, filesContaining, type LdResourceWriter } from "@auto-factory/shared";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "verify-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
};

/** Writer stub whose getFlagState reports the given variations (or absence). */
function fakeWriter(flags: Record<string, string[]>): LdResourceWriter {
  return {
    projectKey: "app",
    async getFlagState(key: string) {
      const values = flags[key];
      if (!values) return { exists: false, key, kind: "multivariate", variations: [], environments: {} };
      return {
        exists: true,
        key,
        kind: "multivariate",
        variations: values.map((value) => ({ value })),
        environments: {},
      };
    },
  } as unknown as LdResourceWriter;
}

describe("handoff shims — flag claims", () => {
  it("passes when the flag exists in LD and key + variation are wired in code", async () => {
    write("src/feature.ts", `const v = flags.variation('enable-x', 'control');\nif (v === 'v2') { /* new */ }\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1", "v2"] }) });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v2" } });
    assert.equal(r?.ok, true);
    assert.deepEqual(
      r?.passed.map((c) => c.name).sort(),
      ["flag-exists-in-ld", "flag-wired-in-code", "variation-exists-in-ld", "variation-wired-in-code"],
    );
  });

  it("fails when the flag key is referenced nowhere in the code", async () => {
    write("src/other.ts", "nothing to see\n");
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1"] }) });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v1" } });
    assert.equal(r?.ok, false);
    assert.ok(r?.failures.some((c) => c.name === "flag-wired-in-code"));
  });

  it("fails the boolean-helper shape: key wired, vN never compared (the live PR #12 bug)", async () => {
    write("src/feature.ts", `const on = await flags.isEnabled('enable-x', false);\nif (!on) return;\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1"] }) });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v1" } });
    assert.equal(r?.ok, false);
    const failure = r?.failures.find((c) => c.name === "variation-wired-in-code");
    assert.ok(failure);
    assert.match(failure.detail, /boolean helper/);
  });

  it("skips the variation check for boolean rides (flag_variation 'true')", async () => {
    write("orders/main.py", `REORDER_FLAG = "enable-old"\nif not flags.is_enabled(REORDER_FLAG):\n    pass\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-old", flag_variation: "true" } });
    assert.equal(r?.ok, true);
    assert.ok(!r?.passed.some((c) => c.name === "variation-wired-in-code"));
  });

  it("fails when LD does not have the flag or the claimed variation", async () => {
    write("src/feature.ts", `flags.variation('enable-x', 'control') === 'v3'\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1"] }) });
    const missingVar = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v3" } });
    assert.equal(missingVar?.ok, false);
    assert.ok(missingVar?.failures.some((c) => c.name === "variation-exists-in-ld"));

    const verify2 = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({}) });
    const missingFlag = await verify2({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v3" } });
    assert.ok(missingFlag?.failures.some((c) => c.name === "flag-exists-in-ld"));
  });

  it("without a writer, LD checks are skipped but code checks still run", async () => {
    write("src/feature.ts", `flags.variation('enable-x', 'control') === 'v1'\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v1" } });
    assert.equal(r?.ok, true);
    assert.ok(!r?.passed.some((c) => c.name === "flag-exists-in-ld"));
    assert.ok(r?.passed.some((c) => c.name === "flag-wired-in-code"));
  });

  it("manifest references don't count as wiring (.release-flags is excluded)", async () => {
    write(".release-flags/pr-9.json", JSON.stringify({ flagKey: "enable-x" }));
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x" } });
    assert.equal(r?.ok, false);
    assert.ok(r?.failures.some((c) => c.name === "flag-wired-in-code"));
  });
});

describe("handoff shims — metric + test claims", () => {
  it("passes when every event-backed metric has an emitter; fails when one has none", async () => {
    write("src/api.ts", `flags.track('enable-x-error');\nflags.track('enable-x-latency', ms);\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const ok = await verify({ configKey: "metrics", tags: { metric_event_keys: "enable-x-error,enable-x-latency" } });
    assert.equal(ok?.ok, true);

    const bad = await verify({ configKey: "metrics", tags: { metric_event_keys: "enable-x-error,enable-x-success" } });
    assert.equal(bad?.ok, false);
    assert.match(bad?.failures[0]?.detail ?? "", /enable-x-success/);
  });

  it("skips track() emitter check for Sentry integration event keys", async () => {
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "metrics", tags: { metric_event_keys: "sentry-errors" } });
    assert.equal(r?.ok, true);
    assert.ok(r?.passed.some((c) => c.name === "metric-event-instrumented"));
  });

  it("requires launchdarklyContext when sentry_guardrail=true", async () => {
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const bad = await verify({ configKey: "metrics", tags: { sentry_guardrail: "true" } });
    assert.equal(bad?.ok, false);
    assert.ok(bad?.failures.some((c) => c.name === "sentry-launchdarkly-context"));

    write("app.py", `sentry_sdk.set_context("launchdarklyContext", {"key": "u"})\n`);
    const ok = await verify({ configKey: "metrics", tags: { sentry_guardrail: "true" } });
    assert.equal(ok?.ok, true);
  });

  it("tests_last_run=fail fails the handoff; pass passes; absent applies no check", async () => {
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const fail = await verify({ configKey: "testing", tags: { tests_last_run: "fail" } });
    assert.equal(fail?.ok, false);
    const pass = await verify({ configKey: "testing", tags: { tests_last_run: "pass" } });
    assert.equal(pass?.ok, true);
    const none = await verify({ configKey: "research", tags: { flag_worthy: "true" } });
    assert.equal(none, null); // no claims → no checks → no verification
  });
});

describe("filesContaining", () => {
  it("skips node_modules/dist/.release-flags and finds nested hits", () => {
    write("a/b/hit.txt", "needle here");
    write("node_modules/pkg/miss.txt", "needle");
    write("dist/miss.txt", "needle");
    write(".release-flags/pr-1.json", "needle");
    assert.deepEqual(filesContaining(root, "needle"), ["a/b/hit.txt"]);
  });
});
