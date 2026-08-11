# beacon

Phase 2 release orchestrator. Receives deploy notifications, discovers
newly-added release flags, routes by scope, triggers releases by calling the
LaunchDarkly release API **directly** (no CD-pipeline hop — see
[ADR 0002](../../docs/adr/0002-release-via-ld-api.md)), and monitors each
release to completion.

## Design: open contract, thin adapters

Beacon's front door is a **provider-agnostic webhook**: anything that can POST
`{service, sha}` with the shared secret can announce a deploy — a CI step, a
provider's native webhook (via an adapter), the bundled Notifier CLI, or a
human with `curl`. Provider specifics live in small translator endpoints, so
supporting a new CD system is a parser, not a Beacon change.

## Layout

Flat `src/`:

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `POST /flag-releases`, `POST /webhooks/railway`, `GET /health` |
| `src/notify.ts` | The `auto-factory-notify` bin — a post-deploy hook services run to POST the deployed SHA |
| `src/discovery.ts` | Diff `.release-flags/` (current vs. previous SHA) to find newly-added flags |
| `src/state.ts` | Deploy-state store: last-seen SHA per service/environment (file-backed default) |
| `src/pending.ts` | Re-evaluation ledger: unfinished releases, re-checked on any later deploy |
| `src/notifyReport.ts` | What the Notifier tells the operator (a 200 can still carry stranded flags) |
| `src/railway.ts` | Railway webhook payload → generic deploy notification |
| `src/scope.ts` | Route by scope — frontend / backend / fullstack |
| `src/fullstack.ts` | Fullstack cross-service SHA check (stateless, re-derived per notification) |
| `src/github.ts` | GitHub Contents API client (list/read `.release-flags/` at a SHA) |
| `src/trigger.ts` | Resolve variations + rollout shape, execute via the shared release adapter |
| `src/monitor.ts` | Poll a triggered release to a terminal state (completed / reverted / stopped) |
| `src/config.ts` | Load config from the YAML files + env |

## HTTP contract

- `POST /flag-releases` — the generic contract: `{service, sha, previousSha?, environment?}`.
- `POST /webhooks/railway` — Railway's deploy webhook, translated into the same
  handling. Only `SUCCESS` deploy events act; everything else is acknowledged
  and ignored. The Railway **service name** must match a `services.yaml` key.
- `GET /health` — `{ ok: true }`.

Auth: every POST must carry `BEACON_WEBHOOK_SECRET`, either in the
`x-beacon-secret` header or a `?secret=` query parameter (for providers whose
webhooks can't set custom headers — configure Railway's webhook URL as
`https://<beacon-host>/webhooks/railway?secret=<secret>`).

## previousSha: explicit, else tracked

Discovery diffs `.release-flags/` between the deployed SHA and the previous
one. An explicit `previousSha` in the notification always wins. When absent,
Beacon falls back to its **deploy-state store** — the last SHA it processed for
that service/environment (two-deep, so a re-delivered notification re-diffs the
same range instead of the empty one). First-ever deploy: no previous SHA, all
current release-flag files are treated as new.

The store is file-backed (`BEACON_STATE_FILE`, default `beacon-state.json`);
mount persistent storage there if the host's filesystem is ephemeral. The
`DeployStateStore` interface is the seam for a KV/DB store in multi-instance
deployments.

## Release monitoring

After triggering a guarded/progressive release, Beacon resolves the release id
and polls it to a terminal state — `completed` (rolled out to 100%),
`reverted` (a guardrail metric regressed; LaunchDarkly rolled the flag back),
or `monitoring_stopped` (human intervened) — logging the outcome. Monitoring is
detached from the HTTP request and never affects the release itself (which
runs server-side in LaunchDarkly regardless). Re-delivered notifications are
idempotent: a flag whose release is already running reports `already_running`
and re-attaches monitoring instead of double-triggering.

`already_running` needs **nobody** (it is not in the Notifier's attention set — a
redelivery mid-rollout is the normal shape of a deploy) but the manifest **stays in
the ledger**. Those are different questions: only one variation of a flag can be
releasing at a time, so a manifest asking for v2 hits `already_running` on v1's
rollout, and treating that as "done" discarded the v2 release and called it a success.

## Several manifests, one flag

Manifests are one per PR (`.release-flags/pr-<N>.json`) and are **never deleted**, and
an iteration PR targets a **new variation of an existing flag**. So one flag routinely
has several manifests, each wanting a different `targetVariation`, while only one
variation of a flag can be releasing at a time. Beacon's rules for that:

- **The manifest is the unit of work** (`service`, `environment`, `sourceFile`); the
  flag is the unit of *action* (`flagKey`, `environment`).
- **Highest target variation acts first**, in both the discovered and the pending pass.
  An absent `targetVariation` means the lineage tip, so it sorts highest. Filename order
  and ledger insertion order both mean "oldest first", which for a lineage is backwards.
- **Only a write claims the flag's action slot — plus a write we cannot rule out.** A `held`
  or `noop` manifest wrote nothing and must not defer one that can release; a second manifest
  that does reach the trigger is deferred **non-finally**, so the ledger re-checks it. A
  trigger that **threw** claims the slot as well, because there are three states and not two:
  `startRelease` awaits the response *after* LaunchDarkly applied the patch, so a lost response
  is "we do not know".
- **Whether that claim costs the sibling a delay or its release depends on the SHAPE of what
  throws**, not on pre-write vs post-write — and the shapes are enumerated status by status in
  `PATCH_FAILURE_TAXONOMY` (see below), which is the only place this repo states them. Two
  consequences of that enumeration are worth having here: every refusal `trigger.ts` can answer
  itself is answered there and returns `held` rather than throwing, and what is left for the catch
  is a throw whose write is unknowable, refusals that recur for no single manifest — **and one that
  does** recur for a single manifest, which is a knowingly open gap recorded in that table rather
  than a solved case. Stating that residual is not optional: leaving it out is exactly how the
  retired version of this bullet read.
- **A manifest whose target is BEHIND what the environment serves is moot**, not held: a
  newer variation superseded it, so it resolves as a final `noop` and stops being tracked.
  Holding it would wait forever for a release that must never happen.
- **A manifest whose target is not in the lineage at all** (`control`, a hand-named
  variation) is **held for a human**. Releasing it would ramp production off the released
  lineage — a deliberate rollback is LaunchDarkly's job, not a deploy notification's.
- **A manifest naming a variation the flag does not have** is **held for a human** too, and
  for the same reason: only a person can say whether the variation was never added or the
  manifest's `targetVariation` is wrong. It must not *throw*: a throw claims the flag's action
  slot, and this refusal recurs identically for this one manifest on every deploy, so the claim
  would never lift and the sibling that could release never would — permanently, since "highest
  target first" ranks the manifest naming the *missing* higher variation ahead of the releasable
  one. `write_manifest` checks `targetVariation` against `/^v\d+$/` but never against the flag's
  real variations.
- **A patch LaunchDarkly REFUSES with an allowlisted status is held for a human**, named with
  LaunchDarkly's own message, and the sibling can still release in this same notification because
  nothing was written. Not "on content grounds", which this bullet used to say and which is false
  twice over: one allowlisted status has a second cause that is nothing to do with the manifest, and
  one of the patches carries no manifest content at all. Which refusals qualify, what each does and
  does not prove, and why, are in the taxonomy — not here.

> **Known limitation: mutual exclusion is per-notification, not per-flag.** The slot
> above is a set inside one request. `config/services.yaml` registers **four
> `side: backend` services on one repo** (`togglemart-gateway`, `-catalog`, `-orders`,
> `-users`), so one merge produces four concurrent notifications, each with its own set —
> and they cannot see each other. Two of them can therefore reach `triggerRelease` for the
> same flag at the same moment. The residual window is a **concurrent double-start during
> a rollout**: `findActiveRelease` catches it as soon as the releases listing is
> consistent (it is eventually consistent right after a start — see `monitor.ts`, which
> retries five times for exactly that), so the exposure is that first moment only.
> Closing it properly needs either a **persisted per-flag lease** or a decision that one
> service **owns** a flag's releases; both are deferred pending that product decision
> (`docs/loop-seam.md`).

### Which statuses mean what: `PATCH_FAILURE_TAXONOMY`, and only there

Every status Beacon classifies, what it does and does not prove, how wide it is, whether anything was
written, what a `held` note may therefore say to an operator, and which residual gaps are knowingly
open — all of it is one table: **`PATCH_FAILURE_TAXONOMY` in [`src/trigger.ts`](src/trigger.ts)**,
next to the classifier, with the behaviour *derived* from it rather than described alongside it. It
also inventories the patches **`triggerRelease`** sends — which is not all of Beacon's: `repoint.ts`
sends one more, handled locally and reported per child flag, and that table does not cover it.

This file, `docs/loop-seam.md` and the catch in `src/server.ts` each used to re-derive that argument
in their own words. Eleven prose corrections on this branch each fixed **three of the four copies**,
and the missed copy was reliably the one an auditor reads first. So the copies are gone rather than
annotated: this section is a pointer and states no part of the argument, and
`tests/ledgerLineage.test.ts` fails if any of the three sites starts stating one again — including in
paraphrase, which is the hole the first version of that test left open.
