---
name: autofactory-setup
description: Guided first-time AutoFactory setup — verify prerequisites, run `bridge init` (LD projects, .env, provisioning, GitHub secrets + setup PR, or local skill install), and validate with `bridge doctor`. Use when the user says "set up AutoFactory", "onboard me", "/autofactory-setup", or asks how to install/configure this repo.
---

# AutoFactory guided setup

You drive two deterministic CLI commands — `npm run init` and `npm run doctor`
— from the root of this tooling repo. Your job is to collect the answers
conversationally, then pass them as flags. Do NOT reimplement what they do
(no hand-editing .env, no manual `gh secret set`, no manual LD project
creation): the CLI is idempotent and safe to re-run; hand-rolled steps aren't.

## 1. Prerequisites (check, don't assume)

- `node --version` ≥ 20; `npm install` has been run (node_modules exists).
- The user has an LD API token (`api-…`, write access). If not: Account
  settings → Authorization in LaunchDarkly. Never ask them to paste it into
  the chat — see "secrets" below.
- Front end GitHub Action? → `gh auth status` must pass.

## 2. Collect the answers, then run init

Ask the user (one message, only what's still unknown; `.env` values already
present are used as defaults automatically):

- factory + app project keys (create-if-missing is automatic),
- provider: `anthropic` (default) / `bedrock` / `cursor`,
- front end: `github-action` / `claude-code` / `cursor-automation` / `none`,
  and the app repo (`owner/name` for GitHub, local path otherwise).

**Secrets:** `init` reads `LD_API_KEY` / `ANTHROPIC_API_KEY` / `CURSOR_API_KEY`
from the environment or `.env` and only prompts for what's missing. Since the
CLI's interactive prompts can't reach the user through you, have the user run
the interactive form themselves when secrets are missing — tell them to type:

```
! npm run init
```

(the `!` prefix runs it in their session, with masked prompts). When all
secrets are already in `.env`/env, run it yourself, non-interactively:

```bash
npm run init -- --yes --provider <p> --factory-project <k> --app-project <k> \
  --front-end <f> [--app-repo owner/name | --app-repo-path <dir>] [--no-pr]
```

Relay each step's output line (projects, SDK key fetch, provisioning counts,
secrets set, the setup-PR URL). Merging the setup PR is the user's decision —
link it, don't merge it.

## 3. Validate

```bash
npm run doctor            # add: -- --app-repo owner/name for the GitHub checks
```

Exit 1 means failures; every failing line carries its own fix — relay those
lines verbatim and offer to apply the fixes. Re-run doctor after fixing.
`init` may be re-run any time; it resumes (existing resources are never
touched, the setup PR branch is reused).

## Rules

- Never set `APPROVAL_MODE` / `RISK_THRESHOLD` / `APPROVAL_GATES` env vars.
- Never echo secret values back into the conversation (not even partially).
- Creating LD projects and pushing the setup PR branch are the only writes;
  both are confirmed by init itself. Don't add extra writes around them.
