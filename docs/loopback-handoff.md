# `loopback-support` — working notes for whoever picks this up

**Status as of 2026-08-11 (round 6):** 84 commits ahead of `main`, 78 files, +15709/−449.
**687/687 tests**, and `npm run typecheck`, `npm run check:configs` and `npm run check:public` all
clean. HEAD is `36b6282`, and **the branch is fully pushed** (`origin/loopback-support` == HEAD, 0
ahead / 0 behind). **No PR exists yet**, and the graph is still not provisioned — both remain the
owner's call.

This header was stale for two rounds (it claimed `3324b40`, 674 tests and "46 commits unpushed"
after two rounds had been committed and pushed), which is worth more than the numbers: a reader
checking whether the working notes are current starts here.

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
- **The branch IS pushed** — rounds 1–5 were committed and pushed on the owner's explicit
  instruction, so `origin/loopback-support` matches HEAD. What is still the owner's call is
  **opening the PR**, and provisioning the graph after review.
- **No PR exists yet** (`gh pr list --head loopback-support --state all` is empty). A draft PR body
  was kept in a session scratchpad and is now **stale and gone** (it described 51 commits / 619
  tests). Regenerate it from the git log rather than hunting for it.

## 3. How verification silently lies here — read before trusting any green suite

Six distinct traps, each of which has produced a wrong conclusion in this branch's history:

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

§4.1–§4.6 are done and the branch is pushed, so what is left is review and release:

1. **Regenerate the PR body from the git log** (84 commits). The old draft is gone; do not hunt for it.
2. **Open the PR and get human review.** This is the owner's call, not an agent's.
3. **Then** provision the graph (`npm run bridge -- upgrade`) — still held until after approval, for
   the reason in §2: the walker executes the graph LaunchDarkly serves, which has neither loop edge
   until that runs.

Still open, and none of it blocking: the items in §5 (each deferred by decision), the two gaps
recorded rather than closed (the permissions row in `PATCH_FAILURE_TAXONOMY`, and the sibling cost
of the §6 narrowing in `PATCH_SITES`), and two lint tuning risks recorded in
`tests/taxonomyHome.test.ts` — its ungated phrases include ordinary English (`patch site`) and
LaunchDarkly RBAC vocabulary (`role action`), so an honest future comment can trip it. That is the
misfire class the test itself warns gets a lint deleted; if it happens, gate the term rather than
deleting the check.
