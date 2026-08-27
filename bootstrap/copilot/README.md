# AutoFactory in GitHub Copilot cloud agent

Phase 1 front end #6: an `autofactory` **custom agent** for Copilot cloud
agent. Assign an issue to Copilot (picking the `autofactory` agent), start it
from the Agents panel, or `@copilot` a PR it opened — Copilot implements the
change in its cloud sandbox, then runs the full AutoFactory chain on the
result and commits the artifacts to the session's PR branch.

Same design as the [Claude Code](../claude-code/) and [Codex](../codex/)
front ends (Option C of `../claude-code/plan.md`): a thin prose layer that
drives the headless [`autofactory` CLI](../../packages/phase1-cli/), so the
run has full fidelity — judges with verified evidence, AI Config monitoring,
gen_ai spans, per-agent models, code-enforced approval gates and write
ceiling. Copilot's role is chauffeur. The difference from the local skills is
**where it runs**: GitHub's own Actions-based sandbox hosts both Copilot and
the chain — nothing runs on your machine.

## The two drop-in files

| File here | Goes to (app repo) | What it does |
|---|---|---|
| [`agents/autofactory.agent.md`](agents/autofactory.agent.md) | `.github/agents/autofactory.agent.md` | The custom agent: implement the task, then chauffeur the CLI; PR-mediated approval-gate and question loops |
| [`copilot-setup-steps.yml`](copilot-setup-steps.yml) | `.github/workflows/copilot-setup-steps.yml` | Pre-installs this tooling repo at `$HOME/autofactory-tooling` in the agent's ephemeral environment (re-runs every session) |

`bridge init --front-end copilot` opens a setup PR adding both, then prints
the manual checklist below. Standalone guide:
[INSTALL-COPILOT.md](../../INSTALL-COPILOT.md).

## Manual settings (no API/gh support yet — repo Settings UI)

1. **Agents secrets/variables** (Settings → Secrets and variables → **Agents**
   — note: *not* Actions; cloud agent cannot read Actions secrets):
   secrets `LD_SDK_KEY`, `LD_API_KEY`, `ANTHROPIC_API_KEY`; variables
   `LD_PROJECT_KEY`, `LD_APP_PROJECT_KEY` (+ optional
   `AUTOFACTORY_MAINTAINER_EMAIL`). These reach the agent's shell as plain
   environment variables, which is exactly what the CLI reads. Never add
   `APPROVAL_MODE` / `RISK_THRESHOLD` (they'd silently override the LD
   approval flags — the same gotcha as ADR 0008's GHA incident).
2. **Firewall** (Settings → Copilot → Internet access): keep the firewall on,
   add custom **domain** rules `launchdarkly.com` (covers all subdomains) and
   `api.anthropic.com`. The recommended allowlist does not include either;
   the CLI runs under the agent's firewalled Bash.
3. **Enablement**: Copilot cloud agent on for the repo (Business/Enterprise
   orgs: the "Copilot cloud agent" policy, off by default), and healthy
   **Actions billing** on the repo owner — sessions run on Actions and die
   immediately on a billing lock.

## Session mechanics worth knowing

- **Surface routing (ADR 0018):** the agent prose pins
  `AUTOFACTORY_SURFACE=copilot`; the `auto-factory-ai-provider` flag routes
  that surface to **Anthropic** — the cloud sandbox is exactly the
  environment the working-tree ceiling was built for, and it needs a
  sandbox-confined runner. A native `copilot` provider (Copilot SDK runner,
  inference on Copilot's models) is the planned follow-up.
- **Artifacts are committed**, not left uncommitted — the session branch/PR
  *is* the review surface, matching the GitHub Action front end's contract
  rather than the local skills'.
- **Approval gates (exit 3) round-trip through the PR**: the agent records
  pending/approved gates in an `## AutoFactory approvals` PR-description
  section and ends the session; `@copilot approve <nodeKey>` starts a
  follow-up session (same branch, setup steps re-run, same custom agent) that
  re-runs with the accumulated `--approve` flags. The PR description is the
  cross-session memory — the run record in `.git/` does not survive between
  ephemeral environments. Agent questions (exit 4) use the same loop via the
  committed manifest.
- **No pre-push gate on this surface**: Copilot has no hook seam, and the
  platform (not the agent) owns push/PR creation. The prose makes running the
  chain part of the agent's job; the GitHub Action front end remains the
  server-side backstop for sessions that skip it (it triggers on the PR
  Copilot opens — with both installed, expect the Action to re-process the
  PR unless you gate it with `AUTOFACTORY_REQUIRE_LABEL`).
- **Setup steps fail open** — if the tooling install fails, the agent says
  the chain didn't run instead of imitating it.

## Costs and caveats

- Copilot cloud agent bills **Actions minutes + Copilot AI credits** for the
  session itself; the chain's agents bill **Anthropic API** (the
  `ANTHROPIC_API_KEY` Agents secret) as usual. Two meters, one run.
- Every session (including follow-ups) re-clones and rebuilds the tooling
  (~a few minutes). A `snapshot` cache in setup steps could cut this later.
- Untested live as of 2026-08-27: needs a repo with Copilot cloud agent
  enabled — see the checklist above and INSTALL-COPILOT.md.
