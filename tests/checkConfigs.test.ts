import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Repo root is one level up from tests/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(repoRoot, "scripts/check-configs.mjs");

/** Run the guard; return { code, out }. */
function runChecker(): { code: number; out: string } {
  try {
    const out = execFileSync("node", [script], { cwd: repoRoot, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("check-configs (routing-contract guard, issue #9)", () => {
  it("passes against the committed agent configs + graph", () => {
    const { code, out } = runChecker();
    assert.equal(code, 0, `check-configs failed:\n${out}`);
    assert.match(out, /passed/);
  });

  it("catches the invalid tag_conversation(key=…, value=…) signature", () => {
    // Failure-mode #1 from the issue: instructions calling the tool with the
    // wrong signature emit no tags. The guard's regex must flag that form.
    const bad = 'tag_conversation(key="needs_tests", value="true")';
    assert.match(bad, /tag_conversation\(\s*key\b[^)]*\)/);
    const good = 'tag_conversation({"tags": {"needs_tests": "true"}})';
    assert.doesNotMatch(good, /tag_conversation\(\s*key\b[^)]*\)/);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 Step 3 — the judge-loop config rules (6d/6e). These run the real
// checker against a COPY of config/ in a temp dir, so a mutated graph can be
// tested without ever touching the committed files.
// ---------------------------------------------------------------------------
describe("check-configs — judge loop edges (6d/6e)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A sandbox with the repo's config + the one source file check 6c reads. */
  function sandbox(
    mutate: (graph: { edges: Array<Record<string, unknown>> }) => void,
    mutateRegistry?: (tags: Record<string, { edges?: Array<Record<string, string>> }>) => void,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "af-checkcfg-"));
    dirs.push(dir);
    cpSync(resolve(repoRoot, "config"), join(dir, "config"), { recursive: true });
    const walker = join(dir, "packages/shared/src");
    mkdirSync(walker, { recursive: true });
    cpSync(resolve(repoRoot, "packages/shared/src/graphWalker.ts"), join(walker, "graphWalker.ts"));
    const graphPath = join(dir, "config/agentcontrol/graphs/auto-factory.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { edges: Array<Record<string, unknown>> };
    mutate(graph);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n");
    if (mutateRegistry) {
      const regPath = join(dir, "config/agentcontrol/tags.json");
      const reg = JSON.parse(readFileSync(regPath, "utf8")) as {
        tags: Record<string, { edges?: Array<Record<string, string>> }>;
      };
      mutateRegistry(reg.tags);
      writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");
    }
    return dir;
  }

  function runIn(dir: string): { code: number; out: string } {
    try {
      const out = execFileSync("node", [script], { cwd: dir, encoding: "utf8" });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  /** The committed judge loop edge (metrics-author self-loop). */
  const judgeEdge = (edges: Array<Record<string, unknown>>) =>
    edges.find((e) => e.sourceConfig === "autofactory-metrics-author" && e.targetConfig === "autofactory-metrics-author")!;

  it("the unmutated copy still passes (the sandbox is faithful)", () => {
    const { code, out } = runIn(sandbox(() => {}));
    assert.equal(code, 0, out);
  });

  it("rejects a loop_if_judge_below outside [0, 1]", () => {
    for (const bad of [1.5, -0.1]) {
      const { code, out } = runIn(sandbox((g) => {
        (judgeEdge(g.edges).handoff as Record<string, unknown>).loop_if_judge_below = bad;
      }));
      assert.equal(code, 1, `${bad} should fail`);
      assert.match(out, /loop_if_judge_below/);
    }
  });

  it("rejects a non-numeric loop_if_judge_below", () => {
    const { code, out } = runIn(sandbox((g) => {
      (judgeEdge(g.edges).handoff as Record<string, unknown>).loop_if_judge_below = "0.7";
    }));
    assert.equal(code, 1);
    assert.match(out, /must be a number/);
  });

  it("rejects a judge loop with no max_visits (it would run to the node-run cap)", () => {
    const { code, out } = runIn(sandbox((g) => {
      delete (judgeEdge(g.edges).handoff as Record<string, unknown>).max_visits;
    }));
    assert.equal(code, 1);
    assert.match(out, /unbudgeted quality loop/);
  });

  it("rejects a loop edge gating on a ROUTING tag its source cannot produce", () => {
    // The freshness rule matches a loop edge's routing conditions against the source
    // run's own tags, so gating on another node's llm tag is unsatisfiable — the loop
    // silently never fires. This turns that into a build failure.
    const { code, out } = runIn(sandbox((g) => {
      const loop = g.edges.find(
        (e) => e.sourceConfig === "autofactory-code-reviewer" && e.targetConfig === "autofactory-flag-implementer",
      )!;
      // `flag_worthy` is produced by the research planner, not the reviewer.
      (loop.handoff as Record<string, unknown>).require_tags = { review_approved: "false", flag_worthy: "true" };
    }));
    assert.equal(code, 1);
    assert.match(out, /flag_worthy/);
    assert.match(out, /produced by 'autofactory-research-planner'/);
    assert.match(out, /can never be satisfied/);
  });

  it("allows a loop edge gating on an upstream FACT tag", () => {
    // Fact tags are never rewound and legitimately come from other nodes, so this
    // must NOT be flagged — over-tightening here would break valid configs. The
    // registry edge is declared too, since check 2 requires that independently.
    const { code, out } = runIn(
      sandbox(
        (g) => {
          const loop = g.edges.find(
            (e) => e.sourceConfig === "autofactory-code-reviewer" && e.targetConfig === "autofactory-flag-implementer",
          )!;
          (loop.handoff as Record<string, unknown>).require_tags = { review_approved: "false", flag_ready: "true" };
        },
        (tags) => {
          (tags.flag_ready!.edges ??= []).push({
            from: "autofactory-code-reviewer",
            to: "autofactory-flag-implementer",
            kind: "require_tags",
          });
        },
      ),
    );
    assert.equal(code, 0, out);
  });

  it("rejects a PLAIN (non-judge) loop edge declared after another edge from the same node", () => {
    // The lint originally only covered judge edges, but a verdict loop is equally
    // killable: add a forward edge above the reviewer's loop and rework silently
    // never happens, with no runtime signal at all.
    const { code, out } = runIn(sandbox((g) => {
      const i = g.edges.findIndex((e) => e.sourceConfig === "autofactory-code-reviewer");
      g.edges.splice(i, 0, {
        key: "edge-reviewer-straight-to-testing",
        sourceConfig: "autofactory-code-reviewer",
        targetConfig: "autofactory-flag-testing",
        handoff: {},
      });
    }));
    assert.equal(code, 1);
    assert.match(out, /loop edge autofactory-code-reviewer → autofactory-flag-implementer/);
    assert.match(out, /declared AFTER another edge/);
  });

  it("rejects a judge loop declared AFTER another edge from the same node", () => {
    // The silent-failure hazard: the walker takes the first passing edge, so a
    // late-declared loop never fires. Caught at build time rather than in a run.
    const { code, out } = runIn(sandbox((g) => {
      const i = g.edges.indexOf(judgeEdge(g.edges));
      const [edge] = g.edges.splice(i, 1);
      g.edges.push(edge!); // move it to the very end
    }));
    assert.equal(code, 1);
    assert.match(out, /declared AFTER another edge/);
  });
});

// ---------------------------------------------------------------------------
describe("committed graph — judge loop shape", () => {
  it("declares the metrics-author self-loop BEFORE its forward edge", () => {
    // Order is authoritative (getEdges returns the raw served array), so this is
    // the difference between a working quality loop and dead config.
    const graph = JSON.parse(
      readFileSync(resolve(repoRoot, "config/agentcontrol/graphs/auto-factory.json"), "utf8"),
    ) as { edges: Array<{ sourceConfig: string; targetConfig: string; handoff?: Record<string, unknown> }> };
    const fromMetrics = graph.edges.filter((e) => e.sourceConfig === "autofactory-metrics-author");
    assert.equal(fromMetrics.length, 2, "self-loop + forward edge");
    assert.equal(fromMetrics[0]?.targetConfig, "autofactory-metrics-author", "the self-loop must come first");
    assert.equal(fromMetrics[0]?.handoff?.loop_if_judge_below, 0.7);
    assert.equal(fromMetrics[0]?.handoff?.max_visits, 1);
    assert.equal(fromMetrics[1]?.targetConfig, "autofactory-flag-testing");
  });
});
