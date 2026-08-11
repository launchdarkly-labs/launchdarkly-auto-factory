# ADR 0014 — Amazon Bedrock as a fourth execution provider

**Status:** accepted (2026-08-07). Extends [ADR 0005](0005-provider-seam-local-anthropic-execution.md). Runtime not yet validated live (no AWS credentials at build time).

**Context.** The `auto-factory-ai-provider` flag selects Phase 1's execution backend per run
(ADR 0005/0006): the local Anthropic tool-use loop (default), hosted Vega, or Cursor agents.
Enterprises frequently standardize on Claude **via Amazon Bedrock** — AWS-side auth (IAM/OIDC),
AWS billing, and data-path requirements — rather than a direct Anthropic API key. We want the
same pipeline to run there with nothing else changing: same graph, same instructions, same
tools, same judges, same metrics.

**Decision.** Add a `bedrock` provider that is *the Anthropic runner over a different
transport*, not a new runner:

- `@anthropic-ai/bedrock-sdk`'s `AnthropicBedrockMantle` client serves the **same Messages
  API** (endpoint `https://bedrock-mantle.<region>.api.aws/anthropic`), so
  `AnthropicAgentRunner` gained an injectable `client` (plus `providerName` and
  `modelIdMapper` knobs) and `BedrockAgentRunner` is a ~30-line wrapper. The whole tool loop —
  sandbox tools, transient-error retries, forced routing tags, LD trackers, gen_ai spans — is
  shared code, so agent behavior is identical by construction. The judge completion is shared
  the same way (`createForcedToolJudgeCompletion`).
- **Model mapping is automatic**: LD AI configs keep their Anthropic model names; the runner
  maps `claude-…` → `anthropic.claude-…` (Bedrock's provider-prefixed ids) via
  `bedrockModelId`, which reuses `anthropicModelId`'s normalization. No per-provider AI-config
  variations are required (unlike Cursor, whose catalog differs).
- **Auth/region come from the standard AWS credential chain** (`AWS_REGION` +
  access keys / profile / ambient OIDC role / `AWS_BEARER_TOKEN_BEDROCK`) — nothing
  AutoFactory-specific to mint or store. The GitHub Action exposes optional `aws_*` inputs;
  an `aws-actions/configure-aws-credentials` step works too.
- Because the Bedrock runner is structurally confined to the sandbox tools (same executor as
  Anthropic), it is allowed everywhere Anthropic is: the GitHub Action, the **CLI**, and the
  **editor extension** — including working-tree mode, whose "nothing is committed or pushed"
  contract is exactly why Cursor is excluded there (ADR 0006 aftermath, 2026-07-20).

**Version pin.** `@anthropic-ai/bedrock-sdk` is pinned to `0.32.0` exactly: `0.32.1` requires
`@anthropic-ai/sdk >= 0.115.1`, which would nest a second copy of the core SDK next to our
`^0.102.0` and break the runner's `instanceof Anthropic.APIError` transient-retry checks. Bump
both SDKs together.

**Consequences.**

- The provider flag gains a `bedrock` variation (committed definition updated; existing live
  flags need the variation added manually — `bridge upgrade` never edits flag variations).
- The drop-in GHA workflow works unchanged (the bundle inlines the Bedrock SDK); only AWS
  credentials/region need to reach the job.
- Rate limits, model availability, and pricing are per-AWS-account/region — the target account
  must have the mapped Claude models enabled in the chosen region, or the first node fails on
  its first API call (construction validates nothing).
- Untested paths to verify on first live run: credential-chain resolution inside the GHA
  runtime, the Mantle endpoint accepting our mapped model ids, and error-class identity for
  transient retries.
