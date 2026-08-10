import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXIT, WALK_STATE_VERSION, parseArgs, validateWalkState } from "@auto-factory/phase1-cli";

describe("autofactory CLI args", () => {
  it("defaults: graph, base, cwd root, no approvals, not dry-run", () => {
    const parsed = parseArgs(["run"], {});
    assert.ok("options" in parsed);
    assert.equal(parsed.options.graphKey, "gha-auto-factory");
    assert.equal(parsed.options.base, "main");
    assert.equal(parsed.options.root, process.cwd());
    assert.deepEqual(parsed.options.approve, []);
    assert.equal(parsed.options.dryRun, false);
  });

  it("env supplies GRAPH_KEY / PR_BASE_REF defaults; flags override env", () => {
    const fromEnv = parseArgs(["run"], { GRAPH_KEY: "my-graph", PR_BASE_REF: "develop" });
    assert.ok("options" in fromEnv);
    assert.equal(fromEnv.options.graphKey, "my-graph");
    assert.equal(fromEnv.options.base, "develop");

    const overridden = parseArgs(["run", "--graph", "other", "--base", "release"], { GRAPH_KEY: "my-graph" });
    assert.ok("options" in overridden);
    assert.equal(overridden.options.graphKey, "other");
    assert.equal(overridden.options.base, "release");
  });

  it("--approve repeats and accumulates in order", () => {
    const parsed = parseArgs(
      ["run", "--approve", "autofactory-flag-implementer", "--approve", "autofactory-metrics-author", "--dry-run"],
      {},
    );
    assert.ok("options" in parsed);
    assert.deepEqual(parsed.options.approve, ["autofactory-flag-implementer", "autofactory-metrics-author"]);
    assert.equal(parsed.options.dryRun, true);
  });

  it("value-taking flags reject a missing value (including a following --flag)", () => {
    for (const argv of [["run", "--approve"], ["run", "--graph"], ["run", "--approve", "--dry-run"]]) {
      const parsed = parseArgs(argv, {});
      assert.ok("error" in parsed, `expected error for: ${argv.join(" ")}`);
    }
  });

  it("unknown commands and options are usage errors; bare/-h is help", () => {
    assert.ok("error" in parseArgs(["deploy"], {}));
    assert.ok("error" in parseArgs(["run", "--yolo"], {}));
    assert.ok("help" in parseArgs([], {}));
    assert.ok("help" in parseArgs(["--help"], {}));
    assert.ok("help" in parseArgs(["run", "-h"], {}));
  });

  it("exit codes are distinct and pendingApproval is 3 (the skill contract)", () => {
    assert.equal(EXIT.PENDING_APPROVAL, 3);
    assert.equal(new Set(Object.values(EXIT)).size, Object.values(EXIT).length);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Step 2 — the resume surface. The guard rails matter more than the
// parsing: a budget grant with no guidance re-burns the same loop, so the CLI
// refuses it rather than obeying.
// ---------------------------------------------------------------------------
describe("autofactory CLI args — resume", () => {
  const ok = (argv: string[]) => {
    const r = parseArgs(argv, {});
    assert.ok("options" in r, `expected success, got ${JSON.stringify(r)}`);
    return (r as { options: import("@auto-factory/phase1-cli").CliOptions }).options;
  };
  const err = (argv: string[]) => {
    const r = parseArgs(argv, {});
    assert.ok("error" in r, `expected an error, got ${JSON.stringify(r)}`);
    return (r as { error: string }).error;
  };

  it("defaults to no resume, no grants, no feedback", () => {
    const o = ok(["run"]);
    assert.equal(o.resume, false);
    assert.deepEqual(o.grantVisits, {});
    assert.equal(o.feedback, undefined);
  });

  it("--resume alone is valid (replay past a gate needs no grant)", () => {
    assert.equal(ok(["run", "--resume", "--approve", "autofactory-flag-implementer"]).resume, true);
  });

  it("--grant-visits translates <source>:<target>=<n> to the walker's edge key", () => {
    const o = ok([
      "run", "--resume",
      "--grant-visits", "autofactory-code-reviewer:autofactory-flag-implementer=2",
      "--feedback", "narrow the flag",
    ]);
    assert.deepEqual(o.grantVisits, { "autofactory-code-reviewer→autofactory-flag-implementer": 2 });
    assert.equal(o.feedback, "narrow the flag");
  });

  it("REFUSES a budget grant with no feedback", () => {
    // The whole point of resuming an exhausted loop is new information; budget
    // alone reproduces the same failure deterministically.
    assert.match(err(["run", "--resume", "--grant-visits", "a:b=1"]), /requires --feedback/);
  });

  it("rejects grants and feedback without --resume", () => {
    assert.match(err(["run", "--grant-visits", "a:b=1", "--feedback", "x"]), /only applies with --resume/);
    assert.match(err(["run", "--feedback", "x"]), /only applies with --resume/);
  });

  it("rejects malformed grants rather than silently ignoring them", () => {
    for (const bad of ["ab=1", "a:b", "a:b=0", "a:b=x", "a:b=c=1"]) {
      assert.match(err(["run", "--resume", "--feedback", "x", "--grant-visits", bad]), /--grant-visits/, bad);
    }
  });
});

describe("walk state validation (fail-closed)", () => {
  const base = {
    version: WALK_STATE_VERSION,
    graphKey: "g",
    configStamp: "cfg123",
    head: "sha1",
    treeHash: "tree1",
    policyMode: "always",
    base: "main",
    haltedAt: { kind: "pending-approval" as const, node: "n" },
    runs: [{ configKey: "n", status: "completed" as const, output: "o", tags: {}, iteration: 1 }],
    at: "2026-08-09T00:00:00.000Z",
  };
  const keys = { graphKey: "g", configStamp: "cfg123", head: "sha1", treeHash: "tree1", policyMode: "always", base: "main" };

  it("accepts a state whose every key matches", () => {
    const r = validateWalkState(base, keys);
    assert.equal(r.ok, true);
  });

  it("refuses when there is nothing saved", () => {
    const r = validateWalkState(undefined, keys);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /nothing to resume/);
  });

  const rejects = (patch: Record<string, unknown>, pattern: RegExp, label: string) => {
    it(`refuses when ${label}`, () => {
      const r = validateWalkState({ ...base, ...patch }, keys);
      assert.equal(r.ok, false, label);
      assert.match((r as { reason: string }).reason, pattern);
    });
  };

  rejects({ version: WALK_STATE_VERSION + 1 }, /version/, "the schema version differs");
  rejects({ graphKey: "other" }, /graph/, "it was recorded against another graph");
  rejects({ configStamp: "different" }, /configs changed/, "the agent configs changed");
  rejects({ head: "sha2" }, /HEAD moved/, "HEAD moved");
  rejects({ treeHash: "tree2" }, /working tree changed/, "the working tree changed");
  rejects({ policyMode: "yolo" }, /approval policy changed/, "the approval policy changed");
  rejects({ base: "develop" }, /base ref changed/, "the base ref changed — a different diff entirely");
  rejects({ runs: [] }, /empty journal/, "the journal is empty");

  it("refuses when ANY key is unknown on either side, not just the tree hash", () => {
    // Fail-closed means "couldn't check" == "refuse". Previously only treeHash
    // enforced this while the doc claimed all of them did.
    for (const key of ["configStamp", "head", "policyMode", "base"] as const) {
      const missingStored = validateWalkState({ ...base, [key]: undefined }, keys);
      assert.equal(missingStored.ok, false, `stored ${key} missing`);
      assert.match((missingStored as { reason: string }).reason, /could not (verify|determine)/, key);
      const missingCurrent = validateWalkState(base, { ...keys, [key]: undefined });
      assert.equal(missingCurrent.ok, false, `current ${key} missing`);
      assert.match((missingCurrent as { reason: string }).reason, /could not (verify|determine)/, key);
    }
  });

  it("refuses when the tree hash is UNKNOWN on either side (never assumes 'unchanged')", () => {
    // The dangerous case: git could not answer. Skipping the check here would
    // replay recorded work against file contents nobody verified.
    const noStored = validateWalkState({ ...base, treeHash: undefined }, keys);
    assert.equal(noStored.ok, false);
    assert.match((noStored as { reason: string }).reason, /could not verify/);
    const noCurrent = validateWalkState(base, { ...keys, treeHash: undefined });
    assert.equal(noCurrent.ok, false);
    assert.match((noCurrent as { reason: string }).reason, /could not verify/);
  });
});

describe("autofactory CLI args — --flag=value", () => {
  const ok = (argv: string[]) => {
    const r = parseArgs(argv, {});
    assert.ok("options" in r, `expected success, got ${JSON.stringify(r)}`);
    return (r as { options: import("@auto-factory/phase1-cli").CliOptions }).options;
  };
  const err = (argv: string[]) => {
    const r = parseArgs(argv, {});
    assert.ok("error" in r, `expected an error, got ${JSON.stringify(r)}`);
    return (r as { error: string }).error;
  };

  it("carries feedback text that STARTS WITH A DASH", () => {
    // The space form can't express this — the parser reads a leading `--` as the
    // next option — and freeform human prose is exactly where that bites.
    const o = ok(["run", "--resume", "--feedback=--use the existing flag, don't create one"]);
    assert.equal(o.feedback, "--use the existing flag, don't create one");
    assert.equal(o.resume, true);
  });

  it("works for every value-taking option", () => {
    const o = ok(["run", "--graph=g1", "--base=develop", "--approve=node-a", "--root=/tmp/x"]);
    assert.equal(o.graphKey, "g1");
    assert.equal(o.base, "develop");
    assert.deepEqual(o.approve, ["node-a"]);
    assert.equal(o.root, "/tmp/x");
  });

  it("still validates the value", () => {
    assert.match(err(["run", "--graph="]), /requires a graph key/);
    assert.match(err(["run", "--resume", "--feedback=x", "--grant-visits=bogus"]), /--grant-visits/);
  });

  it("rejects a value on a boolean flag instead of ignoring it", () => {
    assert.match(err(["run", "--dry-run=true"]), /takes no value/);
    assert.match(err(["run", "--resume=yes"]), /takes no value/);
  });

  it("the space form still works", () => {
    const o = ok(["run", "--graph", "g2", "--resume", "--feedback", "narrow the flag"]);
    assert.equal(o.graphKey, "g2");
    assert.equal(o.feedback, "narrow the flag");
  });
});
