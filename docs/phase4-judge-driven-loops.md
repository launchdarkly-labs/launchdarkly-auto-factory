# Phase 4 — Making the factory loop

**Status:** proposed (rev 2)
**Depends on:** Phase 1 (`31d2b86`), Phase 2 (`c647974`), Phase 3 (`d4a67c9`)
**Companion:** `docs/loop-shapes.md` — the loop taxonomy, triggers, and reachability
this sequence is derived from.

## Why

Phases 1–3 built bounded loops and made the whole pipeline loop-aware, but nothing
loops. Two gaps remain:

1. **No trigger.** No committed edge carries `max_visits`, so the graph is still a
   DAG. The loop machinery is live and tested but unexercised.
2. **Exhaustion is a dead end.** `loopExhausted` is terminal on all four surfaces;
   recovery means re-triggering from the root.

## Corrections from review (rev 1 → rev 2)

Rev 1 led with judge-driven loops and a `code-reviewer → flag-implementer` edge. Three
findings changed the sequence; recorded here so the reasoning is legible:

- **The reviewer has no judge attached.** Judges exist only on `flag-implementer`
  (`autofactory-judge-implementation-quality`) and `metrics-author`
  (`autofactory-judge-metrics-quality`), both `samplingRate: 1`. Combined with the
  fail-open rule, rev 1's flagship edge could never fire.
- **A judge scores the output of the node it is attached to.** So a judge-triggered
  edge means "*this* node did poorly," and the remedy is re-running *that* node.
  Judge-driven loops here are therefore **self-loops**, not long back-edges. Each node
  has exactly one judge, so rev 1's min-across-judges aggregation was policy for a
  case that does not exist.
- **`review_approved` is a peer verdict, not a self-report.** `code-reviewer` is a
  different node evaluating the implementer's work with the full diff in hand — the
  same independence property judges provide. It is forced by `NODE_REQUIRED_TAGS` and
  **no edge routes on it**. That makes it the cheapest correct first loop.

And the downstream effect that reordered the phase: `DEFAULT_GATED_STEPS =
["autofactory-flag-implementer"]` (`approvalPolicy.ts:42`), and the gate `break`s the
walk (`graphWalker.ts:372-376`). **The default loop target is the node gated by
default**, re-evaluated on every re-entry by design. So resumption is needed for
*gates today*, independent of loops — it is not merely the remedy for budget
exhaustion. Promoted from last to second.

Rev 1's `production: "judge"` tag class is dropped entirely; see Step 3.

---

# Step 1 — Verdict-driven loop

The first real loop, at near-zero cost. Two commits: config, then feedback.

## 1a. The edge (config only)

`config/agentcontrol/graphs/auto-factory.json`:

```json
{
  "key": "edge-autofactory-code-reviewer-autofactory-flag-implementer",
  "sourceConfig": "autofactory-code-reviewer",
  "targetConfig": "autofactory-flag-implementer",
  "handoff": {
    "max_visits": 2,
    "require_tags": { "review_approved": "false" },
    "max_turns": 20,
    "request_type": "Fix",
    "capabilities": ["create_flag", "flag_state", "edit_files", "write_manifest", "read_docs"]
  }
}
```

No walker changes. `check-configs` 6b (every cycle carries a budget) is satisfied.
`max_visits: 2` means at most one rework pass — start conservative and measure.

**Reachability.** The target is `[G]` by default, so this loop completes inside one
walk only where the gate resolves true: `yolo` mode, `risk-threshold` mode with
`risk_score` below the threshold, or the cursor extension path where Phase 3's
per-run answer cache (`extension.ts:151-171`) auto-answers iteration 2. On the Action
surface in `always` mode it halts at the gate with `pendingApproval`. That is the
concrete justification for Step 2 — and it means Step 1 should be demoed on the
extension/CLI path first.

**Known fragility, accepted for 1a.** `require_tags` is exact equality, but
`approval.ts:111-119` tolerates `approve`/`approved`/`true`/`rejected` because agents
drift off the instructed `true`/`false`. A drifted verdict silently fails to loop and
reports INCOMPLETE. That fails *safe*, so accept it here and revisit under Step 3's
derived-signal note rather than bolting on a normalizer now. Test 3 below pins the
behaviour so it is a known gap, not a surprise.

**Edge order is load-bearing.** The walker takes the first passing edge and `break`s
(`graphWalker.ts:496`). `code-reviewer` has no other outgoing edge, so 1a is safe —
but this stops being true the moment a loop edge is added to a node that also has a
forward edge (see Step 3). Whether `node.getEdges()` preserves JSON declaration order
is SDK-internal and **unverified**; verify before relying on it.

## 1b. Loop-trigger feedback into the rework preamble

A verdict loop without the reviewer's reasons is just "do it again." This is the one
code change Step 1 needs, and it is the part that makes any loop useful.

`reworkPreamble(iteration, inventory)` (`graphWalker.ts:242`) currently lists
inventory facts. Add a walker-held value, set when a loop edge is taken and consumed
by the target's next run:

```ts
lastLoopTrigger?: { source: string; reason: string; detail?: string }
```

For 1a, `reason` is the rejected verdict and `detail` is a truncated slice
(~1000 chars) of the reviewer's output — the actual critique. Rendered as a
`WHY THIS ITERATION` block above the existing facts.

**Do not put this in a tag.** Tags are `Record<string, string>`, feed edge matching,
and are registry-validated; prose has no business there. This same channel carries
judge reasoning (Step 3) and human feedback (Step 2), which is why it is built once,
here.

## 1c. Reporting

`describeLoopExhausted` (shared, Phase 2) should name the trigger — "the reviewer
rejected 2 iterations without converging" beats "budget exhausted." Extend
`LoopExhaustedInfo.exhausted` entries with an optional trigger description
(`graphWalker.ts:105-118`). Surface the per-iteration verdict in the agent table
(rows are already iteration-labelled from Phase 2 workstream I).

## 1d. Tests

`tests/walker.test.ts`:

| # | Case | Expect |
|---|------|--------|
| 1 | `review_approved: "false"` | Loop edge taken, implementer runs iteration 2 |
| 2 | `review_approved: "true"` | Not taken, clean terminal |
| 3 | `review_approved: "rejected"` (drifted) | Does **not** loop; documents the exact-equality gap |
| 4 | Rejected twice | `loopExhausted` reason `budget`, trigger named |
| 5 | Reviewer emits no verdict on iteration 2 | Overlaid iteration-1 `false` persists → loop fires → exhausts (fails safe) |
| 6 | Gated target, gate resolves false on re-entry | `pendingApproval` at iteration 2 — pins the Step 2 tension |
| 7 | Iteration-2 implementer prompt | Contains `WHY THIS ITERATION` with the reviewer's critique + inventory facts |
| 8 | Rework creates a second flag | Phase 2 orphan guard → INCOMPLETE (expected, not a regression) |

Test 5 is worth explaining: `accumulatedTags` is only rewound on loop-edge traversal,
so between iterations tags accumulate. A reviewer that emits nothing leaves the
overlaid rejection in place. The failure direction is exhaustion, not false success.

Test 8 is expected behaviour: Phase 3's rework instructions tell the implementer to
`use_existing_flag`/`add_variation` and never `create_flag`, so `flag_key` is
unchanged and the guard stays quiet. If the agent ignores that, INCOMPLETE is correct.
It needs a test so nobody later reads it as a bug.

---

# Step 2 — Resumable walk state

Promoted, because the gate needs it now. Two consumers of one primitive:

| Consumer | Exists today | Needs loops? |
|---|---|---|
| `pendingApproval` — gate halted the walk | Yes | No |
| `loopExhausted` — budget spent without converging | Yes (unreachable until Step 1) | Yes |

**The unifying insight:** a resume grant *is* an approval token. The human who resumes
an exhausted or gate-halted walk is the same human whose approval the gate wanted, so
one mechanism serves both — and resume must therefore re-evaluate (or explicitly
carry) the gate decision at the resume node, or resume becomes a gate bypass.

## 2a. Mid-walk re-entry, not replay-from-root

The decision everything else hangs off. **Recommend mid-walk re-entry.** The walk's
state is already fully materialised in `WalkResult` (`runs`, `tags`, `inventory`,
`skipped`, `routingSnapshots`, `edgeCounts`), and Phase 2's `runRecord` already
persists much of it. Replay-from-root with memoisation would require every node's work
to be idempotent — and flag creation is not, which is the whole reason the gate
exists.

## 2b. What to persist

Extend `runRecord`: graph key + config version, resume node, per-edge `edgeCounts`,
`accumulatedTags`, `inventory`, `routingSnapshots`, `runs` (config key / status / tags
/ iteration, output truncated), PR number / branch / **head SHA**, approval policy
mode + threshold, `lastLoopTrigger`.

**Invalidation rule:** if the head SHA moved, refuse to resume — the diff the reviewer
judged no longer exists. Fail closed and require a fresh run.

## 2c. Grant and surface

```ts
{ extraVisits: { "source→target": N }, humanFeedback?: string, approvedNodes?: string[] }
```

Bounded by `MAX_VISITS_HARD_CAP` (`graphWalker.ts:33`), accumulated on top of existing
counts rather than reset — a reset makes "how many times did this actually run"
unanswerable.

Surface: `--resume <runId>` on the CLI, plus a PR comment command or label on the
Action. Phase 2's fail-closed allowlist hook (allow only `approved`/`noop`, else ask)
already handles a resume-pending outcome correctly with no change.

`humanFeedback` flows into the rework preamble through Step 1b's `lastLoopTrigger`.
**Extra budget without extra information just burns the same loop again** — the
feedback is the point, not the budget.

## 2d. Open questions to settle before building

1. Resume at the exhausted node, or at the loop target?
2. Idempotency against Phase 2's orphan guard — a resumed run must not read as an
   orphaning re-create.
3. Does a resumed run reuse the original LD trackers or start a new AI run? Affects
   whether judge scores across a resume are comparable in AI Config monitoring.
4. Does the gate re-run at the resume node, or does the grant carry the approval? (See
   the unifying insight above — likely the latter, but it must be explicit.)

---

# Step 3 — Judge-driven self-loops

Now correctly scoped: **self-loops on the two nodes that have judges.**

| Loop | Judge | Reachable |
|---|---|---|
| `metrics-author → metrics-author` | metrics-quality @1.0 | **Yes, today** — not gated, and `[V]` passes when events are emitted but poorly chosen |
| `flag-implementer → flag-implementer` | implementation-quality @1.0 | Needs Step 2 — `[G]` halts on re-entry |

## 3a. Capture the score

`graphWalker.ts:443` already calls the hook and discards its return value;
`JudgeHook` is typed `=> Promise<LDJudgeResult[]>` (`judges.ts:155`). Capture it,
keeping the existing non-fatal try/catch.

**Usable score:** `sampled === true && success === true && typeof score === "number"`.
Anything else is invisible to routing. One judge per node today — take that score. If
a second is ever attached, decide aggregation then; do not build policy for a case
that does not exist.

**New handoff field `loop_if_judge_below: N`** (`N` in `[0, 1]`), evaluated against
the just-completed node's usable score. Named for its inverted polarity — a *low*
score takes the edge — because that is unmissable at the config site.

Condition order in edge selection (`graphWalker.ts:472-497`): `require_tags` →
`skip_if_tags` → `loop_if_judge_below` → `max_visits`. Budget last, so a spent budget
on an otherwise-passing judge edge still lands in `budgetBlocked` and reports as
`loopExhausted` rather than a silent terminal.

## 3b. Fail-open is normative

`judges.ts` states a judge failure "records a failed evaluation but never fails the
chain," and judges are sampled. Routing on them inverts that contract, so: **no usable
score → condition false → edge not taken.** Every absence mode gets a discriminating
test (3d, tests 1–4).

**The sampling hazard.** Both judges are at rate 1 today, but `samplingRate` lives in
LaunchDarkly, not the repo — `check-configs` cannot see it, so this cannot be a build
check. If it drops below 1, loops become stochastic, and worse: on iteration 2 an
unsampled judge makes the condition false, the walk terminates cleanly, and quality was
never re-verified — a **silent** pass. Mitigation: when a node has a judge-triggered
loop edge and its judge returns unsampled, log loudly and record it as a reporting
caveat on the run.

## 3c. The score is not a tag

Rev 1 proposed a `production: "judge"` tag class. Dropped, for a bug it would have
shipped: the rewind block reads `pickRouting(runs[runs.length - 1]?.tags ?? {})` —
the **agent's** result tags. A judge score is walker-computed and never appears there,
so adding it to the rewound set would delete `judge_score` and fail to restore it,
losing the trigger value exactly when the loop needs it.

The score is read once, at edge-selection time, in the same scope where the results
are a local. Expose it as a typed `NodeRun.judgeScores` field for reporting —
precedent: Phase 2 moved resource links to read `walk.inventory` rather than tags.
This deletes the whole tag-class workstream: no third `production` class, no
`check-configs` 6c change, no disjointness assertions, no rewind semantics question.

**Derived-signal note.** The problem relocates rather than vanishes. Any future
walker-*derived* routing tag — e.g. a normalised `review_verdict` fixing Step 1a's
string fragility — hits the same overlay hole. The decision to make deliberately at
that point: do derived tags get merged into `NodeRun.tags` at record time (before the
FACT mirror and before the routing snapshot), or does `pickRouting` consult a separate
derived map? Do not decide it incidentally.

## 3d. Edge order becomes live

Unlike Step 1a, a `metrics-author` self-loop sits alongside a forward edge whose
`require_tags: {needs_tests: "true"}` will also be satisfied. Declaration order
decides which fires — the self-loop must come first, or the forward edge always wins
at `break` and the loop never evaluates. Verify `getEdges()` ordering first.

Related: **OR needs no new grammar.** "Loop on a low judge score *or* a reviewer
rejection" is two sibling edges relying on first-match-wins.

## 3e. Tests

| # | Case | Expect |
|---|------|--------|
| 1 | No judge attached | Not taken (fail-open) |
| 2 | Judge not sampled | Not taken |
| 3 | Eval failed (`success: false`) | Not taken |
| 4 | `score` undefined | Not taken |
| 5 | Score below threshold | Self-loop taken, iteration 2 runs |
| 6 | Score above threshold | Not taken, clean terminal |
| 7 | Iteration 2 scores high | Converges, walk completes cleanly |
| 8 | Score stays low past budget | `loopExhausted` with score + threshold in the trigger description |
| 9 | Judge hook throws | Non-fatal, no loop, walk continues |
| 10 | Unsampled on iteration 2 after looping | Warning logged + reporting caveat recorded |
| 11 | Self-loop rewind | Judge score absent from `inventory` **and** from `walk.tags` |
| 12 | Iteration-2 prompt | Contains the judge's reasoning via `lastLoopTrigger` |
| 13 | Forward edge declared before self-loop | Self-loop never fires — pins the ordering hazard |

Tests 1–4 are the fail-open contract and must be discriminating (fail if the condition
is hard-coded either way).

---

# Cross-cutting

**Cost.** Step 1's loop re-runs 4 nodes (up to 20+20+20+30 turns plus 2 judge calls);
the `metrics-author` self-loop re-runs 1 node (≤20 turns, 1 judge call). The
run-level backstop is node-count based (`nodeCount × 11`), not time based — the real
ceiling is the Action job timeout. Measure before raising any `max_visits`.

**Bundle drift.** Rebuild `packages/phase1-resource-factory/dist/action.bundle.js` if
`action.ts` changes; CI's drift check requires it (bit us in Phase 3).

**Config bridge.** `tests/upgrade.test.ts` already asserts `handoff.max_visits`
survives the round-trip verbatim; add `loop_if_judge_below` when Step 3 lands. The
**served** graph in LaunchDarkly must be updated too, not just the committed file.

**Docs.** README gains the verdict loop, the `loop_if_judge_below` field, the
fail-open rule, the sampling hazard, and the edge-order hazard. CHANGELOG per step.

**ADR 0014 — judge scores as a routing signal**, written with Step 3: it amends ADR
0007 (judges for coding agents) by inverting the "judges never affect the chain"
contract, and records fail-open as the bound on that inversion.
