/**
 * Agent graph walker.
 *
 * Walks a LaunchDarkly `AgentGraphDefinition` (resolved natively via the AI SDK's
 * `agentGraph()` — LaunchDarkly delivers the structure + each node's resolved AI
 * config, but does NOT execute the graph) by dispatching each node through an
 * `AgentRunner` (Vega or Anthropic) and following edges whose handoff conditions
 * are satisfied by the tags agents set.
 *
 * Handoff conditions live in each edge's freeform `handoff` object:
 *   - require_tags: take the edge only if ALL listed tags are present/equal
 *   - skip_if_tags: do NOT take the edge if ALL listed tags are present/equal
 *     (e.g. research sets {skip_flagging: "true"} → the flagging edge is skipped,
 *      short-circuiting the chain — "this PR needs no flag")
 *
 * Designed for the linear/conditional chains we use today; one outgoing edge is
 * taken per node. Per-node generation metrics and per-edge handoff metrics are
 * recorded back to LaunchDarkly via the AI-config and graph trackers.
 */

import type { AgentGraphDefinition, AgentGraphNode, LDGraphTracker } from "@launchdarkly/server-sdk-ai";
import type { AgentNodeResult, AgentRunner } from "./agentRunner.js";
import type { HandoffVerification, HandoffVerifier } from "./handoffVerifier.js";
import type { JudgeHook } from "./judges.js";
import { startHandoffSpan } from "./observability.js";

export interface NodeRun {
  configKey: string;
  status: AgentNodeResult["status"];
  output: string;
  tags: Record<string, string>;
}

/** An outgoing edge that could NOT be taken because its `require_tags` weren't met. */
export interface UnmetEdge {
  /** Target node key the edge would have advanced to. */
  target: string;
  /** The required tag→value pairs that were absent or mismatched. */
  requireMissing: Record<string, string>;
}

/**
 * Why the walk stopped before a terminal node: the current node had outgoing
 * edges, but every one was blocked by an unmet `require_tags` handoff (NOT an
 * intentional `skip_if_tags` short-circuit, and NOT a genuine no-edge terminal).
 * This is the "silently stalled" case issue #9 wants surfaced — a required
 * routing tag was never produced, so the chain can't advance.
 */
export interface StallInfo {
  /** The node the chain stalled at. */
  node: string;
  /** Tags present when it stalled (what the node actually emitted). */
  tags: Record<string, string>;
  /** The outgoing edges that couldn't be taken, with the missing tags. */
  unmet: UnmetEdge[];
}

export interface WalkResult {
  runs: NodeRun[];
  /** Tags accumulated across all nodes. */
  tags: Record<string, string>;
  /** Node keys never reached because an edge condition stopped the chain. */
  skipped: string[];
  /**
   * Set when the chain stopped on an unmet handoff (a required tag was never
   * emitted) rather than at a terminal node or an intentional skip. Undefined
   * for a clean finish. Lets the caller report "stalled — X required Y, absent"
   * instead of a misleading verdict.
   */
  stalledAt?: StallInfo;
  /**
   * Set when the walk halted BEFORE a gated node because approval wasn't
   * granted (see GateController). The named node and everything downstream did
   * not run. Distinct from a stall: the chain is paused awaiting a human, not
   * broken. Undefined when no gate halted the walk.
   */
  pendingApproval?: { node: string };
  /**
   * Set when a deterministic handoff shim (see handoffVerifier.ts) FAILED
   * after a node: a claim the node handed off could not be re-derived from
   * primary evidence (LaunchDarkly state / the checkout). The chain halts at
   * that node — downstream agents must not build on an unverified claim.
   */
  verificationFailed?: HandoffVerification;
}

/**
 * Controls per-step approval gates. `steps` are the agent node keys that MAY
 * require approval before they run (compiled from the approval-mode /
 * risk-threshold / approval-gates flags — see approvalPolicy.ts). Before
 * running a gated node the walker calls `resolve(nodeKey, tags)` with the tags
 * accumulated so far (e.g. the research planner's `risk_score`, so a gate can
 * be risk-conditional):
 *  - true  → proceed (approved, or the gate decided no approval is needed).
 *  - false → HALT before the node (WalkResult.pendingApproval).
 *
 * `resolve` may be async. Each front end answers the human part differently:
 * the GitHub Action returns a non-blocking PR-label lookup (false → the run
 * ends and a later re-run, after the label is added, proceeds); the Cursor
 * extension shows an interactive prompt that blocks until the human responds.
 */
export interface GateController {
  steps: string[];
  resolve(nodeKey: string, tags: Record<string, string>): boolean | Promise<boolean>;
}

/**
 * Progress events emitted as the walk advances, for live UIs (e.g. the Cursor
 * extension streaming research → flag → metrics → test → review). Optional and
 * additive: callers that don't pass `onEvent` (the GitHub Action) are unaffected.
 */
export type WalkEvent =
  | { type: "node-start"; configKey: string; index: number }
  | { type: "node-complete"; configKey: string; index: number; run: NodeRun }
  | { type: "node-verified"; verification: HandoffVerification }
  | { type: "stalled"; stall: StallInfo }
  | { type: "awaiting-approval"; node: string };

/** All key/value pairs in `cond` are present and equal in `tags`. */
function tagsMatch(tags: Record<string, string>, cond: Record<string, string>): boolean {
  return Object.entries(cond).every(([k, v]) => tags[k] === v);
}

/** Read a `{key:value}` tag map out of an edge handoff field. */
function handoffTags(handoff: Record<string, unknown> | undefined, field: string): Record<string, string> | undefined {
  const v = handoff?.[field];
  return v && typeof v === "object" ? (v as Record<string, string>) : undefined;
}
function handoffNumber(handoff: Record<string, unknown> | undefined, field: string): number | undefined {
  const v = handoff?.[field];
  return typeof v === "number" ? v : undefined;
}
function handoffString(handoff: Record<string, unknown> | undefined, field: string): string | undefined {
  const v = handoff?.[field];
  return typeof v === "string" ? v : undefined;
}
function handoffStringArray(handoff: Record<string, unknown> | undefined, field: string): string[] | undefined {
  const v = handoff?.[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/**
 * Build a node's prompt. Each node runs in its own conversation, so the prompt
 * carries the repo + PR header and, for non-root nodes, the previous agent's
 * full brief (the downstream agent's instructions tell it to parse this).
 */
function buildPrompt(hasInbound: boolean, ctx: Record<string, unknown>): string {
  const header = [
    ctx.REPO ? `Repository: ${ctx.REPO}` : "",
    ctx.PR_NUMBER ? `Pull request: #${ctx.PR_NUMBER}` : "",
    ctx.PR_TITLE ? `Title: ${ctx.PR_TITLE}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!hasInbound) {
    return `${header}${ctx.PR_BODY ? `\n\n${ctx.PR_BODY}` : ""}`.trim();
  }
  const brief = typeof ctx.PREVIOUS_STEP_OUTPUT === "string" ? ctx.PREVIOUS_STEP_OUTPUT : "";
  return `${header}\n\n${brief}`.trim();
}

function lastAssistantText(result: AgentNodeResult): string {
  const finals = result.messages.filter((m) => m.role === "assistant");
  const fin = finals.find((m) => m.isFinal) ?? finals[finals.length - 1];
  return fin?.content ?? "";
}

/** Every node key referenced by the graph (root + all edge sources/targets). */
function allNodeKeys(graphDef: AgentGraphDefinition): string[] {
  const raw = graphDef.getConfig();
  const keys = new Set<string>();
  if (raw.root) keys.add(raw.root);
  for (const [source, edges] of Object.entries(raw.edges ?? {})) {
    keys.add(source);
    for (const e of edges) keys.add(e.key);
  }
  return [...keys];
}

export async function walkGraph(
  graphDef: AgentGraphDefinition,
  runner: AgentRunner,
  context: Record<string, unknown>,
  graphTracker?: LDGraphTracker,
  onEvent?: (event: WalkEvent) => void,
  gate?: GateController,
  /**
   * Optional judge hook (see judges.ts): after each node completes, runs any
   * judges attached to that node's AI config in LaunchDarkly and records their
   * scores on the node's tracker. Judge failures never fail the walk.
   */
  judgeHook?: JudgeHook,
  /**
   * Optional deterministic handoff shims (see handoffVerifier.ts): after each
   * node completes, re-derive the claims its tags assert from primary evidence
   * (LaunchDarkly + the checkout). A failed verification HALTS the walk
   * (WalkResult.verificationFailed) — unlike judges, these are gates.
   */
  verifier?: HandoffVerifier,
): Promise<WalkResult> {
  const runs: NodeRun[] = [];
  const accumulatedTags: Record<string, string> = {};
  const ctx: Record<string, unknown> = { ...context };
  const gatedSteps = new Set(gate?.steps ?? []);
  const visited = new Set<string>();

  let node: AgentGraphNode | null = graphDef.rootNode();
  // Handoff of the edge we traversed INTO the current node (root has none).
  let inboundHandoff: Record<string, unknown> | undefined;
  let stalledAt: StallInfo | undefined;
  let pendingApproval: { node: string } | undefined;
  let verificationFailed: HandoffVerification | undefined;

  while (node && !visited.has(node.getKey())) {
    const key = node.getKey();

    // Approval gate: before running a gated node, ask the controller — passing
    // the tags accumulated so far, so risk-conditional gates can consult the
    // planner's risk_score. If not approved, halt BEFORE the node runs (so its
    // side effects — flag creation, commits — don't happen).
    if (gate && gatedSteps.has(key) && !(await gate.resolve(key, accumulatedTags))) {
      pendingApproval = { node: key };
      onEvent?.({ type: "awaiting-approval", node: key });
      break;
    }

    visited.add(key);

    const cfg = node.getConfig();
    const maxTurns = handoffNumber(inboundHandoff, "max_turns");
    const requestType = handoffString(inboundHandoff, "request_type");
    const capabilities = handoffStringArray(inboundHandoff, "capabilities");
    onEvent?.({ type: "node-start", configKey: key, index: runs.length });
    // One tracker per node run, shared between the runner (generation metrics)
    // and the judge hook (evaluation scores) so both land on the same AI run.
    const tracker = cfg.createTracker();
    const prompt = buildPrompt(inboundHandoff !== undefined, ctx);
    const result = await runner.runNode({
      configKey: key,
      prompt,
      ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
      ...(cfg.model?.name ? { model: cfg.model.name } : {}),
      ...(cfg.model?.parameters ? { modelParameters: cfg.model.parameters } : {}),
      tracker,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(requestType ? { requestType } : {}),
      ...(capabilities ? { capabilities } : {}),
      // Tool attachments from the LD variation (interface overrides; ADR 0011).
      ...(cfg.tools && Object.keys(cfg.tools).length > 0 ? { ldTools: cfg.tools } : {}),
    });

    Object.assign(accumulatedTags, result.tags);
    const output = lastAssistantText(result);
    ctx.PREVIOUS_STEP_OUTPUT = output;
    const run: NodeRun = { configKey: key, status: result.status, output, tags: result.tags };
    runs.push(run);
    onEvent?.({ type: "node-complete", configKey: key, index: runs.length - 1, run });

    // Judges attached to this node's config (if any) score the output now, on
    // the same tracker. Defensive: a judge problem must never break the walk.
    if (judgeHook) {
      try {
        await judgeHook({ configKey: key, cfg, input: prompt, output, tracker });
      } catch (e) {
        console.warn(`[judge] hook failed for '${key}' (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Deterministic handoff shim: re-derive this node's claims from primary
    // evidence. A FAILED check halts the walk — downstream agents must not
    // build on an unverified claim. (A shim implementation bug — an unexpected
    // throw — logs and does not halt; evidential failures are reported inside
    // the verification, not thrown.)
    if (verifier) {
      try {
        const verification = await verifier({ configKey: key, tags: result.tags });
        if (verification) {
          onEvent?.({ type: "node-verified", verification });
          for (const c of verification.passed) console.log(`[verify] ${key} ✓ ${c.name}: ${c.detail}`);
          for (const c of verification.failures) console.error(`[verify] ${key} ✗ ${c.name}: ${c.detail}`);
          if (!verification.ok) {
            verificationFailed = verification;
            break;
          }
        }
      } catch (e) {
        console.warn(`[verify] shim errored for '${key}' (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Pick the next edge whose handoff conditions pass.
    let next: string | null = null;
    let nextHandoff: Record<string, unknown> | undefined;
    for (const edge of node.getEdges()) {
      const h = edge.handoff;
      const require = handoffTags(h, "require_tags");
      if (require && !tagsMatch(accumulatedTags, require)) continue;
      const skip = handoffTags(h, "skip_if_tags");
      if (skip && tagsMatch(accumulatedTags, skip)) continue;
      next = edge.key;
      nextHandoff = h;
      break;
    }

    // No edge taken: distinguish a genuine terminal (no outgoing edges) and an
    // intentional skip (every blocked edge matched its skip_if) from a real
    // stall (an outgoing edge's require_tags was never satisfied).
    if (!next) {
      const edges = node.getEdges();
      const unmet: UnmetEdge[] = [];
      for (const edge of edges) {
        const h = edge.handoff;
        const skip = handoffTags(h, "skip_if_tags");
        if (skip && tagsMatch(accumulatedTags, skip)) continue; // intentionally skipped
        const require = handoffTags(h, "require_tags");
        if (require && !tagsMatch(accumulatedTags, require)) {
          const requireMissing: Record<string, string> = {};
          for (const [k, v] of Object.entries(require)) {
            if (accumulatedTags[k] !== v) requireMissing[k] = v;
          }
          unmet.push({ target: edge.key, requireMissing });
        }
      }
      if (unmet.length > 0) {
        stalledAt = { node: key, tags: { ...accumulatedTags }, unmet };
        onEvent?.({ type: "stalled", stall: stalledAt });
      }
    }

    if (next) {
      graphTracker?.trackHandoffSuccess(key, next);
      // Agent-chain handoff span for Sentry AI monitoring / LD o11y.
      const handoff = startHandoffSpan(key, next);
      handoff.setGenAi({
        provider: "auto-factory",
        requestModel: "graph-walker",
        agentName: key,
        operationName: "handoff",
      });
      handoff.end("ok");
    }
    node = next ? graphDef.getNode(next) : null;
    inboundHandoff = nextHandoff;
  }

  const reached = new Set(runs.map((r) => r.configKey));
  const skipped = allNodeKeys(graphDef).filter((k) => !reached.has(k));

  return {
    runs,
    tags: accumulatedTags,
    skipped,
    ...(stalledAt ? { stalledAt } : {}),
    ...(pendingApproval ? { pendingApproval } : {}),
    ...(verificationFailed ? { verificationFailed } : {}),
  };
}
