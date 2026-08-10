# Action item — make the standard metric set visible at PR time, and preserve it at release

**Status:** pieces 1 and 3 shipped; piece 2 (the PR-time tool) outstanding
**Supersedes:** two gaps previously described separately — "the factory can't attach
existing metrics" and "an orphaned metric can't be detected". Both are consequences of
this one, and neither needs its own fix.

## Why

The factory's goal is a **guarded rollout**: a flag released in stages, compared against
control on live traffic, with automatic rollback. What makes a rollout guarded is the set
of metrics attached to it.

LaunchDarkly already lets a team define that set centrally, as a **release policy** — "in
production always use this set; in QA use that one; flags tagged `UI` get a different set
from flags tagged `API`". A PR whose feature is genuinely covered by standard latency,
error, and Core Web Vitals metrics needs no new metrics at all; it needs the standard set
attached.

The factory can't see that set, and — worse — writing a metric of its own currently
**replaces** it.

## Current state (verified)

**The reader already exists and already includes metrics.** `releaseAdapter.ts:210`:

```ts
getReleasePolicy(ld, flagKey, environmentKey) → ReleasePolicy | null
// { releaseMethod?, randomizationUnit?, stages?, metricKeys?, metricGroupKeys? }
```

It reads `/internal/projects/{p}/flags/{flag}/environments/{env}/release-settings`, so
LaunchDarkly has already resolved environment and tag scoping down to that flag — the
result is the **effective** set, not policy rules we would have to match ourselves. A 404
returns `null`; the call is best-effort.

**Verified against a real project** (`abram-backend`, single policy "Prod policy",
2026-08-10). Every flag in production returns the same resolved policy — including flags
never configured individually, which is the premise piece 2 depends on:

```json
{
  "releaseMethod": "guarded-release",
  "releasePolicyKey": "test",
  "releasePolicyName": "Prod policy",
  "guardedReleaseConfig": {
    "metricKeys": ["ld_autogen__otel-default-http-5xx-rate",
                   "ld_autogen__otel-request-average-latency", "login"],
    "rollbackOnRegression": false,
    "rolloutContextKindKey": "user"
  }
}
```

Three fields in there that `normalizeReleasePolicy` currently **discards**:
`rollbackOnRegression` (the rollback-vs-pause choice — see piece 3),
`releasePolicyKey`, and `releasePolicyName` (which piece 2's reporting wants: *"guarded by
policy 'Prod policy'"* beats a bare key list). `metricGroupKeys` and `stages` are absent
here, so Beacon still falls back to `DEFAULT_GUARDED_STAGES`.

**Environment scoping is real.** The same flag in `dev` and `test` returns
`{"releaseMethod":"","releasePolicyKey":"","releasePolicyName":""}` — no
`guardedReleaseConfig` at all. `normalizeMethod("")` returns `undefined`, so a non-policy
environment yields an effectively empty policy rather than an error. That happens to be
correct behaviour; it should be deliberate rather than incidental.

**Its only consumer is Beacon, at release time** (`trigger.ts:242`). No agent can reach
it: `caps.createMetric` grants exactly `CREATE_METRIC_TOOL` and `LIST_METRICS_TOOL`
(`sandboxTools.ts:489`), and there is no release-settings tool at all.

**The precedence that causes the damage** (`trigger.ts:249-254`):

```ts
const metricKeys      = ov.metricKeys      ?? policy?.metricKeys      ?? [];
const metricGroupKeys = ov.metricGroupKeys ?? policy?.metricGroupKeys ?? [];
const hasMetrics      = metricKeys.length > 0 || metricGroupKeys.length > 0;
const method          = ov.releaseMethod ?? policy?.releaseMethod ?? (hasMetrics ? "guarded" : "progressive");
```

`??`, not a merge. So a manifest naming one feature-specific metric **drops every standard
metric the policy would have supplied** — five metrics become one, silently, and the
rollout is guarded by a single narrow signal instead of the org's baseline.

Note what this precedence gets *right*: with a policy configured, a manifest that lists
**no** metrics still yields a guarded rollout using the policy's set. The "no metrics →
progressive downgrade" failure only occurs when there is neither a policy nor manifest
metrics.

## Decisions taken

- **Merge, don't override.** When a release policy exists, the release is guarded by the
  union of the policy's metrics and anything the PR added.
- **Environment:** assume the policy is not environment-scoped; where it is, read
  **production**. Beacon already defaults to `LD_ENVIRONMENT_KEY || "production"`
  (`beacon/src/config.ts:54`), so a single-environment read matches existing behaviour.
- **Metrics stay advisory.** No hard gate requiring metrics, and no INCOMPLETE for a
  "missing" one — a PR covered by standard metrics is a legitimate outcome.
- **Union unconditionally; no "replace" mode.** Replace is the *current* behaviour rather
  than a feature worth preserving: `ReleasePlan.metricKeys` is the **agents'** block, so an
  LLM listing one metric it just created is recording its work, not deciding to suppress
  the org's baseline. A human who means "only these" would be editing `releaseIntent`,
  which has no metrics field at all. Suppression also turns out to be the wrong tool for
  the case that motivated it — see the next decision.
- **Inherit rollback-vs-pause from the release policy.** Do not assert a per-metric
  auto-rollback preference over a policy that has one configured.

## Design — three independent pieces

Each fixes a different problem and can ship on its own. Pieces 1 and 3 are Beacon-side
and small; piece 2 is the larger one. Nothing here depends on piece 2.

### 1. Merge at release time (Beacon) — SHIPPED

Change the two `??` chains to a union, deduped, keeping singles and groups distinct —
`startRelease` receives them as `{key, isGroup}` pairs (`trigger.ts:269-272`), so the two
lists must not be flattened together.

Doing the merge **in Beacon rather than in the agent's manifest write** is deliberate:

- The manifest keeps meaning "what this PR added", which is what an agent can honestly
  assert.
- The policy is read at release time, so a policy edited between PR and deploy takes
  effect. An agent-written union would be a stale snapshot.
- It works for PRs authored before this ships — no manifest migration.

### 2. Read the policy at PR time (a tool)

A read-only `get_release_policy` tool wrapping `getReleasePolicy`, granted to the
**metrics author** (does the standard set already cover this change?) and the **research
planner** (should the brief even ask for new metrics?).

Its value is *judgment and reporting*, not constructing the union:

- The metrics author can decline to mint a redundant metric — the cheapest possible
  outcome, and one the current instruction set cannot reach because it cannot see what
  already applies.
- The PR can state what the rollout will actually be guarded by: *"guarded by 5 policy
  metrics + 1 created here"*. That is the first time the attached set becomes visible at
  authoring time, which is the gap underneath all of this.

Sequencing note: the read is keyed by flag, so it only works once the flag exists. In the
chain the implementer runs before the metrics author, so that ordering already holds — but
the research planner runs *before* the flag exists, so its read must tolerate `null` (no
flag yet ⇒ no per-flag policy) and reason without it.

### 3. Stop overriding the policy's rollback-vs-pause choice (Beacon) — SHIPPED

A release policy carries **one** rollback setting — auto-rollback, or pause and wait for
human intervention. The same choice exists **per metric** when metrics are added
individually to a guarded release in the UI, and the API is per-metric keyed to match:

```ts
metricMonitoringPreferences?: Record<string, { autoRollback: boolean }>;   // releaseAdapter.ts:57
```

Beacon sends it for **every** metric on **every** guarded release, hardcoded
(`trigger.ts:274`):

```ts
for (const m of metrics) metricMonitoringPreferences[m.key] = { autoRollback: true };
```

So an org that configured its policy to *pause and wait* is very likely having that
overridden to auto-rollback — silently, on metrics its policy owner never listed
individually. Same bug class as the metrics `??` override, and worse in consequence: that
one changes *what* is watched, this changes *what happens when it trips*, and it fails
toward the more destructive action.

**Decision: inherit the policy's setting, read explicitly.** The live probe settled this —
the policy response carries `rollbackOnRegression`, so there is no need to rely on
"omitting inherits". Extract it in `normalizeReleasePolicy` and map it through.

**Shape mismatch to design around:** the policy's setting is singular and policy-level
(`rollbackOnRegression`), while the release instruction is per-metric
(`metricMonitoringPreferences: { [key]: { autoRollback } }`). So the mapping is a fan-out:
the policy's one value applies to every metric in the release. That is also what makes the
deferred per-metric human intent a clean extension rather than a conflict — it would
override individual entries in a map the policy fills uniformly.

**When there is no policy, keep sending `autoRollback: true`.** There is nothing to
inherit, and omitting would trade today's known behaviour for an unknown default. Scope
the change to exactly the case where we are currently overriding something.

## Consequences elsewhere

- **The orphaned-metric guard has stopped gating (done).** It reports INCOMPLETE when an earlier
  iteration's `metric_keys` are absent from the final run's, but `metric_keys` is set only
  by `create_metric`, stripped from agent-supplied tags (`sandboxTools.ts:518`), and the
  tool executor is per node run — so a rework that correctly *adds* a metric while keeping
  the first is indistinguishable from one that replaced it, and the guard fires on the
  compliant path. Once the standard set comes from the policy rather than from tags, the
  guard is measuring the wrong thing entirely. `inventory.metric_keys` now accumulates so
  every created metric stays visible, and the INCOMPLETE is gone.
- **Reporting** should read the union (policy + created), not just `metric_keys`.

## Ask for LaunchDarkly engineering

**Per-metric rollback in the release policy.** The policy carries a single
`rollbackOnRegression` for the whole metric set, while a guarded release configured by
hand in the UI has the checkbox **per metric** — and the API accepts per-metric
preferences. So the policy is the narrower surface, and the factory has to fan one value
out across every metric.

The case for changing it is the same one that motivates the deferred human-intent field: a
team wants auto-rollback on a 5xx-rate regression but pause-and-wait on latency, because a
feature may knowingly cost latency. Today that can only be expressed per release, by hand
— which is exactly what an automated factory can't do. If the policy grows per-metric
settings, the factory inherits the right behaviour for each metric with no extra authoring
surface of its own, and the deferred `releaseIntent` field becomes unnecessary for the
common case.

## Deferred

- **Per-metric rollback preference from a human.** The motivating case is a dev who knows
  their feature adds latency and wants a p95 breach to pause rather than roll back. The
  API supports it per metric, so this is expressible — but the setting belongs in
  `releaseIntent` (human-owned, wins over the plan, alongside holds and `notBefore`), and
  that is a feature rather than a fix. Deferred deliberately. Note it makes metric
  *exclusion* unnecessary: the answer to a metric that would misfire is to change what
  happens when it trips, not to drop it from the release.
- **Tag-scoped release policies.** They need the factory to apply the org's tag taxonomy
  at flag creation (`create_flag` merges only `["auto-factory", "auto-generated", …extra]`,
  `ldWriter.ts:313`). Judged optional and not widely used yet.

## Open questions

1. **Which environment for the agent-side read** — reuse `LD_ENVIRONMENT_KEY` for symmetry
   with Beacon, or a separate variable? Reusing it couples authoring-time reads to Beacon's
   release target, which is probably right but should be stated.
2. **Beta API exposure.** Release settings sit on the same `/internal` beta surface as the
   automated-release read endpoints, which `releaseAdapter.ts:4-11` documents as mid-rename
   and expected to change. A tool wrapping `getReleasePolicy` inherits that containment
   (only `releaseAdapter.ts` changes when the public API lands) — but this is the in-flux
   half of the API. The *trigger* is a public semantic patch; the reads are not.

## What it touches

| Half | Files |
|---|---|
| Merge | `packages/beacon/src/trigger.ts`, tests |
| Inherit rollback | `packages/beacon/src/trigger.ts` (and `releaseAdapter.ts` only if the policy setting must be read explicitly), tests |
| Tool | `sandboxTools.ts` (tool def + `buildSandboxTools` grant + executor case), `npm run export:tools` → `config/agentcontrol/tools/get_release_policy.json`, a capability on the graph edges into metrics-author / research-planner, both agents' instructions, `check-configs` tool-registry sync, CHANGELOG |
| Cleanup | `approval.ts` (drop the metrics gate), `graphWalker.ts` (union `metric_keys` in the inventory mirror), reporting on all surfaces |
