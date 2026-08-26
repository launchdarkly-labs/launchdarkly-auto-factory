# AutoFactory Agent Config & Graph — Change Log

Running log of changes to the AutoFactory **AI configs** (`autofactory-*`), the
**agent graph** (`gha-auto-factory`), and the **operational flags** that drive the
pipeline. These resources live in LaunchDarkly (the factory / control-plane project
`auto-factory-prototype`), not as files in this repo — this file is the
human-readable record of what changed there and why.

> Out of scope: agent *runtime* changes (the action's tools — `git_diff`,
> `create_flag`, `write_file`/`edit_file`/`run_tests`/`commit_and_push` — and the
> approval logic) live in the code repo / its PRs. They're referenced here only
> where they explain a config change.

Status legend: ✅ done · 🔜 planned/in progress

---

## 2026-08-26 (surface-aware provider routing + OpenAI variations, ADR 0018)

### ✅ `auto-factory-ai-provider`: surface rules + `openai` variation

- **New variation `openai`** (agents on OpenAI Chat Completions;
  `OPENAI_API_KEY`/`CODEX_API_KEY`). **New committed `targeting` block**
  (applied on create by provision; live project PATCHed the same day): flag ON,
  rules on `run.surface` — `claude-code` → anthropic, `codex` → openai,
  `github-action` → **50/50 anthropic/cursor rollout bucketed by run key**;
  fallthrough anthropic. Surfaces stamp `AUTOFACTORY_SURFACE` (skills, GHA
  workflow env, CLI default `cli`). Replaces the earlier 40/40/20 per-agent
  model A/B with a run-level provider split. Runners fall back to anthropic
  when the selected provider's key is absent.

### ✅ All 8 AI configs: `openai` variation + provider-routing rule

- Every agent config gains variation **`openai`** = `OpenAI.gpt-5.2` (judges:
  `OpenAI.gpt-5-mini`), instructions/tools **copied from `default` via the new
  committed `copyFrom` field** (one source of truth, no duplicated instruction
  blocks). New committed `targeting` rule: `run.provider in ["openai"]` →
  serve the `openai` variation (applied on create; live project PATCHed).
  Registry note: LD's global model catalog has base gpt-5.x keys but no
  `-codex` variants (probed live 2026-08-26).

## 2026-08-21 (observability-first metric backing + M14 human-input pause)

### ✅ `autofactory-metrics-author`: Metric Backing priority rewritten (ADR 0017)

- **Change (default + sentry variations, committed + live via `bridge upgrade`):**
  decision order per category is now (1) **reuse existing data** — an existing
  `track()` event, OR existing spans with attribution + delivery already verified
  (defining a trace metric on them is code-free); (2) **ride the installed
  observability stack** — LD o11y SDK (direct export, no delivery validation) or
  generic OTel with the LD evaluation hook registered (hook-adding is encouraged,
  code changes and all); (3) **instrument a new `track()` call** — the floor, and
  the only backing when no telemetry stack exists. Installing a new o11y/OTel
  package stays forbidden (M10) — ride what's there, record the gap.
- **Trace metrics are no longer LD-o11y-only:** valid under ATTRIBUTION (an LD
  evaluation hook — o11y plugin or the standalone OTel tracing hook — enriches
  spans in the trace evaluating this flag) + DELIVERY (traces demonstrably reach
  LaunchDarkly; `query_dependencies` edges are the evidence — hook presence in
  code proves attribution, never delivery). Pre-aggregated OTel **metrics**
  remain banned; the ban no longer smears onto span-level traces.
- **M10 rewritten (footprint ≠ guardrail):** span coverage + flag attribution
  wherever a telemetry stack exists, regardless of which backing gates the
  release; hook/exporter init must degrade to a no-op, never crash startup.
- **New M14 (pause and ask):** first-time hook wiring in a generic-OTel service
  with unverifiable delivery → the agent STOPS before any instrumentation,
  writes `humanInput.question` into the manifest, tags `needs_human_input=true`
  + `human_question`, and the walker halts (`WalkResult.pendingInput`). The
  human answers in the manifest's `humanInput.answer` (agent-unwritable,
  structurally protected in `write_manifest`) and re-runs; the fresh walk finds
  the answer and completes. Surfaces: CLI exit 4, PR comment +
  `action_required` check run, editor toast. Same manifest-as-human-channel
  pattern as releaseIntent (ADR 0009).
- **Docs list extended:** `sdk/features/opentelemetry-server-side` /
  `-client-side`, `sdk/features/observability-otel-collector`,
  `home/metrics/autogen/opentelemetry`.
- **Live A/B arms re-synced:** `composer-2-5` and `fable-5` had drifted (stale
  pre-ADR-0013 M01 wording); PATCHed to the new default instructions so arms
  again differ only by model. `vega-chain-copy` left untouched (preserved
  legacy).
- **Why:** the old rules conflated "pre-aggregated OTel metrics can't back a
  guarded release" (true) with "only the LD o11y package can back trace
  metrics" (false — the SDK hooks attribute spans in any OTel estate), and
  framed track() as the default rather than the floor, under-investing in
  estate-wide telemetry. The pause exists so an unverifiable trace guardrail is
  never shipped as a silent no-op — surfacing to a human beats both guessing
  and silently downgrading.

### ✅ `autofactory-research-planner`: telemetry_inventory in the brief

- Repo Conventions now require a `telemetry_inventory` (o11y packages, LD hooks
  wired, track() calls, span coverage, `ld_trace_delivery`
  verified/unverified/unknown via `query_dependencies`, advisory
  `recommended_backing`). Evidence, not routing: the metrics author verifies it
  and may override with a note. Per-telemetry-type config VARIATIONS were
  considered and rejected (the decision needs checkout facts the deciding step
  must verify anyway; near-identical instruction copies multiply maintenance).

### ✅ Tags + tools + runtime

- New registry tags `needs_human_input` (routing: halts the walker) and
  `human_question` (informational: surfaced by front ends); README table +
  check-configs updated.
- `write_manifest` tool: new `humanInput` block — agents may set/update
  `question`; `answer` is human-owned and survives every agent write (mirror of
  the releaseIntent protection). Tool description updated (committed +
  exported + live).
- `create_metric` tool description updated for the two-condition trace-backing
  rule; trimmed to LD's 1024-BYTE description limit (em dashes count as 3 —
  discovered live when the upgrade 400'd at 1017 chars/1029 bytes).
- Runtime (code repo, same commit): `WalkResult.pendingInput` +
  `awaiting-input` walk event; CLI exit code 4 + resume message; Action PR
  comment + `action_required` check; extension toast; Claude Code skill exit-4
  contract. Graph-level metrics are suppressed on the pause (like approval
  pauses — the post-answer re-run reports the complete invocation).

## 2026-08-18 (provider-aware routing on flag-testing)

### ✅ `autofactory-flag-testing`: run.provider rules added around the composer-2-5 arm

- **Why:** on 2026-08-13 a `composer-2-5` A/B arm was added to this config
  (live, via API — not by the bridge) with a naked 50/50 `default`/`composer-2-5`
  fallthrough rollout and NO `run.provider` rules. Composer only runs on the
  Cursor provider, so any run bucketed to the anthropic provider AND the
  composer arm passed `composer-2.5` to the Anthropic API and failed the node
  with a 404 `not_found_error` — deterministically, ~25% of runs. Observed
  live: demo PRs #238 and #240 (2026-08-18) failed flag-testing this way,
  driving the graph invocation-failure rate to 75% that day.
- **Change (production targeting, via API):** mirrored the 2026-07-20
  provider-aware pattern from `autofactory-flag-implementer` /
  `autofactory-metrics-author` — rule `run.provider = cursor` → 50/50
  `default` / `composer-2-5`; rule `run.provider = anthropic` → 100%
  `default` (this config has no fable arm); fallthrough → 100% `default`
  (safe for runtimes that don't stamp `run.provider`).
- **⚠ Known drift, not fixed here:** the `composer-2-5` variation's
  instructions are STALE (pre-ADR-0013: boolean flag-on/flag-off language, no
  T14, no string-multivariate T01, no run_tests scaffolding paragraph), so the
  arm differs from `default` by more than model. Re-sync by hand before
  reading the A/B as a model comparison. There is also a `hello-test`
  connectivity-test variation (weight 0 everywhere) from the same 2026-08-13
  session that can be deleted.

---

## 2026-08-12 (raise runaway backstops)

### ✅ `gha-auto-factory`: all edge `max_turns` → 100

- Raised every edge's `max_turns` (was 8 steward / 20 implementer / 20
  metrics-author / 20 flag-testing / 30 reviewer) to a uniform **100**, and the
  runner's no-edge default from 12 to 100. These caps are runaway backstops,
  not budgets: the old values were low enough for a legitimately long node —
  especially flag-testing scaffolding a test harness from scratch on a
  greenfield repo (explore → scaffold → install → fix-and-re-run loop) — to
  hit the cap mid-task. Worse, a capped node reports `stopped` (not `failed`),
  the chain continues, and un-pushed work is silently lost.
- Companion runtime changes (code repo, same day): per-response `max_tokens`
  4096 → 32000 (a `write_file` carries the whole file in one response; a
  max_tokens stop exited the tool loop silently as `completed`), judge cap
  4096 → 16000 (truncation still detected + discarded), `run_tests` subprocess
  timeout 240s → 30 min, and an explicit 60-min API client timeout (the SDK
  refuses non-streaming requests above ~21k max_tokens without one).
- Live update: `gha-auto-factory` on `auto-factory-prototype` PATCHed via
  `bridge upgrade` (graph handoff drift is part of the owned shape). Other
  existing projects pick this up on their next `bridge upgrade`.

---

## 2026-08-11 (`create_metric` description over LD's 1024-byte cap)

### ✅ Tool: `create_metric` description trimmed to fit
- **Why:** LaunchDarkly rejects AI tool descriptions over **1024 bytes** (counted
  as bytes, not characters), and the `create_metric` description had grown to
  1114 bytes — bootstrap failed to create the tool and two dependent
  tool-attachments cascaded. Multibyte punctuation (em dashes, ellipses, `↔`)
  made the byte count exceed the visible character count.
- **Config:** `tools/create_metric.json` description condensed to 1020 bytes —
  wording tightened, multibyte punctuation converted to ASCII; no semantic
  changes to the backing rules (event vs. trace) or the schema.
- **Credit:** fix contributed by Matt Laster (external PR); already-provisioned
  LD projects need a re-bootstrap / `bridge upgrade` to pick up the new
  description.

---

## 2026-08-07 (Bedrock provider)

### ✅ `auto-factory-ai-provider`: new `bedrock` variation

- Added a fourth variation `bedrock` ("Bedrock") to the committed flag definition
  (`flags/auto-factory-ai-provider.json`), appended after the existing three so
  the provisioned defaults (off→`anthropic`, on→`vega`) are untouched. Serving
  `bedrock` runs the SAME agents/tool loop as `anthropic` over Claude on Amazon
  Bedrock (the Bedrock Mantle Messages endpoint) — auth via the AWS credential
  chain (AWS_REGION + keys/OIDC role), billing on AWS.
- No AI-config changes needed: the runner maps the configs' Anthropic model
  names to Bedrock ids automatically (`claude-…` → `anthropic.claude-…`), so the
  per-agent model variations work unchanged on both providers.
- LIVE flag updated the same day: the `bedrock` variation was PATCHed onto
  `auto-factory-prototype`'s live flag (v2→v3, additive — the production 50/50
  anthropic/cursor rollout and off-variation are unchanged). Other existing
  projects need the same manual PATCH/UI edit — `bridge upgrade` deliberately
  never edits existing flag variations; new bootstraps get it from the
  committed file.
- Runtime NOT yet validated live (no AWS credentials at build time). Before
  serving `bedrock`, confirm the target AWS account has the mapped Claude
  models enabled in the chosen region.

---

## 2026-07-31 (greenfield-repo harness scaffolding)

### ✅ `autofactory-flag-testing`: scaffold the test harness when the repo has none
- **What**: extended the "Test conventions" section: on a repo with no test
  suite the agent must also SCAFFOLD the harness so `run_tests` can invoke it —
  for Node that means adding the package.json `"test"` script (run_tests runs
  `npm test`); a `run_tests` "no test harness" response is an instruction to
  build it, not a reason to skip.
- **Why**: external bug report (2026-07-30, SE run against a minimal Express
  app with no tests): `run_tests` treated npm's default "no test specified"
  stub as a RED run, so every upstream node handed off `tests_last_run=fail`
  and the `tests-green-at-handoff` shim killed the chain before flag-testing —
  the node whose job is to create the missing suite. The runtime side of the
  fix (in code, not config): `run_tests` now classifies "no harness present"
  (missing/stub npm test script, pytest exit 5) as inconclusive — it no longer
  sets `tests_last_run`, so the shim only gates on real test executions.
- **Deploy**: committed file updated; live projects pick it up via
  `bridge upgrade`.

---

## 2026-07-29 (Sentry path → `sentry` variation; review patch)

### ✅ Metrics author: Sentry moved to a dedicated variation
- **Why:** keep Sentry an optional path with zero drift on the core factory —
  the `default` variation (instructions + tools) is byte-identical to the
  pre-Sentry config; LD targeting selects the `sentry` variation to opt in.
- **Config:** `autofactory-metrics-author.json` now ships two variations:
  `default` (unchanged, no `query_sentry` attached) and `sentry` (Sentry
  instructions + `query_sentry`). The graph edge keeps `query_sentry` as the
  capability ceiling (ADR 0011); runners only advertise the tool in the mode
  note when the served variation actually attaches it.
- **Also in this patch:** LD LLM Observability spans record prompts/outputs
  unconditionally again (SENTRY_AI_RECORD_PROMPTS gates only the Sentry copy);
  the GHA/pre-push label gate is now optional (AUTOFACTORY_REQUIRE_LABEL,
  default = every PR); demo manifest `pr-1.json` back to `api-errors` only.

---

## 2026-07-24 (Sentry estate bridge — ADR 0015)

### ✅ Metrics author: `query_sentry` + dual-export guidance
- **Why:** Sentry is ingest-only for OTel; estates need an author-time picture
  and dual-export so LD `otel*` / KG still work alongside Sentry APM.
- **Tool:** `query_sentry` (REST estate client) — issues, error volume,
  `launchdarklyContext` coverage, dual-export gap hints. Soft when creds absent.
- **Graph / grant:** metrics-author edge + fallback include `query_sentry`.
- **Instructions:** call `query_sentry` before choosing killswitches; attach
  `sentry-errors-*` for errors; prefer `otel*` via `list_metrics` when LD o11y
  is present; never invent guardrails from Sentry aggregate-only stats; ensure
  full Sentry baseline + dual-export / LD flag-in-span when LD o11y is present.

### ✅ Shared Seer issue matcher
- Beacon Seer reuses `findRelatedIssue` from `@auto-factory/shared` (same as
  estate client).

---

## 2026-07-24 (Sentry layer — ADR 0014)

### ✅ Metrics author: Sentry as error killswitch
- **Why:** LaunchDarkly's official Sentry→LD metrics integration feeds guarded
  rollouts from production errors; feature-scoped `track()` error events are
  redundant when Sentry is present and miss attribution without
  `launchdarklyContext`.
- **Instructions:** detect Sentry → reuse `sentry-errors-binary` /
  `sentry-errors-count` via `list_metrics`, instrument exact context name
  `launchdarklyContext`, tag `sentry_guardrail=true` (M13). Latency/business
  stay LD `track()` / trace metrics.
- **Config:** `config/agentcontrol/metrics/` provisioned into the APP project;
  tag registry + handoff verifier updated.

### ✅ Factory LLM observability → Sentry AI monitoring (dual-write)
- Runtime: `SENTRY_DSN` enables `@sentry/node` on Phase 1 runners; spans dual-
  write with LD LLM Observability until `DISABLE_LD_OBSERVABILITY=true`.

### ✅ Beacon Seer on revert
- Runtime: `BEACON_SEER_AUTOFIX=true` → find Sentry issue → Autofix `open_pr`.

---


## 2026-07-20 (provider-aware model routing)

### ✅ run.provider context attribute + provider-aware A/B rules
- **Why:** no single provider could execute the 40/40/20 three-model split —
  verified live that `claude-fable-5` works on the Anthropic API but is
  REJECTED by the Cursor plan (fast server-side error on every parameter
  variant; Sonnet succeeds on the identical path), while `composer-2.5` can
  only run on Cursor. Prerequisites can't express this (flag-level gates, not
  variation routers) — the transferable LD-native fix is a context attribute.
- **Runtime (tooling `81dfc18`):** after resolving `auto-factory-ai-provider`,
  every front end stamps the EFFECTIVE provider on the run context
  (`run.provider`); AI config targeting rules can then serve only models the
  executing runner can run. Additive — no rules → fallthrough as before.
- **Targeting (production, both `autofactory-flag-implementer` and
  `autofactory-metrics-author`):** replaced the flat 40/40/20 fallthrough with
  rules — `run.provider = cursor` → 50/50 `default` (Sonnet 4.6) /
  `composer-2-5`; `run.provider = anthropic` → 50/50 `default` / `fable-5`;
  fallthrough → 100% `default` (safe for vega/older runtimes).
- **`auto-factory-ai-provider` (production):** fallthrough changed from fixed
  `cursor` to a **50/50 anthropic/cursor rollout on the run context** — each
  pipeline run picks a provider, and the rules above pick compatible models.
  Net model mix per agent-run: 50% Sonnet, 25% Composer, 25% Fable.
- **Demo repo:** `autofactory-cursor.yml` now passes `ANTHROPIC_API_KEY`
  (secret already existed) so either provider can execute per run.

## 2026-07-20 (maintenance sweep)

### ✅ Metrics author: removed the pre-ADR-0013 `flag_created=false → skip` workflow step
- **Motivation (maintenance sweep):** the committed instructions contradicted
  themselves. Rule M01 (rewritten for ADR 0013) correctly keys the skip on "no
  verified flag outcome" and explicitly says `flag_created=false` alone is NOT a
  skip signal — but the numbered workflow ("## Instructions" step 1) still said
  "If `flag_created` is false, apply M01 … and finish", and the
  conflict-resolution list said "if no flag was created, create no metrics."
  Those two leftovers would skip metrics on exactly the `extend_variation` /
  `ride_existing` iteration PRs the multivariate work exists for (no flag is
  *created* on those paths by design).
- **Change (`autofactory-metrics-author`, committed copy):** workflow step 1 now
  keys on M01's own condition (`flag_action_executed` skipped, or no flag key at
  all) and states that `flag_created=false` with a flag key present means
  proceed; the conflict-resolution line now reads "no verified flag outcome".
  No rule numbering changed.
- **Live sync:** with the next `bridge upgrade` (still pending for the whole
  ADR 0013 batch — see 2026-07-17 rollout status). ⚠ Upgrade only syncs the
  `default` variation: the live-only `composer-2-5` and `fable-5` A/B arms (see
  the Fable 5 entry below) must be re-synced to the updated instructions BY HAND
  afterward, or the arms differ by more than model again.

### ✅ Native cursor-automation rule refreshed to ADR 0013 (bootstrap file, not an LD config)
- `bootstrap/cursor-automation/dot-cursor/rules/autofactory.mdc` still taught the
  pre-0013 world: boolean control/treatment flags, no `flag_action` decision, and
  a `releaseOverrides` manifest. Rewritten: string-multivariate flag convention
  (`control`+`v1`, created dark, client-side availability by scope), tool
  translations for `get_flag_state` / `add_variation` / `use_existing_flag` /
  `write_manifest` / `read_ld_docs` (mapped to LD MCP tools + native edits),
  planner phase now decides `flag_action`, and the manifest example is
  schema 1.2 (`targetVariation`, `releasePlan`, human-owned `releaseIntent`
  skeleton). Logged here because that front end reads the SAME live configs;
  no LD-side change.

## 2026-07-20 (later)

### ✅ Fable 5 A/B arm on the implementer + metrics author
- **New variation `fable-5`** on `autofactory-flag-implementer` and
  `autofactory-metrics-author`: a mirror of each config's `default` (same
  instructions, tools, judge attachment) with the model swapped to the global
  `Anthropic.claude-fable-5` model config (token pricing present, so cost
  tracking works). Live-only change — variations the bridge doesn't recognize
  are left alone by `upgrade`, so the arm survives config syncs.
- **Production targeting** on both configs: fallthrough rollout on the `run`
  context changed from 50/50 (Sonnet 4.6 / Composer 2.5) to
  **40% `default` (Sonnet 4.6) / 40% `composer-2-5` / 20% `fable-5`**.
- **Caveat:** the CLI front end always executes on the Anthropic runner,
  which cannot serve the `composer-2-5` arm — CLI runs bucketed there fail the
  node; run the A/B via the GitHub Action on the cursor provider.
- **Composer drift resolved (same day):** both `composer-2-5` variations were
  synced to their config's `default` — instructions (multivariate rules on the
  implementer, M12 on the metrics author) and tool attachments — so the three
  arms differ ONLY by model, which is what makes the A/B a model comparison.



### ✅ Metrics author: literal event keys (M12) — instruction hardening from live run
- **Motivation (live CLI run, `show-free-shipping-nudge`):** the metrics author
  instrumented events with a template literal — `` track(`${FLAG_KEY}-error`) `` —
  so the deterministic `metric-event-instrumented` shim (which greps for the exact
  event key) found no emitter and halted the chain after the metrics step. The
  instrumentation was real; the key just wasn't greppable. LaunchDarkly code
  references have the same requirement.
- **Change (`autofactory-metrics-author`):** new rule **M12 (literal event keys)** —
  every `track()` call must pass the event key as a literal string exactly matching
  what was given to `create_metric`; template literals/concatenation/variables fail
  the run. The Instrumentation Pattern section now says "written as a LITERAL
  string" at the `track()` syntax. The shim stays strict (greppable literal = the
  verifiable contract); its failure detail now explains the dynamic-key case and
  the fix (runtime change, noted here because it pairs with M12).



### ✅ Deterministic handoff shims: agent claims re-derived from primary evidence
- **Motivation (live run a):** the implementer wired a multivariate flag through a
  boolean helper — every tool-owned tag was TRUE (flag existed, variation existed)
  yet the wiring was wrong, and the LLM reviewer approved it. Tool-owned tags prove a
  side effect happened; nothing connected the claim to the diff.
- **New layer (`handoffVerifier.ts`, wired into the walker for every provider/front
  end):** after each node, mechanical checks re-derive its claims — no model:
  `flag_ready` → the flag AND claimed variation exist in LaunchDarkly (fresh read),
  the flag key is referenced in the code (manifests don't count), and the vN
  variation appears QUOTED in a file referencing the key (catches the
  boolean-helper shape exactly); `metric_event_keys` (new tool-owned tag from
  create_metric) → every event-backed metric has an emitter in the checkout;
  `tests_last_run` (new tool-owned tag from run_tests) → handing off with a red
  suite fails. A failed shim HALTS the chain (WalkResult.verificationFailed), fails
  the GitHub check with the mechanical finding, and shows in the PR comment; a shim
  implementation crash logs and never halts (evidential failures are reported, not
  thrown).
- **Docs:** docs/pipeline-overview.html now renders the shims as ⛊ badges BETWEEN
  the agent nodes (six: brief-verified, intent-fail-closed, flag-verified,
  metrics-verified, tests-executed, verdict-read-mechanically), and the Phase 1/2
  node content was refreshed for ADR 0013 (multivariate actions, variation
  releases, rollback-to-vN-1, prerequisite re-pointing). Registry/README gained
  `metric_event_keys` + `tests_last_run`. No LD config change — code + docs only.

## 2026-07-17

### ✅ Multivariate flags + iteration-aware flagging (fixes the flag_created stall; ADR 0013)
- **Postmortem (weathersynth PR #14, design-partner report):** a follow-up PR that only
  tweaked code already gated by `enable-maximized-layout` stalled the chain forever.
  The implementer correctly decided "no new flag needed", but the
  flag-implementer → metrics-author edge required the tool-owned `flag_created=true`,
  which only a `create_flag` call can set — the agent was penalized for being honest.
  Structural: EVERY iteration PR on already-flagged code failed this way.
- **Philosophy shift (design locked with Tom 2026-07-17):** flags are no longer 0→1
  booleans. `create_flag` now creates **string multivariate** flags (variations
  `control` + `v1`, created dark); iterations on RELEASED behavior append `v2`, `v3`, …
  instead of mutating served code paths — deploy stays decoupled from release across
  follow-up PRs, and a guarded rollback returns users to vN-1, not to off.
- **New decision: `flag_action` (research planner):** create | extend_variation |
  ride_existing | child_flag | none, decided from TARGETING evidence (a new
  `get_flag_state` tool: kind, variation lineage, per-env released-ness verdicts), not
  mere flag existence. Unreleased treatment → ride it; released/mid-release → extend
  (multivariate) or child flag (legacy boolean — LD fixes kind at creation, booleans
  can never take variations). Forced via NODE_REQUIRED_TAGS.
- **New tools (implementer):** `add_variation` (append vN; idempotent per intended
  value; refuses boolean flags with child-flag guidance) and `use_existing_flag`
  (VERIFIES the ridden variation is genuinely unreleased in LD — refuses released
  variations; the honest no-op path). Both, plus create_flag (incl. 409 reuse), set the
  new tool-owned **`flag_ready`** tag — the graph edge now requires `flag_ready`
  instead of `flag_created`, so a verified "nothing to create" advances the chain.
  Also new tool-owned `flag_variation`; new edge capability token `flag_state`.
- **Instruction updates (all synced files):** research-planner (Flag Landscape
  targeting research + the decision matrix + `flag_action` tag + manifest
  `targetVariation`), flag-implementer (execute-per-action, string-variation wiring
  with fail-safe default `"control"`, F17/F19 extended to the new tools),
  metrics-author (M01 no longer keys on flag_created; new M11: iterations reuse the
  flag's existing metrics, feature-specific metrics are valid for vN-vs-vN-1),
  flag-testing (T01 string-variation mocking; new T14 three-way coverage
  control/vN-1/vN on extensions), code-reviewer (R09: control default required,
  previous variation preserved, ride_existing is not a missing flag),
  manifest-steward (carry `hold`/`manual` intent forward onto iteration PRs).
- **Graph:** `edge-autofactory-flag-implementer-autofactory-metrics-author`
  `require_tags` flag_created→**flag_ready**; steward→implementer edge capabilities
  += `flag_state`. Registry (tags.json) + README tables updated;
  `npm run check:configs` green.
- **Manifest schema 1.2:** new agent-owned `targetVariation` (vN values only,
  validated). Beacon releases exactly that variation: trigger resolves
  original = what the env serves today / target = the manifest variation (boolean
  flags keep whole-flag semantics); already-serving → explicit `noop`. NEW: after a
  variation release completes (or an immediate release), Beacon **re-points
  auto-factory children** whose prerequisite pins the parent's previous variation
  (LD prereqs pin a variationId — without this, parent v1→v2 silently darkens
  children). Human-built dependencies are surfaced, never rewritten.
- **Live-validation fix (same day, runs a/b/d):** all three flag_action paths ran GREEN
  on their first live PRs (#12 create, #13 ride_existing — the exact formerly-stalling
  shape, #14 child_flag). Run (d) exposed a semantic bug: the child flag was armed
  on-behind-parent while the parent was ALREADY released, so its prerequisite was
  pre-satisfied and the new behavior would have gone live at deploy. Fix:
  `addPrerequisite` arms ONLY while the prerequisite is UNMET; a met prerequisite
  attaches as a structural constraint and the child stays DARK for its own release
  (create_flag tool description + P01 updated to match).
- **Rollout status:** code + committed configs on main; `bridge upgrade` to the live
  LD project NOT yet run (tool defs + instructions + graph edge all sync through it).
  Live validation pending: fresh create / pre-release ride / post-release extend with
  guarded v2-vs-v1 / legacy-boolean child flag.

---

## 2026-07-14 (later)

### ✅ Prerequisite wiring v2: on-behind-parent semantics + fixes from the first live runs
- **Postmortem (app PR #11 + admin PR #1, first live ADR-0012 runs):** both runs found
  the cross-repo dependency but neither wired the prerequisite. PR #11: the planner got
  GitHub-rate-limited mid-research, never confirmed the parent key, and wrote advisory
  PROSE into the manifest's `releasePlan.prerequisites[].flagKey`. Admin PR #1: the
  planner named `enable-payment-intents` correctly but the implementer guessed
  "different repo → probably a different LD project" and downgraded to advisory.
- **Semantics change (`create_flag.prerequisite` → writer `addPrerequisite`):** wiring
  now attaches the parent AND turns the child ON serving treatment behind it, per
  environment — Beacon's release-via-prerequisites pattern at creation time. Safe while
  the parent is off (LD serves the child's off variation to everyone); when the parent
  releases, the child goes live in lockstep. Idempotent per environment.
- **Planner instructions:** prerequisite recommendations must carry the EXACT parent
  key read from the gating code (read_file fallback when search rate-limits/misses);
  never guess, never prose, never speculate about LD project topology — advisory is
  reserved for "repo unreadable".
- **Implementer instructions (P01–P05 rewrite):** always pass the prerequisite when an
  exact key is named (the tool resolves the parent in the app project and fails soft —
  no topology guessing); verify uncertain keys yourself with `query_related_repos`
  (newly granted: graph edge capability + tool attached to the variation);
  `releasePlan.prerequisites` is a machine field — exact keys only, prose in notes.
- **Guardrails in code:** `write_manifest` now rejects non-key `flagKey` values in
  `releasePlan.prerequisites`; the GitHub client waits out rate limits
  (Retry-After-aware, 2 retries) instead of failing the evidence-gathering.

### ✅ Cross-repo research tool + prerequisite-flag guidance (split-repo estates, ADR 0012)
- **New tool** `query_related_repos` (attached to the research planner): queries the
  OTHER repositories an app repo registers under `relatedRepos:` in
  `.autofactory/services.yaml` — op `list` / `search` (GitHub code search, default
  branch) / `read_file` / `list_dir` — so the planner can establish upstream/downstream
  impact of a PR across a split estate with repo+path evidence. Offered only when the
  registry is non-empty and a GitHub token is present (capability `query_repos`, planner
  fallback grant; runtime is fail-soft and budgeted at 15 fetches/run). Vega runs tools
  server-side and skips it, same as `query_dependencies`.
- **Research planner instructions:** Phase 1 output gains **cross_repo_impact**
  (per affected related repo: relationship, affected surfaces, evidence) and the Flag
  Implementation Brief gains **prerequisite_flag_recommendation** (parent flag key +
  required variation + evidence when the feature must not go live before another
  flag; 'none' otherwise; advisory when the parent isn't in the same LD project).
- **Flag implementer instructions:** new **Prerequisites (cross-repo coordination)**
  section (rules P01–P05): pass `prerequisite: {flagKey, variation}` to `create_flag`
  when the brief recommends one (LD `addPrerequisite` semantic patch across all
  environments; flag stays dark so nothing changes until release); record it under
  `releasePlan.prerequisites` in the manifest; advisory/failed recommendations are
  recorded in the manifest + brief, never retried blindly.
- **`create_flag` tool:** new optional `prerequisite` input (parent `flagKey` +
  `variation`, default `on`). Prerequisite failures never fail flag creation — the
  error is surfaced back to the agent for its brief.
- **Why:** distributed teams split one product across repositories; the planner
  previously reasoned only from the single checkout (plus the knowledge graph's
  trace edges), so cross-repo consumers were invisible and flag dependencies across
  repos had no path into the chain. The manifest's agent side gains
  `releasePlan.prerequisites` so recommendations survive to Phase 2 and humans
  (distinct from the human-owned `releaseIntent.prerequisites` Beacon applies).

## 2026-07-13

### ✅ Metrics author: global autogen guardrails for net-new features + grounded o11y detection
- **New rule (Metric Backing):** classify the flagged change FIRST. NET-NEW
  feature paths (control = 404/nothing) get structurally one-armed
  feature-scoped comparisons — their guardrails should be EXISTING GLOBAL
  metrics, i.e. LaunchDarkly's autogenerated observability metrics (`otel*`
  HTTP 5XX error rate + avg/P95/P99 latency; `$ld:telemetry:*` browser
  autogens). Feature-scoped success/business events stay attached as
  `monitoring` only. Changes to EXISTING paths keep feature-specific metrics
  (events or trace-backed) as before. Fallback documented for projects whose
  first o11y data hasn't generated the autogens yet (Tom's rule, from PR #9's
  one-armed-latency observation).
- **New tool** `list_metrics` (offered with `create_metric`): compact listing
  of the app project's existing metrics with prefix/tag filters — the agent
  DISCOVERS global/autogen metrics instead of guessing keys; replaces the
  "there is NO tool to list metrics" instruction line.
- **Fix 1 (PR #9 postmortem):** decision-order condition "service uses the
  observability SDK" now carries a VERIFICATION RECIPE (grep the service for
  `@launchdarkly/observability`; never assert from memory) — the PR #9 run
  chose event backing off a false "neither service uses the o11y SDK" claim.
- **Fix 2:** metrics author granted `query_graph` (edge + fallback) — the
  knowledge graph's trace-derived edges/gaps are ground truth for which
  services emit spans; instructions point at it for span-coverage checks.
- **Live sync:** with this build (`bridge upgrade`).


### ✅ Frontend-scoped flags auto-expose to the client-side SDK (`create_flag`)
- **Runtime fix** (`ldWriter.createBooleanFlag`): when `scope` is `frontend` or
  `fullstack`, new flags include `clientSideAvailability.usingEnvironmentId`.
  On idempotent re-runs (HTTP 409), a semantic patch turns client-side
  availability on for existing flags.
- **`create_flag` tool** accepts optional `scope`; when omitted, reads
  `.release-flags/*.json` (sole manifest or matching `flagKey`).
- **Flag implementer** instructions: pass scope from the release manifest when
  calling `create_flag`.
- **Why:** flags could be targeting-on in LaunchDarkly but invisible to browser
  SDKs — UI gates silently stayed on their offline defaults.

### ✅ Trace-backed guarded-release metrics: `create_metric` gains `trace_query`
- **Corrected finding:** trace-metric creation is NOT UI-only — the regular
  metrics POST accepts `kind: "trace"` + `traceQuery` (span filter) +
  `dataSource: {key: "launchdarkly-hosted"}` (+ `traceValueLocation` for
  numeric) under the beta API version. Verified live with create+delete probes
  (Tom supplied the UI's payload shape).
- **Tool** `create_metric`: `event_key` now optional — pass `trace_query`
  instead for a trace-backed metric (latency category measures span duration;
  `trace_value_location` overrides). Event path unchanged (no beta header).
- **Instructions** (metrics author): Metric Backing decision order #2 upgraded
  from "record trace_metric_candidates, creation is UI-only" to actually
  creating trace-backed metrics when the flag-evaluated-in-span pattern holds;
  events remain the default and the only backing without the o11y SDK.
- **Why:** closes the loop from the 2026-07-10 trace-metrics design — services
  instrumented once (app PR #5) now get guardrails with ZERO per-PR
  instrumentation when the pattern allows.
- **Live sync:** with this build (`bridge upgrade`).

### ✅ Tool definitions move into LaunchDarkly (ADR 0011)
- **New committed dir** `config/agentcontrol/tools/` — 14 tool-library
  definitions (key/description/schema), generated from the code registry via
  `npm run export:tools`. Bridge `provision` creates them + attaches per the
  new `tools` name array on every agent variation; `upgrade` syncs drifted
  descriptions/schemas and re-points attachments at current tool versions
  (a definition PATCH bumps the version).
- **Runtime**: the offering is now capability set ∩ implementations,
  restricted + re-described by the variation's LD attachments. LD can narrow
  or rephrase, never broaden; unimplemented attachments are logged + ignored;
  `tag_conversation` always survives (routing); no attachments = built-in
  defaults (pre-tools projects unchanged).
- **Telemetry**: both local runners now record per-run tool usage via
  `trackToolCalls` — the tool dimension in AI Config monitoring.
- **Guards**: `check:configs` validates tool files ↔ variation references
  (+ tag_conversation presence); the `[cfg:…]` drift stamp now hashes the
  tools dir.
- **Why:** tool descriptions steer agents as much as instructions do; they are
  now live LD config (editable, versioned, A/B-able per variation) instead of
  hardcoded strings. Load lives in LD; the write ceiling stays in code.

### ✅ LLM-friendly LaunchDarkly docs for the agents (`read_ld_docs`)
- **New capability token** `read_docs` → **new tool** `read_ld_docs`: fetches
  LaunchDarkly documentation pages as clean markdown (the docs site serves
  `.md` for any page; validated that expand/accordion content is fully inlined
  — e.g. all 27 per-SDK "Expand … code sample" sections on
  `sdk/features/all-flags` survive). Allowlisted to launchdarkly.com/docs
  only, 25KB size cap, 8 fetches per node run, 10s timeout, fail-soft (a
  failed fetch tells the agent to proceed from repo evidence).
- **Granted to** flag-implementer, metrics-author (graph edges +
  fallback map) and code-reviewer (new edge capability + fallback entry).
  Research planner / steward / testing stay without — keep the chain lean.
- **Instructions** gained per-agent shortlists + `llms.txt` as the fallback
  directory: metrics-author (sdk/features/events, guarded-rollouts,
  custom-metrics, choose, create-trace-metrics), implementer
  (sdk/features/evaluating, all-flags), reviewer (evaluating, events,
  guarded-rollouts). Framing everywhere: consult when UNCERTAIN, never guess
  SDK syntax for an undemonstrated language, docs are an aid not a gate.
- **Why:** agents previously reasoned about LD semantics from baked-in
  instructions + repo patterns only; live docs close the gap for unfamiliar
  languages and rollout mechanics without fossilizing content in prompts.
- **Live sync:** requires `bridge upgrade` (instructions + graph edges).

## 2026-07-10

### ✅ Knowledge graph: `auto-factory-knowledge-graph` flag + `query_graph` capability (ADR 0010)
- **New operational flag** `auto-factory-knowledge-graph` (boolean, provisioned
  **off**): gates per-run composition of the knowledge graph (service edges
  derived from observability traces + flag wrap points from find-code-refs at
  the PR SHA) and the `query_dependencies` agent tool. Off = the judge-score
  A/B baseline; flag-off runs pay no composition cost.
- **New capability token** `query_graph` (`ToolCapabilities.queryGraph`),
  granted to the research planner via the ROOT fallback (root nodes can't
  receive edge grants). The tool is only offered when a graph was actually
  composed for the run — the flag is the global enable, the capability is the
  per-node grant, same two-level model as `create_flag`.
- **New tool** `query_dependencies`: no-arg call = the PR's blast radius
  (changed services, dependent services with depth+evidence, upstream contract
  services, flags already wrapping changed code); or walk
  dependents/dependencies of one service/flag/file node. Responses carry the
  artifact's `gaps` list and the mode note instructs agents to treat gaps as
  UNKNOWN coverage, never low risk.
- **Why:** ADR 0010 — impact analysis composed from LD-native sources instead
  of a third-party code-graph dependency.
- **Live sync:** with the ADR 0010 build (`bridge upgrade`), not yet pushed.

### ✅ Metrics author: trace-metric backing rules + telemetry-footprint duty (ADR 0010)
- **Instructions** (`autofactory-metrics-author`, default variation): new **Metric
  Backing** section — a guardrail metric must be per-unit attributable to a flag
  variation; exactly two valid backings: custom `track()` events (default) and
  **trace metrics** on span attributes. Trace metrics are valid ONLY when the flag
  is evaluated INSIDE the active span context: the observability SDK plugin's flag
  `afterEvaluation` hook enriches the active span (client-side: child span), so a
  trace metric can only be built on span attributes within a trace that evaluates
  this flag. **Pre-aggregated OTel metrics are never a valid guardrail backing.**
  `create_metric` remains event-only for now, so the agent records
  `trace_metric_candidates` (span attribute + filter) in its output instead of
  creating them; revisit when the trace-metric API is available (EAP).
- **New rule M10 (telemetry footprint):** when the service already uses the LD
  observability SDK, span-cover the flagged path with the flag evaluated in-span
  and add `<flag-key>.<attribute>` span attributes — growing the service telemetry
  AutoFactory's impact analysis reads. Never install the SDK into an
  uninstrumented service (platform decision; report `span_coverage: none`).
- **Chain output** gains `telemetry: { span_coverage, spans_added,
  trace_metric_candidates }`.
- **Why:** the knowledge-graph direction (ADR 0010) derives service-dependency
  edges from LD observability traces; each PR the factory processes should widen
  that footprint. Demo estate design: services get a one-time baseline
  instrumentation sweep, but future demo PRs intentionally ship uninstrumented so
  the metrics author demonstrably fills the gap.
- **Live sync:** not yet pushed to the live factory project — sync via
  `bridge upgrade` together with the ADR 0010 code build.

### ✅ Release intent + manifest steward node (ADR 0009)
- **New AI config** `autofactory-manifest-steward` (mode agent, Sonnet 4.6):
  normalizes human edits to the release manifest's `releaseIntent` block —
  promotes free-text notes ("child of flag-xyz") into structured fields via ONE
  `write_manifest` call, passes the brief through unchanged, fast no-op on an
  untouched skeleton, NEVER broadens intent (never hold→auto).
- **Graph `gha-auto-factory` rewired**: research → **steward** → implementer
  (was research → implementer). Edges: research→steward `{max_turns: 8,
  request_type: "Fix", capabilities: ["steward_manifest"], skip_if_tags:
  {skip_flagging: "true"}}`; steward→implementer carries the implementer's
  previous grant plus `write_manifest`; implementer→metrics adds `write_manifest`.
- **Instruction updates**: research planner gains "Release Manifest (create it
  now)" (creates the manifest + intent skeleton via `write_manifest`); flag
  implementer gains a manifest-correction section; metrics author's
  `releaseOverrides` renamed to **`releasePlan`** (legacy key still read/healed).
- **Registry/tags**: `skip_flagging` edge now research→steward (kind
  `skip_if_tags`).
- **Rollout note**: existing installs pick all of this up via the new
  **`bridge upgrade`** command (provision what's missing + sync existing
  variation instructions and graph edges to the committed defs; built-in
  no-op `modelConfigKey` re-PATCH after every instruction update, so the
  2026-07-08 cost-derivation workaround is automatic).
- **Config-version stamp**: provision/upgrade now append a `[cfg:<hash>]`
  marker to the `gha-auto-factory` graph **description** (hash of the
  committed ai-configs/graphs/flags). The GHA action compares it against its
  own checkout at chain start and warns on drift (Actions log + PR summary
  comment). UI instruction edits don't affect the stamp — it tracks which
  repo version last provisioned the project, not live content.

## 2026-07-08

### ✅ Approval policy: three flags compiled into pre-execution gates (ADR 0008)
- **New flags** (factory project + committed defs, provisioned by bootstrap):
  `auto-factory-approval-mode` (`yolo` default / `risk-threshold` / `always`) and
  `auto-factory-risk-threshold` (0–1, default 0.6). `auto-factory-approval-gates`
  reworked: **no empty variations** (implementer at minimum — yolo is the bypass);
  entries may be `{step, threshold}` objects for per-step sensitivity.
- **Research planner (default variation)** now emits a numeric **`risk_score`**
  (0.0–1.0, anchored: ~0.2 additive / ~0.5 business logic / ~0.8 cross-cutting,
  auth, payments, migrations) alongside `risk_level`; forced via
  NODE_REQUIRED_TAGS so risk-threshold gates fail closed when absent. Registry +
  README table gained `risk_score`; `risk_level` re-described as the categorical
  companion/fallback.
- **Post-hoc modes removed** from the runtime: `decideApproval` is verdict-only;
  the yolo/middle/manual env semantics are legacy-mapped (`middle`→risk-threshold,
  `manual`→always). Workflow templates no longer hardcode `approval_mode`.
- ⚠ The planner instruction edit is a variation PATCH — the no-op
  `modelConfigKey` re-PATCH (cost-derivation workaround, 2026-07-08) was applied
  in the same change.

## 2026-07-07

### ✅ Judges are now part of bootstrap (committed + provisioned)
- **Committed:** `ai-configs/autofactory-judge-implementation-quality.json` and
  `-metrics-quality.json` (mode `judge`, `evaluationMetricKey`, rubric v2 exported
  from live), plus `judgeConfiguration` attachments on the committed
  flag-implementer / metrics-author `default` variations (samplingRate 1).
- **Provisioner:** passes `evaluationMetricKey` at config creation (required for
  judge mode), provisions judge-mode configs before agents (attachments reference
  them), and re-attaches `judgeConfiguration` via a follow-up variation PATCH —
  the create endpoint's inline `defaultVariation` silently drops it.
- **Verified e2e** against a scratch project: judges created + served, attachments
  present, re-provision idempotent (nothing touched).

### ✅ Judges verify evidence, not just the agent's self-report
- **Runtime:** the judge hook now appends a **VERIFIED EVIDENCE** section to the
  judge input — a node-scoped `git diff` of exactly the commits the judged agent
  landed (`shared/judgeEvidence.ts`; HEAD snapshot advanced per judged node;
  "no new commits" is itself evidence). Judges verify the report against the
  actual diff instead of taking the narrative at its word.
- **Judge instructions (both → variation v2):** added a "What you receive, and
  how to verify" section — claims contradicted by evidence score ≤0.2;
  material claims unverifiable from evidence cap the score at 0.6.
- **⚠ Comparability reset:** this is the one-time instruction edit anticipated in
  ADR 0007 — scores from before 2026-07-07 (~2 data points) are not comparable
  with scores after. Do not edit judge instructions again without logging here.
- Note: judge instructions deliberately contain NO `{{message_history}}`-style
  template variables — that's the legacy judge format (the SDK strips such
  messages). History + evidence arrive in the judge's user message at run time.

## 2026-07-06

### ✅ Judges attached to the coding agents (quality layer for the model A/B)
- **New judge AI configs** (mode `judge`, factory project, model Sonnet 4.6):
  `autofactory-judge-implementation-quality` and `autofactory-judge-metrics-quality`.
  Each scores its agent's output 0..1 with reasoning (criteria: honesty/consistency
  first, then safety, correctness, release wiring, completeness), recording against
  the auto-generated `$ld:ai:judge:<key>` metric.
- **Attached** (samplingRate 1 = every run) to BOTH the `Sonnet 4.6` and
  `Composer 2.5` variations of `autofactory-flag-implementer` (v8/v3) and
  `autofactory-metrics-author` (v8/v2) — scores land per-variation, giving the
  Composer-vs-Sonnet A/B its missing quality dimension (Monitoring tab → the
  judge metric; Metrics → Judge metrics).
- **Execution** is in the runtime (ADR 0007): the SDK's `Judge` class over our
  provider seam (Anthropic forced-tool-use / Cursor hermetic one-shot; Vega skips).
  The code reviewer remains the gate — judges are sampled, non-blocking evaluators.
- **⚠ Comparability:** judge instructions are part of the measurement instrument.
  Any edit to them resets cross-time comparability — log edits here.

## 2026-06-26

### ✅ Prevent false `flag_created=true` (tool-owned tags + F19)
- **Why:** a LaunchDarkly API 401 on `create_flag` produced GREEN runs because the
  agent set `flag_created=true` via `tag_conversation` despite the tool failing —
  a passing pipeline with no flag (verified: 5/5 demo flags were 404 while 2 runs
  reported success). The honest failures correctly stalled at the metrics edge.
- **Code fix (shared, both providers):** `flag_created` / `flag_key` /
  `metrics_created` / `metric_keys` are now **tool-owned** — set only by
  `create_flag` / `create_metric` on a real success and stripped from any
  agent-supplied `tag_conversation` call. The agent literally cannot fake them.
- **Config fix:** added **F19** to the flag-implementer instructions on BOTH the
  `Sonnet 4.6` (v7) and `Composer 2.5` (v2) variations — only HTTP 409 (exists) is
  success-via-reuse; any other `create_flag` error is a hard failure (tag
  `flag_created=false`, don't wire/manifest/claim success, stop). Reinforces the
  code fix so the agent's downstream behavior stays honest too.

## 2026-06-25

### ✅ Multi-context (`service` + `run`) for per-agent model A/B
- **Change (code):** the pipeline targeting context is now a multi-context — a
  static `service` kind (flag eval, AI-config/graph targeting, operational flags)
  plus a `run` kind with a fresh UUID per run.
- **How to use (LD-side, per agent):** to A/B an agent's model (e.g. Composer vs
  Sonnet on a coding agent), add the model variations and set that AI config's
  **percentage rollout / experiment randomization unit to the `run` context kind**.
  Each config has its own salt, so the agents bucket INDEPENDENTLY off the one run
  key — per-node A/Bs are decorrelated, no per-node key needed. A fresh UUID per
  run means re-runs are independent samples.
- **Keep on `service`:** `auto-factory-ai-provider` and `auto-factory-approval-gates`
  targeting must stay on `service` (or fallthrough) so they don't re-randomize.
- The `run` UUID is also stamped on the LLM-observability spans (`launchdarkly.run.id`)
  to group a run's agent spans.

### ✅ LLM Observability for the Cursor provider
- **Change:** Registered the LaunchDarkly Observability plugin on the server SDK and
  emit a `gen_ai.*` OpenTelemetry span per Cursor agent run (model, token usage,
  prompt/output, status), correlated to the AgentControl config via the tracker's
  `getTrackData()`. Spans land in the factory project's (`auto-factory-prototype`)
  LLM Observability, alongside the AI Config metrics.
- **Why:** the Cursor calls run in Cursor's hosted service (no local LLM SDK to
  auto-instrument), so manual spans are how those runs become visible in LD. Verified
  live: traces appear in LaunchDarkly for demo PR #26.

### ✅ Chain model bumped to claude-sonnet-4-6
- **Change:** Set `modelConfigKey` = `Anthropic.claude-sonnet-4-6` on the served
  (`default`) variation of all five agent configs (research-planner, flag-implementer,
  metrics-author, flag-testing, code-reviewer) — previously `Anthropic.claude-sonnet-4-5`.
- **Note (where the model lives):** the model is configured via the variation's
  **`modelConfigKey`**, not the inline `model` object (which reads as `{}` in the
  management API). The AI SDK resolves `cfg.model.name` from that key at runtime —
  so the model IS derived from LD. The Anthropic runner uses it directly; the new
  Cursor runner maps it to Cursor's catalog (`cursorModel.ts`); Vega ignores it.
- **Why:** keep the chain on the current Sonnet; makes "model derived from LD" true
  for every provider (was effectively a code default before this was understood).
- Affects Anthropic runs on `main` too (it's the shared factory project), not just
  the Cursor branch — expected for a model-version bump.

### ✅ `cursor` variation added to `auto-factory-ai-provider`
- **Change:** Added a third variation, **`cursor`** (value `cursor`, name "Cursor"),
  to the `auto-factory-ai-provider` multivariate flag — alongside `anthropic`
  (default, idx 0) and `vega` (idx 1). Flag now at version 2; default unchanged.
- **What it selects:** the new `CursorAgentRunner` (`packages/shared/src/cursor/`),
  which runs each graph node as one Cursor agent via `@cursor/sdk`. It reuses the
  same sandbox tools (registered as Cursor `customTools`) and the same agent graph
  + AI configs — only the model brain changes. The agent **model + parameters are
  mapped from the AI config** (`cursorModel.ts`), and per-node metrics (duration,
  tokens, success/error) are recorded through the AI-config tracker, so Cursor runs
  show up in the same AI Config monitoring as the other providers.
- **Caveat (host, not choice):** Cursor inference runs on Cursor's hosted models,
  not LaunchDarkly's Bedrock instance, even when the mapping pins a Claude model.
- **Why here:** lets the deterministic GHA path use Cursor agents as the executor
  (distinct from the non-deterministic Cursor automation front ends). See ADR 0006.

## 2026-06-23

### ✅ Per-step approval gates (`auto-factory-approval-gates` flag)
- **New operational flag** in the factory project: `auto-factory-approval-gates`,
  a **JSON flag** whose value is an array of agent node keys (e.g.
  `["autofactory-flag-implementer"]`). The chain pauses BEFORE each listed
  agent until a human approves. Default `[]` = no gates (current behavior).
  Read natively via the SDK (same pattern as `auto-factory-ai-provider`).
- **Independent of `APPROVAL_MODE`.** `APPROVAL_MODE` still governs whether the
  FINISHED chain auto-applies; gates pause MID-chain (before a step's side
  effects). The original ask — approve after research, before flag creation —
  is `["autofactory-flag-implementer"]`.
- **How approval is given:**
  - **GitHub Action:** the run halts and comments which PR label to add
    (`af-approve:<nodeKey>`); adding it re-triggers the workflow (template now
    includes the `labeled` event) and the re-run proceeds. Approval persists
    across pushes. A pending gate is a red check (action required).
  - **Cursor extension:** an interactive Approve/Stop modal blocks the in-process
    run at each gate.
- Code: `packages/shared/src/approvalGates.ts` + a `GateController` hook in the
  walker; `packages/phase1-resource-factory/src/labels.ts` for the GHA labels.

### ✅ Operational flags now bootstrap-provisioned (off by default)
- **Change:** the two operational flags (`auto-factory-ai-provider`,
  `auto-factory-approval-gates`) now have committed definitions under
  `config/agentcontrol/flags/`, and `config-bridge provision`/`seed` (hence
  `npm run bootstrap`) create them in the factory project alongside the AI
  configs + graph. Previously only AI configs + graphs were provisioned, so a
  fresh consumer project had no operational flags until created by hand.
- **Safe by default:** each is provisioned **off** — provider serves `anthropic`,
  gates serve `[]` (no gates) — so behavior is unchanged until a maintainer flips
  it. Provisioning is idempotent and 404-tolerant: an existing flag (and its
  targeting) is never overwritten.
- Code: `packages/config-bridge/src/provision.ts` (`provisionFlag`, `flagsDir`),
  `config/agentcontrol/flags/*.json`.

## 2026-06-22

### ✅ Tag registry as source of truth (issue #9 item #5)
- **Change:** added `config/agentcontrol/tags.json` — the machine-readable
  registry of every routing/verdict tag (producer, `llm` vs `tool` production,
  the graph edges that consume it, and whether approval/manifest reads it).
- **Guard upgrade:** `check-configs` now validates against the registry exactly
  instead of a token heuristic — bidirectional graph⟷registry edge checks,
  producer verification (an `llm` tag must appear in its agent's instructions; a
  `tool` tag must be in the write-tool auto-set), and a README-table⟷registry
  equality check.
- **Resolved a real drift it surfaced:** `flag_worthy` was emitted by the
  research planner and forced by the runner, but consumed by no edge and absent
  from the README table. Documented it as **advisory** (recorded but not routed
  on) in both the registry and the README "Canonical agent tags" table. Also
  fixed a stale `approval.ts` path in the README (moved to `packages/shared`).

### ✅ Fixed invalid `tag_conversation` signature in committed configs + added a routing-contract guard
- **Problem (issue #9, failure mode #1):** `autofactory-metrics-author` and
  `autofactory-research-planner` instructed the model to call
  `tag_conversation(key="…", value="…")`, but the tool only accepts a single
  `tags` object (`{"tags": {"k": "v"}}`). With the wrong signature the model
  emits no tags, so the chain stalls and reports a misleading verdict.
- **Fix:** rewrote the 5 affected calls to the valid form
  `tag_conversation({"tags": {"…": "…"}})` (metrics-author: metrics_created /
  metric_keys / needs_tests; research-planner: flag_worthy / skip_flagging).
  These are the committed seed copies; re-sync the live LD configs to match if
  they still carry the old form.
- **Guard:** new `npm run check:configs` (`scripts/check-configs.mjs`, wired
  into CI + a test) lints for the invalid signature and checks that every graph
  edge's `require_tags`/`skip_if_tags` is producible by some agent or write
  tool — so this class of routing-contract drift fails fast. Addresses issue #9
  item #2; the runtime forced-tag-call (item #1) is the next step.

## 2026-06-11

### ✅ Committed the canonical public copies of all five agent configs
- **Change:** exported each `autofactory-*` config's `default` (Anthropic) variation
  from the live project into `config/agentcontrol/ai-configs/*.json` (provision
  format). Versions at export: planner v2, implementer v4, metrics-author v5,
  testing v5, reviewer v3. Vega variations stay live-only (internal runtime details).
- **Why:** external consumers provision from these files (`npm run bootstrap`);
  the directory was intentionally empty before (old I3). Convention going forward:
  edit in LD → re-export here → log in this changelog.

### ✅ Code reviewer: metric-key vs event-key convention (false-positive REJECT fix)
- **Problem:** on demo PR #10 the reviewer REJECTED (risk high) because the code's
  `track()` events (`enable-haiku-endpoint-error`) didn't string-match the metric
  KEYS (`enable-haiku-endpoint-error-rate`) — but that difference is the designed
  convention; the metric's `event_key` field is the link, and the Metrics Author's
  brief showed the correct pairing.
- **Change (`autofactory-code-reviewer` `default` v3):** added a "Metric keys vs.
  event keys (do NOT flag this as a mismatch)" section — validate `track()` events
  against each metric's `event_key`, never against metric keys; flag only events
  matching NO metric. Also added the Metrics Author to R09 (fail-safe telemetry,
  event/metric linkage) and to the `agent` attribution enum.

## 2026-06-10

### ✅ Metrics-author tag convention: `flag:<flag-key>` → `flag-<flag-key>`
- **Change:** Updated BOTH `autofactory-metrics-author` variations (`default` and the
  preserved "Vega Chain" copy): the flag-reference tag convention is now
  `flag-<flag-key>` with an explicit "LaunchDarkly tags cannot contain `:`" note.
- **Why:** observed on demo PR #9 — the instructions said `flag:enable-...` but the
  metric landed with `flag-enable-color-endpoint` because LD tag validation rejects
  colons. The convention now matches what actually gets stored, so the future metric
  cleanup job can rely on a mechanical prefix scan. Repo-side, the `ldWriter` test's
  example tag was aligned to the valid form.

### ✅ Synced the live `gha-auto-factory` graph with the committed copy (capabilities now live)
- **Change:** Full-object REST PATCH of the live graph: added the `capabilities`
  grants to three edges (→flag-implementer `["create_flag","edit_files"]`,
  →metrics-author `["create_metric","edit_files"]`, →flag-testing `["edit_files"]`)
  and removed the inert `prompt_template` from every edge (completes CLEANUP #28 on
  the live side). Kept the live `max_turns` values.
- **Why this matters:** the action resolves the graph **live** via the AI SDK's
  `agentGraph()` — the committed `graphs/auto-factory.json` is a record, not the
  runtime source. Until this PATCH, the edge grants only existed in the committed
  copy and the runner was riding on its hardcoded `NODE_CAPABILITIES` fallback.
- **Reconciliation:** the committed copy's testing→code-reviewer `max_turns` was 15
  while live ran 30; updated the committed file to 30 so the record matches reality.

### ✅ Rewrote the live `autofactory-research-planner` instructions for the Anthropic tool surface
- **Change:** Replaced the `default` variation's instructions (now v2). The Vega-era
  original is preserved as the `default-configuration-copy` variation (see the
  variation-pattern entry below).
- **What changed:** tool references fixed (`git_diff`/`read_file`/`list_dir`/`grep`
  instead of `Read`/`Glob`/`Bash` + `gh pr diff`); dropped the four interpolation
  variables the action never supplies (`FILES_CHANGED_COUNT`, `LINES_CHANGED`,
  `CHANGED_FILES_SUMMARY`, `CI_CONTEXT`) — `git_diff` is the changed-files source now;
  replaced the internal-monorepo "Repo Structure Reference" (and `flagfn.NewBool` /
  `createFlagFunction` patterns) with repo-agnostic detect-from-the-code guidance;
  added an explicit Chain Routing Tags section (`flag_worthy`, and `skip_flagging`
  documented as a chain short-circuit — the old text wrongly said the planner's output
  was "NOT a routing decision").
- **Kept:** the two-phase research → brief structure, classification taxonomy, and the
  flag/test/review brief fields downstream agents parse.

### ✅ Pattern: per-provider variations on each AI config
- **Decision:** each `autofactory-*` config keeps its **`default` variation as the
  Anthropic-surface instructions** (the current primary path) and a separate
  **Vega-surface variation** (e.g. "Vega Chain" / "Default Configuration - Copy")
  preserving the Bash/MCP-tooling instructions. Later, targeting can serve the right
  variation off the `auto-factory-ai-provider` flag so instructions switch with the
  execution backend. No targeting changes yet — Anthropic stays the served default.

### ✅ Rewrote the live `autofactory-metrics-author` instructions for the Anthropic tool surface
- **Change:** Replaced the `default` variation's instructions (now v2, renamed
  "Vega Chain" → "Default Configuration"). This is the "separate config update
  entry" promised by the 2026-06-09 `create_metric` code entry below.
- **What changed in the instructions:**
  - Dropped the Vega Environment section (clone-the-repo, `/workspace`, git identity)
    — the Anthropic runner operates in the pre-checked-out PR branch.
  - Tool surface is now the real sandbox set: `read_file`/`list_dir`/`grep`/`git_diff`/
    `tag_conversation` + granted `create_metric`/`edit_file`/`write_file`/`run_tests`/
    `commit_and_push`. No Bash/curl REST payloads (the `create_metric` tool owns the
    category → LD metric-shape mapping), no LD/observability MCP tools.
  - Reuse-first (M02/M07) reworded for what the agent can actually see: code-level
    reuse (existing `track()` events on the flagged path) + `create_metric`
    idempotency, instead of `launchdarkly_list_metrics` / trace queries.
  - Kept: guarded-release framing, M-rules, the three categories, killswitch/pause/
    monitoring classification, naming convention, manifest loop-closure
    (`releaseOverrides.metricKeys` + `randomizationUnit`), chain output + routing tags.
  - New: latency events must pass elapsed ms as the `track()` metric value; M01 skip
    now explicitly tags `metrics_created=false` + `needs_tests=true`; notes that
    `create_metric` auto-sets `metrics_created`/`metric_keys`.
- **Why:** the old instructions were written for the Vega runtime; on the Anthropic
  provider the agent degraded to a markdown spec (demo PR #8). Pairs with the
  `create_metric` capability + graph-edge grant in the entry below.

## 2026-06-09

### ✅ Metrics Author can now actually create metrics on the Anthropic path
- **Problem:** the metrics-author's instructions were written for the Vega runtime
  (Bash + curl to the metrics REST API + observability/LD MCP tools). On the default
  **Anthropic** provider it had none of those — no metric-creation tool and no
  `edit_files` grant — so it degraded to writing a markdown spec and tagged
  `metrics_created=false`. (Confirmed on demo PR #8.)
- **Code (tooling repo):** added a `create_metric` agent tool + `LdResourceWriter.createMetric`
  (maps category error/latency/business → LD metric fields; idempotent on 409) and a
  new `create_metric` capability.
- **Graph:** the edge into `autofactory-metrics-author` now grants
  `capabilities: ["create_metric", "edit_files"]` (so it can instrument a `track()`
  event AND create the metric off it). Fallback `NODE_CAPABILITIES` also updated.
- **Instructions:** the live `autofactory-metrics-author` config must be rewritten to
  the Anthropic tool surface (`create_metric` / `edit_file` / `read_file`) instead of
  Bash/curl/MCP — see the separate config update entry.

### ✅ (cleanup) Dropped inert `prompt_template` from the committed graph copy
- **Change:** Removed `"prompt_template": "{{PR_NUMBER}}"` from every edge of the
  committed `graphs/auto-factory.json`. The graph walker owns prompt construction
  for **every** provider (it never forwards `prompt_template` to Vega), so the field
  was inert. Documented the handoff fields the walker DOES honor (`require_tags`,
  `skip_if_tags`, `max_turns`, `request_type`) in this directory's README.
- **Note:** this only touched the committed local copy. The live LD graph may still
  carry the field; it's harmless (inert) but can be removed there too. See CLEANUP #28.

### ✅ (cleanup) Edge-declared agent `capabilities` (config-driven write access)
- **Change:** Added a `capabilities` array to two edges of the committed
  `graphs/auto-factory.json`: the edge into `autofactory-flag-implementer` grants
  `["create_flag", "edit_files"]`, the edge into `autofactory-flag-testing` grants
  `["edit_files"]`. The Anthropic runner reads these instead of a hardcoded
  config-key map (which it keeps only as a fallback). Always intersected with the
  global `ENABLE_FLAG_CREATION` / `ENABLE_CODE_CHANGES` toggles.
- **Why:** "which agent can write" should be config, not code — a renamed/added
  agent no longer silently lands read-only. See CLEANUP #24. To take effect on the
  Vega-seeded path, add the same `capabilities` to the live LD graph's edges.

### ✅ 0. Provider-selection flag (`auto-factory-ai-provider`) — foundational
- **Change:** Created a multivariate string flag in the factory project: variations
  `anthropic` / `vega` (extensible to other providers), **default `anthropic`**.
- **What it does:** the Phase 1 runtime evaluates it (server SDK) to pick the agent
  execution backend — run the chain locally on the Anthropic API, or dispatch to Vega.
  Flip it in LaunchDarkly to switch; no code/workflow change needed.
- **Why:** decouples "which AI runs the agents" from the pipeline so we can move off
  Vega without losing it, and swap providers later.

### ✅ 1. Added the Metrics Author agent + rewired the graph
- **Change:** Added `autofactory-metrics-author` as a core node in the chain and
  rewired `gha-auto-factory` to:
  `research-planner → flag-implementer → metrics-author → flag-testing → code-reviewer`.
- **Handoff conditions:** flag-implementer → metrics-author requires `flag_created=true`;
  metrics-author → flag-testing requires `needs_tests=true`.
- **Why:** The release pipeline needs metrics authored for guarded releases; the
  metrics step belongs between flag creation and testing.

### ✅ 2. Increased the Code Reviewer turn budget
- **Change:** Raised `max_turns` on the `flag-testing → code-reviewer` edge handoff
  to **30** (verified live).
- **Note:** An earlier attempt to set this to 25 did **not** persist — the live
  graph was still 15 when checked on 2026-06-09, which is why the reviewer kept
  running out of turns. Now confirmed at 30 via full-object REST PATCH.
- **Why:** The reviewer was hitting its turn cap before reaching a verdict. (Turns
  are a cushion; the real cause was the reviewer being unable to see the diff —
  see #4.)

### ✅ 3. Test agent (`autofactory-flag-testing`) — de-scoped + execute (v2)
- **Changes applied** (variation `default` → version 2):
  1. **Explicit execution:** "generate tests" → "use `write_file`/`edit_file` to
     create the test file(s), then `commit_and_push` once. Do NOT merely
     describe/design the tests."
  2. **De-scoped to flagged behavior only:** removed ROLE 1 (general coverage for
     all modified production code — rules T03/T04/T21–T25 and skip-conditions
     T14/T15). The agent now writes ONLY flag-on/flag-off tests for the code paths
     the flag-implementer wrapped (rules T01/T02/T08/T12/T13).
  3. **(Extra) Repo-adaptive test conventions:** replaced the hardcoded internal-monorepo
     Go/TypeScript patterns (`testify`, `@internal/testing`, Vitest, the
     `T26/T27` framework constraints, `/app/run_validation.sh`) with "detect and
     follow the repo's existing framework; else the language's standard (e.g.
     pytest for Python)." Needed because the demo app is Python/Flask — the
     internal-monorepo-only patterns would have produced Go/TS tests for Python code.
- **Why:** The agent has write + push tools now (PR
  launchdarkly-labs/launchdarkly-auto-factory#1, merged), but on demo PR #3 it
  described tests instead of creating them, and its scope/patterns were wrong for
  the target repo.
- **Follow-up (version 4):** switched its diff reference to the new `git_diff` tool
  (it has no shell) and reworded "Validation" to acknowledge it cannot execute
  tests (no bash) — verify test files are syntactically valid instead.

### ✅ 4. Code Reviewer (`autofactory-code-reviewer`) — let it SEE the diff (v2)
- **Root cause (not turns):** the reviewer was told to run `gh pr diff` / use
  `Bash`, but in our runtime it has **no shell, bash, or gh** — only read-only file
  tools. So it couldn't see the change set and burned all its turns reading files
  one-by-one to infer the diff, never reaching a verdict.
- **Changes applied** (variation `default` → version 2):
  1. Added a read-only **`git_diff`** tool to the agent runtime (shared sandbox
     tools; available to all nodes). Wired `pr_base` through the action/workflow so
     it diffs `base...HEAD`.
  2. Reviewer instructions: call **`git_diff` FIRST** to see the full change set
     (incl. agent enrichment commits), then read specific files. Aligned tool names
     (`Read`/`Glob`/`Bash`/`gh pr diff` → `read_file`/`list_dir`/`grep`/`git_diff`)
     and stated it has no shell access.
  3. Verdict stays **last** (step 5): analyze, then emit `review_approved` /
     `risk_level`. (We explicitly did NOT adopt "verdict first" — a verdict should
     follow the analysis, not precede it.)
- **Why:** Treat the cause (can't see the diff), not the symptom (turn cap). Turns
  raised to 30 (see #2) as a secondary cushion.
- **Validated:** demo PR #4 (`/api/quote`) — reviewer ran to completion, called
  `git_diff`, and returned an accurate verdict (REJECT, 2 BLOCKING) catching a real
  test/impl mismatch. See #5.

### ✅ 5. Flag Implementer (`autofactory-flag-implementer`) — tool-accurate cleanup (v2), fail-safe reverted (v3)
- **Tool/pattern cleanup (v2, still in effect):**
  - Removed the internal-monorepo-specific SDK-helper patterns (`createFlagFunction` /
    `@internal/dogfood-flags`, `flagfn.NewBool` / `OnErrorLogAsError`), the
    `make go-generate` "Code Generation" section, and the `/app/run_validation.sh`
    "Validation" step — none apply in this runtime. Replaced with "match the repo's
    existing flag pattern."
  - Swapped `ldcli flags create` → the in-runtime `create_flag` tool, and push →
    `commit_and_push`. NOTE: `ldcli` is LaunchDarkly's official CLI (not an internal tool) —
    this was a swap to our current tool, not a "fix." See backlog below.
- **Fail-safe Task #3 — ADDED in v2, then REVERTED in v3 (decision "(a)"):** v2 had
  added "flag evaluation must FAIL SAFE … harden the shared helper" to keep the code
  consistent with the testing agent's resilience tests. We reverted it because:
  (1) LaunchDarkly's server SDK `variation()` is **already fail-safe by design**
  (returns the default on error, doesn't throw), so the PR #4 resilience test was
  over-specified; (2) the implementer wasn't honoring the instruction anyway (PR #5/#7
  left `_flag()` unhardened). We rely on the SDK's built-in fail-safe rather than imply
  defensive behavior we don't enforce. The testing agent only writes flag-on/flag-off
  tests now, so there's no test/impl conflict to reconcile. Current Task #3 is just
  "preserve existing behavior on the control path."

### ✅ 6. `run_tests` tool — testing agent runs what it writes (testing v5)
- **Change:** Added a `run_tests` agent tool (auto-detects pytest / `npm test` / `go test`,
  installs deps, returns pass/fail output), available to the edit-capable nodes. Testing
  agent → **version 5**: write tests → `run_tests` → fix failures (imports, fixtures,
  assertions) → only `commit_and_push` once green. Added guidance to ensure imports
  resolve for how the runner is invoked (module path / `conftest.py`).
- **Why:** The testing agent wrote tests it couldn't execute (no shell), so import/path
  errors slipped through on every run and the reviewer (correctly) blocked them — PR #4
  (test/impl fail-safe mismatch) and PR #5 (`from app import …` module-path error). Same
  shape as the `git_diff` fix: give the agent the ability to verify its own output. This
  is real code execution in the CI sandbox — the capability expansion we'd deliberately
  deferred until now.

### 🔜 Backlog — consider `ldcli` for flag creation
- Today the implementer creates flags via the REST-backed `create_flag` tool. Using
  LaunchDarkly's official CLI (`ldcli`) may be more efficient/idiomatic long-term.
  Revisit once the core chain is stable. (https://launchdarkly.com/docs/home/getting-started/ldcli)
