/**
 * A failed tool provision must not be reported as a missing repo file.
 *
 * `provisionTools` only records a key in `versions` on success, so a 403 on the
 * tools library used to make every variation referencing that tool report
 * "no such tool in config/agentcontrol/tools/" — naming a file that is present
 * and sending the reader away from the permission failure that actually stopped
 * it. Observed live on 2026-08-12: ~50 such lines buried 7 real 403s.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { LdApiError, LdClient } from "@auto-factory/shared";
import { provision } from "@auto-factory/config-bridge";

const root = mkdtempSync(join(tmpdir(), "provision-tool-failure-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Writes a config whose one variation references `declaredTool` plus a tool that is genuinely absent. */
function dirs(name: string, declaredTool: string): { aiConfigsDir: string; graphsDir: string; flagsDir: string; toolsDir: string } {
  const base = join(root, name);
  for (const sub of ["ai-configs", "graphs", "flags", "tools"]) mkdirSync(join(base, sub), { recursive: true });
  writeFileSync(
    join(base, "tools", `${declaredTool}.json`),
    JSON.stringify({ key: declaredTool, description: "declared in the repo", schema: { type: "object" } }),
  );
  writeFileSync(
    join(base, "ai-configs", "cfg-a.json"),
    JSON.stringify({
      key: "cfg-a",
      name: "A",
      variations: [{ key: "v1", instructions: "x", modelConfigKey: "m", tools: [declaredTool, "never-committed"] }],
    }),
  );
  return {
    aiConfigsDir: join(base, "ai-configs"),
    graphsDir: join(base, "graphs"),
    flagsDir: join(base, "flags"),
    toolsDir: join(base, "tools"),
  };
}

/** An LdClient whose tool writes fail with `status`, as an RBAC-denied token does. */
function ldWithToolWritesDenied(status: number): LdClient {
  const denied = () => {
    // LdApiError's fields are readonly, so build the shape rather than assign onto it.
    const err = Object.assign(new Error("denied"), { status, responseBody: '{"code":"forbidden"}' }) as unknown as LdApiError;
    return Promise.reject(err);
  };
  const ok = () => Promise.resolve({ status: 201, ok: true, data: {} });
  return {
    projectKey: "test-proj",
    getAiTool: async () => ({ status: 404, ok: true, data: {} }),
    createAiTool: denied,
    getAiConfig: async () => ({ status: 404, ok: true, data: {} }),
    createAiConfig: ok,
    createAiConfigVariation: ok,
    updateAiConfigVariation: ok,
    getAgentGraph: async () => ({ status: 404, ok: true, data: {} }),
    createAgentGraph: ok,
    request: async () => ({ status: 404, ok: true, data: {} }),
    createFlag: ok,
  } as unknown as LdClient;
}

function messageFor(failures: Array<{ resource: string; message: unknown }>, needle: string): string {
  const hit = failures.find((f) => f.resource.includes(needle));
  assert.ok(hit, `expected a failure mentioning '${needle}', got: ${JSON.stringify(failures)}`);
  return String(hit.message);
}

describe("provision: a denied tool write is not a missing file", () => {
  it("distinguishes 'declared but not provisioned' from 'not in the repo at all'", async () => {
    const r = await provision(ldWithToolWritesDenied(403), dirs("denied", "read_file"));

    // The real cause is still reported, once, against the tool itself.
    const toolFailure = messageFor(r.failures, "ai-tool read_file");
    assert.match(toolFailure, /forbidden/);

    // The declared-but-unprovisioned tool must point at that failure, NOT at the repo.
    const declared = messageFor(r.failures, "tool 'read_file'");
    assert.match(declared, /declared in config\/agentcontrol\/tools\/ but not provisioned/);
    assert.doesNotMatch(declared, /no such tool/);

    // A genuinely absent tool keeps the original message — the distinction is the point.
    const absent = messageFor(r.failures, "tool 'never-committed'");
    assert.match(absent, /no such tool in config\/agentcontrol\/tools\//);
  });

  it("attaches nothing when the library failed, rather than sending a version-less ref", async () => {
    const r = await provision(ldWithToolWritesDenied(403), dirs("norefs", "grep"));
    // Both tools unresolvable → the variation is created without a tools array,
    // never with `{key, version: undefined}`, which the API would reject.
    assert.equal(r.failures.filter((f) => String(f.resource).includes("tool '")).length, 2);
    assert.ok(r.configsCreated.includes("cfg-a"));
  });
});
