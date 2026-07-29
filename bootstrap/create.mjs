#!/usr/bin/env node
/**
 * One-command bootstrap (`npm run bootstrap`):
 *   1. build the workspace if needed
 *   2. preflight checks (Node, LD env, LD reachability); fail loudly
 *   3. provision agent configs + graph into the target project (via the bridge)
 *   4. print the remaining manual steps (drop in the workflow, set secrets)
 *
 * Defaults are one layer deep: this generates/uses the real config files in
 * config/ that a partner then edits, no hidden magic.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";

/**
 * Pick the Phase 1 execution provider. Non-interactive override:
 * `--provider cursor` / `--provider=cursor` or AUTOFACTORY_PROVIDER=cursor.
 * Interactive (TTY): prompt. Default: anthropic.
 */
async function chooseProvider() {
  const i = process.argv.indexOf("--provider");
  const fromArg =
    process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1] ??
    (i !== -1 ? process.argv[i + 1] : undefined);
  const want = (fromArg ?? process.env.AUTOFACTORY_PROVIDER ?? "").trim().toLowerCase();
  if (want === "anthropic" || want === "cursor") return want;
  if (!stdin.isTTY) return "anthropic"; // non-interactive default
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question("Phase 1 execution provider — [a]nthropic direct (default) or [c]ursor? "))
    .trim()
    .toLowerCase();
  rl.close();
  return ans.startsWith("c") ? "cursor" : "anthropic";
}

console.log("LaunchDarkly Auto-Factory bootstrap\n");
const provider = await chooseProvider();
console.log(`Provider: ${provider}${provider === "anthropic" ? " (direct Anthropic API)" : " (Cursor agents via @cursor/sdk)"}\n`);

// 1. Ensure build output exists before importing built packages.
if (!existsSync("packages/config-bridge/dist/cli.js") || !existsSync("packages/shared/dist/index.js")) {
  console.log("Building workspace…");
  execSync("npm run build", { stdio: "inherit" });
}

// 2. Preflight (dynamic import; depends on the build above).
const { preflight } = await import("./checks/preflight.mjs");
console.log("Preflight checks:");
const { ok, issues, notes } = await preflight();
ok.forEach((m) => console.log("  ✓", m));
notes.forEach((m) => console.log("  •", m));
if (issues.length) {
  issues.forEach((m) => console.error("  ✗", m));
  console.error("\nResolve the above (see .env.example), then re-run `npm run bootstrap`.");
  process.exit(1);
}

// 3. Get agent configs + graph + operational flags into the target project.
//    - If LD_SOURCE_* is configured: SEED (pull the live graph + the configs it
//      references from the source project, provision straight into the target).
//    - Otherwise: provision from the committed local copies in config/agentcontrol/.
//    Either way the operational flags (provider selector, approval gates,
//    knowledge graph) are
//    created from config/agentcontrol/flags/ — off by default, so behavior is
//    unchanged until a maintainer flips them.
const hasSource =
  process.env.LD_SOURCE_API_KEY && process.env.LD_SOURCE_BASE_URL && process.env.LD_SOURCE_PROJECT_KEY;
if (hasSource) {
  console.log("\nLD_SOURCE_* configured: seeding agent configs + graph (+ operational flags) from the source project…");
  execSync("node packages/config-bridge/dist/cli.js seed", { stdio: "inherit" });
} else {
  console.log("\nProvisioning agent configs + graph + operational flags from local config/agentcontrol/…");
  console.log("  (Set LD_SOURCE_* in .env to pull the live configs+graph from the prototype project instead.)");
  execSync("node packages/config-bridge/dist/cli.js provision", { stdio: "inherit" });
}

// 4. Remaining manual steps (tailored to the chosen provider).
const steps =
  provider === "cursor"
    ? `
Next steps (provider: cursor):
  1. Copy bootstrap/github-action-template/auto-factory-cursor.yml → .github/workflows/ in your
     app repo (set <owner>). It checks the tool out + runs \`npm ci\`, because the Cursor SDK
     can't run via the bare \`uses:\` form.
  2. Serve 'cursor' from the auto-factory-ai-provider flag in your factory project.
  3. Add repo secrets:    LD_SDK_KEY, CURSOR_API_KEY, LD_API_KEY
     Add repo variable:   LD_APP_PROJECT_KEY  (e.g. autofactory-demo)
     (GITHUB_TOKEN is provided automatically. For Phase 2, also add BEACON_WEBHOOK_SECRET.)
  4. Open a PR. Phase 1 runs automatically (LLM Observability is on — DISABLE_LD_OBSERVABILITY to opt out;
     set repo variable AUTOFACTORY_REQUIRE_LABEL=true to gate runs on the `autofactory` PR label).
  Optional A/B: to split Composer vs Sonnet per coding agent, add a Composer model + a 'run'
  context kind in LaunchDarkly and bucket those agents' rollouts by 'run' (see
  config/agentcontrol/CHANGELOG.md).`
    : `
Next steps (provider: anthropic):
  1. Copy bootstrap/github-action-template/auto-factory.yml → .github/workflows/ in your app repo
     (set <owner> to the repo hosting this action).
  2. Add repo secrets:    LD_SDK_KEY, ANTHROPIC_API_KEY, LD_API_KEY
     Add repo variable:   LD_APP_PROJECT_KEY  (e.g. autofactory-demo)
     (GITHUB_TOKEN is provided automatically. For Phase 2, also add BEACON_WEBHOOK_SECRET.)
  3. Open a PR. Phase 1 runs automatically (LLM Observability is on — DISABLE_LD_OBSERVABILITY to opt out;
     set repo variable AUTOFACTORY_REQUIRE_LABEL=true to gate runs on the `autofactory` PR label).

  Using Claude Code instead of the GitHub Action? Skip the steps above and follow
  INSTALL-CLAUDE-CODE.md (you're already past step 1).`;

console.log(
  steps +
    (hasSource
      ? ""
      : `

Provisioned from the committed definitions in config/agentcontrol/ (the canonical
public copies). The agent instructions are editable in the LaunchDarkly UI afterward;
the pipeline reads them at run time.`),
);
