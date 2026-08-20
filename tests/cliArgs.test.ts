import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXIT,
  WALK_STATE_VERSION,
  type WalkState,
  appendGrants,
  grantIsAbsorbedByCap,
  grantableEdges,
  parseArgs,
  validateGrants,
  validateWalkState,
} from "@auto-factory/phase1-cli";
import { loopBudgetBase } from "@auto-factory/shared";

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

  it("rejects --resume with --dry-run", () => {
    // A journal records a REAL walk that created real LaunchDarkly resources.
    // Replaying it under a no-writer frontier reports a verdict over mixed state.
    assert.match(err(["run", "--resume", "--dry-run"]), /cannot be combined with --dry-run/);
    assert.match(err(["run", "--dry-run", "--resume"]), /cannot be combined with --dry-run/);
  });

  it("rejects grants and feedback without --resume", () => {
    assert.match(err(["run", "--grant-visits", "a:b=1", "--feedback", "x"]), /only applies with --resume/);
    assert.match(err(["run", "--feedback", "x"]), /only applies with --resume/);
  });

  it("rejects the SAME edge granted twice rather than picking a semantic", () => {
    // Overwrite (what this did) and sum (what mergeGrants does across rounds) disagree, so
    // a repeat is refused instead of silently resolved one way.
    const e = err(["run", "--resume", "--feedback", "x", "--grant-visits", "a:b=1", "--grant-visits", "a:b=2"]);
    assert.match(e, /more than once/);
    assert.match(e, /a:b/);
  });

  it("still allows grants on DIFFERENT edges in one invocation", () => {
    const o = ok(["run", "--resume", "--feedback", "x", "--grant-visits", "a:b=1", "--grant-visits", "c:d=2"]);
    assert.deepEqual(o.grantVisits, { "a→b": 1, "c→d": 2 });
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
    base: "origin/main",
    baseSha: "base-sha-1",
    haltedAt: { kind: "pending-approval" as const, node: "n" },
    runs: [{ configKey: "n", status: "completed" as const, output: "o", tags: {}, iteration: 1 }],
    at: "2026-08-09T00:00:00.000Z",
  };
  const keys = {
    graphKey: "g",
    configStamp: "cfg123",
    head: "sha1",
    treeHash: "tree1",
    policyMode: "always",
    base: "origin/main",
    baseSha: "base-sha-1",
  };

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
  rejects(
    { baseSha: "base-sha-2" },
    /moved since the walk was saved/,
    "the base COMMIT moved under an unchanged ref name (origin/main after a fetch)",
  );
  rejects({ runs: [] }, /empty journal/, "the journal is empty");

  it("refuses when ANY key is unknown on either side, not just the tree hash", () => {
    // Fail-closed means "couldn't check" == "refuse". Previously only treeHash
    // enforced this while the doc claimed all of them did.
    for (const key of ["configStamp", "head", "policyMode", "base", "baseSha"] as const) {
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

// ---------------------------------------------------------------------------
// A grant may only target a loop edge whose exhaustion ENDED the saved walk. This is
// what keeps the walker's uniform application of prior grants correct — and the case
// below is the exact sequence a review found producing permanent divergence.
// ---------------------------------------------------------------------------
describe("resume grants are bounded to the halting edge", () => {
  const state = (haltedAt: WalkState["haltedAt"]): WalkState => ({
    version: WALK_STATE_VERSION,
    graphKey: "g",
    configStamp: "cfg",
    head: "sha",
    treeHash: "tree",
    policyMode: "always",
    base: "main",
    haltedAt,
    runs: [{ configKey: "n", status: "completed", output: "o", tags: {}, iteration: 1 }],
    at: "2026-08-10T00:00:00.000Z",
  });
  const exhausted = state({
    kind: "loop-exhausted",
    node: "autofactory-code-reviewer",
    exhaustedEdges: ["autofactory-code-reviewer→autofactory-flag-implementer"],
  });
  const gated = state({ kind: "pending-approval", node: "autofactory-flag-implementer" });

  it("allows a grant on the edge that ended the walk", () => {
    const r = validateGrants(exhausted, { "autofactory-code-reviewer→autofactory-flag-implementer": 1 });
    assert.equal(r.ok, true);
  });

  it("allows a resume with no grant at all, whatever the halt", () => {
    assert.equal(validateGrants(exhausted, {}).ok, true);
    assert.equal(validateGrants(gated, {}).ok, true);
  });

  it("REFUSES a grant when the walk halted at a gate — nothing was budget-blocked", () => {
    // The repro: an advisory loop spends its budget mid-walk and falls through, the walk
    // later halts at a gate, and the human grants the advisory edge because the run
    // warned about it. Previously accepted and persisted, which made every later resume
    // diverge with "the graph changed" — unrecoverable short of a fresh run.
    const r = validateGrants(gated, { "autofactory-metrics-author→autofactory-metrics-author": 1 });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /nothing to grant/);
    assert.match((r as { reason: string }).reason, /approval gate/);
  });

  it("REFUSES a grant on an edge other than the one that ended the walk, and says what is grantable", () => {
    const r = validateGrants(exhausted, { "autofactory-metrics-author→autofactory-metrics-author": 1 });
    assert.equal(r.ok, false);
    const reason = (r as { reason: string }).reason;
    // Message uses the CLI's own colon syntax so it can be copied straight back.
    assert.match(reason, /autofactory-metrics-author:autofactory-metrics-author/);
    assert.match(reason, /Grantable: autofactory-code-reviewer:autofactory-flag-implementer/);
    assert.match(reason, /cannot be topped up/);
  });

  it("REFUSES when one of several grants is ungrantable", () => {
    const r = validateGrants(exhausted, {
      "autofactory-code-reviewer→autofactory-flag-implementer": 1,
      "a→b": 1,
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /a:b/);
  });

  it("a pre-v3 halt (no exhaustedEdges) grants nothing rather than everything", () => {
    // Forward-degrades safely: an older journal can't justify a grant, so it refuses.
    const legacy = state({ kind: "loop-exhausted", node: "n" });
    assert.equal(validateGrants(legacy, { "a→b": 1 }).ok, false);
    assert.equal(grantableEdges(legacy).size, 0);
  });
});

describe("grant absorbed by the hard cap", () => {
  it("detects when a further grant cannot raise the ceiling", () => {
    // declared 2 + 8 already granted = 10 = the cap, so another grant is inert. The CLI
    // refuses it rather than replaying, doing nothing, and suggesting a grant again.
    const prior = [{ edge: "a→b", visits: 8, effectiveAfterRuns: 3 }];
    assert.equal(grantIsAbsorbedByCap(2, prior, "a→b", 10), true);
    assert.equal(grantIsAbsorbedByCap(1, prior, "a→b", 10), false, "1 + 8 = 9, still room");
  });

  it("uses the WALKER's budget base, so a sub-1 declared value does not disagree by one", () => {
    // The two used to be separate spellings of the same formula: the walker floors, and this
    // carried a `Math.max(1, …)` lower clamp it had dropped. For a served `max_visits: 0` with nine
    // prior grants the walker's rule gives a ceiling of 10 against ≤9 traversals — a grant DOES
    // unlock a traversal — while the clamped copy said the cap was already reached and the CLI
    // refused the resume with "already reached the hard cap".
    const nine = [{ edge: "a→b", visits: 9, effectiveAfterRuns: 0 }];
    assert.equal(grantIsAbsorbedByCap(0, nine, "a→b", 10), false, "0 + 9 = 9 < 10, so the grant is live");
    assert.equal(loopBudgetBase(0), 0, "and the base both sides share is the floor, not a clamp");
    assert.equal(loopBudgetBase(2.7), 2);
  });

  it("counts only grants for the edge in question", () => {
    const prior = [{ edge: "other→edge", visits: 9, effectiveAfterRuns: 0 }];
    assert.equal(grantIsAbsorbedByCap(1, prior, "a→b", 10), false);
  });

  it("treats no prior grants as room available", () => {
    assert.equal(grantIsAbsorbedByCap(1, undefined, "a→b", 10), false);
    assert.equal(grantIsAbsorbedByCap(10, undefined, "a→b", 10), true, "declared already at the cap");
  });
});

describe("appendGrants stamps the position a grant takes effect", () => {
  it("appends with the replayed journal length, preserving prior positions", () => {
    const prior = [{ edge: "a→b", visits: 1, effectiveAfterRuns: 4 }];
    assert.deepEqual(appendGrants(prior, { "a→b": 1, "c→d": 2 }, 9), [
      { edge: "a→b", visits: 1, effectiveAfterRuns: 4 },
      { edge: "a→b", visits: 1, effectiveAfterRuns: 9 },
      { edge: "c→d", visits: 2, effectiveAfterRuns: 9 },
    ]);
  });

  it("is a no-op when nothing new is granted", () => {
    assert.deepEqual(appendGrants(undefined, {}, 5), []);
  });
});
