/**
 * Phase 1 orchestration for the editor. This is the Cursor analog of the
 * Action's `main()`: same shared core (provider resolution, graph resolution,
 * graph walk, approval), different seams.
 *
 *  - Context comes from the working tree, not a PR.
 *  - The Anthropic runner uses gitMode "workingTree": the agents' edits land in
 *    the working tree for the developer to review and commit; nothing is pushed.
 *  - Progress streams through a RunReporter instead of a PR comment.
 *
 * No VS Code imports here on purpose — the only dependency is the shared core.
 */

import {
  AnthropicAgentRunner,
  LdClient,
  LdResourceWriter,
  appConnection,
  buildHandoffVerifier,
  createPolicyGate,
  decideApproval,
  describeLoopBudgetSpent,
  describeLoopEdgeShadowed,
  describeLoopExhausted,
  getLdSdk,
  interpretWalk,
  pipelineContext,
  resolveAiProvider,
  resolveApprovalPolicy,
  walkGraph,
  withProvider,
} from "@auto-factory/shared";
import type { CursorContext } from "./cursorContext.js";
import { buildContextVariables } from "./cursorContext.js";
import type { RunReporter, RunResult } from "./reporter.js";

export interface RunOptions {
  workspaceRoot: string;
  context: CursorContext;
  graphKey: string;
  appProjectKey: string;
  flagCreation: boolean;
  codeChanges: boolean;
  reporter: RunReporter;
  /**
   * Interactive approval for a gated step (from auto-factory-approval-gates).
   * Blocks in-process until the human responds: true → run the step and
   * continue; false → stop before it. Omitted → gated steps are declined
   * (safe default). Injected by the extension (which owns the vscode modal).
   */
  confirmGate?: (nodeKey: string) => Promise<boolean>;
}

/** A writer for real flag/metric creation in the app project, or undefined. */
function buildWriter(flagCreation: boolean): LdResourceWriter | undefined {
  if (!flagCreation) return undefined;
  if (!process.env.LD_API_KEY) throw new Error("Flag creation is on but no LaunchDarkly API key is set.");
  if (!process.env.LD_APP_PROJECT_KEY) throw new Error("Flag creation is on but no app project key is set.");
  return new LdResourceWriter(new LdClient(appConnection()));
}

export async function runPhase1(opts: RunOptions): Promise<RunResult> {
  const { reporter } = opts;

  const { ldClient, aiClient } = await getLdSdk();
  let ldContext = pipelineContext();

  // The extension executes the chain locally, so it always uses the Anthropic
  // runner. We still read the provider flag for parity and surface a note if a
  // hosted provider (Vega) is selected, since that path can't edit your tree.
  const provider = await resolveAiProvider(ldClient, ldContext);
  if (provider !== "anthropic") {
    reporter.log(`Provider flag selects '${provider}', but the editor extension runs locally on Anthropic. Using Anthropic.`);
  }
  // Stamp the EFFECTIVE provider (always anthropic here) on the run context so
  // AI config targeting serves only models this runner can execute.
  ldContext = withProvider(ldContext, "anthropic");

  const variables = buildContextVariables(opts.context, opts.appProjectKey);
  const graphDef = await aiClient.agentGraph(opts.graphKey, ldContext, variables);
  if (!graphDef.enabled) {
    throw new Error(`Agent graph '${opts.graphKey}' is disabled or unavailable in LaunchDarkly.`);
  }
  const graphTracker = graphDef.createTracker();

  const writer = buildWriter(opts.flagCreation);
  reporter.log(`Flag/metric creation: ${writer ? `enabled → '${writer.projectKey}'` : "disabled (read-only)"}.`);
  reporter.log(`Code changes: ${opts.codeChanges ? "enabled (edits land in your working tree)" : "disabled"}.`);

  const runner = new AnthropicAgentRunner({
    sandboxRoot: opts.workspaceRoot,
    codeChangesEnabled: opts.codeChanges,
    gitMode: "workingTree",
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
    ...(writer ? { writer } : {}),
    ...(opts.context.PR_BRANCH ? { prBranch: String(opts.context.PR_BRANCH) } : {}),
    ...(process.env.PR_BASE_REF ? { prBaseRef: process.env.PR_BASE_REF } : {}),
  });

  // The approval policy (mode/threshold/gates flags) compiles into
  // pre-execution gates; the extension answers each gate with an interactive
  // modal (opts.confirmGate). Yolo mode → no gates → unchanged behavior.
  const policy = await resolveApprovalPolicy(ldClient, ldContext);
  const gate = createPolicyGate(policy, (node) => opts.confirmGate?.(node) ?? false);

  const walk = await walkGraph(graphDef, runner, opts.context, {
    graphTracker,
    onEvent: (event) => {
      if (event.type === "node-start") reporter.nodeStart(event.configKey);
      else if (event.type === "node-complete") reporter.nodeComplete(event.run);
      else if (event.type === "node-verified") {
        const v = event.verification;
        if (v.ok) reporter.log(`⛊ deterministic checks passed after ${v.node} (${v.passed.map((c) => c.name).join(", ")})`);
        else reporter.log(`⛔ deterministic check FAILED after ${v.node}: ${v.failures.map((c) => `[${c.name}] ${c.detail}`).join("; ")}`);
      } else if (event.type === "stalled") {
        const u = event.stall.unmet
          .map((e) => `→ ${e.target} needs ${Object.entries(e.requireMissing).map(([k, v]) => `${k}=${v}`).join(", ")}`)
          .join("; ");
        reporter.log(`⚠ chain stalled at ${event.stall.node}: unmet handoff ${u}`);
      } else if (event.type === "loop-exhausted") {
        reporter.log(`⚠ ${describeLoopExhausted(event.info)}`);
      } else if (event.type === "awaiting-approval") {
        reporter.log(`⏸ approval gate: stopped before ${event.node}`);
      } else if (event.type === "replay-diverged") {
        reporter.log(`⛔ resume aborted: ${event.info.detail}`);
      }
    },
    gate,
    // Deterministic handoff shims: LD-side checks need the writer's connection;
    // read-only runs still get the code-side checks.
    verifier: buildHandoffVerifier({ sandboxRoot: opts.workspaceRoot, ...(writer ? { writer } : {}) }),
  });

  // Advisory quality loops that gave up. The walk finished normally, so nothing
  // else would mention them.
  if (walk.loopBudgetSpent) for (const l of describeLoopBudgetSpent(walk.loopBudgetSpent)) reporter.log(`⚠ ${l}`);
  // A loop the SERVED graph's edge order may have made unreachable — it never ran,
  // so unlike an exhausted budget there is no other trace of it in this walk.
  if (walk.loopEdgeShadowed) for (const l of describeLoopEdgeShadowed(walk.loopEdgeShadowed)) reporter.log(`⚠ ${l}`);

  const verdict = interpretWalk(walk.tags, walk.inventory, walk.runs);
  const decision = decideApproval(verdict);

  const result: RunResult = {
    runs: walk.runs,
    skipped: walk.skipped,
    tags: walk.tags,
    inventory: walk.inventory,
    decision,
    ...(walk.pendingApproval ? { pendingApproval: walk.pendingApproval } : {}),
    ...(walk.loopExhausted ? { loopExhausted: walk.loopExhausted } : {}),
    mode: policy.mode,
    provider,
  };
  reporter.done(result);
  return result;
}
