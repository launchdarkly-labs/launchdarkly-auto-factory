# ADR 0018: Surface-aware provider routing + the OpenAI runner

Date: 2026-08-26
Status: accepted

## Context

The same Phase 1 chain runs from several front ends ("surfaces"): the GitHub
Action, the Cursor/VS Code extension, native Cursor automation, and the
headless CLI driven by Claude Code or Codex skills. Until now the
`auto-factory-ai-provider` flag served one value for everyone, and the
execution providers were Anthropic, Bedrock, Cursor, and Vega — there was no
way to run the agents on OpenAI models at all, which reads as a gap precisely
where users would expect them (a Codex-driven run).

Model/provider choice *should* follow the surface: a Claude Code user expects
Anthropic models; a Codex user expects OpenAI models; CI has no such
expectation, which makes it the right place for a live cross-provider
comparison.

## Decision

1. **A `surface` context attribute.** Every front end stamps
   `AUTOFACTORY_SURFACE` (`claude-code` | `codex` | `github-action` | `cli`)
   — the skills on their command line, the Action in its workflow env (with a
   code-side default), the bare CLI as `cli`. `pipelineContext()` copies it
   onto the `run` and `service` contexts.

2. **Routing lives in the provider flag's targeting, not code.** Bootstrap
   provisions `auto-factory-ai-provider` ON with rules on `run.surface`:
   claude-code → `anthropic`, codex → `openai`, github-action → a **50/50
   anthropic/cursor rollout bucketed by run key** (each CI run lands wholly on
   one provider; per-run randomization enables live model comparison).
   Fallthrough: `anthropic`. The chain stays two-layered: surface → provider
   (this flag), provider → model variation (each AI config's existing
   `run.provider` rules, now including an `openai` variation serving
   `OpenAI.gpt-5.2` for agents and `OpenAI.gpt-5-mini` for judges).

3. **A fifth execution provider: OpenAI.** `OpenAiAgentRunner` +
   `createOpenAiJudgeCompletion` implement the same agent contract on OpenAI
   Chat Completions function calling. Bedrock could inject a client into the
   Anthropic loop (same Messages API); OpenAI cannot — the wire shapes differ
   — so it is a sibling loop that imports every provider-agnostic piece
   (grants, required-tag forcing, mode note, tool overlay, sandbox executor)
   from the Anthropic runner. Sandbox-confined: allowed in the CLI's
   workingTree mode alongside Anthropic/Bedrock. Key: `OPENAI_API_KEY`, falling
   back to `CODEX_API_KEY` (the same platform key Codex CLI users already
   hold).

4. **Fail open to Anthropic.** A selected provider whose key is absent
   (cursor without `CURSOR_API_KEY`, openai without either key) logs and falls
   back to Anthropic instead of failing the run — the bootstrap-default 50/50
   must not break repos that never configured a Cursor key.

5. **Provisioner learns targeting-on-create.** Committed flag files and AI
   config files may carry a `targeting` block (rules by variation value/key);
   `provision` applies it only to resources it creates — existing resources'
   targeting remains runtime state it never touches. AI config files may also
   declare `copyFrom` on a variation to inherit a sibling's instructions/
   messages/tools, keeping provider variations at one source of truth.

## Consequences

- Fresh bootstraps get surface-appropriate models with zero configuration;
  existing projects need a one-time live targeting update (`bridge upgrade`
  creates the new variations; the rules were applied to the live factory
  project alongside this ADR).
- The GHA 50/50 replaces the earlier 40/40/20 per-agent model A/B; comparison
  now happens at run level across providers.
- OpenAI judge/agent behavior inherits all deterministic scaffolding (⛊/⛔
  checks, forced tags, judges) — provider quality differences surface as data
  in AI Config monitoring, not as pipeline changes.
