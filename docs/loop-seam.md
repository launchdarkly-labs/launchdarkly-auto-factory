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
│   triggerRelease → released │ noop │ skipped      ← done; nobody is told      │
│                  → already_running    ← nobody to tell, but NOT this          │
│                                         manifest's work finished              │
│                  → held │ waiting │ error   ← needs a human, and re-checked   │
│        ▼                                                                      │
│   monitorRelease (24h) → completed │ reverted │ ⟨paused?⟩                      │
│                                                                               │
│   ✔ LEDGER (pending.ts): unfinished MANIFESTS re-checked on ANY later deploy    │
│     — webhook-gated, so nothing happens until some deploy arrives               │
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

## Gap 2 — Beacon could not finish its own work (now largely closed)

Nothing to do with the graph. Beacon acts only on webhooks and decided what to act on by
diffing filenames, so a manifest got exactly one evaluation and any non-final outcome never got
another. The **re-evaluation ledger** now gives it one: entries are re-checked on any later
deploy, independently of discovery.

| Outcome | Why it isn't final | Recovery now |
|---|---|---|
| `held` | intent said hold/manual, a future `notBefore`, or segments recorded-not-executed | **ledger re-checks on any later deploy**, re-reading the manifest at the current SHA — so a human's fix takes effect. Re-POST to retry sooner |
| `waiting` | the fullstack counterpart **definitively** hasn't deployed — the readiness check is tri-state, so this is a real verdict rather than a shrug | the counterpart's own deploy releases it; if that notification is lost, **the ledger catches it** on any later deploy |
| `error`, idempotency guard unverifiable | the read that would prove no release is running failed | 503 (a refusal, not a retry — nothing redelivers it) **plus a ledger entry**, so the next deploy re-checks |
| `error`, readiness check unverifiable | the fullstack check could not be finished (status endpoint down, GitHub non-404 error) | **ledger**, and it is *diagnosed* as unverified rather than reported as "not deployed" |
| `error`, `triggerRelease` threw | LD 5xx or a network failure mid-write | **ledger**, guarded by the terminal-status check below. And it **claims the flag's action slot**, because a throw is not "did not write" but "we do not know": `startRelease` awaits the response *after* the patch is applied, so a sibling manifest must not release a different variation of that flag in the same notification |
| `already_running` | a release is under way for **some** variation of this flag, which does not mean THIS manifest's variation released | **not** in the Notifier's attention set (a redelivery mid-rollout needs nobody) but **kept in the ledger**, so the manifest gets another look once that release ends. It used to be final, which cleared the entry and reported the discarded work as success |
| release completed while unwatched (paused-then-resumed, or after the 24h window) | monitoring stopped at its deadline | **the ledger repoints the flag's children as it goes past** — for any entry of that flag whose manifest still reads, including one held by its own intent — and separately `triggerRelease` decides this manifest's own outcome from served-vs-target (`noop` when they match, and a `noop` repoints as well). The two are deliberately split: "some release of this flag completed" is a fact about the FLAG and is allowed to repoint; it is not an answer to "is THIS manifest done?" |
| newest release was **reverted** or **monitoring_stopped** | a guardrail rolled it back, or it ended without completing | **never re-triggered while that is still true.** One check answers it for both write paths (`terminalHistoryRefusal`): the ledger pass, and a re-POST of an already-processed sha. It is **recomputed on every deploy**, so the `needsHuman` report clears by itself once a human completes the release, starts a new one, or the flag moves on — the stored field is last-known reporting, not a latch. A NEW sha still releases, because fix-and-redeploy is the way out of a revert. Deliberately flag-level: a rejected v1 also blocks a manifest wanting v2, which errs in the blocking direction |

**What is still not closed:** the ledger is webhook-gated, so a `notBefore` date passing does
nothing until some deploy arrives, and a project that stops deploying stops re-checking. That
is the timer decision, deferred.

Manual re-POST still works and is faster: an explicit `previousSha` wins over the store
(`state.ts:49`) and reopens any range indefinitely. Two revisions of this doc got this wrong in
opposite directions — first claiming recovery was impossible, then claiming a manifest fix was
a no-op. Both were about discovery, which genuinely cannot re-surface a file present at both
SHAs; the ledger is a separate path that does not use discovery at all.

### Redelivery retries nothing — the ledger does

This was checked, and it is why the ledger exists. Two paths *answer*
retriably — the idempotency-guard **503**, and a **502 on discovery failure** which does not
record the SHA so a later notification re-diffs the same range. Neither is retried by anything:

- **The Notifier** (`auto-factory-notify`, `notify.ts`) is the demo's delivery path, run as a
  post-deploy step. It is **non-blocking by contract** so it can never fail a deploy: a
  non-2xx becomes one `console.warn` and `exit 0`. That property is correct — flag automation
  must not break deploys — but it means the status code reaches no operator, no alert, and no
  dashboard.
- **Railway's webhooks** (the other path) document no retry policy, no backoff, and no
  delivery guarantee. Undocumented retry is no retry.

So a 5xx from Beacon is an honest **refusal**, not a recovery mechanism. It remains the right
answer — it cannot duplicate a release, and it works for any CD system that does retry, which
the provider-agnostic `/flag-releases` contract invites — but recovery today is a human
re-POST, by a human who was never told.

This re-ranks everything below. The ledger is not an improvement on provider redelivery; **it
is the only recovery mechanism Phase 2 would have.** And the case for making the Notifier
distinguish a 5xx from a lost deploy — logging loudly, or surfacing somewhere an operator
looks — is now independent of it.

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

One further reason redelivery is a weak foundation, and it would bite even a CD system that
*does* retry: a 5xx'd SHA **is still recorded** (`server.ts` records before evaluating
outcomes), so one intervening deploy makes the retry diff a range where the manifest exists at
both ends — it discovers nothing and acks 200. The retry mechanism defeats itself on the second
deploy.

**This is the gap that is already causing harm**, and it is the only silent one. It is also
the one this branch made worse, correctly: refusing free-form dates puts more manifests into
`held`, and the fail-closed idempotency guard turns a silent double-start into a skip that
needs redelivery. Every fail-closed improvement adds to a pile that recovers badly.

**SHIPPED** (`packages/beacon/src/pending.ts`): a persisted re-evaluation ledger. An entry per
outcome that left work outstanding, keyed by `(service, environment, sourceFile)` — the
manifest's ADDRESS, not its content, so a corrected `flagKey` cannot leave the safety guard
inspecting a different flag from the one being triggered — re-evaluated on any webhook
*independently of discovery*, cleared on a final outcome. What it buys is not the retry
mechanism — re-POST already was one — but that **no human has to know to invoke it.**

Two properties matter more than the retry:

- re-evaluation **re-reads the manifest at the current SHA**, so a human's fix to a bad
  `releaseIntent` takes effect. That used to be a no-op: the file existed at both SHAs, so
  discovery never looked at it again. The pass reads every pending manifest *before* it orders
  them, because the order decides which manifest takes the flag's one action slot — ordering on
  the remembered target would rank a retargeted v1→v2 entry as v1 and hand the slot to a sibling.
- a release that **finished while nobody was watching** is noticed on the next deploy, so its
  dependent child flags get repointed — previously reachable only by a re-POST inside the
  two-deep window. It needs one pending entry for that flag and a deploy to arrive; a flag with
  nothing outstanding is release monitoring's job (`monitor.ts`).

The guard that makes it safe to automate: re-evaluation is a WRITE path, and
`findActiveRelease` excludes terminal statuses, so on its own it would read "nothing running"
for a release LaunchDarkly already REVERTED and start a second rollout of the variation the
guardrail just rolled back. So re-evaluation consults `findLatestRelease` first:
`reverted`/`monitoring_stopped` → refuse, report `needsHuman`, re-derive that answer on every
deploy rather than latching it; unreadable history → fail closed and stay pending. `completed`
deliberately renders **no verdict** here — the manifest's own outcome is served-vs-target inside
`triggerRelease` — but it does **repoint the flag's children** on the way past, which is the one
thing the deleted branch was right about. See the next section.

**Still WEBHOOK-GATED, deliberately.** Nothing fires on a timer, so a `notBefore` date passing
causes nothing until some deploy arrives. Closing that would make Beacon a scheduler, against
its stated design as a translator to LaunchDarkly primitives — deferred as its own decision.

One round-seven defect belonged here rather than to the architecture and is **fixed**: the
fullstack readiness check no longer fails open, because it is now tri-state (`fullstack.ts`) —
"the other side has not deployed" and "we could not find out" are distinct answers, and only the
first is a verdict. That fix is entirely about **diagnosis**; what to *do* about an unverifiable
answer is the retry question above, which the ledger owns.

Since fixed: a re-evaluation arriving after a release reached a terminal status can no longer
start a second one (both the ledger and a repeat-SHA re-POST consult `findLatestRelease` first),
and re-recording the prior SHA is a no-op so an intervening deploy no longer makes the next
deploy re-diff a processed range.

### The axis address-keying exposed: several manifests, ONE flag

Keying the ledger on the manifest's address was right, and it made a second problem visible
rather than causing it. Manifests are one per PR and **never deleted**, and an iteration PR
targets a **new variation of an existing flag** — the documented steady state. So one flag
routinely has several manifests, each wanting a different `targetVariation`, while only one
variation of a flag can be releasing at a time.

The ledger remembered a MANIFEST; every "is this done?" decision was being made about its FLAG.
Three consequences, each of which reported success while losing work:

- **`reEvaluate`'s `completed` branch** treated "some release of this flag finished" as "this
  entry's work is done" and returned a final `noop`, so a manifest asking for v2 was discarded
  because v1's release had completed. Its **verdict is deleted** — `triggerRelease` answers that
  question per manifest from what the environment serves now — while its **side effect is kept**:
  a `completed` newest release repoints the flag's children *and does not return*. A first
  revision deleted both, and the note explaining that away was wrong: it claimed the lost
  coverage "needed some unrelated manifest for the same flag to happen to be pending", but the
  branch ran *before* `processFlag`, so **any** entry triggered the repoint — including the
  held-by-intent entry itself. The reachable failure was the documented steady state (Beacon
  restarts mid-rollout; the flag's only pending manifest is an iteration awaiting approval; the
  child flag stays dark indefinitely), because every path that returns before `triggerRelease`
  reads LaunchDarkly — `held`, `waiting`, readiness `unknown`, the idempotency read failure, the
  slot deferral, and (final, so the last chance ever) scope `skipped` and manifest-absent — never
  reached the surviving repoint.
- **`already_running` was final**, so an entry cleared while a release for a *different*
  variation ran. Now kept by the ledger and still absent from the Notifier's attention set —
  two lists answering two different questions, which is the one place they must disagree.
- **The lineage guard answered `held` for a target BEHIND what is served.** `held` is not final,
  so the entry lived forever, and a non-writing return used to claim the flag's per-notification
  action slot — so an already-superseded manifest deferred the releasable one on **every**
  deploy. Permanent deadlock, zero releases. It is now a final `noop` ("superseded"), and the
  slot is claimed only by a method that actually patched LaunchDarkly — or by one that *may*
  have, see below.

Two rules fall out, both in `server.ts`: **highest target variation first** in both passes (an
absent `targetVariation` means the lineage tip, so it sorts highest — ranking it last inverts
the fix; the pending pass ranks on the target read from the manifest *now*, not the remembered
one, because the order decides which manifest releases), and **only a write claims the slot —
plus a write we cannot rule out.** There are three states, not two: wrote, did not write, and
don't know. A `triggerRelease` that threw is the third — the patch may have landed and the
response been lost — and filing it with "did not write" let a sibling release a variation
*behind* the one that may now be live, invisibly, because mid-rollout the fallthrough still
serves `control` and both lineage guards need a lineage-indexed served value to fire.

And one refusal was added: a manifest whose
target is not in the lineage at all (`control`, a hand-named variation) is `held` for a human,
because releasing it ramps production *off* the released lineage. That was the only backwards
move with no guard at all, and the most destructive — an automated un-release reported as a
release.

**Still open, and deliberately not fixed here: mutual exclusion is per-notification.** The
action slot is a set inside one request. `config/services.yaml` registers **four
`side: backend` services on one repo** (`togglemart-gateway`, `-catalog`, `-orders`, `-users`),
so one merge produces four concurrent notifications, each with its own set and no visibility
into the others — in-process mutual exclusion cannot cover them. The residual window is a
**concurrent double-start during a rollout**: `findActiveRelease` catches it as soon as the
releases listing is consistent (it is eventually consistent right after a start — `monitor.ts`
retries five times for exactly that), so the exposure is that first moment only. Closing it
properly means either a **persisted per-flag lease** (the ledger's file is the obvious home, but
a lease needs an owner, a TTL, and a crash story) or **designating which service owns a flag's
releases** (cheaper and clearer, but it is a product decision about how the registry models a
multi-service repo). Deferred pending that decision rather than half-built.

That same fan-out produced the second-order defect worth remembering: one merge, four
notifications, the same manifest discovered four times — one releases and **three answer
`already_running`**. Since `already_running` is (correctly) kept in the ledger, a later revert
then stamped `needsHuman` on three entries that had written nothing, and because `needsHuman`
short-circuited re-evaluation before the manifest re-read and was not sha-gated, all three
reported `ACTION REQUIRED` on every subsequent deploy of those services, permanently. Fixed by
deriving the refusal instead of remembering it. The lesson is the general one: a **stored
verdict** about live state is a latch, and a latch with no clearing path is a permanent false
alarm — recompute, and keep the stored copy for reporting.

**Still open, and known.** `discovery.ts` classifies a transient non-JSON response as a
permanently malformed manifest, because `SyntaxError` is thrown both by `JSON.parse` on file
content and by `res.json()` on a proxy interstitial — so a CDN blip gets the file skipped by
name, the SHA recorded, and a log that blames the manifest. A **sixth instance of the
anti-pattern, inside a fix.** The fix is to classify at the source: have `getFileJson`
distinguish "content failed to parse" from "response failed to parse", and keep only the former
skippable. Note `req()` is shared, so `listDir`/`fileExists` have the same conflation.

Also open: `findLatestRelease` can bless a STALE completion. If the post-trigger attach attempts
miss the new release and a *previous* release of the same flag completed — the normal v1→v2
case — the monitor logs the old release's id, repoints, and returns, leaving the real release
unwatched. There is no creation timestamp on `AutomatedRelease` to gate on; the only signal is
`stages[].startedAtMillis`, which is optional. If that proves unusable, reverting to
warn-and-return is the better trade: missing a repoint beats repointing on the wrong release.

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
