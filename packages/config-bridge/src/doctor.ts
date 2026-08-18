/**
 * `bridge doctor` — standalone setup validation, runnable any time (not just
 * inside bootstrap). Checks four surfaces and never stops early: local env,
 * the factory LD project (including whether LD_SDK_KEY actually belongs to
 * it — the #1 support issue), the app LD project, and (when an app repo is
 * known) the GitHub side via `gh`: secrets, variables, and workflow files.
 *
 * Every failing check carries the fix. Exit is handled by the CLI: any `fail`
 * → exit 1; warns are advisory.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeConfigHash,
  extractConfigStamp,
  LdClient,
  validateProjectKey,
  type LdConnection,
} from "@auto-factory/shared";
import { ghAuthenticated, ghAvailable, ghGetFile, ghJson, ghListSecrets, ghListVariables } from "./gh.js";
import { provision } from "./provision.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  status: CheckStatus;
  label: string;
  /** How to fix it — printed under the check for warn/fail. */
  fix?: string;
}

export interface DoctorSection {
  title: string;
  checks: Check[];
}

export interface DoctorReport {
  sections: DoctorSection[];
  failures: number;
  warnings: number;
}

export interface DoctorOptions {
  /** GitHub app repo (owner/name) to check; default AUTOFACTORY_APP_REPO. */
  appRepo?: string;
  /** Skip the GitHub section entirely. */
  skipGithub?: boolean;
  aiConfigsDir?: string;
  graphsDir?: string;
  flagsDir?: string;
  toolsDir?: string;
}

const ok = (label: string): Check => ({ status: "ok", label });
const warn = (label: string, fix?: string): Check => ({ status: "warn", label, fix });
const fail = (label: string, fix?: string): Check => ({ status: "fail", label, fix });
const skip = (label: string): Check => ({ status: "skip", label });

/** Which environment of `envs` the SDK key belongs to, if any. */
export function sdkKeyEnvironment(
  sdkKey: string,
  envs: Array<{ key: string; apiKey?: string }>,
): string | undefined {
  return envs.find((e) => e.apiKey && e.apiKey === sdkKey)?.key;
}

function localChecks(): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 20
      ? ok(`Node ${process.versions.node}`)
      : fail(`Node >= 20 required (have ${process.versions.node})`, "Install Node 20+ (see .nvmrc)"),
  );

  checks.push(
    existsSync(".env")
      ? ok(".env present")
      : warn(".env not found in the current directory", "Run `npm run init` from the tooling repo root, or cp .env.example .env"),
  );

  for (const [name, why] of [
    ["LD_API_KEY", "REST writes (provisioning, flag/metric creation)"],
    ["LD_SDK_KEY", "runtime flag/graph/config reads (server + AI SDKs)"],
    ["LD_PROJECT_KEY", "the factory/control-plane project"],
  ] as const) {
    checks.push(
      process.env[name] ? ok(`${name} present`) : fail(`${name} not set (${why})`, "Run `npm run init`, or fill it in .env (see .env.example)"),
    );
  }

  for (const name of ["LD_PROJECT_KEY", "LD_APP_PROJECT_KEY"]) {
    const v = process.env[name];
    if (!v) continue;
    try {
      validateProjectKey(name, v);
    } catch (e) {
      checks.push(fail(e instanceof Error ? e.message : String(e)));
    }
  }
  if (!process.env.LD_APP_PROJECT_KEY) {
    checks.push(
      warn("LD_APP_PROJECT_KEY not set — flag creation in the app project will fail", "Set it in .env (or re-run `npm run init`)"),
    );
  }

  // Execution provider credentials: at least one backend must be runnable.
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  const cursor = !!process.env.CURSOR_API_KEY;
  const awsRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  const awsCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK);
  const bedrock = awsRegion && awsCreds;
  if (anthropic) checks.push(ok("ANTHROPIC_API_KEY present (anthropic provider ready)"));
  if (bedrock) checks.push(ok("AWS region + credentials present (bedrock provider ready)"));
  else if (awsRegion || awsCreds) {
    checks.push(warn(`AWS ${awsRegion ? "credentials" : "region"} missing — bedrock provider incomplete`, "Bedrock needs AWS_REGION AND credentials (keys, profile, ambient role, or AWS_BEARER_TOKEN_BEDROCK)"));
  }
  if (cursor) checks.push(ok("CURSOR_API_KEY present (cursor provider ready)"));
  if (!anthropic && !bedrock && !cursor) {
    checks.push(
      fail("No execution-provider credentials found (Anthropic, Bedrock/AWS, or Cursor)", "Set ANTHROPIC_API_KEY in .env (default provider), or AWS/Cursor credentials for those providers"),
    );
  }

  // ADR 0008 footgun: these env vars SILENTLY override the approval flags.
  for (const name of ["APPROVAL_MODE", "RISK_THRESHOLD", "APPROVAL_GATES"]) {
    if (process.env[name]) {
      checks.push(
        warn(`${name} is set in the environment — it OVERRIDES the auto-factory approval flags`, "Unset it unless this is a deliberate local experiment (ADR 0008; it once bypassed mode=always in a live run)"),
      );
    }
  }
  return checks;
}

async function factoryChecks(conn: LdConnection, opts: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const ld = new LdClient(conn);

  try {
    await ld.request({ path: `/api/v2/projects/${conn.projectKey}` });
    checks.push(ok(`Factory project '${conn.projectKey}' reachable + authorized @ ${conn.baseUrl}`));
  } catch (e) {
    checks.push(
      fail(`Factory project check failed: ${e instanceof Error ? e.message : e}`, "Check LD_API_KEY (write access to the factory project) and LD_PROJECT_KEY"),
    );
    return checks; // everything below needs the project
  }

  // Does LD_SDK_KEY actually belong to this project? The single most common
  // setup failure ("agent graph disabled or unavailable") is an SDK key from
  // a different project.
  if (process.env.LD_SDK_KEY) {
    try {
      const envs = await ld.request<{ items?: Array<{ key: string; apiKey?: string }> }>({
        path: `/api/v2/projects/${conn.projectKey}/environments?limit=50`,
      });
      const envKey = sdkKeyEnvironment(process.env.LD_SDK_KEY, envs.data.items ?? []);
      checks.push(
        envKey
          ? ok(`LD_SDK_KEY belongs to factory environment '${envKey}'`)
          : fail("LD_SDK_KEY does not match any environment of the factory project", "It's probably another project's key. Copy the server SDK key from the FACTORY project's environment (or re-run `npm run init`)"),
      );
    } catch (e) {
      checks.push(warn(`Could not verify LD_SDK_KEY against the factory environments: ${e instanceof Error ? e.message : e}`));
    }
  }

  // Provisioned resources: a provision dry run reports exactly what's missing.
  // Includes the shared APP-project metrics (sentry-errors-*) when an app
  // project is configured, mirroring the real provision path.
  try {
    const appKey = process.env.LD_APP_PROJECT_KEY;
    const r = await provision(ld, {
      aiConfigsDir: opts.aiConfigsDir ?? "config/agentcontrol/ai-configs",
      graphsDir: opts.graphsDir ?? "config/agentcontrol/graphs",
      flagsDir: opts.flagsDir ?? "config/agentcontrol/flags",
      toolsDir: opts.toolsDir ?? "config/agentcontrol/tools",
      ...(appKey ? { appLd: new LdClient({ ...conn, projectKey: appKey }) } : {}),
      dryRun: true,
    });
    const missing = [
      r.configsCreated.length && `${r.configsCreated.length} AI config(s): ${r.configsCreated.join(", ")}`,
      r.graphsCreated.length && `${r.graphsCreated.length} graph(s): ${r.graphsCreated.join(", ")}`,
      r.flagsCreated.length && `${r.flagsCreated.length} operational flag(s): ${r.flagsCreated.join(", ")}`,
      r.toolsCreated.length && `${r.toolsCreated.length} tool definition(s)`,
      r.metricsCreated.length && `${r.metricsCreated.length} app-project metric(s): ${r.metricsCreated.join(", ")}`,
    ].filter(Boolean);
    checks.push(
      missing.length === 0
        ? ok("All committed AI configs, graphs, flags, and tools exist in the factory project")
        : fail(`Missing from the factory project — ${missing.join("; ")}`, "Run `npm run bootstrap` (fresh install) or `npm run bridge -- upgrade` (existing install)"),
    );
  } catch (e) {
    checks.push(warn(`Could not compare provisioned resources: ${e instanceof Error ? e.message : e}`));
  }

  // Config-version drift (same comparison the GHA action does at run start).
  const graphsDir = opts.graphsDir ?? "config/agentcontrol/graphs";
  const hash = computeConfigHash({
    aiConfigsDir: opts.aiConfigsDir ?? "config/agentcontrol/ai-configs",
    graphsDir,
    flagsDir: opts.flagsDir ?? "config/agentcontrol/flags",
    toolsDir: opts.toolsDir ?? "config/agentcontrol/tools",
  });
  if (hash && existsSync(graphsDir)) {
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(graphsDir).filter((f) => f.endsWith(".json"))) {
      const key = (JSON.parse(readFileSync(join(graphsDir, f), "utf8")) as { key?: string }).key;
      if (!key) continue;
      try {
        const g = await ld.getAgentGraph<{ description?: string }>(key);
        if (g.status !== 200) continue; // absence already reported above
        const stamp = extractConfigStamp(g.data.description);
        if (stamp && stamp !== hash) {
          checks.push(
            warn(`Graph '${key}' was provisioned from a different repo version ([cfg:${stamp}] vs local ${hash})`, "Run `npm run bridge -- upgrade` (add --dry-run to preview)"),
          );
        } else if (stamp === hash) {
          checks.push(ok(`Graph '${key}' config version matches this checkout`));
        }
      } catch {
        /* connectivity already reported */
      }
    }
  }
  return checks;
}

async function appProjectChecks(conn: LdConnection): Promise<Check[]> {
  const checks: Check[] = [];
  const appKey = process.env.LD_APP_PROJECT_KEY;
  if (!appKey) return [skip("LD_APP_PROJECT_KEY not set — skipped (see local checks)")];
  if (appKey === conn.projectKey) {
    checks.push(warn("App project = factory project — flags will be created next to the control plane", "Use a separate app project for blast-radius isolation"));
  }
  const ld = new LdClient({ ...conn, projectKey: appKey });
  try {
    await ld.request({ path: `/api/v2/projects/${appKey}` });
    checks.push(ok(`App project '${appKey}' reachable + authorized`));
  } catch (e) {
    checks.push(fail(`App project check failed: ${e instanceof Error ? e.message : e}`, "Check LD_APP_PROJECT_KEY and that LD_API_KEY has write access to it (or re-run `npm run init`)"));
  }
  return checks;
}

function githubChecks(appRepo: string): Check[] {
  const checks: Check[] = [];
  if (!ghAvailable()) {
    return [fail("GitHub CLI (gh) not found on PATH", "Install it (https://cli.github.com) and run `gh auth login`")];
  }
  if (!ghAuthenticated()) {
    return [fail("gh is not authenticated", "Run `gh auth login`")];
  }
  checks.push(ok("gh available + authenticated"));

  if (!ghJson([`repos/${appRepo}`])) {
    checks.push(fail(`App repo '${appRepo}' not reachable via gh`, "Check the owner/name and your gh account's access"));
    return checks;
  }
  checks.push(ok(`App repo '${appRepo}' reachable`));

  const secrets = ghListSecrets(appRepo);
  if (!secrets) {
    checks.push(warn("Could not list the app repo's Actions secrets (needs repo admin)", "Verify LD_SDK_KEY / LD_API_KEY / provider-key secrets by hand"));
  } else {
    for (const name of ["LD_SDK_KEY", "LD_API_KEY"]) {
      checks.push(
        secrets.includes(name)
          ? ok(`Secret ${name} set`)
          : fail(`Secret ${name} missing in ${appRepo}`, `gh secret set ${name} --repo ${appRepo} (or re-run \`npm run init\`)`),
      );
    }
    const providerSecret = ["ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CURSOR_API_KEY"].filter((n) => secrets.includes(n));
    checks.push(
      providerSecret.length
        ? ok(`Provider secret(s) set: ${providerSecret.join(", ")}`)
        : warn("No provider secret found (ANTHROPIC_API_KEY / AWS_* / CURSOR_API_KEY)", "Required unless AWS credentials come from an OIDC step in the workflow"),
    );
  }

  const variables = ghListVariables(appRepo);
  const appProjectVar = variables?.get("LD_APP_PROJECT_KEY");
  if (!variables) {
    checks.push(warn("Could not list the app repo's Actions variables", "Verify the LD_APP_PROJECT_KEY variable by hand"));
  } else if (!appProjectVar) {
    checks.push(fail(`Variable LD_APP_PROJECT_KEY missing in ${appRepo}`, `gh variable set LD_APP_PROJECT_KEY --repo ${appRepo} --body <key>`));
  } else if (process.env.LD_APP_PROJECT_KEY && appProjectVar !== process.env.LD_APP_PROJECT_KEY) {
    checks.push(warn(`Variable LD_APP_PROJECT_KEY='${appProjectVar}' differs from local .env ('${process.env.LD_APP_PROJECT_KEY}')`, "Align them — the workflow uses the repo variable"));
  } else {
    checks.push(ok(`Variable LD_APP_PROJECT_KEY='${appProjectVar}' set`));
  }

  // The workflow may be named anything — scan .github/workflows for one that
  // references this tool (the `uses:` action or the checked-out bundle).
  const listing = ghJson<Array<{ name?: string; path?: string }>>([`repos/${appRepo}/contents/.github/workflows`]);
  const ymls = (Array.isArray(listing) ? listing : []).filter((f) => f.path && /\.ya?ml$/.test(f.path));
  let found: { path: string; content: string } | undefined;
  for (const f of ymls.slice(0, 15)) {
    const file = ghGetFile(appRepo, f.path!);
    if (file && /launchdarkly-auto-factory|action\.bundle\.js/.test(file.content)) {
      found = { path: f.path!, content: file.content };
      break;
    }
  }
  if (!found) {
    checks.push(fail(`No AutoFactory workflow found in ${appRepo}/.github/workflows/`, "Re-run `npm run init` (it opens a setup PR), or copy bootstrap/github-action-template/auto-factory.yml"));
  } else if (found.content.includes("<owner>")) {
    checks.push(fail(`${found.path} still contains the <owner> placeholder`, "Replace <owner> with the org/user hosting this tooling repo"));
  } else {
    checks.push(ok(`AutoFactory workflow present (${found.path})`));
  }

  const codeRefs = ghGetFile(appRepo, ".github/workflows/find-code-refs.yml");
  if (codeRefs?.content.includes("<your-app-project-key>")) {
    checks.push(warn("find-code-refs.yml still contains the <your-app-project-key> placeholder", "Replace it with your app project key"));
  } else if (codeRefs) {
    checks.push(ok("find-code-refs.yml workflow present"));
  }
  return checks;
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  sections.push({ title: "Local environment", checks: localChecks() });

  // LD checks need a connection; without one the local section already failed.
  let conn: LdConnection | undefined;
  if (process.env.LD_API_KEY && process.env.LD_PROJECT_KEY) {
    try {
      const { targetConnection } = await import("@auto-factory/shared");
      conn = targetConnection();
    } catch {
      /* reported in local checks */
    }
  }
  if (conn) {
    sections.push({ title: "LaunchDarkly — factory project", checks: await factoryChecks(conn, opts) });
    sections.push({ title: "LaunchDarkly — app project", checks: await appProjectChecks(conn) });
  } else {
    sections.push({
      title: "LaunchDarkly",
      checks: [skip("Skipped — no usable LD connection (fix the local checks first)")],
    });
  }

  const appRepo = opts.appRepo ?? process.env.AUTOFACTORY_APP_REPO;
  if (opts.skipGithub) {
    sections.push({ title: "GitHub app repo", checks: [skip("Skipped (--skip-github)")] });
  } else if (!appRepo) {
    sections.push({
      title: "GitHub app repo",
      checks: [skip("Skipped — no app repo configured (pass --app-repo owner/name or set AUTOFACTORY_APP_REPO in .env). Not needed for the Claude Code / CLI front end.")],
    });
  } else {
    sections.push({ title: `GitHub app repo (${appRepo})`, checks: githubChecks(appRepo) });
  }

  const all = sections.flatMap((s) => s.checks);
  return {
    sections,
    failures: all.filter((c) => c.status === "fail").length,
    warnings: all.filter((c) => c.status === "warn").length,
  };
}

const GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "·" };

export function printDoctorReport(report: DoctorReport): void {
  for (const section of report.sections) {
    console.log(`\n${section.title}`);
    for (const c of section.checks) {
      console.log(`  ${GLYPH[c.status]} ${c.label}`);
      if (c.fix && c.status !== "ok" && c.status !== "skip") console.log(`      ↳ ${c.fix}`);
    }
  }
  console.log(
    `\n${report.failures ? `✗ ${report.failures} problem(s)` : "✓ No problems"}${report.warnings ? `, ⚠ ${report.warnings} warning(s)` : ""}.`,
  );
}
