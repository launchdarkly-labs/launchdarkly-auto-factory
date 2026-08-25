/**
 * `bridge init` — guided first-time setup. The human supplies at most three
 * things (an LD API token, a provider key, a gh login); everything else is
 * derived or created:
 *
 *   1. Verify the LD API token, then create-or-confirm the factory and app
 *      projects (POST /api/v2/projects) and FETCH the factory environment's
 *      server SDK key — so LD_SDK_KEY can never be the wrong project's key.
 *   2. Pick the execution provider and collect its key.
 *   3. Write .env (preserving anything else already in it).
 *   4. Provision the agent configs/graph/flags/tools (same as bootstrap).
 *   5. Wire a front end: for the GitHub Action, set the app repo's secrets +
 *      variable via `gh` and open a setup PR with the rendered workflows; for
 *      Claude Code / Cursor automation, copy the drop-in files locally.
 *
 * Idempotent and resumable: existing .env values become defaults, existing LD
 * resources are left untouched, the setup PR branch is reused. Non-interactive
 * with --yes (or no TTY): prompts become errors listing the missing flags.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { LdClient, loadDotEnv, validateProjectKey } from "@auto-factory/shared";
import { gh, ghAuthenticated, ghAvailable, ghJson, ghPutFile, ghSetSecret, ghSetVariable } from "./gh.js";
import { provision } from "./provision.js";
import {
  parseOwnerRepo,
  renderFindCodeRefs,
  renderMcpJson,
  renderWorkflow,
  upsertEnv,
  workflowFileFor,
  type Provider,
} from "./render.js";

const SETUP_BRANCH = "autofactory-setup";
const RENDER_DIR = ".autofactory-rendered";

class InitError extends Error {}

function argValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  return i >= 0 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined;
}

// --- prompting ---------------------------------------------------------------

let interactive = true;

async function ask(question: string, def?: string): Promise<string> {
  if (!interactive) {
    if (def !== undefined) return def;
    throw new InitError(`Missing required value in non-interactive mode: ${question}`);
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
  rl.close();
  return answer || def || "";
}

async function confirm(question: string, def = true): Promise<boolean> {
  if (!interactive) return def;
  const answer = await ask(`${question} (${def ? "Y/n" : "y/N"})`, "");
  if (!answer) return def;
  return answer.toLowerCase().startsWith("y");
}

/** Masked secret prompt (echoes '*'); falls back to plain when not a TTY. */
function askSecret(question: string): Promise<string> {
  if (!interactive) {
    return Promise.reject(new InitError(`Missing required secret in non-interactive mode: ${question}`));
  }
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return ask(question);
  }
  return new Promise((resolvePromise) => {
    stdout.write(`${question}: `);
    const chars: string[] = [];
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          stdin.pause();
          stdout.write("\n");
          resolvePromise(chars.join(""));
          return;
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") {
          if (chars.length) {
            chars.pop();
            stdout.write("\b \b");
          }
          continue;
        }
        chars.push(c);
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

// --- LaunchDarkly steps --------------------------------------------------------

interface LdEnvironment {
  key: string;
  name?: string;
  apiKey?: string;
}

/** GET the project; offer to create it when absent. Returns true if it exists/was created. */
async function ensureProject(ld: LdClient, key: string, role: string): Promise<boolean> {
  validateProjectKey("project key", key);
  const existing = await ld.request({ path: `/api/v2/projects/${key}`, okStatuses: [404] });
  if (existing.status === 200) {
    console.log(`  ✓ ${role} project '${key}' exists`);
    return true;
  }
  if (!(await confirm(`  ${role} project '${key}' does not exist — create it?`, true))) return false;
  const name = key
    .split(/[-_.]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  await ld.request({ method: "POST", path: "/api/v2/projects", body: { key, name } });
  console.log(`  ✓ created ${role} project '${key}' ('${name}')`);
  return true;
}

async function listEnvironments(ld: LdClient, projectKey: string): Promise<LdEnvironment[]> {
  const r = await ld.request<{ items?: LdEnvironment[] }>({
    path: `/api/v2/projects/${projectKey}/environments?limit=50`,
  });
  return r.data.items ?? [];
}

// --- GitHub Action front end ---------------------------------------------------

interface RenderedFile {
  path: string;
  content: string;
}

function detectToolRepo(): { owner: string; repo: string } | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
    return parseOwnerRepo(url);
  } catch {
    return undefined;
  }
}

function renderAppRepoFiles(provider: Provider, toolOwner: string, appProjectKey: string): RenderedFile[] {
  const { templateName, appRepoPath } = workflowFileFor(provider);
  const templateDir = "bootstrap/github-action-template";
  const workflow = renderWorkflow(readFileSync(join(templateDir, templateName), "utf8"), { toolOwner, provider });
  const codeRefs = renderFindCodeRefs(readFileSync(join(templateDir, "find-code-refs.yml"), "utf8"), appProjectKey);
  return [
    { path: appRepoPath, content: workflow },
    { path: ".github/workflows/find-code-refs.yml", content: codeRefs },
  ];
}

/** Push the rendered workflows to a setup branch and open (or find) the PR. */
function openSetupPr(appRepo: string, files: RenderedFile[]): string | undefined {
  const repoInfo = ghJson<{ default_branch?: string }>([`repos/${appRepo}`]);
  const base = repoInfo?.default_branch ?? "main";
  const ref = ghJson<{ object?: { sha?: string } }>([`repos/${appRepo}/git/ref/heads/${base}`]);
  const sha = ref?.object?.sha;
  if (!sha) throw new InitError(`Could not resolve ${appRepo}@${base} — does the repo have a first commit?`);

  const created = gh(["api", "-X", "POST", `repos/${appRepo}/git/refs`, "-f", `ref=refs/heads/${SETUP_BRANCH}`, "-f", `sha=${sha}`]);
  if (!created.ok && !created.stderr.includes("Reference already exists") && !created.stdout.includes("Reference already exists")) {
    throw new InitError(`Could not create branch '${SETUP_BRANCH}' in ${appRepo}: ${created.stderr || created.stdout}`);
  }

  for (const f of files) {
    const put = ghPutFile(appRepo, f.path, f.content, `Add AutoFactory workflow (${f.path})`, SETUP_BRANCH);
    if (!put.ok) throw new InitError(`Could not write ${f.path} to ${appRepo}@${SETUP_BRANCH}: ${put.stderr || put.stdout}`);
  }

  const pr = gh([
    "api", "-X", "POST", `repos/${appRepo}/pulls`,
    "-f", "title=Set up LaunchDarkly AutoFactory",
    "-f", `head=${SETUP_BRANCH}`,
    "-f", `base=${base}`,
    "-f", "body=Adds the AutoFactory Phase 1 workflow (runs the agent chain on every PR) and the LaunchDarkly code-references scan. Generated by `bridge init`; repo secrets and the LD_APP_PROJECT_KEY variable were set alongside this PR. Merge, then open any PR to see the chain run.",
  ]);
  if (pr.ok) {
    return (JSON.parse(pr.stdout) as { html_url?: string }).html_url;
  }
  // 422 = a PR for this branch already exists (idempotent re-run) — find it.
  const existing = ghJson<Array<{ html_url?: string }>>([`repos/${appRepo}/pulls?head=${appRepo.split("/")[0]}:${SETUP_BRANCH}&state=open`]);
  if (existing?.[0]?.html_url) return existing[0].html_url;
  throw new InitError(`Could not open the setup PR in ${appRepo}: ${pr.stderr || pr.stdout}`);
}

interface GithubFrontEndInput {
  appRepo: string;
  provider: Provider;
  sdkKey: string;
  apiKey: string;
  appProjectKey: string;
  providerKey?: string;
  noPr: boolean;
  toolRepoArg?: string;
}

async function setupGithubFrontEnd(input: GithubFrontEndInput): Promise<void> {
  if (!ghAvailable()) throw new InitError("GitHub CLI (gh) not found — install https://cli.github.com and run `gh auth login`, then re-run init");
  if (!ghAuthenticated()) throw new InitError("gh is not authenticated — run `gh auth login`, then re-run init");
  if (!ghJson([`repos/${input.appRepo}`])) throw new InitError(`App repo '${input.appRepo}' not reachable via gh — check the owner/name and your access`);

  console.log(`\nConfiguring GitHub app repo ${input.appRepo}…`);

  const secrets: Array<[string, string | undefined]> = [
    ["LD_SDK_KEY", input.sdkKey],
    ["LD_API_KEY", input.apiKey],
  ];
  if (input.provider === "anthropic") secrets.push(["ANTHROPIC_API_KEY", input.providerKey]);
  if (input.provider === "cursor") secrets.push(["CURSOR_API_KEY", input.providerKey]);
  if (input.provider === "bedrock") {
    secrets.push(["AWS_ACCESS_KEY_ID", process.env.AWS_ACCESS_KEY_ID], ["AWS_SECRET_ACCESS_KEY", process.env.AWS_SECRET_ACCESS_KEY]);
  }
  if (process.env.AUTOFACTORY_REPOS_TOKEN) secrets.push(["AUTOFACTORY_REPOS_TOKEN", process.env.AUTOFACTORY_REPOS_TOKEN]);

  for (const [name, value] of secrets) {
    if (!value) {
      console.log(`  ⚠ secret ${name} skipped (no local value${input.provider === "bedrock" ? " — fine if the workflow uses an OIDC credentials step" : ""})`);
      continue;
    }
    const r = ghSetSecret(input.appRepo, name, value);
    if (!r.ok) throw new InitError(`gh secret set ${name} failed: ${r.stderr || r.stdout}`);
    console.log(`  ✓ secret ${name} set`);
  }

  const varResult = ghSetVariable(input.appRepo, "LD_APP_PROJECT_KEY", input.appProjectKey);
  if (!varResult.ok) throw new InitError(`gh variable set LD_APP_PROJECT_KEY failed: ${varResult.stderr || varResult.stdout}`);
  console.log(`  ✓ variable LD_APP_PROJECT_KEY=${input.appProjectKey} set`);
  if (input.provider === "bedrock") {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (region) {
      const r = ghSetVariable(input.appRepo, "AWS_REGION", region);
      console.log(r.ok ? `  ✓ variable AWS_REGION=${region} set` : `  ⚠ could not set AWS_REGION variable: ${r.stderr}`);
    } else {
      console.log("  ⚠ AWS_REGION not set locally — set the AWS_REGION repo variable by hand (the rendered workflow reads it)");
    }
  }

  let toolRepo = input.toolRepoArg ? parseOwnerRepo(`https://github.com/${input.toolRepoArg}`) : detectToolRepo();
  if (!toolRepo) {
    const answer = await ask("GitHub owner/name hosting THIS tooling repo (for the workflow's `uses:` line)");
    toolRepo = parseOwnerRepo(`https://github.com/${answer}`);
    if (!toolRepo) throw new InitError("Could not determine the tooling repo owner — pass --tool-repo owner/name");
  }

  const files = renderAppRepoFiles(input.provider, toolRepo.owner, input.appProjectKey);
  if (input.noPr) {
    for (const f of files) {
      const local = join(RENDER_DIR, f.path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, f.content);
    }
    console.log(`  ✓ rendered workflows written to ${RENDER_DIR}/ — copy them into ${input.appRepo} yourself (--no-pr)`);
    return;
  }
  const url = openSetupPr(input.appRepo, files);
  console.log(`  ✓ setup PR ready: ${url}`);
}

// --- local front ends (Claude Code / Codex skill, Cursor automation) ------------

function installClaudeSkill(appRepoPath: string): void {
  const target = join(appRepoPath, ".claude", "skills", "autofactory");
  cpSync("bootstrap/claude-code/skills/autofactory", target, { recursive: true });
  console.log(`  ✓ skill installed at ${target}`);
  console.log(`  → add to your shell profile:  export AUTOFACTORY_HOME="${process.cwd()}"`);
  console.log("  → then run /autofactory in a Claude Code session in that repo (see INSTALL-CLAUDE-CODE.md for the optional pre-push gate)");
}

function installCodexSkill(appRepoPath: string): void {
  const target = join(appRepoPath, ".agents", "skills", "autofactory");
  cpSync("bootstrap/codex/skills/autofactory", target, { recursive: true });
  console.log(`  ✓ skill installed at ${target}`);
  console.log(`  → add to your shell profile:  export AUTOFACTORY_HOME="${process.cwd()}"`);
  console.log("  → then run $autofactory in a Codex session in that repo (see INSTALL-CODEX.md for the optional pre-push gate)");
}

function installCursorAutomation(appRepoPath: string, ldApiKey: string): void {
  const target = join(appRepoPath, ".cursor");
  cpSync("bootstrap/cursor-automation/dot-cursor", target, { recursive: true });
  const mcpPath = join(target, "mcp.json");
  writeFileSync(mcpPath, renderMcpJson(readFileSync(mcpPath, "utf8"), ldApiKey));
  console.log(`  ✓ Cursor automation installed at ${target} (mcp.json rendered with your LD API key)`);
  console.log(`  ⚠ ${mcpPath} now contains a real API key — add it to the app repo's .gitignore rather than committing it`);
}

// --- main ----------------------------------------------------------------------

export async function init(args: string[]): Promise<void> {
  interactive = !args.includes("--yes") && stdin.isTTY === true;
  loadDotEnv(); // existing .env values become the defaults — re-running resumes

  console.log("AutoFactory guided setup (bridge init)\n");
  console.log("Step 1/5 — LaunchDarkly connection");

  const baseUrl = (argValue(args, "base-url") ?? process.env.LD_BASE_URL ?? "https://app.launchdarkly.com").replace(/\/+$/, "");
  let apiKey = process.env.LD_API_KEY;
  if (!apiKey) {
    apiKey = await askSecret("LaunchDarkly API access token (api-…, write access; created under Account settings → Authorization)");
  }
  if (!apiKey) throw new InitError("An LD API token is required (set LD_API_KEY or answer the prompt)");

  const probe = new LdClient({ apiKey, baseUrl, projectKey: "-" });
  await probe.request({ path: "/api/v2/projects?limit=1" }).catch((e) => {
    throw new InitError(`Could not authenticate against ${baseUrl}: ${e instanceof Error ? e.message : e}`);
  });
  console.log(`  ✓ token valid @ ${baseUrl}`);

  console.log("\nStep 2/5 — projects (created if missing)");
  const factoryKey = argValue(args, "factory-project") ?? (await ask("Factory (control-plane) project key", process.env.LD_PROJECT_KEY || "auto-factory"));
  if (!(await ensureProject(probe, factoryKey, "factory"))) throw new InitError("A factory project is required");

  const appKey = argValue(args, "app-project") ?? (await ask("App (data-plane) project key — where agents create flags", process.env.LD_APP_PROJECT_KEY || "autofactory-demo"));
  if (!(await ensureProject(probe, appKey, "app"))) throw new InitError("An app project is required");

  // The SDK key is FETCHED from the factory project, never pasted — this kills
  // the wrong-project's-key failure mode entirely.
  const envs = await listEnvironments(probe, factoryKey);
  const firstEnv = envs[0];
  if (!firstEnv) throw new InitError(`Factory project '${factoryKey}' has no environments`);
  const wantEnv = argValue(args, "ld-env");
  let environment = envs.find((e) => e.key === (wantEnv ?? "production")) ?? firstEnv;
  if (!wantEnv && envs.length > 1 && interactive) {
    const answer = await ask(`Factory environment to run against (${envs.map((e) => e.key).join(", ")})`, environment.key);
    environment = envs.find((e) => e.key === answer) ?? environment;
  }
  const sdkKey = environment.apiKey;
  if (!sdkKey) throw new InitError(`Could not read the server SDK key for '${factoryKey}/${environment.key}' — does the token have Reader+ access to keys?`);
  console.log(`  ✓ server SDK key fetched from '${factoryKey}/${environment.key}'`);

  console.log("\nStep 3/5 — execution provider");
  const providerArg = (argValue(args, "provider") ?? process.env.AUTOFACTORY_PROVIDER ?? "").toLowerCase();
  let provider: Provider;
  if (providerArg === "anthropic" || providerArg === "bedrock" || providerArg === "cursor") {
    provider = providerArg;
  } else {
    const answer = (await ask("Provider — [a]nthropic direct (default), [b]edrock, or [c]ursor", "a")).toLowerCase();
    provider = answer.startsWith("c") ? "cursor" : answer.startsWith("b") ? "bedrock" : "anthropic";
  }
  console.log(`  provider: ${provider}`);

  let providerKey: string | undefined;
  if (provider === "anthropic") {
    providerKey = process.env.ANTHROPIC_API_KEY || (await askSecret("Anthropic API key (agents bill to this key)"));
    if (!providerKey) throw new InitError("ANTHROPIC_API_KEY is required on the anthropic provider");
  } else if (provider === "cursor") {
    providerKey = process.env.CURSOR_API_KEY || (await askSecret("Cursor API key"));
    if (!providerKey) throw new InitError("CURSOR_API_KEY is required on the cursor provider");
  } else {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const creds = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!region || !creds) {
      console.log("  ⚠ Bedrock uses the standard AWS credential chain — AWS_REGION and credentials aren't fully set locally; local runs will fail until they are");
    }
    console.log("  → remember to serve 'bedrock' from the auto-factory-ai-provider flag (bootstrap provisions it serving 'anthropic')");
  }

  console.log("\nStep 4/5 — write .env + provision the factory project");
  const envBase = existsSync(".env") ? readFileSync(".env", "utf8") : existsSync(".env.example") ? readFileSync(".env.example", "utf8") : "";
  const updates: Record<string, string | undefined> = {
    LD_SDK_KEY: sdkKey,
    LD_API_KEY: apiKey,
    LD_BASE_URL: baseUrl,
    LD_PROJECT_KEY: factoryKey,
    LD_APP_PROJECT_KEY: appKey,
    ...(provider === "anthropic" ? { ANTHROPIC_API_KEY: providerKey } : {}),
    ...(provider === "cursor" ? { CURSOR_API_KEY: providerKey } : {}),
  };
  writeFileSync(".env", upsertEnv(envBase, updates));
  chmodSync(".env", 0o600);
  console.log("  ✓ .env written (existing unrelated entries preserved)");

  // Provision reads the connection from process.env — align it with what we
  // just wrote (loadDotEnv never overwrites pre-existing values).
  Object.assign(process.env, { LD_SDK_KEY: sdkKey, LD_API_KEY: apiKey, LD_BASE_URL: baseUrl, LD_PROJECT_KEY: factoryKey, LD_APP_PROJECT_KEY: appKey });

  const ld = new LdClient({ apiKey, baseUrl, projectKey: factoryKey });
  const r = await provision(ld, {
    aiConfigsDir: "config/agentcontrol/ai-configs",
    graphsDir: "config/agentcontrol/graphs",
    flagsDir: "config/agentcontrol/flags",
    toolsDir: "config/agentcontrol/tools",
    // Shared APP-project metrics (sentry-errors-* guardrails) land in the app project.
    appLd: new LdClient({ apiKey, baseUrl, projectKey: appKey }),
  });
  console.log(
    `  ✓ provisioned: ${r.configsCreated.length} config(s), ${r.graphsCreated.length} graph(s), ${r.flagsCreated.length} flag(s), ${r.toolsCreated.length} tool(s), ${r.metricsCreated.length} app metric(s) created` +
      ` (${r.configsExisting.length + r.graphsExisting.length + r.flagsExisting.length + r.toolsExisting.length + r.metricsExisting.length} already existed)`,
  );
  if (r.failures.length) {
    for (const f of r.failures) console.log(`  ✗ ${f.resource} [${f.status}]: ${JSON.stringify(f.message)}`);
    throw new InitError(`${r.failures.length} provisioning failure(s) — fix and re-run init (it resumes)`);
  }

  console.log("\nStep 5/5 — front end");
  let frontEnd = argValue(args, "front-end");
  if (!frontEnd) {
    const answer = (await ask("Front end — [g]itHub Action (default), [c]laude Code skill, code[x] skill, c[u]rsor automation, or [n]one", "g")).toLowerCase();
    frontEnd = answer.startsWith("x")
      ? "codex"
      : answer.startsWith("c")
        ? "claude-code"
        : answer.startsWith("u")
          ? "cursor-automation"
          : answer.startsWith("n")
            ? "none"
            : "github-action";
  }

  if (frontEnd === "github-action") {
    const appRepo = argValue(args, "app-repo") ?? process.env.AUTOFACTORY_APP_REPO ?? (await ask("App repo on GitHub (owner/name)"));
    if (!appRepo || !appRepo.includes("/")) throw new InitError("An app repo is required for the GitHub Action front end (--app-repo owner/name)");
    await setupGithubFrontEnd({
      appRepo,
      provider,
      sdkKey,
      apiKey,
      appProjectKey: appKey,
      providerKey,
      noPr: args.includes("--no-pr"),
      toolRepoArg: argValue(args, "tool-repo"),
    });
    writeFileSync(".env", upsertEnv(readFileSync(".env", "utf8"), { AUTOFACTORY_APP_REPO: appRepo }));
    console.log("\nDone. Merge the setup PR in the app repo, then open any PR there — the chain runs automatically.");
  } else if (frontEnd === "claude-code") {
    const path = argValue(args, "app-repo-path") ?? (await ask("Local path to your app repo checkout"));
    if (!path || !existsSync(resolve(path))) throw new InitError("A valid local app repo path is required (--app-repo-path)");
    installClaudeSkill(resolve(path));
    console.log("\nDone.");
  } else if (frontEnd === "codex") {
    const path = argValue(args, "app-repo-path") ?? (await ask("Local path to your app repo checkout"));
    if (!path || !existsSync(resolve(path))) throw new InitError("A valid local app repo path is required (--app-repo-path)");
    installCodexSkill(resolve(path));
    console.log("\nDone.");
  } else if (frontEnd === "cursor-automation") {
    const path = argValue(args, "app-repo-path") ?? (await ask("Local path to your app repo checkout"));
    if (!path || !existsSync(resolve(path))) throw new InitError("A valid local app repo path is required (--app-repo-path)");
    installCursorAutomation(resolve(path), apiKey);
    console.log("\nDone.");
  } else {
    console.log("  · skipped — wire a front end later (README: Phase 1 front ends)");
    console.log("\nDone.");
  }

  console.log("Validate any time with: npm run doctor" + (frontEnd === "github-action" ? "" : "  (add -- --app-repo owner/name once a GitHub app repo exists)"));
}
