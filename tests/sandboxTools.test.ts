import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  SandboxToolExecutor,
  buildSandboxTools,
  type CreateFlagArgs,
  type CreateMetricArgs,
  type LdResourceWriter,
  type LdWriteResult,
} from "@auto-factory/shared";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "hello world\nsecond line\n");
  writeFileSync(join(root, "sub", "b.txt"), "nested needle here\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SandboxToolExecutor — read-only happy paths", () => {
  it("read_file returns file contents", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("read_file", { path: "a.txt" });
    assert.equal(r.isError, undefined);
    assert.match(r.content, /hello world/);
  });

  it("list_dir lists entries with trailing slash on dirs", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("list_dir", { path: "." });
    assert.match(r.content, /a\.txt/);
    assert.match(r.content, /sub\//);
  });

  it("grep finds matches across nested dirs and reports file:line", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("grep", { pattern: "needle" });
    assert.match(r.content, /sub\/b\.txt:1/);
  });

  it("unknown tool name is an error result, not a throw", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("nope", {});
    assert.equal(r.isError, true);
    assert.match(r.content, /Unknown tool/);
  });
});

describe("SandboxToolExecutor — sandbox escape rejection", () => {
  it("allows the root itself and descendants", async () => {
    const exec = new SandboxToolExecutor(root);
    assert.equal((await exec.execute("list_dir", { path: "." })).isError, undefined);
    assert.equal((await exec.execute("read_file", { path: "sub/b.txt" })).isError, undefined);
  });

  it("rejects ../escape", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("read_file", { path: "../escape" });
    assert.equal(r.isError, true);
    assert.match(r.content, /outside the sandbox/);
  });

  it("rejects an absolute path outside the root", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("read_file", { path: "/etc/hosts" });
    assert.equal(r.isError, true);
    assert.match(r.content, /outside the sandbox/);
  });
});

describe("SandboxToolExecutor — tag accumulation", () => {
  it("tag_conversation records tags onto the executor", async () => {
    const exec = new SandboxToolExecutor(root);
    await exec.execute("tag_conversation", { tags: { review_approved: "approve", risk_level: "low" } });
    assert.deepEqual(exec.tags, { review_approved: "approve", risk_level: "low" });
  });

  it("accumulates across multiple calls", async () => {
    const exec = new SandboxToolExecutor(root);
    await exec.execute("tag_conversation", { tags: { a: "1" } });
    await exec.execute("tag_conversation", { tags: { b: "2" } });
    assert.deepEqual(exec.tags, { a: "1", b: "2" });
  });
});

describe("SandboxToolExecutor — capability gating", () => {
  it("write_file / edit_file are unavailable without allowEdits", async () => {
    const exec = new SandboxToolExecutor(root); // no writer, no edits
    assert.equal((await exec.execute("write_file", { path: "x.txt", content: "x" })).isError, true);
    assert.equal((await exec.execute("edit_file", { path: "a.txt", old_string: "hello", new_string: "hi" })).isError, true);
  });

  it("create_flag / create_metric are unavailable without a writer", async () => {
    const exec = new SandboxToolExecutor(root);
    const flag = await exec.execute("create_flag", { key: "x" });
    assert.equal(flag.isError, true);
    assert.match(flag.content, /not available/);
    const metric = await exec.execute("create_metric", { key: "x-error-rate", category: "error", event_key: "x-error" });
    assert.equal(metric.isError, true);
    assert.match(metric.content, /not available/);
  });

  it("buildSandboxTools offers only read-only tools by default", () => {
    const names = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false }).map((t) => t.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("git_diff"));
    assert.ok(!names.includes("create_flag"));
    assert.ok(!names.includes("create_metric"));
    assert.ok(!names.includes("write_file"));
    assert.ok(!names.includes("commit_and_push"));
  });

  it("buildSandboxTools adds gated tools when capabilities are granted", () => {
    const names = buildSandboxTools({ createFlag: true, createMetric: true, editFiles: true }).map((t) => t.name);
    assert.ok(names.includes("create_flag"));
    assert.ok(names.includes("create_metric"));
    assert.ok(names.includes("write_file"));
    assert.ok(names.includes("edit_file"));
    assert.ok(names.includes("run_tests"));
    assert.ok(names.includes("commit_and_push"));
  });

  it("createFlag grants the whole flag-action suite; flagState is separate", () => {
    const suite = buildSandboxTools({ createFlag: true, createMetric: false, editFiles: false }).map((t) => t.name);
    assert.ok(suite.includes("create_flag"));
    assert.ok(suite.includes("add_variation"));
    assert.ok(suite.includes("use_existing_flag"));
    assert.ok(!suite.includes("get_flag_state"));

    const readonly = buildSandboxTools({ createFlag: false, flagState: true, createMetric: false, editFiles: false }).map((t) => t.name);
    assert.ok(readonly.includes("get_flag_state"));
    assert.ok(!readonly.includes("create_flag"));
    assert.ok(!readonly.includes("add_variation"));
    assert.ok(!readonly.includes("use_existing_flag"));
  });

  it("create_metric is offered independently of create_flag", () => {
    const names = buildSandboxTools({ createFlag: false, createMetric: true, editFiles: true }).map((t) => t.name);
    assert.ok(names.includes("create_metric"));
    assert.ok(!names.includes("create_flag"));
  });
});

describe("SandboxToolExecutor — edit_file with edits enabled", () => {
  it("rejects a non-unique old_string", async () => {
    writeFileSync(join(root, "dup.txt"), "x\nx\n");
    const exec = new SandboxToolExecutor(root, undefined, true);
    const r = await exec.execute("edit_file", { path: "dup.txt", old_string: "x", new_string: "y" });
    assert.equal(r.isError, true);
    assert.match(r.content, /not unique/);
  });

  it("edits a unique substring", async () => {
    const exec = new SandboxToolExecutor(root, undefined, true);
    const r = await exec.execute("edit_file", { path: "a.txt", old_string: "hello world", new_string: "hi there" });
    assert.equal(r.isError, undefined);
    assert.match((await exec.execute("read_file", { path: "a.txt" })).content, /hi there/);
  });
});

describe("SandboxToolExecutor — create_flag fallback tagging", () => {
  it("sets flag_created/flag_ready/flag_key/flag_variation even when the agent doesn't tag", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async createFlag(args: CreateFlagArgs): Promise<LdWriteResult & { variation: string }> {
        return { created: true, alreadyExists: false, key: args.key, variation: "v1", detail: `created ${args.key}` };
      },
    } as unknown as LdResourceWriter;

    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("create_flag", { key: "enable-thing" });
    assert.equal(r.isError, undefined);
    assert.equal(exec.tags.flag_created, "true");
    assert.equal(exec.tags.flag_ready, "true");
    assert.equal(exec.tags.flag_key, "enable-thing");
    assert.equal(exec.tags.flag_variation, "v1");
  });

  it("409 reuse still advances the chain (flag_ready) but asserts no variation", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async createFlag(args: CreateFlagArgs): Promise<LdWriteResult & { variation: string }> {
        return { created: false, alreadyExists: true, key: args.key, variation: "v1", detail: "already exists" };
      },
    } as unknown as LdResourceWriter;

    const exec = new SandboxToolExecutor(root, fakeWriter);
    await exec.execute("create_flag", { key: "enable-thing" });
    assert.equal(exec.tags.flag_ready, "true");
    assert.equal(exec.tags.flag_created, "true");
    // The existing flag may have iterated past v1 — don't claim a variation blindly.
    assert.equal(exec.tags.flag_variation, undefined);
  });
});

describe("SandboxToolExecutor — add_variation", () => {
  it("unavailable without a writer", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("add_variation", { key: "enable-x" });
    assert.equal(r.isError, true);
    assert.match(r.content, /not available/);
  });

  it("sets flag_ready/flag_key/flag_variation on success", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async addVariation(key: string, opts: { value?: string }): Promise<LdWriteResult & { variation: string }> {
        return { created: true, alreadyExists: false, key, variation: opts.value ?? "v2", detail: "added v2" };
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("add_variation", { key: "enable-x", value: "v2" });
    assert.equal(r.isError, undefined);
    assert.equal(exec.tags.flag_ready, "true");
    assert.equal(exec.tags.flag_key, "enable-x");
    assert.equal(exec.tags.flag_variation, "v2");
  });

  it("a legacy-boolean error surfaces as a tool error with NO tags set", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async addVariation(): Promise<never> {
        throw new Error("'enable-x' is a legacy BOOLEAN flag — LaunchDarkly cannot add variations to it.");
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("add_variation", { key: "enable-x" });
    assert.equal(r.isError, true);
    assert.match(r.content, /legacy BOOLEAN/);
    assert.equal(exec.tags.flag_ready, undefined);
  });
});

describe("SandboxToolExecutor — use_existing_flag", () => {
  const stateFor = (released: string[]) => ({
    exists: true,
    key: "enable-x",
    kind: "multivariate" as const,
    variations: [{ value: "control" }, { value: "v1" }],
    latestVariation: "v1",
    environments: {
      production: { on: released.length > 0, fallthroughServes: released, prerequisites: [], rulesServe: [], individualTargets: false, released },
    },
  });

  it("verifies an unreleased variation and sets the tool-owned tags", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async getFlagState() {
        return stateFor([]);
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("use_existing_flag", { key: "enable-x" });
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /NOT released/);
    assert.equal(exec.tags.flag_ready, "true");
    assert.equal(exec.tags.flag_key, "enable-x");
    assert.equal(exec.tags.flag_variation, "v1"); // defaulted to the lineage tip
  });

  it("REFUSES a released variation (would re-couple deploy with release)", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async getFlagState() {
        return stateFor(["v1"]);
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("use_existing_flag", { key: "enable-x", variation: "v1" });
    assert.equal(r.isError, true);
    assert.match(r.content, /RELEASED/);
    assert.equal(exec.tags.flag_ready, undefined);
  });

  it("errors on a missing flag and a missing variation", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async getFlagState() {
        return { exists: false, key: "nope", kind: "multivariate" as const, variations: [], environments: {} };
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const missing = await exec.execute("use_existing_flag", { key: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content, /does not exist/);

    const fakeWriter2 = {
      projectKey: "demo",
      async getFlagState() {
        return stateFor([]);
      },
    } as unknown as LdResourceWriter;
    const exec2 = new SandboxToolExecutor(root, fakeWriter2);
    const noVar = await exec2.execute("use_existing_flag", { key: "enable-x", variation: "v9" });
    assert.equal(noVar.isError, true);
    assert.match(noVar.content, /no variation 'v9'/);
  });
});

describe("SandboxToolExecutor — get_flag_state", () => {
  it("reports a missing flag as guidance, not an error", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async getFlagState(key: string) {
        return { exists: false, key, kind: "multivariate" as const, variations: [], environments: {} };
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("get_flag_state", { key: "enable-new" });
    assert.equal(r.isError, undefined);
    assert.match(r.content, /does not exist/);
  });

  it("includes per-variation released-ness verdicts and sets no tags", async () => {
    const fakeWriter = {
      projectKey: "demo",
      async getFlagState() {
        return {
          exists: true,
          key: "enable-x",
          kind: "multivariate" as const,
          variations: [{ value: "control" }, { value: "v1" }],
          latestVariation: "v1",
          environments: {
            production: { on: true, fallthroughServes: ["v1"], prerequisites: [], rulesServe: [], individualTargets: false, released: ["v1"] },
          },
        };
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, fakeWriter);
    const r = await exec.execute("get_flag_state", { key: "enable-x" });
    assert.equal(r.isError, undefined);
    assert.match(r.content, /v1: RELEASED/);
    assert.deepEqual(exec.tags, {});
  });
});

describe("SandboxToolExecutor — commit_and_push gitMode", () => {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  function initRepo(): void {
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "initial"]);
  }

  it("workingTree mode reports changed files without committing them", async () => {
    initRepo();
    const exec = new SandboxToolExecutor(root, undefined, true, undefined, undefined, "workingTree");
    // An agent edit lands in the working tree.
    await exec.execute("write_file", { path: "feature.txt", content: "new behavior\n" });

    const before = git(["rev-parse", "HEAD"]).trim();
    const r = await exec.execute("commit_and_push", { message: "feat: wire flag" });
    const after = git(["rev-parse", "HEAD"]).trim();

    assert.equal(r.isError, undefined);
    assert.match(r.content, /working tree for review/);
    assert.equal(before, after, "HEAD must not move in workingTree mode");
    // The change is still present, uncommitted.
    assert.match(git(["status", "--porcelain"]), /feature\.txt/);
  });

  it("workingTree mode reports cleanly when nothing changed", async () => {
    initRepo();
    const exec = new SandboxToolExecutor(root, undefined, true, undefined, undefined, "workingTree");
    const r = await exec.execute("commit_and_push", { message: "noop" });
    assert.equal(r.isError, undefined);
    assert.match(r.content, /No file changes/);
  });
});

describe("SandboxToolExecutor — create_metric", () => {
  const fakeWriter = () => {
    const calls: CreateMetricArgs[] = [];
    const writer = {
      projectKey: "demo",
      async createMetric(args: CreateMetricArgs): Promise<LdWriteResult> {
        calls.push(args);
        return { created: true, alreadyExists: false, key: args.key, detail: `created ${args.key}` };
      },
    } as unknown as LdResourceWriter;
    return { writer, calls };
  };

  it("sets metrics_created + accumulates metric_keys across calls", async () => {
    const { writer } = fakeWriter();
    const exec = new SandboxToolExecutor(root, writer);
    await exec.execute("create_metric", { key: "f-error-rate", category: "error", event_key: "f-error" });
    await exec.execute("create_metric", { key: "f-latency", category: "latency", event_key: "f-latency" });
    assert.equal(exec.tags.metrics_created, "true");
    assert.equal(exec.tags.metric_keys, "f-error-rate,f-latency");
  });

  it("passes the parsed args through to the writer", async () => {
    const { writer, calls } = fakeWriter();
    const exec = new SandboxToolExecutor(root, writer);
    await exec.execute("create_metric", {
      key: "f-success",
      category: "business",
      event_key: "f-success",
      randomization_unit: "account",
    });
    assert.equal(calls[0]?.category, "business");
    assert.equal(calls[0]?.eventKey, "f-success");
    assert.equal(calls[0]?.randomizationUnit, "account");
  });

  it("rejects an invalid category before calling the writer", async () => {
    const { writer, calls } = fakeWriter();
    const exec = new SandboxToolExecutor(root, writer);
    const r = await exec.execute("create_metric", { key: "f-x", category: "throughput", event_key: "f-x" });
    assert.equal(r.isError, true);
    assert.match(r.content, /category must be one of/);
    assert.equal(calls.length, 0);
  });
});

describe("SandboxToolExecutor — tag_conversation tool-owned tags", () => {
  it("records decision tags the agent sets", async () => {
    const exec = new SandboxToolExecutor(root);
    await exec.execute("tag_conversation", { tags: { flag_worthy: "true", risk_level: "low" } });
    assert.equal(exec.tags.flag_worthy, "true");
    assert.equal(exec.tags.risk_level, "low");
  });

  it("ignores agent-set side-effect tags (can't fake flag_ready/flag_created/metrics_created)", async () => {
    const exec = new SandboxToolExecutor(root);
    const r = await exec.execute("tag_conversation", {
      tags: {
        flag_created: "true",
        flag_ready: "true",
        flag_key: "enable-x",
        flag_variation: "v2",
        metrics_created: "true",
        metric_keys: "x-error",
        needs_tests: "true",
      },
    });
    // Side-effect tags stripped; only the decision tag survives.
    assert.equal(exec.tags.flag_created, undefined);
    assert.equal(exec.tags.flag_ready, undefined);
    assert.equal(exec.tags.flag_key, undefined);
    assert.equal(exec.tags.flag_variation, undefined);
    assert.equal(exec.tags.metrics_created, undefined);
    assert.equal(exec.tags.metric_keys, undefined);
    assert.equal(exec.tags.needs_tests, "true");
    assert.match(r.content, /Ignored \[/);
  });

  it("still lets the create_flag tool set flag_created on a real success", async () => {
    const writer = {
      projectKey: "app",
      async createFlag(args: CreateFlagArgs): Promise<LdWriteResult & { variation: string }> {
        return { created: true, alreadyExists: false, key: args.key, variation: "v1", detail: "created" };
      },
    } as unknown as LdResourceWriter;
    const exec = new SandboxToolExecutor(root, writer);
    await exec.execute("create_flag", { key: "enable-x" });
    assert.equal(exec.tags.flag_created, "true");
    assert.equal(exec.tags.flag_key, "enable-x");
  });
});

describe("SandboxToolExecutor — write_file content guards", () => {
  it("refuses empty content (the 0-byte release-manifest bug)", async () => {
    const exec = new SandboxToolExecutor(root, undefined, true);
    for (const content of ["", "   \n"]) {
      const r = await exec.execute("write_file", { path: "config/settings.json", content });
      assert.equal(r.isError, true);
      assert.match(r.content, /refusing to write empty content/);
    }
  });

  it("rejects invalid JSON written to a .json path", async () => {
    const exec = new SandboxToolExecutor(root, undefined, true);
    const r = await exec.execute("write_file", { path: "config/settings.json", content: "{not json" });
    assert.equal(r.isError, true);
    assert.match(r.content, /not valid JSON/);
  });

  it("accepts valid JSON and non-JSON files as before", async () => {
    const exec = new SandboxToolExecutor(root, undefined, true);
    const ok = await exec.execute("write_file", { path: "config/settings.json", content: '{"flagKey":"x"}' });
    assert.equal(ok.isError, undefined);
    const txt = await exec.execute("write_file", { path: "notes.txt", content: "not json, fine here" });
    assert.equal(txt.isError, undefined);
  });
});

describe("SandboxToolExecutor — write_manifest", () => {
  const PATH = ".release-flags/pr-9.json";
  // workingTree mode: no git needed; file writes land uncommitted.
  const steward = () => new SandboxToolExecutor(root, undefined, false, undefined, undefined, "workingTree", false, true);
  const agent = () => new SandboxToolExecutor(root, undefined, false, undefined, undefined, "workingTree", true, false);
  const readManifest = () => JSON.parse(readFileSync(join(root, PATH), "utf8"));

  it("unavailable without the capability", async () => {
    const exec = new SandboxToolExecutor(root, undefined, true); // editFiles only
    const r = await exec.execute("write_manifest", { path: PATH, manifest: { flagKey: "x" } });
    assert.equal(r.isError, true);
  });

  it("creates schema-1.2 manifest and injects the human-editable intent skeleton", async () => {
    const r = await agent().execute("write_manifest", {
      path: PATH,
      manifest: { flagKey: "enable-x", scope: "backend", releasePlan: { randomizationUnit: "user" } },
    });
    assert.equal(r.isError, undefined, r.content);
    const m = readManifest();
    assert.equal(m.schemaVersion, "1.2");
    assert.equal(m.flagKey, "enable-x");
    assert.equal(m.releasePlan.randomizationUnit, "user");
    assert.equal(m.releaseIntent.action, "auto");
    assert.match(m.releaseIntent._instructions, /Human approver/);
  });

  it("agents cannot overwrite an existing releaseIntent (human-owned)", async () => {
    await agent().execute("write_manifest", { path: PATH, manifest: { flagKey: "enable-x" } });
    // Simulate the human's edit.
    const m = readManifest();
    m.releaseIntent = { action: "hold", notes: "after Q3" };
    writeFileSync(join(root, PATH), JSON.stringify(m));
    // Agent write with an intent — ignored; other fields merge.
    const r = await agent().execute("write_manifest", {
      path: PATH,
      manifest: { flagKey: "enable-x-final", releaseIntent: { action: "auto" } },
    });
    assert.match(r.content, /PRESERVED/);
    const after = readManifest();
    assert.equal(after.flagKey, "enable-x-final");
    assert.equal(after.releaseIntent.action, "hold");
    assert.equal(after.releaseIntent.notes, "after Q3");
  });

  it("the steward MAY update an existing releaseIntent", async () => {
    await agent().execute("write_manifest", { path: PATH, manifest: { flagKey: "enable-x" } });
    const r = await steward().execute("write_manifest", {
      path: PATH,
      manifest: { releaseIntent: { action: "hold", notBefore: "2026-08-01", notes: "" } },
    });
    assert.match(r.content, /releaseIntent updated \(steward\)/);
    assert.equal(readManifest().releaseIntent.action, "hold");
  });

  it("heals the legacy releaseOverrides key into releasePlan", async () => {
    mkdirSync(join(root, ".release-flags"), { recursive: true });
    writeFileSync(join(root, PATH), JSON.stringify({ flagKey: "old", releaseOverrides: { metricKeys: ["m1"] } }));
    await agent().execute("write_manifest", { path: PATH, manifest: { releasePlan: { randomizationUnit: "user" } } });
    const m = readManifest();
    assert.deepEqual(m.releasePlan, { metricKeys: ["m1"], randomizationUnit: "user" });
    assert.equal(m.releaseOverrides, undefined);
  });

  it("rejects non-manifest paths", async () => {
    const r = await agent().execute("write_manifest", { path: "backend/app.py", manifest: { flagKey: "x" } });
    assert.equal(r.isError, true);
  });

  it("write_file/edit_file refuse .release-flags/ paths", async () => {
    const exec = new SandboxToolExecutor(root, undefined, true);
    const w = await exec.execute("write_file", { path: PATH, content: '{"flagKey":"x"}' });
    assert.equal(w.isError, true);
    assert.match(w.content, /write_manifest/);
    mkdirSync(join(root, ".release-flags"), { recursive: true });
    writeFileSync(join(root, PATH), '{"flagKey":"x"}');
    const e = await exec.execute("edit_file", { path: PATH, old_string: "x", new_string: "y" });
    assert.equal(e.isError, true);
  });

  it("humanInput: agent sets the question; the answer is human-owned and preserved (M14)", async () => {
    // Agent pauses: writes the question.
    const r1 = await agent().execute("write_manifest", {
      path: PATH,
      manifest: { flagKey: "enable-x", humanInput: { question: "Does the collector forward traces to LD?" } },
    });
    assert.equal(r1.isError, undefined, r1.content);
    assert.match(r1.content, /awaiting a human answer/);
    assert.equal(readManifest().humanInput.question, "Does the collector forward traces to LD?");

    // Simulate the human's answer.
    const m = readManifest();
    m.humanInput.answer = "yes — otel-collector.yaml exports to LD";
    writeFileSync(join(root, PATH), JSON.stringify(m));

    // A later agent write cannot clear or overwrite the answer — even when it
    // passes its own humanInput (question updates, answer survives).
    const r2 = await agent().execute("write_manifest", {
      path: PATH,
      manifest: { scope: "backend", humanInput: { question: "updated q", answer: "agent-forged answer" } },
    });
    assert.match(r2.content, /PRESERVED/);
    const after = readManifest();
    assert.equal(after.humanInput.question, "updated q");
    assert.equal(after.humanInput.answer, "yes — otel-collector.yaml exports to LD");
    assert.equal(after.scope, "backend");
  });

  it("humanInput survives unrelated agent writes untouched", async () => {
    mkdirSync(join(root, ".release-flags"), { recursive: true });
    writeFileSync(
      join(root, PATH),
      JSON.stringify({ flagKey: "x", humanInput: { question: "q?", answer: "use track()" } }),
    );
    const r = await agent().execute("write_manifest", {
      path: PATH,
      manifest: { releasePlan: { metricKeys: ["m1"] } },
    });
    assert.equal(r.isError, undefined, r.content);
    const m = readManifest();
    assert.deepEqual(m.humanInput, { question: "q?", answer: "use track()" });
    assert.deepEqual(m.releasePlan.metricKeys, ["m1"]);
  });

  it("reports intent issues informationally without blocking the write", async () => {
    mkdirSync(join(root, ".release-flags"), { recursive: true });
    writeFileSync(join(root, PATH), JSON.stringify({ flagKey: "x", releaseIntent: { action: "banana" } }));
    const r = await agent().execute("write_manifest", { path: PATH, manifest: { scope: "backend" } });
    assert.equal(r.isError, undefined);
    assert.match(r.content, /Intent issues/);
  });
});

describe("SandboxToolExecutor — create_flag scope", () => {
  class RecordingWriter {
    lastArgs: CreateFlagArgs | undefined;
    async createFlag(args: CreateFlagArgs): Promise<LdWriteResult & { variation: string }> {
      this.lastArgs = args;
      return { created: true, alreadyExists: false, key: args.key, variation: "v1", detail: "ok" };
    }
    async createMetric(_args: CreateMetricArgs): Promise<LdWriteResult> {
      throw new Error("unused");
    }
    get projectKey() {
      return "demo";
    }
  }

  it("reads frontend scope from the sole release manifest when scope is omitted", async () => {
    mkdirSync(join(root, ".release-flags"), { recursive: true });
    writeFileSync(
      join(root, ".release-flags/pr-9.json"),
      JSON.stringify({ flagKey: "enable-x", scope: "frontend" }),
    );
    const writer = new RecordingWriter();
    const exec = new SandboxToolExecutor(root, writer as unknown as LdResourceWriter);
    const r = await exec.execute("create_flag", { key: "enable-x" });
    assert.equal(r.isError, undefined);
    assert.equal(writer.lastArgs?.scope, "frontend");
  });

  it("honors an explicit backend scope over the manifest", async () => {
    mkdirSync(join(root, ".release-flags"), { recursive: true });
    writeFileSync(
      join(root, ".release-flags/pr-9.json"),
      JSON.stringify({ flagKey: "enable-x", scope: "frontend" }),
    );
    const writer = new RecordingWriter();
    const exec = new SandboxToolExecutor(root, writer as unknown as LdResourceWriter);
    await exec.execute("create_flag", { key: "enable-x", scope: "backend" });
    assert.equal(writer.lastArgs?.scope, "backend");
  });
});

describe("SandboxToolExecutor — run_tests no-harness detection", () => {
  const editingExec = () => new SandboxToolExecutor(root, undefined, true);

  it("no recognized setup at all → inconclusive, tests_last_run NOT set", async () => {
    const exec = editingExec();
    const r = await exec.execute("run_tests", {});
    assert.equal(r.isError, true);
    assert.match(r.content, /no recognized test setup/);
    assert.equal(exec.tags.tests_last_run, undefined);
  });

  it("package.json without a test script → no harness, tests_last_run NOT set", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { start: "node server.js" } }));
    const exec = editingExec();
    const r = await exec.execute("run_tests", {});
    assert.equal(r.isError, true);
    assert.match(r.content, /no test harness/);
    assert.equal(exec.tags.tests_last_run, undefined);
  });

  it("npm's default 'no test specified' stub counts as no harness", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    const exec = editingExec();
    const r = await exec.execute("run_tests", {});
    assert.equal(r.isError, true);
    assert.match(r.content, /no test harness/);
    assert.equal(exec.tags.tests_last_run, undefined);
  });

  it("a real passing test script → tests_last_run=pass", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "exit 0" } }));
    const exec = editingExec();
    const r = await exec.execute("run_tests", {});
    assert.ok(!r.isError);
    assert.equal(exec.tags.tests_last_run, "pass");
  });

  it("a real failing test script → tests_last_run=fail", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "exit 1" } }));
    const exec = editingExec();
    const r = await exec.execute("run_tests", {});
    assert.equal(r.isError, true);
    assert.equal(exec.tags.tests_last_run, "fail");
  });
});
