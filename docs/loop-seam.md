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
| `held` | intent said hold/manual, a future `notBefore`, or segments recorded-not-executed | manual re-POST |
| `waiting` | the fullstack counterpart **definitively** hasn't deployed — the readiness check is tri-state, so this is now a real verdict rather than a shrug | the other side's deploy notification re-evaluates; if lost, manual re-POST |
| `error`, idempotency guard unverifiable | the read that would prove no release is running failed | **503 → provider redelivery** (automatic — the one case where we know nothing was started) |
| `error`, readiness check unverifiable | the fullstack check could not be finished (status endpoint down, GitHub non-404 error) | manual re-POST — but it is now *diagnosed* as unverified instead of reported as "not deployed" |
| `error`, `triggerRelease` threw | LD 5xx or a network failure mid-write | manual re-POST |
| paused release resumed late | monitoring stopped at the deadline | manual re-POST → `noop` → children repointed |
| release completed after the window | same | same |

**Recovery is manual, not impossible** — an earlier revision of this doc said "none" for the
last two rows and was wrong. `repointDependentPrerequisites` runs on a `noop` result
(`server.ts:200-202`), and `noop` — the environment already serves the target variation — is
exactly what an externally-completed release looks like. So a re-POST that rediscovers the
manifest does repoint the children. It also re-reads the manifest **at the current SHA**, so a
human's edit to fix a `held` release does take effect on re-POST.

What makes recovery manual-only is that nothing *organic* re-surfaces the manifest: discovery
is a filename diff, so a file present at both SHAs is never rediscovered, and two-deep history
(`{ last, prior }`) closes the state-resolved range once another deploy lands. But an explicit
`previousSha` on the request wins over the store (`state.ts:49`) and reopens any range
indefinitely. The gap is that this requires a human who knows to do it, and the two 200-acked
paths above mean nobody is told that they should.

Two retriable paths exist, both deliberate and both narrow: the idempotency-guard **503**, and a
**502 on discovery failure** which does not record the SHA so the next notification re-diffs the
same range (`server.ts:103-107`). The ledger generalises what those two do case-by-case.

**Why the other unfinished outcomes are NOT retriable — the decision worth knowing.** Round
seven made the readiness check and a trigger throw answer 503 as well. Round eight falsified the
argument for it, and both were reverted. The argument had been "retrying is safe by
construction: a patch that landed comes back as `already_running`" — true only while the release
is **running**. `findActiveRelease` excludes terminal statuses, and the sequence a provider's
backoff actually produces is: the trigger patch lands, the response is lost, the guarded release
runs, a metric regresses, **LaunchDarkly reverts it**. `reverted` is terminal, so the redelivery
finds no active release, the noop guard sees served(original) ≠ target, and Beacon starts a
*second* release of the variation the guardrail just rolled back — the outcome `state.ts` itself
calls out as destructive.

So the trade is deliberate: **an unfinished release strands with a 200, because a strand is
recoverable by a human and undoing a guardrail's rollback is not.** Two things make that
tolerable rather than merely resigned — the tri-state classifier is kept, so an unverifiable
readiness check is now *diagnosed* as unverified rather than misreported as "the other side
hasn't deployed", and every stranding log states the recovery action. What it costs is that
nobody is *told* automatically, which is the ledger's job.

Two further reasons redelivery is a weak foundation here, both worth checking before anyone
revisits this: a 503'd SHA **is still recorded** (`server.ts` records before evaluating
outcomes), so one intervening deploy makes the redelivery diff a range where the manifest exists
at both ends — it discovers nothing and acks 200; and **Railway, the only adapter in the repo,
is not known to redeliver on failure at all**, which would make every "retriable" answer here
aspirational for the deployed provider. Verify that before relying on it.

**This is the gap that is already causing harm**, and it is the only silent one. It is also
the one this branch made worse, correctly: refusing free-form dates puts more manifests into
`held`, and the fail-closed idempotency guard turns a silent double-start into a skip that
needs redelivery. Every fail-closed improvement adds to a pile that recovers badly.

The fix is a **persisted re-evaluation ledger**: an entry per non-final outcome keyed by
`(service, environment, flagKey)`, re-evaluated on any webhook *independently of discovery*,
cleared on a final outcome. What it buys is not the retry mechanism — re-POST already is one —
but that **no human has to know to invoke it.** Both recoveries above exist and both require
someone to notice; the ledger is what notices.

One round-seven defect belonged here rather than to the architecture and is **fixed**: the
fullstack readiness check no longer fails open, because it is now tri-state (`fullstack.ts`) —
"the other side has not deployed" and "we could not find out" are distinct answers, and only the
first is a verdict. That fix is entirely about **diagnosis**; what to *do* about an unverifiable
answer is the retry question above, which the ledger owns.

Still open, and known: a redelivery arriving after a release reached a terminal status can start
a second release (no guard consults terminal history before triggering — `findLatestRelease`
exists and would serve); a 503'd SHA is recorded, so an intervening deploy breaks the retry;
`discovery.ts` classifies a transient non-JSON response as a permanently malformed manifest,
because `SyntaxError` is thrown both by `JSON.parse` on file content and by `res.json()` on a
proxy interstitial. That last one is a sixth instance of the anti-pattern, inside a fix.

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
