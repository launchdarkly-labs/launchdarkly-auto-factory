# @auto-factory/phase1-cli

Phase 1 front end #4: a headless CLI over the real Node core (`packages/shared`)
— Option C of [the Claude Code plan](../../bootstrap/claude-code/plan.md). It is
the extension's `runChain` shape with a terminal surface: the same graph walk,
provider seam, judges, AI Config monitoring, gen_ai spans, approval gates,
knowledge-graph and cross-repo tools, run against a local working tree.

```
autofactory run [--graph gha-auto-factory] [--approve <nodeKey>]... [--dry-run] [--base <ref>] [--root <dir>]
```

What a run does (identical contract to the other front ends): research and
classify the branch's change (committed + uncommitted, vs the base ref), create
a flag (targeting off) in the app project, wire the behavior behind it, create
guarded-release metrics and instrument their events, write flag-on/flag-off
tests, write the release manifest under `.release-flags/`, and produce a review
verdict. Edits land **uncommitted in the working tree** (`gitMode:
"workingTree"`); nothing is committed or pushed.

## Setup

The same five secrets the GitHub Action needs, in a `.env` **in the directory
you invoke from** (typically this tooling repo's root — the app repo needs no
secrets):

```
LD_SDK_KEY=            # factory project server SDK key
LD_API_KEY=            # api- token that writes flags/metrics in the app project
LD_PROJECT_KEY=        # factory project
LD_APP_PROJECT_KEY=    # app project
ANTHROPIC_API_KEY=     # default 'anthropic' provider; on 'bedrock' use AWS_REGION + AWS creds instead (see Fidelity notes)
```

Build once (`npm install && npm run build` at the repo root), then either run
`npx autofactory run --root <app-repo>` from this repo, or
`node <this-repo>/packages/phase1-cli/dist/cli.js run --root <app-repo>`.

## Approval gates (exit code 3)

The three approval flags compile into pre-execution gates exactly as in the
Action (ADR 0008). When a gate holds, the run **halts before the gated step**
(nothing created for it), prints the exact re-run command, and exits `3`. A
human approves by re-running with `--approve <nodeKey>` — carry every
previously approved step on each re-run. There is no stdin prompt: the caller
(a human, or Claude Code relaying the question — see
[`bootstrap/claude-code/`](../../bootstrap/claude-code/)) owns the question.
The `APPROVAL_MODE` / `RISK_THRESHOLD` env overrides exist but silently defeat
the flag control plane — leave them unset.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | reviewer approved, or clean no-op (change needs no flag) |
| 1 | review rejected, chain incomplete/stalled, or a deterministic handoff check failed |
| 2 | usage/configuration error, or nothing to process on this branch |
| 3 | paused at an approval gate — re-run with `--approve <node>` |

## Fidelity notes

- **Judges** run with verified evidence, but since agents never commit in
  workingTree mode the evidence is the **node-scoped working-tree diff**
  (`createWorkingTreeEvidence`) rather than the commit-scoped one the Action
  uses. Same ground-truth property: the judge sees what changed, not what the
  agent claimed.
- **Provider**: the CLI executes on the **sandboxed** runners only — `anthropic`
  (default) or `bedrock` (the same tool loop on Claude via Amazon Bedrock;
  needs `AWS_REGION` + AWS credentials instead of `ANTHROPIC_API_KEY`). `vega`
  runs agents server-side and can't edit a local tree. `cursor` runs locally
  but a Cursor local agent carries its own native shell/git alongside our
  sandbox tools — in a live run it committed each step and pushed the branch,
  bypassing `commit_and_push` (the only place the working-tree mode is
  enforced), and the SDK has no tool-restriction API to prevent that. Only the
  sandbox-confined runners satisfy the "nothing is committed or pushed"
  contract. Vega/Cursor selections fall back to Anthropic with a note; use the
  GitHub Action for Cursor/Vega runs.
- **Config drift**: the `[cfg:…]` stamp check runs when the CLI executes from a
  checkout of this repo (it hashes `config/agentcontrol/` three levels up).
- **Run record**: every completed non-dry run writes
  `<git-dir>/autofactory-last-run.json` in the target repo (branch, HEAD,
  outcome, flag, manifest) — inside `.git/` so it can't be committed or dirty
  the tree. This is what the Claude Code pre-push gate
  ([`bootstrap/claude-code/hooks/`](../../bootstrap/claude-code/hooks/))
  checks before letting `git push` / `gh pr create` through. Approval pauses,
  dry runs, and errors don't write one.
