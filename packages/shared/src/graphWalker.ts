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
 *   - loop_if_judge_below: take the edge only if the just-completed node's judge
 *     score is below N (fail-open — no usable score means no signal). Pairs with
 *     max_visits; on a node that also has a forward edge the loop is ADVISORY (a
 *     spent budget falls through and is recorded in WalkResult.loopBudgetSpent).
 *   - max_visits: caps how many times THIS edge may be traversed. An edge that
 *     carries max_visits is the author-designated loop-back edge; untagged edges
 *     (forward / rejoin) are never capped. This is how bounded loops work — a
 *     re-entered node re-runs, and its routing tags are rewound to the state
 *     before it last ran (facts/inventory persist). Termination is guaranteed by
 *     the per-edge cap plus a run-level backstop. An UNMET loop edge is treated
 *     as convergence, not a stall — only unmet forward edges stall the chain. A loop
 *     edge's ROUTING conditions are matched against the just-completed run's OWN
 *     tags, so a stale verdict can't re-fire the loop; FACT conditions may still
 *     come from upstream.
 *     SCOPE: `edgeCounts` below is process-local, so the budget bounds ONE walk,
 *     not one PR — every re-run starts fresh. See the README's scope caveat.
 *
 * One outgoing edge is taken per node. Per-node generation metrics and per-edge
 * handoff metrics are recorded back to LaunchDarkly via the AI-config and graph
 * trackers.
 */

import type { AgentGraphDefinition, AgentGraphNode, LDGraphTracker } from "@launchdarkly/server-sdk-ai";
import type { AgentNodeResult, AgentRunner } from "./agentRunner.js";
import type { HandoffVerification, HandoffVerifier } from "./handoffVerifier.js";
import type { JudgeHook } from "./judges.js";

/** Bound on a journalled judge `reasoning` string, so the resume journal stays small. */
const JUDGE_REASONING_MAX = 1000;

/** Hard ceiling on any declared `max_visits`, so config can't remove the guarantee. */
const MAX_VISITS_HARD_CAP = 10;

/**
 * Tags produced by the LLM (routing/verdict) — REWOUND when a loop edge re-enters
 * a node, so a re-run starts from the routing state that preceded the target's
 * last run rather than inheriting stale downstream decisions. Mirrors tags.json
 * `production: "llm"`. A check-configs case asserts this stays in sync.
 */
const ROUTING_TAGS = new Set<string>([
  "skip_flagging",
  "flag_worthy",
  "flag_action",
  "needs_tests",
  "review_approved",
  "risk_level",
  "risk_score",
]);

/**
 * Tags produced by tools (facts) — NEVER rewound; mirrored into `inventory` so
 * reporting, the rework preamble, and the orphan guard see real created-resource
 * state even after a routing rewind. Mirrors tags.json `production: "tool"`.
 */
const FACT_TAGS = new Set<string>([
  "flag_ready",
  "flag_created",
  "flag_key",
  "flag_variation",
  "metrics_created",
  "metric_keys",
  "metric_event_keys",
  "tests_last_run",
]);

export interface NodeRun {
  configKey: string;
  status: AgentNodeResult["status"];
  output: string;
  tags: Record<string, string>;
  /** 1-based run count for this node key in this walk (>1 means a loop re-run). */
  iteration: number;
  /**
   * Judge key → score, for scores that are USABLE as routing input (sampled,
   * successful, numeric — see `usableJudgeScores`). Absent when no judge is
   * attached, none was sampled, or every evaluation failed.
   *
   * On `NodeRun` rather than in tags, and deliberately: `NodeRun[]` IS the resume
   * journal (`ResumeInput.journal`), so a score that routes is persisted and
   * replayed by construction. A tag would instead be deleted by the routing rewind,
   * which reads the agent's own result tags and so never sees a walker-computed one.
   */
  judgeScores?: Record<string, number>;
  /**
   * The lowest-scoring usable judge's `reasoning`, truncated. Journalled alongside
   * the scores because it is the substance of a judge-driven rework: if a resume
   * replays up to a loop target and then runs it live, dropping this would hand the
   * re-run extra budget with no explanation — the exact failure the whole feedback
   * channel exists to prevent.
   */
  judgeReasoning?: string;
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

/**
 * Why the walk stopped on a loop that did not converge, rather than at a terminal
 * node, a stall, or an intentional skip. Distinct from a stall (a required tag
 * was never produced) — here a loop edge PASSED its conditions but had already
 * been traversed its budget (`"budget"`), or the run-level backstop tripped on an
 * untagged/pathological cycle (`"run-cap"`). Either way the intended iteration
 * did not complete; the caller must NOT report this as a clean success.
 */
export interface LoopExhaustedInfo {
  /** The node the walk was at when it stopped. */
  node: string;
  /** Which ceiling stopped it. */
  reason: "budget" | "run-cap";
  /**
   * Budget-exhausted loop edges that otherwise passed their tag conditions.
   * `trigger` describes the condition that kept firing (e.g. `review_approved=false`)
   * — present only when the edge has a describable condition, so "budget spent"
   * can be reported as *why* rather than just *that*.
   */
  exhausted: Array<{
    source: string;
    target: string;
    traversals: number;
    maxVisits: number;
    trigger?: string;
  }>;
  /** Any edges also blocked by unmet require_tags at the same point (context). */
  alsoUnmet?: UnmetEdge[];
  /** Tags present at exhaustion. */
  tags: Record<string, string>;
}

/**
 * A resume was attempted but the journal no longer describes this walk — the graph,
 * configs, or walker logic changed under it. A HARD failure: the caller must discard
 * the journal and start a fresh run. Never treat a diverged replay as a result, since
 * the partial state it produced is a mix of two different walks.
 */
export interface ReplayDivergence {
  /** Position in the journal where the mismatch was found. */
  atIndex: number;
  /** What the journal said should run there (`configKey#iteration`). */
  expected: string;
  /** What the walk re-derived instead. */
  actual: string;
  /** Human-readable explanation for reporting. */
  detail: string;
}

export interface WalkResult {
  runs: NodeRun[];
  /** Tags accumulated across all nodes (routing tags may have been rewound). */
  tags: Record<string, string>;
  /**
   * Tool-produced facts accumulated across the whole walk and NEVER rewound —
   * the authoritative created-resource inventory (flag_key, metric_keys, …).
   * Reporting and the orphan guard read this, not `tags`, so a loop rewind can't
   * erase the record of resources that really exist.
   */
  inventory: Record<string, string>;
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
  /**
   * Set when a loop did not converge within budget (or hit the run-level
   * backstop). A hard-fail terminal — callers must not treat it as success even
   * if a stale routing tag reads as approved. Undefined for a clean finish.
   */
  loopExhausted?: LoopExhaustedInfo;
  /**
   * Set when a resume's journal stopped matching what the walk re-derived. A hard
   * failure — the run is a mix of two walks and must not be reported as a result.
   */
  replayDiverged?: ReplayDivergence;
  /**
   * Every loop edge whose budget was spent, WHETHER OR NOT the walk continued past
   * it. Informational, never a failure.
   *
   * Why this exists: a loop edge on a node that also has a forward edge is
   * ADVISORY — when the budget runs out the walk falls through and finishes
   * normally, so `loopExhausted` never fires. Without this record, "we tried N
   * times to improve quality, never got there, and shipped anyway" would appear
   * nowhere. `loopExhausted.exhausted` is the subset that actually ended the walk.
   */
  loopBudgetSpent?: Array<{
    source: string;
    target: string;
    traversals: number;
    maxVisits: number;
    trigger?: string;
  }>;
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
  | { type: "loop-exhausted"; info: LoopExhaustedInfo }
  | { type: "replay-diverged"; info: ReplayDivergence }
  | { type: "awaiting-approval"; node: string };

/**
 * One line per advisory loop that ran out of budget WITHOUT failing the run. These
 * are the quality retries that gave up and let the chain proceed — invisible unless
 * something says so, since the walk itself finished normally.
 */
export function describeLoopBudgetSpent(spent: NonNullable<WalkResult["loopBudgetSpent"]>): string[] {
  return spent.map(
    (e) =>
      `quality loop ${e.source} → ${e.target} used all ${e.maxVisits} attempt(s) without converging` +
      (e.trigger ? ` (${e.trigger})` : "") +
      " — the chain continued anyway.",
  );
}

/** Human-readable one-liner describing why a loop did not converge. */
export function describeLoopExhausted(info: LoopExhaustedInfo): string {
  if (info.reason === "run-cap") {
    return `loop did not converge at '${info.node}': the run hit the total-node-run cap — likely an untagged cycle in the graph.`;
  }
  const edges = info.exhausted
    .map((e) => {
      // Name the condition that kept firing, so the reader learns what to FIX,
      // not merely that a counter ran out.
      const why = e.trigger ? ` — trigger: ${e.trigger}` : "";
      return `edge → ${e.target} spent its budget (${e.traversals}/${e.maxVisits} traversals)${why}`;
    })
    .join("; ");
  return `loop did not converge at '${info.node}'; ${edges}. The chain could not advance within budget.`;
}

/**
 * `accumulated`, but with every ROUTING tag replaced by what the just-completed run
 * emitted — so a routing tag the run didn't emit reads as ABSENT rather than as its
 * stale accumulated value. Fact tags pass through untouched, since they are never
 * rewound and legitimately originate upstream.
 *
 * Used only for LOOP-edge conditions: re-firing a loop on a verdict the source node
 * didn't repeat costs a full live iteration and mis-attributes the reason.
 */
function withFreshRouting(
  accumulated: Record<string, string>,
  own: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(accumulated)) if (!ROUTING_TAGS.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(own)) out[k] = v;
  return out;
}

/**
 * Warn when a loop edge was skipped ONLY because of the routing-freshness rule — the
 * condition matches the accumulated tags but not the source run's own. That means the
 * edge gates on a routing tag another node owns, so it can never fire: dead config.
 *
 * `check-configs` catches this in the committed graph, but the walker executes the
 * graph LaunchDarkly SERVES, so a dashboard edit can introduce it with no build step
 * in between. This is the runtime backstop for that gap.
 */
function warnIfOnlyStaleWouldMatch(
  isLoop: boolean,
  source: string,
  target: string,
  kind: string,
  cond: Record<string, string>,
  accumulated: Record<string, string>,
  fresh: Record<string, string>,
): void {
  if (!isLoop || !tagsMatch(accumulated, cond)) return;
  const foreign = Object.keys(cond).filter((k) => ROUTING_TAGS.has(k) && fresh[k] === undefined);
  if (foreign.length === 0) return;
  console.warn(
    `[loop] edge ${source} → ${target} can never fire: its ${kind} names routing tag(s) ` +
      `${foreign.join(", ")} that '${source}' did not emit. A loop edge's routing conditions are matched ` +
      `against the source run's own tags, so this condition is unsatisfiable — check the SERVED graph.`,
  );
}

/** All key/value pairs in `cond` are present and equal in `tags`. */
function tagsMatch(tags: Record<string, string>, cond: Record<string, string>): boolean {
  return Object.entries(cond).every(([k, v]) => tags[k] === v);
}

/** The routing-classified (LLM-produced) subset of a tag map — the rewindable tags. */
function pickRouting(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (ROUTING_TAGS.has(k)) out[k] = v;
  return out;
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
 * Why a loop edge fired, carried from the loop source to the re-entered node's
 * rework preamble. Deliberately NOT a tag: tags are `Record<string, string>`,
 * feed edge matching, and are registry-validated, so prose has no place there —
 * and a walker-computed tag would be dropped by the routing rewind, which reads
 * the agent's own result tags.
 */
export interface LoopTrigger {
  /** The node whose run satisfied the loop edge's conditions. */
  source: string;
  /** The condition that fired, e.g. `review_approved=false`. */
  reason: string;
  /**
   * Guidance for this iteration that is NOT already in the inbound brief.
   * A verdict loop leaves this empty on purpose — the brief is the loop source's
   * own full report, so repeating it here would duplicate it. Populated by human
   * feedback on a resume and by a judge's reasoning.
   */
  detail?: string;
}

/**
 * The judge scores a node run may route on. A score counts only when the judge was
 * SAMPLED, the evaluation SUCCEEDED, and the score is numeric.
 *
 * This is the fail-open contract in one place: `judges.ts` promises that a judge
 * failure never fails the chain, and judges are sampled, so routing on them must
 * treat every absence as "no signal" rather than as a low score. An unsampled or
 * broken judge must never be able to trigger rework.
 */
export function usableJudgeScores(
  results: ReadonlyArray<{ judgeConfigKey?: string; sampled: boolean; success: boolean; score?: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    if (r.sampled && r.success && typeof r.score === "number" && Number.isFinite(r.score)) {
      out[r.judgeConfigKey ?? "judge"] = r.score;
    }
  }
  return out;
}

/**
 * The score a `loop_if_judge_below` edge is compared against: the MINIMUM usable
 * score, so that adding a second judge later can never let a high scorer mask a low
 * one. One judge per node today, so this is trivially that judge's score.
 * Undefined when there is nothing usable — which fails open.
 */
function routingJudgeScore(scores: Record<string, number> | undefined): number | undefined {
  if (!scores) return undefined;
  const values = Object.values(scores);
  return values.length > 0 ? Math.min(...values) : undefined;
}

/**
 * Describe a judge-driven loop edge's condition, including the RUNTIME score — the
 * part a config-only describer can't know, and the part a human actually needs
 * ("scored 0.55, below 0.70" beats "judge score was low"). Undefined when the edge
 * carries no judge threshold, so callers fall back to the tag describer.
 */
function describeJudgeCondition(
  handoff: Record<string, unknown> | undefined,
  scores: Record<string, number> | undefined,
): string | undefined {
  const below = handoffNumber(handoff, "loop_if_judge_below");
  if (below === undefined) return undefined;
  const entries = Object.entries(scores ?? {});
  if (entries.length === 0) return `no usable judge score (threshold ${below})`;
  // Name the judge that actually tripped it, not just the number.
  const [lowestKey, lowestScore] = entries.reduce((lo, e) => (e[1] < lo[1] ? e : lo));
  return `${lowestKey} scored ${lowestScore.toFixed(2)}, below ${below}`;
}

/**
 * Describe a loop edge's firing condition for humans. `require_tags` is the
 * trigger (all pairs had to match); a `max_visits`-only edge loops until budget,
 * which is worth saying out loud rather than leaving blank.
 */
function describeLoopCondition(handoff: Record<string, unknown> | undefined): string | undefined {
  const require = handoffTags(handoff, "require_tags");
  if (require && Object.keys(require).length > 0) {
    return Object.entries(require)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  }
  // A skip_if loop edge fires on the ABSENCE of its exit condition, so describe it
  // as the exit that never happened rather than as a double negative.
  const skip = handoffTags(handoff, "skip_if_tags");
  if (skip && Object.keys(skip).length > 0) {
    return Object.entries(skip)
      .map(([k, v]) => `${k} never became ${v}`)
      .join(", ");
  }
  return undefined;
}

/**
 * A rework preamble injected into a re-entered node's prompt so the agent knows
 * it is iteration N with prior work to amend (not a fresh first pass). Lists the
 * created-resource inventory as "reuse, don't recreate" facts, and — when the
 * re-entry came from a loop edge — names WHO sent it back and WHY. Without that,
 * the loop source's report arrives as an undifferentiated brief and reads like a
 * fresh task rather than a change request.
 */
function reworkPreamble(
  iteration: number,
  inventory: Record<string, string>,
  trigger?: LoopTrigger,
): string {
  const facts = Object.entries(inventory)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`);
  const factBlock = facts.length
    ? `\nResources already created in a prior iteration (amend or reuse — do NOT recreate):\n${facts.join("\n")}`
    : "";
  const why = trigger
    ? `Sent back by '${trigger.source}' because ${trigger.reason}. ` +
      `The brief below is that step's own report — treat it as the change request, not a new task.`
    : `The brief below explains what to change.`;
  const detailBlock = trigger?.detail
    ? `\nAdditional guidance for this iteration:\n${trigger.detail}`
    : "";
  return (
    `=== REWORK ITERATION ${iteration} ===\n` +
    `This is a re-run of an earlier step; a previous iteration already executed. ` +
    `${why}${detailBlock}${factBlock}\n` +
    `=== END REWORK CONTEXT ===`
  );
}

/**
 * Build a node's prompt. Each node runs in its own conversation, so the prompt
 * carries the repo + PR header. The ROOT node always gets the PR body (even when
 * re-entered via a loop edge, which would otherwise look "non-root"); nodes with
 * an inbound edge also get the previous agent's brief. On a re-run (iteration>1)
 * a rework preamble is prepended.
 */
function buildPrompt(
  isRoot: boolean,
  hasInbound: boolean,
  iteration: number,
  inventory: Record<string, string>,
  ctx: Record<string, unknown>,
  trigger?: LoopTrigger,
  humanFeedback?: string,
): string {
  const header = [
    ctx.REPO ? `Repository: ${ctx.REPO}` : "",
    ctx.PR_NUMBER ? `Pull request: #${ctx.PR_NUMBER}` : "",
    ctx.PR_TITLE ? `Title: ${ctx.PR_TITLE}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const parts: string[] = [header];
  if (iteration > 1) parts.push(reworkPreamble(iteration, inventory, trigger));
  // Human guidance from a resume. Its own block, not folded into the rework
  // preamble, because a gate-halt resume can land on iteration 1 (no preamble at
  // all) and because a human's instruction outranks an agent's brief.
  if (humanFeedback) {
    parts.push(
      `=== HUMAN GUIDANCE (authoritative — overrides the brief below) ===\n` +
        `${humanFeedback}\n` +
        `=== END HUMAN GUIDANCE ===`,
    );
  }
  // The root always sees the PR body; a re-entered root keeps it too.
  if (isRoot && typeof ctx.PR_BODY === "string" && ctx.PR_BODY) parts.push(ctx.PR_BODY);
  // The inbound brief (previous step output): present for non-root nodes and for
  // a root re-entered via a loop edge.
  if (hasInbound) {
    const brief = typeof ctx.PREVIOUS_STEP_OUTPUT === "string" ? ctx.PREVIOUS_STEP_OUTPUT : "";
    if (brief) parts.push(brief);
  }
  return parts.filter(Boolean).join("\n\n").trim();
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

/**
 * Everything nondeterministic or side-effecting that a walk depends on, in one
 * bundle.
 *
 * THE INVARIANT: the walk loop itself is pure — no `Date.now`, no `Math.random`,
 * and every value it accumulates (`accumulatedTags`, `inventory`, `edgeCounts`,
 * `routingSnapshots`, envelope inheritance) is a function of the ordered node
 * results plus the graph. That purity is what makes `resume` replay possible.
 * So: adding a field here that the walk *branches on* obliges you to journal it
 * in `ResumeInput`, or replay silently diverges. This bundle exists to make that
 * obligation visible at the type level rather than in a comment nobody reads.
 */
export interface WalkInputs {
  /**
   * LaunchDarkly graph tracker (per-edge handoff metrics). NOT called for edges
   * whose source node was replayed — the original walk already recorded them, and
   * re-recording double-counts the AI Config monitoring data.
   */
  graphTracker?: LDGraphTracker;
  onEvent?: (event: WalkEvent) => void;
  gate?: GateController;
  /**
   * Judge hook (see judges.ts): after each node completes, runs any judges
   * attached to that node's AI config in LaunchDarkly and records their scores on
   * the node's tracker. Judge failures never fail the walk. Skipped for replayed
   * nodes (their scores were already recorded).
   *
   * Judge scores ARE a routing input (`loop_if_judge_below`), and the obligation
   * above is met by carrying them on `NodeRun` — which is itself the resume journal,
   * so they are persisted and replayed without a separate `ResumeInput` field. On
   * replay they are served from the journal instead of re-running the hook.
   */
  judgeHook?: JudgeHook;
  /**
   * Deterministic handoff shims (see handoffVerifier.ts): after each node
   * completes, re-derive the claims its tags assert from primary evidence
   * (LaunchDarkly + the checkout). A failed verification HALTS the walk
   * (WalkResult.verificationFailed) — unlike judges, these are gates. Skipped for
   * replayed nodes: a verification failure is not resumable, so every node in a
   * journal we accept has already passed.
   */
  verifier?: HandoffVerifier;
  /** Resume an interrupted walk instead of starting fresh. */
  resume?: ResumeInput;
}

/**
 * Resume an interrupted walk by replaying its recorded node results through this
 * same loop, then continuing live from the frontier.
 *
 * Only `pendingApproval` and `loopExhausted` walks are resumable. A stall is not
 * (replaying it reproduces the same missing tag — the fix is upstream), and a
 * verification failure is not (downstream must not build on an unverified claim —
 * the fix is a loop).
 *
 * Caller obligations, none of which the walker can check: the journal must come
 * from the same graph and config version, and — because agents mutate the working
 * tree without moving HEAD — from the same working-tree content. Divergence
 * between the journal and what the walk re-derives IS detected, and is reported as
 * `WalkResult.replayDiverged`.
 */
export interface ResumeInput {
  /**
   * Node results from the interrupted walk, in order — `WalkResult.runs` verbatim.
   * `iteration` is re-derived rather than trusted, and a mismatch is treated as
   * divergence.
   */
  journal: readonly NodeRun[];
  /**
   * Grants that were ALREADY in force for the walk that produced this journal.
   * Applied during replay as well as at the frontier, so replayed steps re-derive
   * the same budget decisions the original walk made.
   *
   * Without this, a granted loop traversal recorded in the journal would be
   * budget-blocked on the next replay and reported as divergence — which capped
   * grant-and-feedback at exactly one round and blamed "the graph changed". It is
   * also required by this bundle's own invariant: the walk branches on it, so it
   * must be journalled.
   */
  priorExtraVisits?: Record<string, number>;
  /**
   * A NEW grant from this resume, keyed `${source}→${target}`. Applied only once the
   * journal is consumed — at the frontier and beyond — so it cannot rewrite a
   * decision the recorded walk already made. Added on top of the declared
   * `max_visits` plus any prior grants, and still clamped to the hard cap, so a
   * grant can raise a ceiling but never remove it.
   */
  extraVisits?: Record<string, number>;
  /**
   * Human guidance for the first live node, rendered as its own authoritative
   * block. This is the point of resuming: extra budget with no new information
   * burns the same loop again, deterministically.
   */
  humanFeedback?: string;
}

export async function walkGraph(
  graphDef: AgentGraphDefinition,
  runner: AgentRunner,
  context: Record<string, unknown>,
  inputs: WalkInputs = {},
): Promise<WalkResult> {
  const { graphTracker, onEvent, gate, judgeHook, verifier, resume } = inputs;
  const journal = resume?.journal ?? [];
  const runs: NodeRun[] = [];
  const accumulatedTags: Record<string, string> = {};
  // Never-rewound mirror of tool-produced facts (the created-resource inventory).
  const inventory: Record<string, string> = {};
  const ctx: Record<string, unknown> = { ...context };
  const gatedSteps = new Set(gate?.steps ?? []);

  // Per-edge traversal counts (key `${source}→${target}`) — only loop edges (those
  // carrying max_visits) are ever consulted/capped.
  const edgeCounts = new Map<string, number>();
  // Loop edges whose budget ran out, keyed per edge so a revisited node records once.
  const budgetSpent = new Map<string, NonNullable<WalkResult["loopBudgetSpent"]>[number]>();
  // Routing-tag state captured just before each run (parallel to `runs`), so a
  // loop re-entry can restore the target's pre-run routing state.
  const routingSnapshots: Array<Record<string, string>> = [];
  // The edge-carried envelope (max_turns/request_type/capabilities) recorded on a
  // node's first entry, inherited on re-entry when the loop edge omits a field.
  const entryEdgeFields = new Map<string, { maxTurns?: number; requestType?: string; capabilities?: string[] }>();
  // Per-node execution count, for the `iteration` label and the rework preamble.
  const runCountByKey = new Map<string, number>();

  const rootKey = graphDef.getConfig().root;
  // Run-level termination backstop, scaled to graph size so it never preempts a
  // legal per-edge budget (nodeCount × (hardCap+1)); the true control is the
  // per-loop-edge cap. Guards untagged cycles and a maliciously edited served graph.
  const maxTotalNodeRuns = Math.max(1, allNodeKeys(graphDef).length) * (MAX_VISITS_HARD_CAP + 1);
  let totalRuns = 0;

  let node: AgentGraphNode | null = graphDef.rootNode();
  // Handoff of the edge we traversed INTO the current node (root has none).
  let inboundHandoff: Record<string, unknown> | undefined;
  let stalledAt: StallInfo | undefined;
  let pendingApproval: { node: string } | undefined;
  let verificationFailed: HandoffVerification | undefined;
  let loopExhausted: LoopExhaustedInfo | undefined;
  let replayDiverged: ReplayDivergence | undefined;
  // Set when a loop edge is traversed; consumed by the target's next prompt.
  let pendingLoopTrigger: LoopTrigger | undefined;
  // Human guidance from a resume, delivered to the FIRST live node then cleared.
  let pendingHumanFeedback = resume?.humanFeedback;

  while (node) {
    const key = node.getKey();
    // This node's result comes from the journal, not the runner. Positional: the
    // walk is deterministic, so the Nth node it wants to run must be the Nth it
    // ran before.
    const replayEntry = runs.length < journal.length ? journal[runs.length] : undefined;
    const replaying = replayEntry !== undefined;

    // Approval gate: before running a gated node, ask the controller — passing
    // the tags accumulated so far, so risk-conditional gates can consult the
    // planner's risk_score. If not approved, halt BEFORE the node runs (so its
    // side effects — flag creation, commits — don't happen). Re-evaluated on each
    // loop re-entry (each re-run can create new side effects).
    //
    // Replayed nodes are NEVER re-gated: they already ran, which means they were
    // already permitted. Re-asking would halt the replay on the same gate that
    // produced the journal. The FRONTIER node is always gated normally, so a
    // resume can't become an approval bypass.
    if (!replaying && gate && gatedSteps.has(key) && !(await gate.resolve(key, accumulatedTags))) {
      pendingApproval = { node: key };
      onEvent?.({ type: "awaiting-approval", node: key });
      break;
    }

    // Run-level backstop: bound total node executions (untagged cycles, malicious
    // served graph). Checked BEFORE running so we never exceed the ceiling.
    if (totalRuns >= maxTotalNodeRuns) {
      loopExhausted = { node: key, reason: "run-cap", exhausted: [], tags: { ...accumulatedTags } };
      onEvent?.({ type: "loop-exhausted", info: loopExhausted });
      break;
    }
    totalRuns++;

    const iteration = (runCountByKey.get(key) ?? 0) + 1;
    runCountByKey.set(key, iteration);
    // Snapshot the pre-run routing state (index aligns with the runs.push below).
    routingSnapshots.push(pickRouting(accumulatedTags));

    const cfg = node.getConfig();
    // Execution envelope: read the inbound edge's fields, recording them on first
    // entry and inheriting them on re-entry when the loop edge omits a field (so a
    // re-run isn't silently downgraded to the runner's built-in defaults).
    const inboundMaxTurns = handoffNumber(inboundHandoff, "max_turns");
    const inboundRequestType = handoffString(inboundHandoff, "request_type");
    const inboundCapabilities = handoffStringArray(inboundHandoff, "capabilities");
    if (!entryEdgeFields.has(key)) {
      entryEdgeFields.set(key, {
        maxTurns: inboundMaxTurns,
        requestType: inboundRequestType,
        capabilities: inboundCapabilities,
      });
    }
    const entry = entryEdgeFields.get(key) ?? {};
    const maxTurns = inboundMaxTurns ?? entry.maxTurns;
    const requestType = inboundRequestType ?? entry.requestType;
    const capabilities = inboundCapabilities ?? entry.capabilities;

    // Divergence check, before any work: the journal must describe the node the
    // walk actually wants to run, at the same iteration the walk re-derived. A
    // mismatch means the graph, configs, or code changed under the journal — fail
    // closed rather than continuing against stale state.
    if (replayEntry && (replayEntry.configKey !== key || replayEntry.iteration !== iteration)) {
      replayDiverged = {
        atIndex: runs.length,
        expected: `${replayEntry.configKey}#${replayEntry.iteration}`,
        actual: `${key}#${iteration}`,
        detail:
          "the journal does not describe the node this walk re-derived — the served graph, the agent configs, or the walker's routing changed under it. A fresh run is required.",
      };
      onEvent?.({ type: "replay-diverged", info: replayDiverged });
      break;
    }

    onEvent?.({ type: "node-start", configKey: key, index: runs.length });
    // One tracker per node run, shared between the runner (generation metrics) and
    // the judge hook (evaluation scores) so both land on the same AI run. A replayed
    // node creates NO tracker: its metrics were recorded by the original walk, and
    // re-recording double-counts the per-variation AI Config monitoring data.
    const tracker = replaying ? undefined : cfg.createTracker();
    // Consume the loop trigger set when the edge INTO this node was taken. Cleared
    // on read so it can't leak into a later node's preamble (a forward re-entry at
    // iteration > 1 legitimately has no trigger).
    const trigger = pendingLoopTrigger;
    pendingLoopTrigger = undefined;
    // Human guidance is delivered to the first LIVE node only.
    const humanFeedback = replaying ? undefined : pendingHumanFeedback;
    if (!replaying) pendingHumanFeedback = undefined;
    const prompt = buildPrompt(
      key === rootKey,
      inboundHandoff !== undefined,
      iteration,
      inventory,
      ctx,
      trigger,
      humanFeedback,
    );
    const result: AgentNodeResult = replayEntry
      ? {
          status: replayEntry.status,
          // The recorded final text, re-wrapped so the rest of the loop (which reads
          // it via lastAssistantText) is identical on a replayed and a live run.
          messages: [{ role: "assistant", content: replayEntry.output, isFinal: true }],
          tags: replayEntry.tags,
        }
      : await runner.runNode({
      configKey: key,
      prompt,
      ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
      ...(cfg.model?.name ? { model: cfg.model.name } : {}),
      ...(cfg.model?.parameters ? { modelParameters: cfg.model.parameters } : {}),
      ...(tracker ? { tracker } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(requestType ? { requestType } : {}),
      ...(capabilities ? { capabilities } : {}),
      // Tool attachments from the LD variation (interface overrides; ADR 0011).
      ...(cfg.tools && Object.keys(cfg.tools).length > 0 ? { ldTools: cfg.tools } : {}),
    });

    Object.assign(accumulatedTags, result.tags);
    // Mirror tool-produced facts into the never-rewound inventory.
    for (const [k, v] of Object.entries(result.tags)) if (FACT_TAGS.has(k)) inventory[k] = v;
    const output = lastAssistantText(result);
    ctx.PREVIOUS_STEP_OUTPUT = output;
    const run: NodeRun = { configKey: key, status: result.status, output, tags: result.tags, iteration };
    // A replayed node's scores come from the journal, because the hook below is
    // skipped. This is what keeps judge-driven ROUTING deterministic across a
    // resume; drop it and the loop edge silently fails open on replay.
    if (replayEntry?.judgeScores && Object.keys(replayEntry.judgeScores).length > 0) {
      run.judgeScores = { ...replayEntry.judgeScores };
      if (replayEntry.judgeReasoning) run.judgeReasoning = replayEntry.judgeReasoning;
    }
    runs.push(run);
    onEvent?.({ type: "node-complete", configKey: key, index: runs.length - 1, run });

    // Judges attached to this node's config (if any) score the output now, on
    // the same tracker. Defensive: a judge problem must never break the walk.
    // Skipped on replay: the scores were recorded by the original walk (and served
    // from the journal above), so re-running them would double-record on the
    // tracker without changing any decision.
    //
    // Ordering note: this runs AFTER runs.push + node-complete on purpose — moving
    // it earlier would delay the "step done" event by a full judge call on every
    // surface. Scores are therefore attached by mutating the pushed run, which is
    // the same object reference and leaves routingSnapshots alignment untouched.
    if (judgeHook && tracker) {
      let judgeResults: Awaited<ReturnType<JudgeHook>> = [];
      try {
        judgeResults = await judgeHook({ configKey: key, iteration, cfg, input: prompt, output, tracker });
      } catch (e) {
        console.warn(`[judge] hook failed for '${key}' (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
      const scores = usableJudgeScores(judgeResults);
      if (Object.keys(scores).length > 0) {
        run.judgeScores = scores;
        // The reasoning that goes with the score a loop edge would fire on.
        const lowestKey = Object.entries(scores).reduce((lo, e) => (e[1] < lo[1] ? e : lo))[0];
        const reasoning = judgeResults.find((r) => (r.judgeConfigKey ?? "judge") === lowestKey)?.reasoning;
        if (reasoning) run.judgeReasoning = reasoning.slice(0, JUDGE_REASONING_MAX);
      }
      // The sampling hazard, surfaced at runtime because it can't be a build check:
      // `samplingRate` lives in LaunchDarkly, not the repo. If a node routes on a
      // judge score and none came back, the loop silently won't fire and quality
      // goes unverified — so say so loudly rather than proceeding quietly.
      const routesOnJudge = node.getEdges().some((e) => handoffNumber(e.handoff, "loop_if_judge_below") !== undefined);
      if (routesOnJudge && Object.keys(scores).length === 0) {
        console.warn(
          `[judge] '${key}' has a judge-driven loop edge but produced NO usable score ` +
            `(unsampled, failed, or no judge attached) — the quality loop cannot fire and this run is unverified.`,
        );
      }
    }

    // Deterministic handoff shim: re-derive this node's claims from primary
    // evidence. A FAILED check halts the walk — downstream agents must not
    // build on an unverified claim. (A shim implementation bug — an unexpected
    // throw — logs and does not halt; evidential failures are reported inside
    // the verification, not thrown.)
    // Skipped on replay: a verification failure is not resumable, so every node in
    // an accepted journal already passed. Re-running the shims against a checkout
    // that may have moved is what the caller's invalidation keys are for.
    if (verifier && !replaying) {
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

    // Pick the next edge whose handoff conditions pass. Only edges carrying
    // `max_visits` (the author-designated loop edges) are budget-capped; untagged
    // forward/rejoin edges are never blocked, so forward progress can't stall.
    let next: string | null = null;
    let nextHandoff: Record<string, unknown> | undefined;
    let nextIsLoopEdge = false;
    // The judge threshold the taken loop edge fired on, for the trigger message.
    let nextJudgeThreshold: number | undefined;
    // A resume grant applies only once the journal is spent — i.e. at the frontier
    // and beyond. NOT `!replaying`: the exhausted edge's budget check happens during
    // the LAST journalled iteration (the run is already pushed, so runs.length has
    // caught up), so gating on `replaying` would stop the grant from ever firing.
    // Gating on journal-consumed instead means replayed steps re-derive the ORIGINAL
    // budget decisions — otherwise a grant on a mid-journal edge would make replay
    // take a loop the first walk fell through, and report that as divergence.
    const journalConsumed = runs.length >= journal.length;
    const budgetBlocked: LoopExhaustedInfo["exhausted"] = [];
    for (const edge of node.getEdges()) {
      const h = edge.handoff;
      const isLoop = handoffNumber(h, "max_visits") !== undefined;
      // A LOOP edge's ROUTING conditions must be satisfied by the just-completed
      // run's OWN tags, not by whatever is left in accumulatedTags.
      //
      // Why: routing tags are exactly the ones that go stale (it's why they're
      // rewound). Matching a loop condition against accumulatedTags means a verdict
      // from iteration 1, re-overlaid by the rewind, can re-fire the loop when the
      // node that owns that verdict said nothing this time — burning a full live
      // iteration per pass and then attributing it to a critique nobody made. FACT
      // tags are exempt: they're never rewound and legitimately come from upstream
      // nodes, so a loop edge may still gate on e.g. flag_ready.
      const matchAgainst = isLoop ? withFreshRouting(accumulatedTags, result.tags) : accumulatedTags;
      const require = handoffTags(h, "require_tags");
      if (require && !tagsMatch(matchAgainst, require)) {
        warnIfOnlyStaleWouldMatch(isLoop, key, edge.key, "require_tags", require, accumulatedTags, matchAgainst);
        continue;
      }
      const skip = handoffTags(h, "skip_if_tags");
      if (skip && tagsMatch(matchAgainst, skip)) continue;
      // Quality gate: take this edge only when the just-completed node scored BELOW
      // the threshold. FAIL-OPEN — no usable score means no signal, so the edge is
      // not taken (an unsampled or broken judge must never trigger rework).
      const below = handoffNumber(h, "loop_if_judge_below");
      if (below !== undefined) {
        const score = routingJudgeScore(run.judgeScores);
        if (score === undefined || score >= below) continue;
      }
      const rawMax = handoffNumber(h, "max_visits");
      if (rawMax !== undefined) {
        const ek = `${key}→${edge.key}`;
        // Prior grants apply everywhere (so replay re-derives the original
        // decisions); a NEW grant applies only from the frontier on. The hard cap
        // still clamps the total, so a grant raises a ceiling but never removes it.
        const priorGrant = Math.max(0, Math.floor(resume?.priorExtraVisits?.[ek] ?? 0));
        const newGrant = journalConsumed ? Math.max(0, Math.floor(resume?.extraVisits?.[ek] ?? 0)) : 0;
        const grant = priorGrant + newGrant;
        const maxVisits = Math.min(Math.max(1, Math.floor(rawMax)) + grant, MAX_VISITS_HARD_CAP);
        const traversals = edgeCounts.get(ek) ?? 0;
        if (traversals >= maxVisits) {
          const trig = describeJudgeCondition(h, run.judgeScores) ?? describeLoopCondition(h);
          const spent = {
            source: key,
            target: edge.key,
            traversals,
            maxVisits,
            ...(trig ? { trigger: trig } : {}),
          };
          budgetBlocked.push(spent);
          // Recorded whether or not the walk continues past this edge. An advisory
          // loop (one whose node also has a forward edge) falls through and finishes
          // normally, so this is the only place that "we gave up on quality" is
          // written down. Keyed per edge so a revisited node doesn't duplicate it.
          budgetSpent.set(`${key}→${edge.key}`, spent);
          continue;
        }
      }
      next = edge.key;
      nextHandoff = h;
      nextIsLoopEdge = rawMax !== undefined;
      nextJudgeThreshold = handoffNumber(h, "loop_if_judge_below");
      break;
    }

    // No edge taken: distinguish a loop that exhausted its budget (a loop edge
    // passed its conditions but is spent) from a genuine terminal / intentional
    // skip / real stall (a required tag was never satisfied).
    if (!next) {
      const edges = node.getEdges();
      const unmet: UnmetEdge[] = [];
      for (const edge of edges) {
        const h = edge.handoff;
        const skip = handoffTags(h, "skip_if_tags");
        if (skip && tagsMatch(accumulatedTags, skip)) continue; // intentionally skipped
        // A LOOP edge whose conditions are unmet is CONVERGENCE, not a stall: the
        // rework trigger simply didn't fire (e.g. the reviewer approved). Without
        // this, giving a previously-terminal node a loop-back edge would report
        // every clean run as stalled. The dual of the rule in the edge-selection
        // loop above: untagged forward edges are never budget-capped, and
        // max_visits edges never manufacture a stall. Budget-spent loop edges are
        // still reported — via budgetBlocked/loopExhausted, not here.
        if (handoffNumber(h, "max_visits") !== undefined) continue;
        const require = handoffTags(h, "require_tags");
        if (require && !tagsMatch(accumulatedTags, require)) {
          const requireMissing: Record<string, string> = {};
          for (const [k, v] of Object.entries(require)) {
            if (accumulatedTags[k] !== v) requireMissing[k] = v;
          }
          unmet.push({ target: edge.key, requireMissing });
        }
      }
      if (budgetBlocked.length > 0) {
        loopExhausted = {
          node: key,
          reason: "budget",
          exhausted: budgetBlocked,
          ...(unmet.length > 0 ? { alsoUnmet: unmet } : {}),
          tags: { ...accumulatedTags },
        };
        onEvent?.({ type: "loop-exhausted", info: loopExhausted });
      } else if (unmet.length > 0) {
        stalledAt = { node: key, tags: { ...accumulatedTags }, unmet };
        onEvent?.({ type: "stalled", stall: stalledAt });
      }
    }

    // Taking a loop edge is an iteration boundary: rewind ROUTING tags to the
    // target's pre-run state, then overlay this (source) node's routing tags as
    // the trigger/feedback. Fact tags (inventory) are left at their latest values.
    // Forward/rejoin re-entries do NOT rewind — that would resurrect stale
    // iteration-1 routing state mid-iteration.
    if (next && nextIsLoopEdge) {
      let k = -1;
      for (let j = runs.length - 1; j >= 0; j--) {
        if (runs[j]?.configKey === next) {
          k = j;
          break;
        }
      }
      if (k >= 0) {
        const snap = routingSnapshots[k] ?? {};
        const sourceRouting = pickRouting(runs[runs.length - 1]?.tags ?? {});
        for (const rk of ROUTING_TAGS) delete accumulatedTags[rk];
        for (const [rk, rv] of Object.entries(snap)) accumulatedTags[rk] = rv;
        for (const [rk, rv] of Object.entries(sourceRouting)) accumulatedTags[rk] = rv;
      }
      const ek = `${key}→${next}`;
      edgeCounts.set(ek, (edgeCounts.get(ek) ?? 0) + 1);
      // Tell the re-entered node who sent it back and why. `detail` stays empty for
      // a verdict loop: the inbound brief already carries this node's full report.
      // A judge-driven edge describes itself with the runtime score; a tag-driven one
      // with the tags that matched. `detail` carries the judge's reasoning, which —
      // unlike a verdict loop's critique — is NOT in the inbound brief.
      const judgeReason = describeJudgeCondition(nextHandoff, run.judgeScores);
      pendingLoopTrigger = {
        source: key,
        reason: judgeReason ?? describeLoopCondition(nextHandoff) ?? "the loop edge fired (budget-bounded)",
        ...(nextJudgeThreshold !== undefined && run.judgeReasoning ? { detail: run.judgeReasoning } : {}),
      };
    }

    // Handoff metrics: recorded only when the SOURCE node ran live. If the source
    // was replayed, the original walk already recorded whatever edge it took, and
    // re-recording would double-count. Known undercount: when the journal ends at a
    // loop-exhausted node, the original took no edge, so the one handoff a grant now
    // unlocks goes untracked. Undercounting one edge beats inflating every replayed
    // one.
    if (next && !replaying) graphTracker?.trackHandoffSuccess(key, next);
    node = next ? graphDef.getNode(next) : null;
    inboundHandoff = nextHandoff;
  }

  // The journal must be fully consumed. Leftover entries mean the walk terminated
  // earlier than it did before — the graph changed under it, or an edge condition
  // now resolves differently. Same fail-closed treatment as a positional mismatch.
  if (!replayDiverged && runs.length < journal.length) {
    const nextEntry = journal[runs.length];
    replayDiverged = {
      atIndex: runs.length,
      expected: nextEntry ? `${nextEntry.configKey}#${nextEntry.iteration}` : "(entry)",
      actual: "(walk ended)",
      detail:
        "the walk terminated before consuming the whole journal — an edge condition or the graph changed. A fresh run is required.",
    };
    onEvent?.({ type: "replay-diverged", info: replayDiverged });
  }

  const reached = new Set(runs.map((r) => r.configKey));
  const skipped = allNodeKeys(graphDef).filter((k) => !reached.has(k));

  return {
    runs,
    tags: accumulatedTags,
    inventory,
    skipped,
    ...(stalledAt ? { stalledAt } : {}),
    ...(pendingApproval ? { pendingApproval } : {}),
    ...(verificationFailed ? { verificationFailed } : {}),
    ...(loopExhausted ? { loopExhausted } : {}),
    ...(replayDiverged ? { replayDiverged } : {}),
    ...(budgetSpent.size > 0 ? { loopBudgetSpent: [...budgetSpent.values()] } : {}),
  };
}
