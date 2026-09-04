import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXIT, parseArgs } from "@auto-factory/phase1-cli";

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

  it("intake: requires --issue, accepts its options, and reports as { intake }", () => {
    const parsed = parseArgs(["intake", "--issue", "#12", "--repo", "o/r", "--draft", "--pr-label", "autofactory", "--no-pr", "--base", "dev"], {});
    assert.ok("intake" in parsed);
    assert.equal(parsed.intake.command, "intake");
    assert.equal(parsed.intake.issue, 12);
    assert.equal(parsed.intake.repo, "o/r");
    assert.equal(parsed.intake.node, "autofactory-issue-coder");
    assert.equal(parsed.intake.graphKey, "gha-auto-factory");
    assert.equal(parsed.intake.base, "dev");
    assert.equal(parsed.intake.draft, true);
    assert.equal(parsed.intake.prLabel, "autofactory");
    assert.equal(parsed.intake.noPr, true);
    assert.equal(parsed.intake.dryRun, false);

    const fromEnv = parseArgs(["intake", "--issue", "3"], { INTAKE_NODE: "my-coder", GRAPH_KEY: "g" });
    assert.ok("intake" in fromEnv);
    assert.equal(fromEnv.intake.node, "my-coder");
    assert.equal(fromEnv.intake.graphKey, "g");

    for (const argv of [["intake"], ["intake", "--issue"], ["intake", "--issue", "0"], ["intake", "--issue", "x"], ["intake", "--issue", "1", "--repo", "bad"], ["intake", "--issue", "1", "--yolo"]]) {
      assert.ok("error" in parseArgs(argv, {}), `expected error for: ${argv.join(" ")}`);
    }
    assert.ok("help" in parseArgs(["intake", "-h"], {}));
  });

  it("exit codes are distinct and pendingApproval is 3 (the skill contract)", () => {
    assert.equal(EXIT.PENDING_APPROVAL, 3);
    assert.equal(new Set(Object.values(EXIT)).size, Object.values(EXIT).length);
  });
});
