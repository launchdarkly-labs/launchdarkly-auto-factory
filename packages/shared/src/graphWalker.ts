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
 * trackers, plus graph-level ("global") metrics on the graph tracker once the walk
 * finishes: invocation success/failure, total duration, the path taken, and
 * aggregate token usage summed from the per-node trackers.
 */

import type { AgentGraphDefinition, AgentGraphNode, LDGraphTracker, LDTokenUsage } from "@launchdarkly/server-sdk-ai";
import type { AgentNodeResult, AgentRunner } from "./agentRunner.js";
import type { HandoffVerification, HandoffVerifier } from "./handoffVerifier.js";
import type { JudgeHook } from "./judges.js";
import { startHandoffSpan } from "./observability.js";

/** Bound on a journalled judge `reasoning` string, so the resume journal stays small. */
const JUDGE_REASONING_MAX = 1000;

/** Hard ceiling on any declared `max_visits`, so config can't remove the guarantee. */
export const MAX_VISITS_HARD_CAP = 10;

/**
 * The `max_visits` declared on the edge keyed `${source}→${target}`, or undefined if the
 * edge doesn't exist or isn't a loop edge. Lets a caller tell whether a grant could raise
 * that edge's ceiling at all, rather than issuing one the hard cap silently swallows.
 */
export function declaredMaxVisits(graphDef: AgentGraphDefinition, edgeKey: string): number | undefined {
  const [source, target] = edgeKey.split("→");
  if (!source || !target) return undefined;
  const node = graphDef.getNode(source);
  const edge = node?.getEdges().find((e) => e.key === target);
  return edge ? handoffNumber(edge.handoff, "max_visits") : undefined;
}

/**
 * Tags produced by the LLM (routing/verdict) — REWOUND when a loop edge re-enters
 * a node, so a re-run starts from the routing state that preceded the target's
 * last run rather than inheriting stale downstream decisions. Mirrors tags.json
 * `production: "llm"`. A check-configs case asserts this stays in sync.
 *
 * KEEP QUOTED LOWERCASE STRINGS OUT OF THE SET BODY BELOW, comments included: check-configs
 * parses the members with a regex over the literal, so a comment quoting a tag class read as a
 * member and failed the build with `ROUTING_TAGS has 'llm'`. That is the cost of a source-text
 * lint, and the reason the prose about individual members lives up here.
 *
 * `sentry_guardrail` arrived with the Sentry guardrail work (ADR 0014) on `main`, which had no
 * loop to rewind for. It belongs in this class because it is LLM-produced and is the
 * metrics-author's claim about the pass it just made, not a durable fact about a created
 * resource. An earlier note here justified it instead with a handoff-verifier scenario — a stale
 * `true` verified as fresh on iteration 2 — and that scenario is FALSE twice over: the verifier
 * is called with `result.tags`, the just-completed run's own tags, so nothing left in
 * `accumulatedTags` can reach it whatever its class; and on the metrics-author SELF-loop the
 * rewind re-overlays the source's own routing tags afterwards, so the value survives regardless.
 * The classification is right; the argument for it was not.
 */
const ROUTING_TAGS = new Set<string>([
  "skip_flagging",
  "flag_worthy",
  "flag_action",
  "needs_tests",
  "review_approved",
  "risk_level",
  "risk_score",
  // See the note above this Set for why (ADR 0014).
  "sentry_guardrail",
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
  /**
   * Loop edges the SERVED graph declared AFTER a non-loop edge from the same source.
   * This is an ORDERING record, not a proof that the loop is dead — the distinction
   * matters and the first version of this comment got it wrong:
   *
   *  - If the forward edge ahead of it PASSES, the loop is unreachable: dead config
   *    that produces a walk which looks perfect — no extra runs, no loopBudgetSpent,
   *    no loopExhausted, and a quality retry that simply never happened.
   *  - If that forward edge is condition-gated and fails its own conditions, selection
   *    falls through and the loop fires normally. The record is still correct as an
   *    ordering violation (6e rejects the ordering unconditionally), but nothing was
   *    lost on this walk.
   *
   * Narrowing this to UNCONDITIONAL forward edges would remove that second case and is
   * the obvious-looking improvement — do not make it. The committed graph's own
   * shadowable edge is `metrics-author → flag-testing`, gated on `needs_tests`, a tag
   * the metrics author always emits: narrowing would make the guard skip the one edge
   * in the graph it exists to protect. Informational, never a failure.
   *
   * Why it lives here and not only in a log: `check-configs` 6e already rejects this
   * ordering in the COMMITTED graph, so anything this catches is a served-vs-committed
   * divergence (a dashboard edit, or a seed from another project) — and REST GET's edge
   * order is not faithful enough for `bridge upgrade` to catch it instead. See
   * docs/loopback-handoff.md 7a. Reported on the same surfaces as loopBudgetSpent,
   * because a retry that silently did not happen is invisible unless something says so.
   */
  loopEdgeShadowed?: Array<{
    /** The source node whose edge list is mis-ordered. */
    source: string;
    /** The loop edge that may be unreachable (target config key). */
    target: string;
    /**
     * The FIRST non-loop edge declared ahead of it. Selection reaches this edge before
     * the loop; whether it is actually TAKEN depends on its own handoff conditions, so
     * this names the edge that orders ahead — not one proven to have won.
     */
    precededBy: string;
  }>;
}

/**
 * The ONE statement of the loop-edge ordering rule, referenced by both halves that
 * enforce it: `check-configs` 6e (committed graph, fails the build) and the walker's
 * served-graph record (`WalkResult.loopEdgeShadowed`). check-configs 6h asserts this
 * marker and the walker's wiring still exist, which makes SILENT REMOVAL of the served
 * half fail the build — the repo has corrected the same claim in three of four places
 * eleven times, and this is the cheap way not to.
 *
 * It is not proof the two agree: 6h is a source-text lint, so it cannot see a mechanism
 * that is present but broken. `tests/loopEdgeOrder.test.ts` is what actually exercises
 * the behaviour end to end; 6h only stops the wiring disappearing under a refactor.
 */
export const LOOP_EDGE_SHADOWED_RULE =
  "a loop edge (max_visits) must be declared BEFORE every non-loop edge from the same source, " +
  "because edge selection takes the first passing edge and breaks";

/**
 * Scan one node's SERVED edge list for loop edges declared after a non-loop edge, and
 * record each once per walk. Must run before edge selection, not inside it: selection
 * stops at the first passing edge, which is precisely the edge doing the shadowing.
 */
function recordShadowedLoopEdges(
  nodeKey: string,
  node: AgentGraphNode,
  into: NonNullable<WalkResult["loopEdgeShadowed"]>,
  warned: Set<string>,
): void {
  let precededBy: string | undefined;
  for (const edge of node.getEdges()) {
    const isLoop = handoffNumber(edge.handoff, "max_visits") !== undefined;
    if (!isLoop) {
      // The FIRST forward edge is the one that shadows: selection reaches it first.
      precededBy ??= edge.key;
      continue;
    }
    if (precededBy === undefined) continue;
    // Keyed by (source, TARGET), not per edge: on a served graph `edge.key` IS the
    // target config key, so two loop edges from one source to the same target — legal,
    // and each carrying its own conditions — collapse to one record. Accepted, and
    // stated rather than hidden: `edgeCounts` below keys traversals the same way, where
    // the consequence is larger (a shared budget), so narrowing it here alone would put
    // two different notions of edge identity in one file. Unreachable in the committed
    // graph; recorded as a known gap in docs/loopback-handoff.md 7a.1.
    const seenKey = `${nodeKey}→${edge.key}`;
    if (warned.has(seenKey)) continue;
    warned.add(seenKey);
    const entry = { source: nodeKey, target: edge.key, precededBy };
    into.push(entry);
    console.warn(`[loop] ${describeLoopEdgeShadowed([entry])[0]}`);
  }
}

/**
 * One line per loop edge the served graph may have made unreachable by ordering.
 *
 * The remediation half is load-bearing and was WRONG in the first version: it advised
 * `bridge upgrade`, which cannot repair this. `upgrade` compares graphs through
 * `ownedGraphShape`, which key-sorts edges before comparing — the sort 7a established
 * must stay — so an order-only difference produces an identical shape and it skips the
 * write entirely, reporting no changes. Advice that visibly does nothing is worse than
 * no advice: it teaches the reader to dismiss the warning.
 */
export function describeLoopEdgeShadowed(shadowed: NonNullable<WalkResult["loopEdgeShadowed"]>): string[] {
  return shadowed.map(
    (s) =>
      `loop edge ${s.source} → ${s.target} is declared AFTER the forward edge to ${s.precededBy} in the graph ` +
      `LaunchDarkly SERVES, so it may never fire (${LOOP_EDGE_SHADOWED_RULE}). The committed graph is checked ` +
      `by check-configs 6e, so this is served-vs-committed drift: fix the edge order in LaunchDarkly. ` +
      `'bridge upgrade' will NOT repair it — its graph comparison sorts edges by key, so it reports no changes ` +
      `for an order-only difference (docs/loopback-handoff.md 7a).`,
  );
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

/**
 * Handoff fields the walker reads as NUMBERS and silently ignores when they are not one,
 * changing control flow as it does so. Each entry says what is lost, because the two
 * losses are opposite and a reader chasing the wrong symptom wastes the warning.
 *
 * `check-configs` 6a/6d reject a non-numeric value in the COMMITTED graph. The walker
 * executes the graph LaunchDarkly SERVES, and its own test for "is this a loop edge" is
 * `typeof === "number"` — so the two disagree exactly where nothing validates. A dashboard
 * edit that stores `max_visits: "2"` therefore makes the edge not a loop edge at all: no
 * budget, no `loopBudgetSpent`, no exit-tag warning (all of those are gated on the edge
 * being RECOGNISED), and `loopExhausted.reason` comes back as the generic `run-cap`. A
 * bounded walk measured at 10 runs became 44 — the run cap is the only thing that stopped
 * it, and nothing said why.
 *
 * Deliberately a WARNING and not a coercion. Reading `"2"` as 2 would make the walker
 * accept input the validator rejects, which is a second definition of a loop edge and the
 * very drift being closed here. The walker's job is to NOTICE what the validator refuses.
 *
 * DELIBERATELY NOT EVERY silently-ignored field. `max_turns` (`handoffNumber`),
 * `request_type` (`handoffString`) and `capabilities` (`handoffStringArray`) drift the same
 * silent way, and are left out because what they lose is the run ENVELOPE — the node falls
 * back to the entry edge's recorded fields and then to the runner's defaults — which cannot
 * change loop recognition, termination, or budget reporting. The two fields here are the
 * ones whose loss is invisible AND alters control flow. Stated because an earlier account
 * of this change claimed the exclusions were named in a comment when they were not, which
 * is the same over-claim this file's history is full of.
 */
const NUMERIC_HANDOFF_FIELDS: ReadonlyArray<{ field: string; lost: string }> = [
  {
    field: "max_visits",
    lost:
      "this edge is NOT budget-capped — it is treated as an ordinary forward edge, so the loop is bounded " +
      "only by the run-level cap and no loop-budget report is produced",
  },
  {
    field: "loop_if_judge_below",
    lost:
      "this edge no longer gates on the judge score — it fires whenever its tag conditions pass, so rework " +
      "is triggered without any quality signal",
  },
];

/**
 * Render a rejected value for the message without ever being the reason the walk stops.
 *
 * `JSON.stringify` THROWS on a BigInt and on a circular structure. A served graph arrives as
 * parsed JSON so neither is reachable in production, but a programmatically built
 * `AgentGraphDefinition` — tests, and any future harness — can hold both, and a warning that
 * crashes the walk it is describing is strictly worse than the silence it replaced. `String`
 * is total for every value that reaches here, including symbols (unlike interpolation).
 */
function describeRejectedValue(raw: unknown): string {
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Warn once per edge+field when a numeric handoff field is present but is not a number.
 *
 * Once per walk rather than per pass: the condition is a property of the served graph, not
 * of this iteration, so repeating it per traversal would bury the run it belongs to.
 */
function warnIfMalformedNumericHandoff(
  source: string,
  target: string,
  handoff: Record<string, unknown> | undefined,
  warned: Set<string>,
): void {
  for (const { field, lost } of NUMERIC_HANDOFF_FIELDS) {
    const raw = handoff?.[field];
    if (raw === undefined || typeof raw === "number") continue;
    const wk = `${source}→${target}#${field}`;
    if (warned.has(wk)) continue;
    warned.add(wk);
    console.warn(
      `[loop] edge ${source} → ${target} has ${field}=${describeRejectedValue(raw)}, which is ` +
        `${Array.isArray(raw) ? "an array" : typeof raw} and not a number, so the walker IGNORES it: ${lost}. ` +
        `The committed-config check rejects this, so it came from the SERVED graph — ` +
        `run 'npm run bridge -- upgrade' to restore the committed value.`,
    );
  }
}

/**
 * Extra traversals granted to `edge` for a budget decision taken after `runsConsumed` runs.
 * Clamped non-negative and integral; the caller still applies the hard cap.
 */
function grantedVisits(grants: readonly LoopGrant[] | undefined, edge: string, runsConsumed: number): number {
  let total = 0;
  for (const g of grants ?? []) {
    if (g.edge === edge && runsConsumed >= g.effectiveAfterRuns) {
      total += Math.max(0, Math.floor(g.visits));
    }
  }
  return total;
}

/** Merge two comma-separated key lists, deduped, order-stable, whitespace-tolerant. */
function unionCsv(existing: string | undefined, incoming: string): string {
  const split = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return [...new Set([...split(existing), ...split(incoming)])].join(",");
}

/**
 * Routing tags a loop edge's `skip_if_tags` exit names that the source run did not emit.
 * Empty when the exit is reachable as far as this pass shows.
 */
function unemittedExitTags(
  skip: Record<string, string> | undefined,
  fresh: Record<string, string>,
): string[] {
  if (!skip) return [];
  return Object.keys(skip).filter((k) => ROUTING_TAGS.has(k) && fresh[k] === undefined);
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
/** A human-granted increase to one loop edge's budget, from a point in the journal on. */
export interface LoopGrant {
  /** Edge key, `${source}→${target}`. */
  edge: string;
  /** Extra traversals granted. */
  visits: number;
  /**
   * The grant applies to budget decisions made once this many runs have been recorded.
   *
   * Off-by-one warning, learned the hard way: the walker pushes a node's run BEFORE
   * selecting the next edge, so the decision that follows journal entry `j` executes with
   * `runs.length === j + 1`. A grant issued when the journal held `L` entries therefore
   * first applied at the selection where `runs.length === L`. The predicate is
   * `runs.length >= effectiveAfterRuns` — expressed in entries CONSUMED, not entry index,
   * which is also exactly the existing frontier test (`runs.length >= journal.length`).
   */
  effectiveAfterRuns: number;
}

export interface ResumeInput {
  /**
   * Node results from the interrupted walk, in order — `WalkResult.runs` verbatim.
   * `iteration` is re-derived rather than trusted, and a mismatch is treated as
   * divergence.
   */
  journal: readonly NodeRun[];
  /**
   * Loop-budget grants, each stamped with the point in the journal from which it took
   * effect. ONE list covers both the grants already in force for the recorded walk and
   * the new grant this resume adds — a new grant is simply one whose
   * `effectiveAfterRuns` equals the journal's length.
   *
   * POSITION is the whole point. Two earlier shapes failed:
   *
   *  - not journalling grants at all, so a granted traversal recorded in the journal was
   *    budget-blocked on the next replay and reported as divergence;
   *  - journalling them as a flat per-edge total applied uniformly, justified by "for an
   *    edge that ended the walk, its first budget-block IS the halt". That is false
   *    whenever the halting node has a second loop edge (or a forward edge whose
   *    conditions change across iterations): the first edge gets blocked mid-journal
   *    while the other keeps the walk moving, both are recorded as exhausted, and a grant
   *    on the first then un-blocks its earlier position on replay — diverging forever.
   *
   * With positions there is no premise about walk shape left to be wrong about.
   */
  grants?: readonly LoopGrant[];
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
  // Per-edge: warned about an unemitted exit tag already (once per walk, not per pass).
  const exitWarned = new Set<string>();
  // Per edge+field: warned that a numeric handoff field is not a number (see
  // NUMERIC_HANDOFF_FIELDS). Keyed with the field so max_visits and
  // loop_if_judge_below on one edge each get said once.
  const malformedHandoffWarned = new Set<string>();
  // Per-edge: every traversal so far was taken while its exit tag went unemitted. Lets the
  // categorical "the exit never had a chance" claim be a RECORD at exhaustion rather than a
  // prediction from one pass.
  const exitNeverPossible = new Map<string, boolean>();
  // Routing-tag state captured just before each run (parallel to `runs`), so a
  // loop re-entry can restore the target's pre-run routing state.
  const routingSnapshots: Array<Record<string, string>> = [];
  // The edge-carried envelope (max_turns/request_type/capabilities) recorded on a
  // node's first entry, inherited on re-entry when the loop edge omits a field.
  const entryEdgeFields = new Map<string, { maxTurns?: number; requestType?: string; capabilities?: string[] }>();
  // Per-node execution count, for the `iteration` label and the rework preamble.
  const runCountByKey = new Map<string, number>();
  // Loop edges the served graph declared after a forward edge from the same source, and
  // the once-per-edge guard for saying so (the condition is a property of the served
  // graph, not of any one traversal — same reasoning as malformedHandoffWarned).
  const loopEdgeShadowed: NonNullable<WalkResult["loopEdgeShadowed"]> = [];
  const shadowWarned = new Set<string>();

  const rootKey = graphDef.getConfig().root;
  // Run-level termination backstop, scaled to graph size (nodeCount × (hardCap+1));
  // the true control is the per-loop-edge cap. Guards untagged cycles and a
  // maliciously edited served graph. NOT a guarantee of never preempting a legal
  // walk: a graph that chains several long loop segments can in principle exceed
  // this within its per-edge budgets. Unreachable with the committed graph even at
  // maximum grants (~56 runs vs a cap of 66), and tripping early fails SAFE — the
  // walk reports loopExhausted (run-cap), never a false success.
  const maxTotalNodeRuns = Math.max(1, allNodeKeys(graphDef).length) * (MAX_VISITS_HARD_CAP + 1);
  let totalRuns = 0;
  const startMs = Date.now();
  // Did ANY node come from the journal rather than run here? Gates the graph-level metrics
  // below, which describe a whole walk and cannot describe half of one.
  let anyReplayed = false;
  // Aggregate token usage across the whole walk, summed from each node
  // tracker's summary after its run (the runner records tokens on the tracker).
  const totalTokens: LDTokenUsage = { total: 0, input: 0, output: 0 };

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
    if (replaying) anyReplayed = true;

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

    // Roll this node's token usage into the graph-level aggregate. Defensive:
    // a metrics read must never break the walk (and some providers record no
    // tokens, in which case the summary simply has none).
    try {
      // `tracker?` — optional on this branch: a REPLAYED node runs no tracker at all.
      const nodeTokens = tracker?.getSummary?.().tokens;
      if (nodeTokens) {
        totalTokens.total += nodeTokens.total;
        totalTokens.input += nodeTokens.input;
        totalTokens.output += nodeTokens.output;
      }
    } catch {
      /* ignore — node metrics still landed via the node tracker itself */
    }

    Object.assign(accumulatedTags, result.tags);
    // Mirror tool-produced facts into the never-rewound inventory.
    for (const [k, v] of Object.entries(result.tags)) {
      if (!FACT_TAGS.has(k)) continue;
      // `metric_keys` ACCUMULATES across iterations; every other fact is last-write-wins.
      //
      // Why the exception: the tool executor is per node run, so a re-run's `metric_keys`
      // lists only what THAT run created. Last-write-wins therefore hides iteration 1's
      // metrics the moment a rework creates another one — the links go missing and the
      // run looks like it created fewer resources than it did. Union keeps the record
      // honest. NOT applied to `metric_event_keys`: the handoff verifier greps the
      // checkout for an emitter of each, and resurrecting an earlier iteration's event
      // key would assert an emitter that may no longer exist.
      inventory[k] = k === "metric_keys" ? unionCsv(inventory[k], v) : v;
    }
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
    //
    // A FAILED node is never judged either: its "output" is an error string (e.g.
    // "Request timed out."), so a score would measure infrastructure luck, not agent
    // quality — observed live as a misleading 0.00 on work that had actually landed.
    // The failure itself is still recorded via trackError. It matters more here than on
    // a DAG: a judge-driven loop edge routes on that score, so scoring an infra failure
    // would spend a quality iteration on a run that produced no work to improve.
    if (judgeHook && result.status === "failed") {
      console.log(`[judge] ${key}: node failed (infra/API error) — judges skipped, no score recorded`);
    } else if (judgeHook && tracker) {
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
    // Set when this edge was taken because the source run FAILED rather than because a
    // condition matched — the trigger message and the exit-tag bookkeeping both need to know,
    // since neither has any tag evidence to describe.
    let nextIsFailureRetry = false;
    // The judge threshold the taken loop edge fired on, for the trigger message.
    let nextJudgeThreshold: number | undefined;
    // Runs recorded so far. Both the frontier test and each grant's effective point are
    // expressed against this — see LoopGrant.effectiveAfterRuns for why it is entries
    // CONSUMED rather than an entry index.
    const runsConsumed = runs.length;
    // THE budget rule, read by both selection passes below (conditions, then failure-retry).
    // Extracted rather than restated: two copies of "floor(max_visits) + grants, capped" is
    // exactly how a granted traversal becomes reachable in one pass and blocked in the other,
    // which the grant-POSITION history in `ResumeInput` says is the bug that took longest to
    // find. Sums only the grants in force at THIS point of the walk, so a replay re-derives
    // the original decisions with no premise about the graph's shape.
    const loopBudgetFor = (ek: string, rawMax: number): { traversals: number; maxVisits: number } => ({
      traversals: edgeCounts.get(ek) ?? 0,
      maxVisits: Math.min(
        Math.max(1, Math.floor(rawMax)) + grantedVisits(resume?.grants, ek, runsConsumed),
        MAX_VISITS_HARD_CAP,
      ),
    });
    const budgetBlocked: LoopExhaustedInfo["exhausted"] = [];
    // The SERVED counterpart of check-configs 6e (see LOOP_EDGE_SHADOWED_RULE): a loop
    // edge declared after a non-loop edge from the same source may never be reached,
    // because selection below takes the first passing edge and BREAKS. 6e enforces this
    // on the committed file; nothing enforced it on the graph LaunchDarkly SERVES, and
    // REST GET's edge order is not faithful enough for `bridge upgrade` to do it
    // (docs/loopback-handoff.md 7a). Recorded, not enforced: the walk is correct either
    // way. What it MAY have lost is a retry — "may", because a condition-gated forward
    // edge can fail its own conditions and let the loop fire anyway, so what this
    // records is the ORDERING (which 6e rejects unconditionally), not a dead loop. See
    // WalkResult.loopEdgeShadowed for why narrowing it to unconditional edges is wrong.
    //
    // A SEPARATE pass over the edges, deliberately: folding this into the selection
    // loop below cannot work, because that loop breaks at the first passing edge — the
    // forward edge that shadows the loop — so it would never reach the very edge it is
    // looking for. Written that way first, and the test caught it.
    recordShadowedLoopEdges(key, node, loopEdgeShadowed, shadowWarned);
    for (const edge of node.getEdges()) {
      const h = edge.handoff;
      const isLoop = handoffNumber(h, "max_visits") !== undefined;
      // Before any decision reads them: say so if a numeric field drifted to a non-number,
      // because every other signal about this edge (budget, loopBudgetSpent, the exit-tag
      // warnings) is gated on the recognition this would have silently lost.
      warnIfMalformedNumericHandoff(key, edge.key, h, malformedHandoffWarned);
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
        const { traversals, maxVisits } = loopBudgetFor(ek, rawMax);
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
          // Now earned: the exit named a tag the source never emitted across every
          // traversal, so it genuinely never had a chance. Unlike the per-pass note above,
          // this is a record of N iterations, which is why it can name the served graph.
          if (exitNeverPossible.get(ek) === true) {
            const named = Object.keys(handoffTags(h, "skip_if_tags") ?? {}).join(", ");
            console.warn(
              `[loop] ${key} → ${edge.key} exhausted ${traversals} iteration(s) and its exit (${named}) was ` +
                `never satisfiable — '${key}' emitted none of those tags on any pass. This edge can only ever ` +
                `end by budget; check the SERVED graph.`,
            );
          }
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

    // RETRY A FAILED RUN — and this is a SECOND PASS, which is the whole point.
    //
    // A run that fails emits an error string as its output, and its tag conditions and judge
    // score are usually absent, so nothing routes: one transient API error on a loop-carrying
    // node STALLED the walk with its retry budget completely unspent, where the same graph
    // pre-loop recovered on the next iteration. The loop that exists to buy another attempt
    // could not buy one, because a failure destroys exactly the evidence it routes on.
    //
    // WHY A SECOND PASS, and the first implementation got this wrong: expressed inside the
    // selection loop as a condition-bypass, the retry OUTRANKS every other edge — and on the
    // committed graph the self-loop is declared BEFORE the forward edge, because the ordering
    // invariant requires it. The runners return `tags: {...executor.tags}` on the failure path
    // too, so a node that fails LATE still carries the tags its tool calls produced; that node's
    // forward path is open and its work is done, and the bypass re-ran it anyway. Asking only
    // "did anything else route?" cannot be done from inside the loop that decides it — the same
    // shape as the shadowed-loop detection in §7a.1 of the handoff notes, which had to become a
    // separate pass for the same reason.
    //
    // ONLY `status: "failed"`, which is narrower than "did not complete". `AgentStatus` also has
    // `stopped` (the runners' turn-cap) and `cancelled`. Neither retries, deliberately: a turn cap
    // is not transient, and the retry would re-enter through the self-loop's own envelope — on the
    // committed graph a SMALLER `max_turns` than the forward edge's — so it would most likely stop
    // again, having spent a budget unit and another paid agent run. A turn-capped node therefore
    // still stalls, and that is the honest outcome; raising its `max_turns` is the fix.
    //
    // SELF-loops only (`edge.key === key`). "Run it again" needs no tag evidence to justify it.
    // A loop edge pointing ELSEWHERE does: code-reviewer → flag-implementer means "rework this,
    // here is the critique", and firing it for a reviewer that produced no critique would send
    // the implementer back to work with no findings. That case still stalls, which is honest —
    // the fix there is a self-loop on the reviewer, a graph change, not a walker guess.
    //
    // Budget: the SAME per-edge budget and grants as any other traversal (`loopBudgetFor`), so
    // retries are bounded, and a spent budget records `budgetBlocked` here so the walk reports
    // loopExhausted — an invocation FAILURE — rather than a stall. Note the shared budget is a
    // real coupling worth knowing: on `max_visits: 1`, one infra failure consumes the pass a
    // later low judge score would have used.
    if (!next && result.status === "failed") {
      for (const edge of node.getEdges()) {
        if (edge.key !== key) continue;
        const rawMax = handoffNumber(edge.handoff, "max_visits");
        if (rawMax === undefined) continue;
        // The exit condition still decides, even on a failed pass — the SAME argument that made
        // this a second pass. A late failure's tags are real evidence, so if they satisfy the
        // loop's own `skip_if_tags` the node has CONVERGED and re-running it would be a wasted
        // side-effecting pass over finished work. What the retry overrides is the absence of a
        // trigger (a missing judge score, an unmet require_tags); it must not override a
        // present, satisfied exit.
        const exit = handoffTags(edge.handoff, "skip_if_tags");
        if (exit && tagsMatch(withFreshRouting(accumulatedTags, result.tags), exit)) continue;
        const ek = `${key}→${edge.key}`;
        const { traversals, maxVisits } = loopBudgetFor(ek, rawMax);
        const trigger = "the previous attempt failed and its retry budget is spent";
        if (traversals >= maxVisits) {
          // Pass 1 can already have recorded this exact edge's exhaustion, with the condition that
          // actually fired. ONE edge, ONE record: pushing a second entry prints the edge twice in
          // `describeLoopExhausted` on all three report surfaces, and overwriting `budgetSpent`
          // relabels a quality exhaustion as a retry exhaustion. Dedup on the array rather than on
          // `budgetSpent` (which is walk-level) so `loopExhausted` is still reported here when an
          // earlier node iteration already spent the same edge.
          const spent = { source: key, target: edge.key, traversals, maxVisits, trigger };
          if (!budgetBlocked.some((b) => b.source === key && b.target === edge.key)) budgetBlocked.push(spent);
          if (!budgetSpent.has(ek)) budgetSpent.set(ek, spent);
          continue;
        }
        console.warn(
          `[loop] ${key} FAILED (infrastructure or API error) — retrying via its self-loop ` +
            `(${traversals + 1} of ${maxVisits}). No judge score is involved.`,
        );
        next = edge.key;
        nextHandoff = edge.handoff;
        nextIsLoopEdge = true;
        nextIsFailureRetry = true;
        break;
      }
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
        // Record each blocked edge as a failed handoff (the counterpart of the
        // trackHandoffSuccess fired when an edge IS taken). Intentional
        // skip_if short-circuits were filtered out above and are not failures.
        //
        // `!replaying` for the SAME reason the success side carries it, which this line was
        // missing: a replayed node's edges were already decided and recorded by the original
        // walk, so re-recording them double-counts. It mattered more here than on the success
        // side — a replay against a changed graph stalls at a replayed node, which is a
        // divergence to report, not a handoff that failed on this walk.
        if (!replaying) for (const u of unmet) graphTracker?.trackHandoffFailure(key, u.target);
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
      // Evidence-based, and only for an edge actually TAKEN: this pass really did burn an
      // iteration while the exit named a tag the source didn't emit. Stated as a
      // conditional ("if it never emits") rather than the categorical "can never exit",
      // because a tag emitted only on affirmative passes is legitimate — the definitive
      // version is asserted at exhaustion, where "never" is a record and not a prediction.
      //
      // A FAILURE RETRY does not draw the per-pass warning: the pass it describes did not choose
      // this edge on the evidence, it errored, so "taken while its exit named tags the source did
      // not emit" would be describing an attempt that never got to emit anything.
      //
      // But it is NOT exempt from the record, and the first version of this exemption repeated the
      // very premise the second-pass commit was written to disprove ("a failed run emits no tags").
      // A late failure DOES carry tags. So: if a retried pass emitted the exit tags, that is
      // positive evidence the exit is satisfiable, and it CLEARS the flag — otherwise the
      // categorical claim asserted at exhaustion ("emitted none of those tags on any pass") is
      // false and sends an operator to check a SERVED graph that has no defect. Absence of tags on
      // a failed pass remains evidence in neither direction, so that case leaves the flag alone.
      const exitUnemitted = unemittedExitTags(handoffTags(nextHandoff, "skip_if_tags"), result.tags);
      const unemitted = nextIsFailureRetry ? [] : exitUnemitted;
      // AND across traversals: true only if EVERY pass took this edge with its exit tag
      // unemitted. That turns "never" into a record by the time the budget runs out.
      if (!nextIsFailureRetry) {
        exitNeverPossible.set(ek, (exitNeverPossible.get(ek) ?? true) && exitUnemitted.length > 0);
      } else if (exitUnemitted.length === 0) {
        exitNeverPossible.set(ek, false);
      }
      if (unemitted.length > 0 && !exitWarned.has(ek)) {
        exitWarned.add(ek);
        console.warn(
          `[loop] ${key} → ${next}: iteration taken while its exit named routing tag(s) ` +
            `${unemitted.join(", ")}, which '${key}' did not emit this pass. If it never emits them, this ` +
            `loop can only end by exhausting its budget.`,
        );
      }
      const judgeReason = describeJudgeCondition(nextHandoff, run.judgeScores);
      pendingLoopTrigger = {
        source: key,
        reason: nextIsFailureRetry
          ? "the previous attempt FAILED (infrastructure or API error, not a quality verdict) — retrying"
          : judgeReason ?? describeLoopCondition(nextHandoff) ?? "the loop edge fired (budget-bounded)",
        ...(nextJudgeThreshold !== undefined && run.judgeReasoning ? { detail: run.judgeReasoning } : {}),
      };
    }

    // Handoff metrics: recorded only when the SOURCE node ran live. If the source
    // was replayed, the original walk already recorded whatever edge it took, and
    // re-recording would double-count. Known undercount: when the journal ends at a
    // loop-exhausted node, the original took no edge, so the one handoff a grant now
    // unlocks goes untracked. Undercounting one edge beats inflating every replayed
    // one. The Sentry/LD handoff SPAN is gated the same way and for the same reason: a
    // replayed edge is not a handoff that happened on this walk.
    if (next && !replaying) {
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

  // Graph-level ("global") metrics, alongside the per-node metrics recorded
  // above. A pause at an approval gate is NOT a finished invocation — emit
  // nothing graph-level for it: the post-approval re-run walks the chain on a
  // fresh tracker (fresh runId) and reports the complete run. Likewise skip
  // when nothing ran (e.g. a disabled graph): there is no invocation to score.
  // Defensive try/catch: metric emission must never fail the walk.
  //
  // `!anyReplayed` is the third condition, and it is the one that arrived with the loop
  // machinery rather than with these metrics. Every quantity here describes A WALK, and on a
  // resume only part of the walk happened in this process: `trackDuration` would time the tail
  // while `trackPath` reported the whole chain, `trackTotalTokens` would count only the live
  // runs (replayed nodes get no tracker), and the invocation verdict would be the SECOND one
  // emitted for one logical run — the original walk already emitted its own before it halted.
  // Measured, not feared: a loop-exhausted walk plus one `--resume` produced two
  // trackInvocationSuccess calls and a 10-entry path for 6 node runs.
  //
  // So a replaying walk emits nothing graph-level, the same treatment a pause gets, and for the
  // same reason: it is not a whole invocation. The cost is real and worth stating — a CLI
  // `--resume` that finishes the work contributes no graph-level metrics, so a graph routinely
  // driven through --resume under-reports invocations. The GitHub Action front end re-runs from
  // scratch (no journal), so it is unaffected. Double-counting one PR as two invocations, and
  // attributing the whole path's tokens to its tail, is the worse error: it corrupts the
  // aggregate for every consumer rather than omitting one row.
  if (graphTracker && !pendingApproval && !anyReplayed && runs.length > 0) {
    try {
      graphTracker.trackPath(runs.map((r) => r.configKey));
      graphTracker.trackDuration(Date.now() - startMs);
      if (totalTokens.total > 0) graphTracker.trackTotalTokens(totalTokens);
      // Success = the machinery finished cleanly: every node completed, no
      // stall, no deterministic-verification failure.
      //
      // "A reviewer REJECT is still an invocation success — the graph did its job" was true of the
      // DAG this predicate arrived on, and is only half true now. A reject that the rework loop
      // then converges IS a success. A reject that exhausts the rework budget ENDS the walk with
      // downstream nodes never run, and on the committed graph that is every twice-rejected PR —
      // so `!loopExhausted` below means the metric now moves with the business outcome in that
      // one case. Deliberate (see the paragraph on `loopExhausted`), and recorded in
      // docs/loopback-handoff.md §7b as an owner-visible consequence rather than left to be
      // discovered on a dashboard.
      //
      // `replayDiverged` joins that list because a divergent replay is not an
      // invocation at all: the walk is abandoned fail-closed and a fresh run is
      // required, so scoring it as a success would count one PR's machinery twice
      // and score the abandoned half clean. (Belt and braces now that the block is
      // gated on `!anyReplayed` — a divergence always involves a replayed run.)
      //
      // `loopExhausted` JOINS THE LIST TOO, and an earlier version of this comment argued the
      // opposite — that a spent budget is "the loop working as specified". That defends
      // `loopBudgetSpent`, which is ADVISORY and fires while the walk continues past an
      // advisory loop. This is the TERMINAL case: a loop edge passed its conditions, had no
      // budget left, and the walk ended there with downstream nodes never run.
      // `LoopExhaustedInfo`'s own docstring, twenty lines up, says the caller must NOT report
      // it as a clean success, and for `reason: "run-cap"` — the backstop against an untagged
      // or dashboard-corrupted cycle — reporting success would put a graph that cannot
      // terminate at a 100% invocation success rate.
      //
      // PER NODE'S LAST RUN, not every run, and this is what the failure retry forces. `runs` is
      // the resume journal, so a failed attempt stays in it forever; `runs.every(completed)` therefore
      // scored a walk that survived a transient error EXACTLY like one that died — making the
      // retry's entire success case invisible in the aggregate every front end feeds. A node whose
      // LAST run failed is still a failure; a node that failed and then completed is recovery,
      // which is the outcome the mechanism exists to produce.
      const lastRunByNode = new Map<string, (typeof runs)[number]>();
      for (const r of runs) lastRunByNode.set(r.configKey, r);
      const clean =
        !stalledAt &&
        !verificationFailed &&
        !replayDiverged &&
        !loopExhausted &&
        [...lastRunByNode.values()].every((r) => r.status === "completed");
      if (clean) graphTracker.trackInvocationSuccess();
      else graphTracker.trackInvocationFailure();
    } catch (e) {
      console.warn(`[graph-metrics] emission failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }
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
    ...(loopEdgeShadowed.length > 0 ? { loopEdgeShadowed } : {}),
  };
}
