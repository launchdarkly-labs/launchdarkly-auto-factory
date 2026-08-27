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

## Known blocker: in-session chain execution (live-tested 2026-08-27)

Three live sessions validated every piece of this front end's infrastructure
— Agents secrets reached the shell, the firewall rules held, the setup steps
built the CLI (~30s on a warm cache), the custom agent was selected, and the
agent issued the exact right CLI invocation. **None of the three sessions
ran the chain to completion.** The cause is a three-part interaction in the
cloud-agent harness, all observed directly in session logs:

1. **The bash tool is fire-and-forget.** Commands are spawned and return in
   ~100ms; output is read via a separate `read_bash` tool. A multi-minute
   chain run therefore needs the model to poll `read_bash` across dozens of
   turns. No synchronous mode or timeout parameter is exposed.
2. **The engine ends the session at the first tool-free message.** The
   moment the model emits an assistant message with zero tool calls, the
   engine logs `session.idle` → "Main session complete" — permanently. The
   runner VM is torn down, killing any still-running chain process. Models
   narrate by habit; here narration is fatal (attempt 2 died mid-plan,
   before even launching the CLI).
3. **The model is tuned to wrap up, and the engine reinforces it** (built-in
   code-review/secret-scan/PR-summary steps pull toward completion).
   Attempt 1 polled the running chain once at 3s then wandered off; attempt
   3 — with a profile that states rule 2 explicitly and a three-part
   definition of done — launched the chain, polled once, opened the PR at
   13s *while the chain was running*, and idled out at 23s.

Waiting out the chain means surviving ~20–40 consecutive disciplined polling
turns where one tool-free message is game over — a harness-behavior problem,
not an instruction-clarity problem, so prose iteration stopped at v3. The
20-minute session timeout (`COPILOT_AGENT_TIMEOUT_MIN`) is a hard ceiling on
implement+chain regardless.

**Working today — the server-side backstop.** The GitHub Action front end
runs the full chain on the PR the agent opens, deterministically: validated
live (review APPROVED; flag, wiring, tests, and manifest committed onto the
agent's branch). Two operational notes: Copilot-authored PRs park workflow
runs in `action_required` (a label event does NOT bypass it — a human-actor
push, e.g. an empty commit, or the "Approve and run workflows" click does),
and the cursor-variant workflow must pass `ANTHROPIC_API_KEY` (fixed in the
template 2026-08-27 — the anthropic arm of the 50/50 split failed without
it).

**Candidate fix — chain as an MCP tool (unbuilt).** MCP tool calls are
synchronous: the harness itself blocks on the result, eliminating the
polling loop and the idle window. A stdio MCP server wrapping the CLI,
declared in this profile's `mcp-servers` frontmatter, would make "run the
chain" one un-abandonable call — and the egress firewall doesn't apply to
MCP servers, dropping the allowlist dependency too. Open questions before
building: the engine's MCP tool timeout is undocumented (measure first — if
it's short, the approach is dead), and MCP servers only see
`COPILOT_MCP_*`-prefixed Agents secrets, so `LD_SDK_KEY`/`LD_API_KEY`/
`ANTHROPIC_API_KEY` need duplicating under that prefix.

## Costs and caveats

- Copilot cloud agent bills **Actions minutes + Copilot AI credits** for the
  session itself (~$1 in credits per ~6-minute session observed); the
  chain's agents bill **Anthropic API** (the `ANTHROPIC_API_KEY` Agents
  secret) as usual. Two meters, one run.
- Every session (including follow-ups) re-clones and rebuilds the tooling
  (~a few minutes). A `snapshot` cache in setup steps could cut this later.
- The agent tasks REST API (`POST /agents/repos/{owner}/{repo}/tasks`,
  public preview) accepts `custom_agent` — handy for scripted testing.
