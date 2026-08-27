# Install: AutoFactory in GitHub Copilot cloud agent

Run the full AutoFactory Phase 1 chain **inside Copilot's cloud sandbox**:
assign an issue to Copilot with the `autofactory` custom agent (or start it
from the Agents panel at github.com/copilot/agents), and Copilot implements
the change, runs the chain on it — flag (targeting off), guarded-release
metrics, instrumentation, flag-on/flag-off tests, release manifest, review
verdict — and commits everything to the session's PR branch. Nothing runs on
your machine; GitHub hosts the compute.

Two pieces land in your app repo (a custom agent profile and a
`copilot-setup-steps.yml`), plus a few one-time settings in the repo's UI.
Setup is about 15 minutes. (Copilot is the chauffeur; the chain's agents
execute on the provider LaunchDarkly routes for the surface — **Anthropic by
default on Copilot** (ADR 0018), billed to your `ANTHROPIC_API_KEY`,
retargetable in the `auto-factory-ai-provider` flag.)

## Prerequisites

- A **GitHub Copilot paid plan** with **cloud agent** available on the app
  repo (Pro/Pro+: on by default; Business/Enterprise: an org admin must
  enable the "Copilot cloud agent" policy), and **healthy Actions billing**
  on the repo owner (sessions run on Actions runners)
- **Node 20+ locally** for the one-time setup commands
- A **LaunchDarkly account** and an **API access token** (`api-…`) with write
  access — the two projects and the SDK key are created/fetched by setup
- An **Anthropic API key** — the chain's agents bill to this key (separate
  from your Copilot subscription)

## 1. Clone and run the guided setup

```bash
git clone <this-repo> && cd launchdarkly-auto-factory
npm install
npm run init
```

Choose provider **anthropic** and front end **copilot**, and give it the app
repo's `owner/name`. `init` provisions the LaunchDarkly side (projects, agent
AI configs, judges, graph, operational flags — idempotent, resumable) and
opens a **setup PR** in the app repo adding:

- `.github/agents/autofactory.agent.md` — the custom agent
- `.github/workflows/copilot-setup-steps.yml` — pre-installs this tooling in
  Copilot's environment each session

Merge that PR (the setup-steps file only takes effect on the **default
branch**).

## 2. One-time repo settings (Settings UI — no API support yet)

In the app repo on GitHub:

1. **Settings → Secrets and variables → Agents** (note: **Agents**, not
   Actions — cloud agent cannot read Actions secrets). Add
   **secrets**: `LD_SDK_KEY` (the factory project's server SDK key — `init`
   printed it into the tooling repo's `.env`), `LD_API_KEY`,
   `ANTHROPIC_API_KEY`; and **variables**: `LD_PROJECT_KEY` (factory project
   key), `LD_APP_PROJECT_KEY`, and optionally `AUTOFACTORY_MAINTAINER_EMAIL`
   (your LD member email — created flags get you as maintainer; there's no
   git identity to infer it from in the cloud). Never add `APPROVAL_MODE` or
   `RISK_THRESHOLD` here.
2. **Settings → Copilot → Internet access**: keep the firewall enabled and
   add custom domain rules **`launchdarkly.com`** and
   **`api.anthropic.com`** — the CLI runs under the agent's firewalled Bash
   and neither host is on the recommended allowlist.

## 3. First run

Open an issue describing a small feature, then **assign it to Copilot** and
pick the **`autofactory`** agent in the assignment dialog (or go to the
Agents panel, select `autofactory`, and type the task). Copilot will:

1. run the setup steps (clones + builds this tooling — a few minutes),
2. implement the change,
3. run the chain (5–6 agents, several more minutes; progress lands in the
   session log),
4. commit the artifacts and open a draft PR with the verdict summarized.

For a flag-worthy change you'll get: a flag (targeting off) and three
guarded-release metrics in your app project, the behavior wired behind the
flag, metric instrumentation, tests, and a release manifest under
`.release-flags/` — all committed on the PR branch for you to review.

**Approval gates:** if the `auto-factory-approval-mode` flag gates a step,
the session ends with the pending gate listed under `## AutoFactory
approvals` in the PR description. Reply **`@copilot approve <nodeKey>`** on
the PR to resume (a follow-up session re-runs past the gate). The default
mode (`yolo`) runs unattended.

**Agent questions:** if the chain pauses on a question (exit 4 — e.g. "do
this service's OTel traces reach LaunchDarkly?"), it appears in the PR
description; answer it in an `@copilot` reply.

**Verdicts:** a rejected review is the reviewer agent's opinion, not a
pipeline failure — it's committed on the PR for you to read and decide.

## Troubleshooting

First move: `npm run doctor` in the tooling repo (validates the LD side);
for the Copilot side, check the session logs at github.com/copilot/agents.

| Symptom | Fix |
|---------|-----|
| The `autofactory` agent doesn't appear in the picker | The agent profile must be on the **default branch** at `.github/agents/autofactory.agent.md`; cloud agent must be enabled for the repo. |
| Agent says "AutoFactory tooling is not installed" | The setup steps failed (they fail open) — check the `Copilot Setup Steps` run in the Actions tab; the file must be on the default branch with the job named `copilot-setup-steps`. |
| Exit 2, `LD_SDK_KEY is not set` (or similar) | The Agents secrets/variables from step 2 are missing or under the wrong type (Actions instead of **Agents**). |
| Network errors against `launchdarkly.com` / `api.anthropic.com` | Firewall allowlist entries from step 2 are missing (blocked requests are also warned about in the PR body). |
| Session never starts / fails immediately | Actions billing on the repo owner is locked or over limit — cloud agent runs on Actions. |
| `Agent graph 'gha-auto-factory' is disabled or unavailable` | `LD_SDK_KEY` must be the **factory** project's server SDK key, not the app project's (`npm run doctor` verifies this). |
| Both this and the GitHub Action process the same PR | Expected with both installed — the Action is the server-side backstop. Scope the Action with `AUTOFACTORY_REQUIRE_LABEL=true` if you want one owner per PR. |

More detail: [`bootstrap/copilot/README.md`](bootstrap/copilot/README.md)
(design, session mechanics, costs) and
[`packages/phase1-cli/README.md`](packages/phase1-cli/README.md) (the
underlying CLI, exit codes, run records).
