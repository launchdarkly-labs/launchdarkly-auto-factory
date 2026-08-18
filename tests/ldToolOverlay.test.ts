import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SANDBOX_TOOL_DEFS, applyLdToolOverlay, buildSandboxTools } from "@auto-factory/shared";

const FULL_CAPS = {
  createFlag: true, flagState: true, createMetric: true, editFiles: true,
  writeManifest: true, queryGraph: false, querySentry: false, readDocs: true,
};

describe("LD tool overlay (ADR 0011)", () => {
  it("registry covers every capability-buildable tool", () => {
    const built = buildSandboxTools({
      ...FULL_CAPS,
      queryGraph: true,
      querySentry: true,
      queryRepos: true,
    });
    for (const t of built) assert.ok(SANDBOX_TOOL_DEFS.has(t.name), `registry missing ${t.name}`);
    assert.equal(SANDBOX_TOOL_DEFS.size, 20);
  });

  it("no attachments → built-in defaults, unchanged (pre-tools projects)", () => {
    const defs = buildSandboxTools(FULL_CAPS);
    const r = applyLdToolOverlay(defs, undefined);
    assert.deepEqual(r.tools, defs);
    assert.deepEqual(r.unknown, []);
    const r2 = applyLdToolOverlay(defs, {});
    assert.deepEqual(r2.tools, defs);
  });

  it("attachments RESTRICT the offering within the capability ceiling", () => {
    const defs = buildSandboxTools(FULL_CAPS);
    const r = applyLdToolOverlay(defs, {
      read_file: { name: "read_file" },
      grep: { name: "grep" },
      create_flag: { name: "create_flag" },
    });
    const names = r.tools.map((t) => t.name).sort();
    // restricted to attached ∪ tag_conversation; everything else dropped
    assert.deepEqual(names, ["create_flag", "grep", "read_file", "tag_conversation"]);
  });

  it("attachments can NOT broaden past the capability ceiling", () => {
    // read-only caps: create_flag is attached in LD but not capability-granted
    const defs = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false });
    const r = applyLdToolOverlay(defs, { read_file: {}, create_flag: {} });
    assert.ok(!r.tools.some((t) => t.name === "create_flag"));
    assert.ok(r.tools.some((t) => t.name === "read_file"));
  });

  it("LD description and schema override the built-ins", () => {
    const defs = buildSandboxTools(FULL_CAPS);
    const r = applyLdToolOverlay(defs, {
      read_file: {
        description: "LD-authored description",
        parameters: { type: "object", properties: { path: { type: "string" }, extra: { type: "number" } } },
      },
      grep: { name: "grep" }, // attached with no overrides → built-in def kept
    });
    const readFile = r.tools.find((t) => t.name === "read_file");
    assert.equal(readFile?.description, "LD-authored description");
    assert.ok((readFile?.input_schema.properties as Record<string, unknown>).extra);
    const grep = r.tools.find((t) => t.name === "grep");
    assert.equal(grep?.description, SANDBOX_TOOL_DEFS.get("grep")?.description);
  });

  it("ignores schema-shaped garbage, reports unimplemented attachments", () => {
    const defs = buildSandboxTools(FULL_CAPS);
    const r = applyLdToolOverlay(defs, {
      read_file: { parameters: { bogus: true } }, // no properties/type → built-in schema kept
      totally_new_tool: { description: "no local implementation" },
    });
    const readFile = r.tools.find((t) => t.name === "read_file");
    assert.deepEqual(readFile?.input_schema, SANDBOX_TOOL_DEFS.get("read_file")?.input_schema);
    assert.deepEqual(r.unknown, ["totally_new_tool"]);
    assert.ok(!r.tools.some((t) => t.name === "totally_new_tool"));
  });

  it("tag_conversation survives any restriction (chain routing depends on it)", () => {
    const defs = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false });
    const r = applyLdToolOverlay(defs, { read_file: {} });
    assert.ok(r.tools.some((t) => t.name === "tag_conversation"));
  });
});
