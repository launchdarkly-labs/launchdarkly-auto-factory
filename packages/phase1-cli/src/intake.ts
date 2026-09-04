/**
 * `autofactory intake` — the ISSUE entry point (ADR 0019).
 *
 * Runs the graph's intake node (the issue coder) against a checkout of the app
 * repo: fresh branch off the base, the coder implements the GitHub issue with
 * the sandbox tools, `commit_and_push` pushes the branch (WITHOUT `[skip ci]`,
 * so the PR can trigger workflows), and this command opens the pull request.
 * The regular chain — planner, flag, metrics, tests, review — then runs on that
 * PR exactly as it does for a human-authored one. Two runs, joined by the
 * issue: the PR body carries an intent marker the Action reads into TICKET_ID
 * and onto its run context, so both runs' agent telemetry share `ticket`.
 *
 * Deliberately thin: no approval gates, no judges, no flag/metric powers for the
 * coder. Everything release-related is the downstream chain's job.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  type AgentRunner,
  AnthropicAgentRunner,
  BedrockAgentRunner,
  OpenAiAgentRunner,
  addLabels,
  buildIntentMarker,
  closeLdSdk,
  createPullRequest,
  fetchIssue,
  findOpenPullRequest,
  getLdSdk,
  initFactorySentry,
  intakeNodeKeys,
  isGitRepo,
  issueBranchName,
  issueIntentId,
  loadDotEnv,
  loadRelatedRepos,
  pipelineContext,
  pipelineRunId,
  readRepoState,
  resolveAiProvider,
  resolveGitHubToken,
  walkGraph,
  withProvider,
  withRunAttributes,
} from "@auto-factory/shared";
import { EXIT, type IntakeOptions } from "./args.js";
import { UsageError, describeStall, nodeTitle } from "./run.js";

const MAX_PR_BODY_SUMMARY = 6000;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(root: string, args: string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

export async function runIntake(opts: IntakeOptions): Promise<number> {
  try {
    return await intake(opts);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`autofactory intake: ${e.message}`);
      return EXIT.USAGE;
    }
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return EXIT.FAILED;
  } finally {
    await closeLdSdk();
  }
}

async function intake(opts: IntakeOptions): Promise<number> {
  loadDotEnv();
  if (!process.env.LD_SDK_KEY) throw new UsageError("LD_SDK_KEY is not set (factory project server SDK key)");
  if (!process.env.LD_PROJECT_KEY) throw new UsageError("LD_PROJECT_KEY is not set (factory project key)");

  await initFactorySentry({ serviceName: "auto-factory-phase1-cli" });

  const root = resolve(opts.root);
  if (!(await isGitRepo(root))) throw new UsageError(`'${root}' is not a git repository`);
  const state = await readRepoState(root, opts.base);
  const repo = opts.repo ?? state.repoSlug;
  if (!repo) throw new UsageError("could not determine the GitHub repository — pass --repo owner/name");
  if (!opts.dryRun && state.dirtyFiles > 0) {
    throw new UsageError(
      `the working tree at '${root}' has ${state.dirtyFiles} uncommitted change(s); intake commits with \`git add -A\` — stash or commit them first (or use --dry-run)`,
    );
  }

  const token = resolveGitHubToken();
  if (!token && !opts.dryRun && !opts.noPr) {
    throw new UsageError("no GitHub token: set AUTOFACTORY_INTAKE_TOKEN or GITHUB_TOKEN, or log in with `gh auth login` (needed to open the PR)");
  }

  const issue = await fetchIssue(repo, opts.issue, token);
  if (issue.isPullRequest) throw new UsageError(`#${opts.issue} on ${repo} is a pull request, not an issue`);
  if (issue.state !== "open") console.log(`⚠ issue #${issue.number} is ${issue.state} — implementing it anyway`);

  const branch = issueBranchName(issue.number);
  const intent = issueIntentId(issue.number);

  // Branch setup: fork the working branch from the base (or resume the branch a
  // previous intake run pushed). Dry runs leave the checkout alone.
  let baseRef = opts.base;
  if (!opts.dryRun) {
    gitOk(root, ["fetch", "origin", opts.base]);
    gitOk(root, ["fetch", "origin", branch]);
    baseRef = gitOk(root, ["rev-parse", "--verify", "--quiet", `origin/${opts.base}`]) ? `origin/${opts.base}` : opts.base;
    if (gitOk(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`])) {
      console.log(`Resuming existing branch ${branch} (origin/${branch}).`);
      git(root, ["checkout", "-B", branch, `origin/${branch}`]);
    } else {
      git(root, ["checkout", "-B", branch, baseRef]);
    }
  }

  const { ldClient, aiClient } = await getLdSdk();
  process.env.AUTOFACTORY_SURFACE ||= "cli";
  let ldContext = pipelineContext();
  const runId = pipelineRunId();
  console.log(`Surface: ${process.env.AUTOFACTORY_SURFACE}; run ${runId}`);

  // Same runner ceiling as `run`: the coder edits this checkout, so it needs a
  // sandbox-confined runner (Anthropic, Bedrock, or OpenAI).
  let provider = await resolveAiProvider(ldClient, ldContext);
  if (provider !== "anthropic" && provider !== "bedrock" && provider !== "openai") {
    console.log(`Provider flag selects '${provider}', but intake edits a local checkout and needs a sandboxed runner. Using Anthropic.`);
    provider = "anthropic";
  }
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new UsageError("ANTHROPIC_API_KEY is not set (required on the Anthropic runner)");
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
    throw new UsageError("OPENAI_API_KEY (or CODEX_API_KEY) is not set (required on the OpenAI runner)");
  }
  ldContext = withProvider(ldContext, provider);
  // Join keys on the run context (the same attributes the PR-triggered run
  // stamps from the intent marker): ticket, repo, and which entry this is.
  ldContext = withRunAttributes(ldContext, { entry: "issue", ticket: intent, repo });

  const appProjectKey = process.env.LD_APP_PROJECT_KEY || process.env.LD_PROJECT_KEY || "";
  const context: Record<string, unknown> = {
    REPO: repo,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_URL: issue.htmlUrl,
    PR_TITLE: issue.title,
    PR_BODY: issue.body,
    PR_BRANCH: branch,
    BASE_REF: opts.base,
  };
  const variables: Record<string, unknown> = {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body,
    ISSUE_URL: issue.htmlUrl,
    REPO: repo,
    PR_NUMBER: "",
    PR_TITLE: issue.title,
    PR_BODY: issue.body,
    PR_BRANCH: branch,
    BASE_REF: opts.base,
    TICKET_ID: intent,
    LAUNCHDARKLY_PROJECT: appProjectKey,
  };

  const graphDef = await aiClient.agentGraph(opts.graphKey, ldContext, variables);
  if (!graphDef.enabled) {
    throw new Error(
      `Agent graph '${opts.graphKey}' is disabled or unavailable in LaunchDarkly (check LD_SDK_KEY is the FACTORY project's key, and --graph).`,
    );
  }
  if (!graphDef.getNode(opts.node)) {
    throw new UsageError(
      `graph '${opts.graphKey}' has no node '${opts.node}' — the intake entry point isn't provisioned; run \`npm run bridge -- upgrade\` from the tooling repo, or pass --node`,
    );
  }
  if (!intakeNodeKeys(graphDef).has(opts.node)) {
    console.log(`⚠ '${opts.node}' is not marked as an intake node (no outgoing edge with handoff.intake=true); running it as the entry anyway.`);
  }
  const graphTracker = graphDef.createTracker();

  console.log(
    `Intake: ${repo}#${issue.number} "${issue.title}" → branch ${branch} (from ${baseRef}) → node '${opts.node}' of graph '${opts.graphKey}' [provider: ${provider}]`,
  );
  console.log(`Code changes: ${opts.dryRun ? "disabled (dry run: no branch, no edits, no push, no PR)" : `enabled (commits are pushed to origin/${branch})`}.`);

  const relatedRepos = loadRelatedRepos(root);
  const reposToken = process.env.AUTOFACTORY_REPOS_TOKEN || token;
  const runnerOpts = {
    sandboxRoot: root,
    codeChangesEnabled: !opts.dryRun,
    gitMode: "push" as const,
    // The push must be allowed to trigger CI: the PR opened on this branch is
    // what hands the work to the regular chain.
    skipCi: false,
    prBranch: branch,
    prBaseRef: baseRef,
    ...(relatedRepos.length > 0 && reposToken ? { relatedRepos, githubToken: reposToken } : {}),
  };
  const runner: AgentRunner =
    provider === "bedrock"
      ? new BedrockAgentRunner({ ...runnerOpts, ...(process.env.AWS_REGION ? { awsRegion: process.env.AWS_REGION } : {}) })
      : provider === "openai"
        ? new OpenAiAgentRunner(runnerOpts)
        : new AnthropicAgentRunner({ ...runnerOpts, ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}) });

  const walk = await walkGraph(
    graphDef,
    runner,
    context,
    graphTracker,
    (event) => {
      if (event.type === "node-start") console.log(`\n▶ ${nodeTitle(event.configKey)}`);
      else if (event.type === "node-complete") {
        console.log(`■ done: ${nodeTitle(event.run.configKey)} [${event.run.status}] tags: ${JSON.stringify(event.run.tags)}`);
      } else if (event.type === "stalled") console.log(`⚠ ${describeStall(event.stall)}`);
    },
    undefined,
    undefined,
    undefined,
    { startAt: opts.node, stopAfter: [opts.node] },
  );

  const run = walk.runs[0];
  const lines: string[] = ["", "──────── AutoFactory intake — summary ────────", `Issue: ${issue.htmlUrl}`, `Intent: ${intent}; run ${runId}`];
  if (!run || run.status !== "completed") {
    lines.push(`⛔ the coder did not complete (${run?.status ?? "did not run"}).`);
    console.log(lines.join("\n"));
    return EXIT.FAILED;
  }

  if (opts.dryRun) {
    lines.push("Dry run: nothing was branched, edited, pushed, or opened.", "", run.output.slice(0, 2000));
    console.log(lines.join("\n"));
    return EXIT.OK;
  }

  // What actually landed on the remote branch — from git, not from the agent's tags.
  gitOk(root, ["fetch", "origin", branch]);
  const pushed = gitOk(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
  const commits = pushed ? Number(git(root, ["rev-list", "--count", `${baseRef}..origin/${branch}`])) || 0 : 0;
  lines.push(`Branch: ${branch} — ${pushed ? `${commits} commit(s) pushed ahead of ${baseRef}` : "NOT pushed"}`);
  if (!pushed || commits === 0) {
    lines.push("⛔ no commits reached origin, so no PR was opened. The coder's report:", "", run.output.slice(0, 2000));
    console.log(lines.join("\n"));
    return EXIT.FAILED;
  }

  if (opts.noPr) {
    lines.push("--no-pr: branch pushed; open the PR yourself to hand off to the chain.");
    console.log(lines.join("\n"));
    return EXIT.OK;
  }

  const existing = await findOpenPullRequest(repo, branch, token);
  if (existing) {
    lines.push(`PR: ${existing.htmlUrl} (already open — reused)`);
    console.log(lines.join("\n"));
    return EXIT.OK;
  }

  const marker = buildIntentMarker({
    intent,
    issue: issue.number,
    repo,
    intakeRun: runId,
    graph: opts.graphKey,
    node: opts.node,
    surface: process.env.AUTOFACTORY_SURFACE,
  });
  const summary = run.output.trim().slice(0, MAX_PR_BODY_SUMMARY);
  const body = [
    summary || "_The coder produced no summary._",
    "",
    `Closes #${issue.number}`,
    "",
    "---",
    `_Opened by LaunchDarkly AutoFactory intake (\`${intent}\`). The regular AutoFactory chain runs on this PR._`,
    marker,
  ].join("\n");
  const title = issue.title.length > 120 ? `${issue.title.slice(0, 117)}…` : issue.title;
  const pr = await createPullRequest(repo, { title, body, head: branch, base: opts.base, draft: opts.draft }, token as string);
  if (opts.prLabel) {
    try {
      await addLabels(repo, pr.number, [opts.prLabel], token as string);
    } catch (e) {
      lines.push(`⚠ could not add label '${opts.prLabel}': ${e instanceof Error ? e.message : e}`);
    }
  }
  lines.push(`PR: ${pr.htmlUrl}${opts.draft ? " (draft)" : ""}`, "The regular chain takes it from here.");
  console.log(lines.join("\n"));
  return EXIT.OK;
}
