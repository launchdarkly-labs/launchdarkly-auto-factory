# `loopback-support` — working notes for whoever picks this up

**Status as of 2026-08-18:** `origin/main` is MERGED IN and **PR #19 is open, green and mergeable**.
The graph is still not provisioned — that remains the owner's call, now waiting on review of the PR
rather than on the PR being opened.

Measure the rest rather than reading it here, because every number this header used to carry went
stale, twice:

```
git rev-list --left-right --count origin/loopback-support...HEAD   # pushed?  → 0 0
git rev-list --count main..HEAD ; git diff --shortstat main..HEAD  # size
npm test ; npm run typecheck ; npm run check:configs ; npm run check:public
gh pr view 19 --json state,mergeable,mergeStateStatus              # PR?     → OPEN/CLEAN
gh pr checks 19                                                    # CI?     → verify pass
```

The header first claimed `3324b40`, 674 tests and "46 commits unpushed" after two rounds had been
committed and pushed; the fix for that then pinned its own parent's hash and commit count in a commit
that added another commit, 187 insertions and a test — stale before it was written. A reader checking
whether these notes are current starts here, so this section names rounds, never hashes or counts.

This file exists because the git log and `docs/loop-seam.md` carry the architecture and the
reasoning, but three things live nowhere durable: **the open findings**, **the decisions and why
they were made**, and **the ways verification silently lies in this repo**. Delete it when the
branch merges.

---

## 1. Read these first, in this order

1. **`docs/loop-seam.md`** — the architecture, the three gaps at the PR-time/deploy-time seam, and
   what is deliberately deferred. The single most useful document.
2. **`git log --oneline main..HEAD`** — commit messages describe the *failure scenario*, not the
   change. They are the real design record.
3. **`docs/loop-shapes.md`** and **`docs/phase4-judge-driven-loops.md`** — the graph half.
4. This file — open items and traps.

## 2. Standing constraints from the repo owner

- **Do not provision the graph.** `npm run bridge -- upgrade` is held until the branch is peer
  reviewed and approved. The walker executes the graph **LaunchDarkly serves**, which has neither
  loop edge until that runs — so a live run shows no looping and looks broken.
- **The branch IS pushed**, and **PR #19 is open** — its body was regenerated from the git log, as
  §7 asked (the old scratchpad draft was stale and gone). What is still the owner's call is
  provisioning the graph after review.
- **`main` is merged in, not rebased onto.** It had advanced 10 commits, including one that emits
  graph-level metrics from `graphWalker.ts` — 70 lines into the same file this branch rewrites. Nine
  files conflicted; the merge commit records every decision that was not mechanical, and the two
  worth re-reading are that main's `visited` DAG guard is dropped (keeping it would have disabled
  every loop) and that `clean` now excludes `replayDiverged` but still ignores `loopExhausted`.

## 3. How verification silently lies here — read before trusting any green suite

Seven distinct traps, each of which has produced a wrong conclusion in this branch's history:

1. **`npm test` runs against built `dist/`.** Tests import workspace packages by name
   (`@auto-factory/beacon`), which resolve to compiled output. Editing `src/` and running
   `npm test` tests the *previous* build.
2. **`tsc --build` is incremental via `tsconfig.tsbuildinfo`, which lives at each package ROOT,
   not in `dist/`.** Deleting `dist/` alone gives a silent no-op build and dozens of spurious
   failures. Use **`npx tsc --build --force`** when build state is in doubt.
3. **A build failure is not a test failure.** An unused-variable or unreachable-code error from a
   sabotage proves nothing. Make sabotages type-valid.
4. **Check the failure landed where you predicted.** A sabotage that changed only one side of a
   two-sided key comparison tested a *mismatch* rather than the old behaviour, and failed a
   different test than expected. "Something failed" is not evidence.
5. **A `git worktree` with symlinked `node_modules` gives a false green.**
   `node_modules/@auto-factory/beacon → ../../packages/beacon` resolves through the symlink's real
   path back to the main checkout, so a sabotage compiled into the worktree's `dist/` is never
   loaded. Rebuild `node_modules` with a real `@auto-factory` dir pointing into the worktree.
6. **`npm test` does not typecheck the tests, so a green suite proves nothing about `tsc`.**
   The runner is `node --import tsx --test tests/*.test.ts`, and `tsx` strips types rather than
   checking them — while `npm run typecheck` builds the packages *and* runs `tsc -p tests
   --noEmit`. A new test file can therefore pass the full suite and still fail the typechecker;
   this happened with an unguarded index access under `noUncheckedIndexedAccess` (`m[1]` on a regex
   match), which `npm test` reported as 680/680 green. The two commands answer different questions:
   **run both, and do not report a suite as clean until `npm run typecheck` has also passed.**

7. **A fixture's shape can come from git config, so a green suite on a dev box says nothing.**
   `git init` in a test fixture inherits the machine's `init.defaultBranch`, so walkState's
   throwaway repo was `main` locally and `master` on the CI runner. Its "origin/main becoming
   unresolvable falls through to LOCAL main" test therefore had no local `main` to fall through
   TO on CI, and asserted a refusal it never reached — passing locally, failing on the runner,
   and testing nothing in either place. Fixed by pinning `git init -b main`. CI found this, not
   the suite; the same class covers any fixture that reads ambient git or shell config.

**The discipline that works:** sabotage the mechanism, `npx tsc --build --force`, run the full
suite, and confirm the *predicted* test failed.

## 4. Findings §4.1–§4.6 — ALL IMPLEMENTED (rounds 1–6). Kept as the record of what changed and why

From an adversarial review of `3324b40` (round 19). All verified against LaunchDarkly's docs. **Every
item below is now done**, across six review rounds; the sections are retained because they state the
failure scenarios, and a future reader needs those more than a checklist. The structural item §4.6
was done first, as §7 said to: the taxonomy has one home (`PATCH_FAILURE_TAXONOMY` in
`packages/beacon/src/trigger.ts`) and `tests/taxonomyHome.test.ts` fails if another file restates it.

What the rounds after §4.6 mostly found was not new defects in the code but **more copies of the
claims being corrected** — three of four, then three of five, then four more sites of a clause
already withdrawn. The lesson is in §3 and in that test: when correcting a claim, grep for every
occurrence of it and count the set before declaring the fix done.

### 4.1 BLOCKER (prose, not code) — "400 ⇒ manifest content" is false, and unfixable by code

`PATCH /api/v2/flags/{proj}/{flag}` returns **400** when a change would conflict with a **pending
scheduled change or approval request**, with `ignoreConflicts=true` as the opt-out. Beacon never
sends it — and **should not**, because that would override a human's scheduled change.

So a 400 means *either* "your manifest content is wrong" *or* "someone has a pending change on
this flag", and `contentRefusalStatus` is status-only, so it cannot tell them apart. A correct
manifest gets `held` with a note accusing its `releasePlan`, every deploy, until a human clears
the pending change.

`{400, 422}` is still the best available answer. **The fix is to stop claiming a precision the
discriminator does not have** — four sites assert the unqualified premise: `trigger.ts` (the
classifier's doc comment), `server.ts` (the catch taxonomy), `packages/beacon/README.md`,
`docs/loop-seam.md`.

### 4.2 A false proof: "there is no per-manifest 403"

`updatePrerequisites` is a **distinct role action** from `updateFallthrough`, and `trigger.ts`
selects between those instruction families **per manifest** (the prerequisites patch versus the
release-start patch). `tests/ledgerLineage.test.ts` already puts one of each on a single flag in a
single notification, so a custom role granting one and not the other 403s one manifest
deterministically while the other would succeed → the sibling starves.

**Neither existing bucket fits it:** `held` would blame manifest content for a permissions
problem; throwing claims the slot and starves. Delete the false sentence and record the gap.

### 4.3 The deferral message is now false in the other direction

`server.ts` says *"another manifest wrote or may have written…"*. But the catch's own enumeration
states that six of its seven buckets **definitively wrote nothing** (429, 409, 405, 404, and the
two pre-write per-flag throws). Only the 5xx/network/truncated-body bucket supports "may have
written".

The honest predicate is about **the slot**, not about writing: *"another manifest for this flag was
acted on first (it wrote, or its outcome is unknown)."* No test pins this wording in either
direction.

### 4.4 Three patch sites, not two

`trigger.ts` has **three**: the prerequisites patch, the **`immediate`** patch, and the
release-start patch (via `startRelease`). Only the first and third are classified; `immediate` has
no try/catch. Exposure is small — its body is LaunchDarkly-derived (`targetVar._id` from the flag
read), so it carries no unvalidated manifest content — but the repeated claim to have "closed the
whole class" is overstated, and a 4.1-style conflict 400 there throws rather than holding.

### 4.5 Minor prose

- The 405 quotation *"Approval is required to make this request"* appears in no LaunchDarkly
  document. The behaviour is real (the endpoint page says a request in an approvals-required
  environment "will fail with a 405"); the quotation marks are not earned.
- 405 is called *"a per-environment setting"* — LaunchDarkly scopes approvals per environment
  **and** narrower (`requiredApprovalTags`, per-flag+environment settings). Same over-claim class
  as the "403 is GLOBAL" one already corrected.
- 404 is called *"the flag or the environment, never the release plan"* — but `metricKeys`,
  `metricGroupKeys` and `randomizationUnit` are LaunchDarkly resources identified by key and reach
  the API unvalidated. "Never" is unearned.
- `write_manifest`'s stage message ends *"Omit stages entirely to use the flag's configured release
  policy"*, which over-promises when the manifest pinned `releaseMethod: "guarded"` — the method
  still outranks the policy.

### 4.6 THE PROCESS FINDING — worth more than any single item above

Eleven prose corrections in this branch's history, and **each one fixed three of four sites**, with
the missed site being the one an auditor checks first. The last instance missed a wrong claim
sitting *seven lines above the test being edited, in the same file, in the same diff*.

The structural fix is to **stop restating the taxonomy in four places.** Put it in **one**
canonical location — next to the classifier in `trigger.ts` — and have `server.ts`, the README,
`docs/loop-seam.md` and the tests *reference* it rather than paraphrase it. That makes the drift
unrepresentable, which is the same move that fixed the pre-walk tree hash and the ledger's
identity. Correcting four copies a twelfth time is not the answer.

## 5. Deferred by explicit decision — do not "discover" these

Each was raised, considered, and deferred. `docs/loop-seam.md` carries the reasoning.

| Item | Why deferred |
|---|---|
| A **timer** for Beacon | The ledger is webhook-gated by decision; a `notBefore` passing does nothing until some deploy arrives. A timer makes Beacon a scheduler, against its stated design |
| Walk outcomes on the manifest | Gap 3 — a contested-quality run is byte-identical to a clean one by the time Beacon sees it |
| Rollout-failure → graph rework | Gap 1 — post-merge, so no walk to re-enter; needs a new entrypoint, release evidence in agent context, and an authority model |
| `metricKeys`/`randomizationUnit` validation | Cannot be validated without a project read |
| The repoint **forward** destination family | Mid-rollout the destination is the live fallthrough; shared with `monitor.ts`. `AutomatedRelease` carries no target variation |
| Cross-notification mutual exclusion | `config/services.yaml` puts four `side: backend` services on one repo, so one merge is four concurrent notifications each with its own slot set. A persisted lease or release-ownership are the fixes |
| First-run bulk guard | Both stores start empty on ENOENT; on an ephemeral filesystem that means amnesia and bulk re-triggering. **Awaiting an owner decision** |
| `discovery.ts` narrowing on `SyntaxError` | Thrown by both `JSON.parse` on content and `res.json()` on transport |
| `dedupeMonitors` lacks a `.catch` | Small; a rejecting injected hook is an unhandled rejection |
| Transition-based attention | `held` alarms every deploy because attention is not new-or-changed yet |
| The flag-level retry policy | A rejected v1 blocking a v2 manifest is deliberate and conservative |

## 6. The invariants that took the longest to find — do not casually change these

- **A unit of work is a manifest's ADDRESS** (`service, environment, sourceFile`). Keying the ledger
  on `flagKey` — manifest *content* — let a corrected key make the guard inspect one flag while the
  trigger fired on another.
- **The target of an action is `(flagKey, environment)`.** Only one variation of a flag may be
  releasing at a time. Memory and action are keyed differently, deliberately.
- **"Is this manifest's work done?" is answered in exactly one place** — `served`-vs-`target` inside
  `triggerRelease`, recomputed from LaunchDarkly at every decision. A flag-level shortcut was
  deleted rather than patched. Do not add a second answer.
- **A manifest that writes nothing must not take the flag's action slot**, or it starves a sibling.
  Three write states — wrote, did not write, **don't know** — and "don't know" fails closed.
  **NARROWED by the repo owner (round 4), and this is the only amendment made to this list:**

  > …except where the refusal cannot be specific to one manifest, in which case no sibling may act
  > either.

  It applies to exactly one place — the `immediate` patch, whose body contains no manifest values at
  all (`turnFlagOn` plus a variation id LaunchDarkly itself reported), so no refusal of it can tell
  one such manifest from another. Freeing the slot there was demonstrated to roll an **older**
  variation out to production behind a refused newer one, which no later deploy undoes. The
  condition is a value, not a comment — `PatchSite.carriesManifestContent` in
  `packages/beacon/src/trigger.ts`, which `heldOnContentRefusal` reads and
  `TriggerResult.claimsSlotWithoutWriting` carries into the outcome — and
  `tests/taxonomyHome.test.ts` pins the split exactly — ONE patch carries no manifest content, TWO
  do — so the exception cannot spread without a test failing.

  **Its accepted cost, in the owner's words, recorded as a known gap rather than closed** — the same
  TREATMENT as the 403 gap in `PATCH_FAILURE_TAXONOMY`, though pinned differently: that one by a
  table-shape assertion in `tests/taxonomyHome.test.ts`, this one by a behavioural reproduction in
  `tests/ledgerLineage.test.ts`:

  > a sibling targeting the same or a later variation by a different method would have succeeded,
  > and defers while the refusal stands.

  Two arguments once offered for the narrowing were false and are withdrawn: that every sibling
  would be refused identically, and that there was no reachable loss on the sibling's side. The
  narrowing rests only on the asymmetry of RECOVERABILITY: a deferred sibling releases as soon as a
  human fixes the flag, so what it loses is deploys, however many that takes — **not** "the next
  deploy", which is the third form this claim has taken and is contradicted by the residual four
  lines above and by the test that runs it across three deploys. A rollout backwards recovers by
  nothing.
- **Never move a lineage backwards**, and never repoint a child onto a variation behind what it is
  pinned to.
- **`held` is non-final; `noop` is final.** A superseded manifest is *moot*, not held — that is what
  makes a starving entry resolve.

## 7. Suggested next steps

§4.1–§4.6 are done, `main` is merged in, and PR #19 is open and green. What is left:

1. **Human review of PR #19.** Nothing else blocks it.
2. **Then** provision the graph (`npm run bridge -- upgrade`) — still held until after approval, for
   the reason in §2: the walker executes the graph LaunchDarkly serves, which has neither loop edge
   until that runs.
3. **Delete this file when the branch merges**, as the top of it says.

## 7a. SETTLED EMPIRICALLY 2026-08-12 — the edge-order finding, and the fix is not the filed one

Run live against a separate LaunchDarkly project (`abram-factory-testbed`, the owner's persistent
factory test bed) provisioned by `bridge provision` from the committed files, then walked by
`npm run smoke:loop` with a scripted runner. **The served graph loops, bounds and reports exactly
as the fixtures do**: 10 runs in the expected order, `loopExhausted.reason = "budget"` at the code
reviewer, one `loopBudgetSpent` entry (1 traversal of 1), and `max_visits` arriving as a **number**,
not the `"2"`-style string `5aa3315` was about. `bridge upgrade --dry-run` then reported 0 changes.

**The two paths disagree about edge ORDER, and only one of them is faithful.** A probe graph
declared three edges from one source in the order Z, M, A (edge keys deliberately reverse to the
declared order):

- **The SDK-served graph returned declared order** (Z, M, A), and likewise preserves the committed
  graph's load-bearing `metrics-author` pair — the loop edge before the forward edge. Two
  observations, and LaunchDarkly documents no ordering guarantee, so read this as "was faithful
  both times", not as a property to rely on. The walker RECORDS the served ordering rather than
  trusting it (§7a.1), which is what makes the system robust if that ever stops holding.
- **REST GET returned A, M, Z** — the exact reverse. On the real graph REST returned yet another
  arrangement (7 edges, neither declared nor alphabetical). **REST GET order is not dependable.**
  One counterexample is enough for the conclusion below, so this half needs no more evidence.

Two consequences, and the second is the one that needs the design call:

1. **Do NOT drop the sort at `upgrade.ts:86`.** That was the filed proposal, and it is wrong: REST
   returns a different order than the committed file for a graph LaunchDarkly created *from that
   file*, so an order-sensitive comparison would report drift on every run, starting immediately.
   The sort is load-bearing.

   **The accepted cost, which the first version of this section did not state:** keeping the sort
   makes an order-only reorder not just undetectable by the bridge but **unrepairable** by it.
   `upgrade` skips the write when the sorted shape AND the stamped description both match
   (`upgrade.ts:213`), so `bridge upgrade` against an LD-side reorder reports zero changes and
   rewrites nothing; `provision` is create-only. It repairs the order only incidentally, when some
   *other* committed change moves the config hash and forces a graph rewrite. The reliable fix is
   the LaunchDarkly UI, or a direct graph write. The walker's warning says exactly this — advice
   that visibly does nothing teaches the reader to dismiss the warning, which is how a guard dies.
2. **No REST-based check can guard the ordering invariant at all** — GET's order is a derived view,
   so a real within-source reorder is indistinguishable from LaunchDarkly's own shuffling. The
   invariant in the graph's `$comment` ("the loop edge MUST stay declared BEFORE the forward edge",
   which the walker reads via first-passing-edge) is therefore guardable only against the
   **SDK-served** graph, which IS order-faithful. **CLOSED** — see below.

### 7a.1 The ordering guard, closed 2026-08-12 (the factory is about to run real PRs)

The exposure was one edge. Ordering can only kill a loop whose source ALSO has a non-loop edge:
`code-reviewer`'s rework loop is its source's only edge, and the other four sources have one
forward edge each. So the whole risk was the judge-driven `metrics-author` self-loop — one silently
skipped quality retry, with the release machinery unaffected. Left alone that is survivable; on
unattended real PRs it is a retry nobody would ever know did not happen.

- **The committed half already existed**: `check-configs` **6e** fails the build on a loop edge
  declared after a non-loop edge from the same source. Nothing was needed there.
- **The served half now exists**: the walker records each such edge on
  `WalkResult.loopEdgeShadowed` and warns once per edge per walk (`recordShadowedLoopEdges`). It is
  a RECORD, not a gate — the walk is still valid, it has just lost a retry — reported on the same
  three surfaces as `loopBudgetSpent` (Action warning, CLI summary, extension log), because the
  failure leaves no other trace: no extra runs, no budget spent, no `loopExhausted`.
- **The two halves cannot vanish silently**: `check-configs` **6h** asserts the walker still defines
  `LOOP_EDGE_SHADOWED_RULE`, still calls the recorder, and still puts the result on `WalkResult`.
  Eleven prose corrections in this branch's history each fixed three of four sites; 6h is the cheap
  refusal to make that twelve. It earned itself on the first run, catching the marker moving into a
  helper. **It is not proof the halves AGREE** — an earlier draft of this line said "cannot drift",
  which over-claims: 6h is a source-text lint, so it matches commented-out code and cannot tell a
  live mechanism from a broken one. `tests/loopEdgeOrder.test.ts` is the behavioural proof.

**Two known gaps, recorded rather than closed** (the treatment §6 uses for the 403 row and the
`immediate` narrowing):

1. **The record is an ORDERING violation, not a proven-dead loop.** If the forward edge ahead of the
   loop is condition-gated and fails, selection falls through and the loop fires — so a walk can
   carry `loopEdgeShadowed` *and* a fired loop, and `precededBy` can name an edge that never won.
   Narrowing the check to unconditional forward edges is the obvious fix and it is **wrong**: the
   committed graph's only shadowable edge, `metrics-author → flag-testing`, is gated on
   `needs_tests`, which its source always emits, so narrowing would skip the one edge the guard
   exists for. Pinned by a test asserting the loop fires AND the record is present.
2. **`loopEdgeShadowed` is deduped by (source, TARGET), not per edge.** On a served graph
   `edge.key` IS the target key, so two loop edges from one source to the same target — legal, each
   with its own conditions — collapse to one record. `edgeCounts` keys traversals the same way,
   where the cost is larger (a shared budget), so fixing only the record would put two notions of
   edge identity in one file. Unreachable in the committed graph.

**A trap worth keeping**, because the first implementation had it: the detection CANNOT live inside
the edge-selection loop. That loop breaks at the first passing edge — which is the forward edge doing
the shadowing — so it never reaches the loop edge it is looking for. It must be a separate pass.
`tests/loopEdgeOrder.test.ts` caught this, and pins the quiet-failure shape: a mis-ordered graph
produces `["worker", "done"]` with `loopBudgetSpent`, `loopExhausted` and `stalledAt` all undefined.

`npm run smoke:loop` also covers the served graph now. Its first version passed no `judgeHook`, so
judge scores failed open and the `metrics-author` loop never fired — it exercised only the loop that
ordering cannot break. It now scripts a 0.4 score, so both loops fire: 11 runs, two `loopBudgetSpent`
entries, and `loopEdgeShadowed` asserted empty against the live served graph.

Also observed: a 403 during tool provisioning makes `provision.ts:149` report
`no such tool in config/agentcontrol/tools/` for every variation referencing that tool, when the
file is present and the real cause is the permission failure printed above it. ~50 false lines
buried 7 real 403s. Same over-claim class as §4 — the message names a cause the code cannot
distinguish.

Still open, and none of it blocking: the items in §5 (each deferred by decision), the two gaps
recorded rather than closed (the permissions row in `PATCH_FAILURE_TAXONOMY`, and the sibling cost
of the §6 narrowing in `PATCH_SITES`), and two lint tuning risks recorded in
`tests/taxonomyHome.test.ts` — its ungated phrases include ordinary English (`patch site`) and
LaunchDarkly RBAC vocabulary (`role action`), so an honest future comment can trip it. That is the
misfire class the test itself warns gets a lint deleted; if it happens, gate the term rather than
deleting the check.

## 7b. ADVERSARIAL REVIEW OF THE `main` MERGE, 2026-08-19 — nine findings, all fixed

An independent adversarial review of the merge commit found nine defects. All are fixed; the four
that changed behaviour are pinned by tests in `tests/walker.test.ts`
("loop/metrics merge regressions"), each verified to FAIL against the pre-fix walker — five
predicted failures, five observed, no others.

The two worth knowing about as a reader, because both were WRONG CLAIMS made confidently:

- **The taxonomy lint's first gate was too wide, and its own sabotage proof was worthless.** It
  exempted a status numeral when `sentry|seer` appeared within 80 characters of it *anywhere in the
  raw file*, so proximity bought the exemption and it leaked across paragraphs. The sentence
  "Seer aside: LaunchDarkly's 403 on the release patch is deterministic and the manifest is held as
  content" — a complete second copy of the taxonomy, attributed to LaunchDarkly — passed. The
  sabotage that "verified" the gate had placed its numeral far from any Sentry word, so it tested
  distance and reported it as attribution. Now per prose unit, exempt only when a foreign-API word
  is STRICTLY CLOSER than any LaunchDarkly-subject word. **The lesson is §3's, one level up: a
  sabotage proves what it actually varied, not what you meant it to vary.**
- **`sentry_guardrail`'s stated reason for being in `ROUTING_TAGS` was false.** The handoff-verifier
  scenario it cited cannot happen: the verifier reads `result.tags`, never `accumulatedTags`, and on
  a self-loop the rewind re-overlays the source's own routing tags anyway. The classification is
  right (check-configs 6c forces it); only the argument was wrong.

Three accepted costs, recorded rather than closed, in the treatment §6 uses:

1. **A CLI `--resume` emits NO graph-level metrics.** The metrics block is now gated on
   `!anyReplayed`, because every quantity in it describes a whole walk: measured, one loop-exhausted
   walk plus one resume produced two `trackInvocationSuccess` calls and a 10-entry path for 6 node
   runs, with tokens from only the live tail. So a graph driven through `--resume` under-reports
   invocations. The GitHub Action re-runs from scratch and is unaffected. Omitting a row beats
   corrupting the aggregate.
2. **A loop edge pointing elsewhere still stalls on a FAILED source.** The failure retry is
   restricted to SELF-loops, where "run it again" needs no tag evidence. `code-reviewer →
   flag-implementer` on a failed reviewer would hand the implementer a rework with no critique, so
   that case still stalls; the fix there is a self-loop on the reviewer, which is a graph change.
   `tests/walker.test.ts` pins the restriction so it cannot widen unnoticed.

   **AND ITS FIRST IMPLEMENTATION WAS WRONG, which is the trap worth keeping.** Written as a
   condition-bypass INSIDE the edge-selection loop, the retry outranked every other edge — and the
   ordering invariant puts the self-loop BEFORE the forward edge, so it always won. The premise
   stated in its comment, "a failed run emits no tags", is false: every runner returns
   `tags: {...executor.tags}` on the failure path too, so a node that fails LATE carries the tags
   its tool calls already produced, its forward path is open, and it was re-run anyway. Asking "did
   anything else route?" cannot be answered from inside the loop that decides it — the SAME shape
   as the shadowed-loop detection in §7a.1, which had to become a separate pass for the same
   reason. It is now a second pass, and a test pins the late-failure case.

   One coupling that follows and is not a defect: failure retries and quality retries share one
   per-edge budget, so on `max_visits: 1` an infra failure consumes the pass a later low judge
   score would have used.
3. ~~**A drifted taxonomy claim that names no LaunchDarkly-subject word at all, sitting next to a
   Sentry word, still passes the lint.**~~ **UNDERSTATED — see §7c finding 5.** The hole was wider
   than this in both directions, and the attribution rule this describes has since been replaced.

Also fixed, without a behavioural test because they are prose or a one-line gate: the restored
Beacon README sections (main's snapshot said "no retry queue" and omitted `BEACON_PENDING_FILE` and
the Seer envs, contradicting the ledger the same file documents on line 27); the Seer revert context
on the `already_running` re-attach (it named the evaluated manifest's variation and the current
deploy's sha, when what is running is a sibling's earlier release — now repo-only, because an
imprecise Seer search beats a confidently wrong one); and this file's own trap-7 placement.

## 7c. ADVERSARIAL REVIEW, ROUND TWO, 2026-08-19 — the fixes reviewed, eight findings, all fixed

Round one reviewed the merge; this round reviewed the FIXES, which is where the defects were, and
found eight. The pattern is worth more than the list: **every serious finding was the fix round
carrying its own false premise forward one more step.**

- **The retry's success case was scored as a failure.** `clean` used
  `runs.every(r => r.status === "completed")`, and `runs` is the resume journal, so a failed attempt
  stays in it forever. A walk that survived a transient error therefore scored EXACTLY like one that
  died — the new mechanism's entire purpose, invisible in the aggregate every front end feeds. Now
  keyed on each node's LAST run: recovery is a success, a node whose last run failed is not.
- **The retry re-ran a node whose failed pass had satisfied the loop's own exit.** Same argument as
  the late-failure case the second pass was built for — a late failure's tags are real evidence —
  and the second pass did not apply it to `skip_if_tags`. A satisfied exit means CONVERGED, so the
  retry now yields to it. What the retry overrides is a missing trigger, never a satisfied exit.
- **The exit-bookkeeping exemption repeated the "a failed run emits no tags" premise that §7b was
  written to disprove.** A retried pass that DID emit the exit tag now clears the flag, so the
  categorical claim at exhaustion ("emitted none of those tags on any pass") cannot be asserted
  falsely and stop naming the SERVED graph as defective when it is not.
- **One exhausted edge could be recorded twice**, once per pass, printing it twice on all three
  report surfaces and relabelling a quality exhaustion as a retry exhaustion. Deduped on the
  per-iteration array, so `loopExhausted` is still reported when an earlier iteration spent it.
- **The lint's attribution rule was broken in BOTH directions** (finding 5, and the reason cost 3
  above is struck out). Nearest-attribution is grammar-blind: front-load a Sentry word and a full
  second copy of the taxonomy passes; put `flag` nearer than `Seer` and honest prose about Sentry's
  own 403 is reported — the misfire class §7a says gets a check deleted. Attribution is now GONE.
  The rule is the one the NAMES check beside it already used: **a status numeral is a taxonomy claim
  only when a verdict about it sits within the window.** One sentence, no list of whose API a number
  belongs to, and it decides all four known cases correctly (verified by executing each).
- **`AgentStatus` has `stopped` and `cancelled`, which the fix round's prose ignored** by saying "a
  run that fails" as though `failed` were the only non-completion. A turn-capped (`stopped`) run
  still stalls, deliberately — a turn cap is not transient and the self-loop's envelope carries a
  SMALLER `max_turns` than the forward edge on the committed graph, so it would stop again having
  spent a budget unit. Now stated in the code.
- **Two retained comments contradicted the code beside them** — the class round one was hunting.
  "A reviewer REJECT is still an invocation success" sat 19 lines above the `!loopExhausted` clause
  that makes every twice-rejected PR on the committed graph an invocation failure. Rewritten, and
  see the owner decision below.
- **`384901c`'s message overstates the re-attach fix**: "for a release it did not start" is wrong for
  the case its own code comment names (a re-POST after a restart re-attaches to the release this
  same manifest started, where the discarded context was exactly right). The CODE is still correct —
  the two cases are indistinguishable at that site, `AutomatedRelease` carries no variation or sha,
  and a wrong context is worse than a thin one — but the justification was too clean.

**ONE OWNER DECISION, not a defect.** On the committed graph the reviewer's rework loop is its
source's only edge, so ANY walk whose final verdict is reject ends `loopExhausted` → and now records
`trackInvocationFailure`. The graph-level metric therefore moves with the business outcome for the
most ordinary contested case, which `LoopExhaustedInfo`'s docstring supports and main's original
"a reject is still a success" principle does not. Defensible either way; decide it deliberately
rather than finding it on a dashboard.

**What survived the round**, so the next reviewer does not repeat it: replay/resume across a failure
retry (no divergence, with no grant, a halt-position grant, or a mid-journal grant), the approval
gate (a retry re-enters through the live gate, replayed nodes stay ungated), the `!replaying` gating
of `trackHandoffFailure` (no real failure goes unrecorded), the metrics behaviour of each front end
(the Action passes no `resume`, so it is genuinely unaffected), and the restored Beacon README facts.

**A verification lesson to add to §3 in spirit:** the test for the exit-claim finding passed under
BOTH walkers on its first two drafts — the scenario never reached the retry path, because
`unemittedExitTags` counts only ROUTING tags and the loop's freshness rule decides which pass sees
the edge. A test that passes before and after pins nothing. Each of the four behavioural fixes here
was confirmed to fail against `65459cf` before being accepted.

