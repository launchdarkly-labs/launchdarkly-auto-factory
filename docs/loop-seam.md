# Where the loops stop: the PR-time / deploy-time seam

**Status:** analysis. Out of scope for the `loopback-support` branch; recorded so the next
person starts from the shape rather than rediscovering it.

Phase 4 made the agent graph loop. This is about what those loops can and cannot reach, and
the three distinct gaps that fall out of it — which look like one problem in conversation and
need three different fixes.

## The seam

Everything Phase 1 (the graph walk) hands to Phase 2 (Beacon) is one file. Verified against
`ReleaseFlagFile` (`packages/shared/src/types.ts`): `flagKey`, `targetVariation`, `scope`,
`releasePlan`, `releaseIntent`. **Nothing about the walk crosses** — no `loopExhausted`, no
`loopBudgetSpent`, no judge scores.

```
┌── PHASE 1 · PR time · the agent graph walk ───────────────────────────────────┐
│                                                                               │
│   research-planner → manifest-steward → flag-implementer ────────┐            │
│                                              ▲                   │            │
│                    review_approved="false"   │                   ▼            │
│                    max_visits: 1  ───────────┘         metrics-author ⟲        │
│                                              │      loop_if_judge_below 0.7   │
│                                              │      max_visits: 1 (ADVISORY)  │
│                                              │                   │            │
│                                              │                   ▼            │
│                                              │            flag-testing         │
│                                              │                   │            │
│                                              └──── code-reviewer ◄┘            │
│                                                                               │
│   ✔ RESUME EXISTS: journal → replay → positional grants → continue live        │
└───────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  writes exactly ONE artifact
                                    ▼
                   ╔════════════════════════════════════════╗
                   ║   .release-flags/pr-N.json             ║ ◄── THE ENTIRE SEAM
                   ║   flagKey · targetVariation · scope    ║
                   ║   releasePlan · releaseIntent          ║
                   ╚════════════════════════════════════════╝
                                    │
                          merge  +  deploy webhook
                                    ▼
┌── PHASE 2 · deploy time · Beacon ─────────────────────────────────────────────┐
│                                                                               │
│   discovery: FILENAME diff between two SHAs, two-deep history                 │
│        ▼                                                                      │
│   read release policy → union metrics · inherit rollback choice                │
│        ▼                                                                      │
│   triggerRelease → released │ noop │ skipped │ already_running   ← final       │
│                  → held │ waiting │ error                       ← NOT final    │
│        ▼                                                                      │
│   monitorRelease (24h) → completed │ reverted │ ⟨paused?⟩                      │
│                                                                               │
│   ✘ NO RESUME: one shot per manifest.                                          │
└───────────────────────────────────────────────────────────────────────────────┘

        ╳  NO FEEDBACK EDGE — nothing goes from Phase 2 back to Phase 1
```

## Gap 1 — a failed rollout cannot reach the graph

The loops are all upstream of the seam. They improve the *artifact*; they have no bearing on
the *release*. A rejected review sends work back to the implementer at PR time, but a rollout
that regresses in production cannot send anything anywhere.

**This is not "add an edge."** Every loop mechanism we built — `max_visits`, the routing
rewind, budgets, the resume journal — presupposes a live walk over an open PR. A guarded
rollout fails *after merge*: there is no walk to re-enter and no PR to re-enter it on. Closing
this gap means:

- **A new entrypoint.** The factory runs on `pull_request` events. Beacon would have to
  *start* something — open an issue, open a fix PR, dispatch a workflow. A new trigger
  surface, not a graph edge.
- **A new context source.** Agents read the PR diff, the manifest, and the knowledge graph. A
  remediation run needs *release* evidence: which metric regressed, by how much, what the
  release did. That data exists (`getReleaseStatus`, `metricConfigurations`) but nothing
  plumbs it into agent context.
- **An authority model.** Reworking a PR pre-merge is a small grant. Acting on a production
  regression is a much larger one, and the diagnosis ("*why* did p95 regress") is far harder
  than "the reviewer said no."

That makes it a Phase 3, not an extension of Phase 4.

**And it is the least urgent of the three,** because when a guarded rollout fails the failure
is already contained: LaunchDarkly reverted the flag, users are on the known-good variation,
and a human sees a red release. That is the guarded-rollout value proposition working. Closing
this gap buys *faster remediation*, not safety.

## Gap 2 — Beacon cannot finish its own work

Nothing to do with the graph. Beacon acts only on webhooks and decides what to act on by
diffing filenames, so a manifest gets exactly one evaluation. Any outcome that is not final at
that moment never gets another.

| Outcome | Why it isn't final | Recovery today |
|---|---|---|
| `held` | intent said hold/manual, a future `notBefore`, or segments recorded-not-executed | manual re-POST, while the window lasts |
| `waiting` | the fullstack counterpart hasn't deployed | same |
| `error` | includes an unverifiable idempotency guard | 503 → provider redelivery (the one retriable path) |
| paused release resumed late | monitoring stopped at the deadline | none — children stay pinned to the old variation |
| release completed after the window | same | none |

Two mechanisms make it permanent rather than delayed. **Filename diffing** means editing the
manifest to fix the problem is a no-op — the file exists at both SHAs. **Two-deep history**
(`{ last, prior }`) means the re-POST window closes as soon as one more deploy lands.

**This is the gap that is already causing harm**, and it is the only silent one. It is also
the one this branch made worse, correctly: refusing free-form dates puts more manifests into
`held`, and the fail-closed idempotency guard turns a silent double-start into a skip that
needs redelivery. Every fail-closed improvement adds to a pile that recovers badly.

The fix is a **persisted re-evaluation ledger**: an entry per non-final outcome keyed by
`(service, environment, flagKey)`, re-evaluated on any webhook *independently of discovery*,
cleared on a final outcome. Two properties matter more than the retry itself — re-reading the
manifest at the current SHA makes a human's fix take effect, and re-checking a release we
stopped watching lets a late completion trigger the child-flag repointing that currently never
happens.

What it still would not fix: it is webhook-gated. A `notBefore` date passing causes nothing
until *some* deploy arrives. Closing that needs a timer, which makes Beacon a scheduler —
against the grain of its stated design as "a translator to LaunchDarkly primitives." That is
the open decision, not the ledger itself.

## Gap 3 — the seam is lossy where it matters most

The metrics judge loop is **advisory**: when its budget runs out the walk falls through and
finishes normally, recording `loopBudgetSpent`. That record reaches the PR comment and dies
there.

So a run where a judge twice said "these metrics are inadequate" produces **byte-identical
release behaviour** to one that passed first time. Beacon guards the rollout with whatever
metrics landed in the manifest, with no idea quality was contested and abandoned.

If any walk signal deserves to cross the seam it is that one: a contested-quality run is a
candidate for pause-and-wait rather than auto-rollback, or a slower stage ramp. Nothing carries
it, and nothing can — `ReleasePlan` has no field for it.

**This is the cheapest of the three** and independent of the others: a field on `ReleasePlan`,
written by the manifest steward or the walk, read by `triggerRelease`. It would also be the
first time a loop outcome influenced a release, which is what the original goal was reaching
for.

## The asymmetry worth naming

Phase 1 — where nothing irreversible happens and the worst case is wasted tokens — has a
journal, replay, positional grants, and divergence detection, hardened over six adversarial
review rounds. Phase 2 — where a real flag is turned on for real users — is one-shot.

**We hardened the cheap half.** Not indefensible (the loops were the assignment and Beacon was
pre-existing; the reviews followed the diff, which was Phase 1 until the release-policy work
pulled them across the seam), but it is the right lens for prioritising what comes next.
Beacon lacks precisely what Phase 1 has: a durable record saying "this isn't finished, re-check
it."

## Recommended order

1. **The re-evaluation ledger** (gap 2) — makes every fail-closed improvement safe, and is the
   direct analogue of the resume journal already built on the cheaper side of the seam.
2. **Carry walk outcomes into the manifest** (gap 3) — small, independent, and the first time a
   loop outcome would influence a release.
3. **Rollout-failure remediation** (gap 1) — the ambitious one, and it depends on gap 2 anyway,
   since a remediation run needs release evidence to cross the seam in the other direction.

## Deliberately not done on this branch

All three. The loop work is complete and reviewed; these are the shape of what comes after, and
gap 1 in particular is a new phase with a product decision attached (what authority does an
agent have when production regresses?) rather than an engineering gap.
