# Loop shapes in the factory graph

**Status:** reference / design discussion
**Scope:** what kinds of loops the Phase 1–3 walker can host, what could logically
trigger each, and which are reachable today.

Companion to `docs/phase4-judge-driven-loops.md`. Verified against
`packages/shared/src/graphWalker.ts`, `config/agentcontrol/graphs/auto-factory.json`,
`config/agentcontrol/tags.json`, `packages/shared/src/approvalPolicy.ts`, and the
committed AI configs.

## The organizing principle

**Evaluation distance sets loop cost.** A node can't reliably grade its own work, so
every loop needs an evaluator *other* than the node being redone. The further
downstream that evaluator sits, the more evidence it has — and the more work gets
thrown away when it fires. Self-loops need an evaluator co-located with the node (a
judge); long back-edges buy a better verdict at a higher price.

Three things fire **before** edge selection, so they pre-empt any loop:

```
  [G] approval gate   halts BEFORE the node runs        graphWalker.ts:372
  [V] verifier        halts AFTER the node, pre-edges   graphWalker.ts:452
      run-cap         halts before the node runs        graphWalker.ts:379
```

This is not incidental to loop design — it *is* the design problem. See
"Reachability" below.

## Current graph

`config/agentcontrol/graphs/auto-factory.json` — a DAG, no `max_visits` anywhere.

```
   research-planner                      emits flag_worthy, flag_action, risk_score
         │
         ├── skip_if skip_flagging=true ──►  (terminal — successful no-op, Rule F11)
         ▼
   manifest-steward                      manifest is a file, no LD side effects
         │
         ▼
   flag-implementer      [G] [J]         J: implementation-quality @1.0
         │                               creates REAL LD resources (flag_key, flag_variation)
         │ require flag_ready=true
         ▼
   metrics-author            [J] [V]     J: metrics-quality @1.0
         │                               V: greps for an emitter of each metric_event_key
         │ require needs_tests=true
         ▼
   flag-testing                  [V]     V: fails the run on tests_last_run=fail
         │
         ▼
   code-reviewer                         emits review_approved (forced, UNCONSUMED today)
         │
         ▼
      (terminal)
```

Judge attachments (from the committed AI configs, both `samplingRate: 1`):

| Node | Judge |
|---|---|
| `flag-implementer` | `autofactory-judge-implementation-quality` |
| `metrics-author` | `autofactory-judge-metrics-quality` |
| all others | none |

---

## ① Self-loop — X redoes X

```
              ┌─────────┐
              │         │  max_visits: N
              ▼         │
        ┌───────────────┴──┐
        │        X         │
        └──────────────────┘
```

Cheapest possible loop: one node, no downstream work discarded, no other node's
output invalidated. The trigger must come from outside X's own claims — otherwise
it's the node deciding it failed, the weakest signal in the system. That is precisely
what a co-located judge is for.

| Node | Trigger available | Reachable? |
|---|---|---|
| `metrics-author` | metrics-quality judge @1.0 | **Yes — the only judge-driven loop reachable today** |
| `flag-implementer` | implementation-quality judge @1.0 | No — `[G]` halts on re-entry |
| `flag-testing` | `tests_last_run=fail` (deterministic) | No — `[V]` breaks first |

The `flag-testing` row is the interesting one. `tests_last_run` is a **tool fact**,
not an LLM opinion — the strongest trigger in the system. A self-loop there would
turn "red suite → hard fail" into "red suite → bounded repair attempt." It is
unreachable purely because the verifier's `break` comes first.

---

## ② Evaluator → producer — the classic back-edge

```
   ┌──► flag-implementer ──► metrics-author ──► flag-testing ──► code-reviewer ──┐
   │      [G] re-entry                                                           │
   │                                                                             │
   └──────────────────── review_approved = "false"  (max_visits: 2) ◄────────────┘
```

A downstream node's verdict about *upstream* work sends control back to the producer.
`code-reviewer` already emits this verdict, it is forced by `NODE_REQUIRED_TAGS`
(`anthropicAgentRunner.ts:140-148`), and **nothing routes on it** — a rejection just
reports INCOMPLETE to a human.

- **Cost:** re-runs 4 nodes, up to 90 turns plus 2 judge calls.
- **Semantics:** the strongest *logical* trigger available with zero new walker code
  — a different node, with the full diff in hand, judging the implementer's work.
- **Blocker:** the target is `flag-implementer`, which is `[G]` by default.
- **Fragility:** `require_tags` is exact equality, but `approval.ts:111-119` tolerates
  `approve`/`approved`/`true`/`rejected` because agents drift off the instructed
  `true`/`false`. A drifted verdict silently fails to loop and reports INCOMPLETE —
  safe direction, but reliability rests on LLM string compliance.

A shorter variant with a tighter feedback span:

```
   ┌──► flag-implementer ──► metrics-author ──► flag-testing ──┐
   │                                                            │
   └──────────── tests fail because the FLAG WIRING is wrong ◄──┘
```

Same shape, 3 nodes instead of 4 — but it needs a signal distinguishing "the tests
are bad" (→ self-loop on testing) from "the thing under test is bad" (→ back to the
implementer). Nothing emits that distinction today. It is the one place where a
*self-report* trigger is unavoidable, because only the testing node can tell those
two apart.

---

## ③ Re-plan — deep rewind to the planner

```
   ┌──► research-planner ──► manifest-steward ──► flag-implementer ──► ... ──► code-reviewer ──┐
   │                                                                                           │
   └──────────── "the PLAN was wrong" (wrong flag_action / flag_worthy call) ◄──────────────────┘
```

The most powerful and the most dangerous. The planner may re-decide `flag_action`, so
iteration 2 can create a *different* flag — orphaning the one iteration 1 created.

That hazard is already handled: Phase 2's `orphanedFlagKeys` compares earlier
iterations' `flag_key` against the final and forces INCOMPLETE. **The guard's
existence implies this loop shape was anticipated** — it is the specific failure it
was built to catch. The planner also owns `skip_flagging`, so a re-plan can
short-circuit the whole chain on iteration 2 after a flag already exists; that is the
`inconsistentSkip` half of the same guard.

---

## ④ Steward re-entry — cheap correction

```
   ┌──► manifest-steward ──► flag-implementer ──┐
   │                                             │
   └──── manifest / targetVariation mismatch ◄───┘
```

Lowest-risk back-edge in the graph: the manifest is a file, not an LD resource, so
re-running the steward has no external side effects. The natural trigger is a
mismatch between the manifest's `targetVariation` and the `flag_variation` the
implementer actually produced — mechanically checkable, same family as the existing
verifier checks.

---

## Trigger ladder, strongest to weakest

| Trigger | Independent of the redone node? | Evidence-grounded? | Exists today | Consumed today |
|---|---|---|---|---|
| Human feedback | Yes | Yes | No | — (needs resumption) |
| Deterministic tool fact (`tests_last_run`, event-key grep) | Yes | Mechanical | Yes | `[V]` → **hard fail** |
| Judge score vs verified evidence | Yes | Yes (real diff) | Yes, 2 nodes @1.0 | **Discarded** at `graphWalker.ts:443` |
| Peer node verdict (`review_approved`) | Yes | Sees the diff | Yes, forced | **Unconsumed** — no edge routes on it |
| Node self-report | No | No | No | — |

## Reachability

Every loop shape except the `metrics-author` self-loop is blocked by something that
halts before edge selection, and in both cases the halt is deliberately protective:

- **`[G]` on `flag-implementer`** (`DEFAULT_GATED_STEPS`, `approvalPolicy.ts:42`) —
  the default gated node is also the natural target of shapes ② and ③. The walker
  re-evaluates the gate on every loop re-entry by design ("each re-run can create new
  side effects"), and a non-approval `break`s the walk with no in-walk resumption.
- **`[V]` after `metrics-author` / `flag-testing`** — converts the two strongest
  (deterministic) triggers into terminal failures before any repair edge can be
  considered.

So the two strongest triggers that already exist are both spent on non-loop outcomes,
and the judge scores — third on the ladder — are the only ones whose consumption
requires no change to a protective halt.

## Notes for whoever authors the first loop edge

- **Edge order is load-bearing.** The walker takes the first passing edge and
  `break`s (`graphWalker.ts:496`). A self-loop on `flag-implementer` sits alongside a
  forward edge whose `require_tags: {flag_ready: "true"}` will also be satisfied — so
  declaration order decides which fires. `getEdges()` returns the raw served edge
  array untransformed (`@launchdarkly/server-sdk-ai/dist/index.js:325-327`, built at
  `:359`), so declaration order is authoritative — and a LaunchDarkly dashboard edit
  to the served graph can reorder it.
- **`max_visits` bounds a walk, not a PR.** `edgeCounts` is process-local
  (`graphWalker.ts:340`) and persisted nowhere, so every re-run starts with a full
  budget. Cumulative rework across a PR is uncapped until walk state persists.
- **OR needs no new grammar.** `require_tags` is AND-only, but "loop on a low judge
  score *or* on a reviewer rejection" is two sibling edges relying on
  first-match-wins.
- **`check-configs` 6b** already requires every cycle to carry `max_visits`, so an
  untagged loop fails the build rather than running to the node cap.
- The **served** graph in LaunchDarkly must be updated too, not just the committed
  file.
