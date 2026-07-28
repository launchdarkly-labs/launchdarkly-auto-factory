/**
 * Phase 1 orchestration for the headless CLI. This is the terminal analog of
 * the Action's `main()` and the extension's `runChain`: the same shared core
 * (provider resolution, graph resolution, judges, approval gates, deterministic
 * handoff shims), with the CLI's seams:
 *
 *  - Context comes from the working tree (branch vs base + uncommitted edits),
 *    not a PR.
 *  - The runners use gitMode "workingTree": the agents' edits land in the
 *    working tree for the developer to review and commit; nothing is pushed.
 *  - Approval gates halt the process with a distinct exit code
 *    (EXIT.PENDING_APPROVAL) instead of blocking on stdin; the caller — a
 *    human, or Claude Code relaying the question — re-runs with
 *    `--approve <nodeKey>` for every step approved so far.
 *  - Judge evidence is the node-scoped WORKING-TREE diff (agents never commit
 *    here, so commit-scoped evidence would read "no new commits" every step).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentRunner,
  AnthropicAgentRunner,
  type AssembledGraph,
  type JudgeCompletion,
  type JudgeHook,
  KNOWLEDGE_GRAPH_FLAG_KEY,
  LdClient,
  LdResourceWriter,
  type StallInfo,
  appConnection,
  assembleKnowledgeGraph,
  buildHandoffVerifier,
  buildWorkingTreeContext,
  buildWorkingTreeVariables,
  closeLdSdk,
  computeConfigHash,
  createAnthropicJudgeCompletion,
  createJudgeHook,
  createPolicyGate,
  createWorkingTreeEvidence,
  decideApproval,
  extractConfigStamp,
  getLdSdk,
  hasChangeToProcess,
  initFactorySentry,
  interpretWalk,
  isGitRepo,
  loadDotEnv,
  loadRelatedRepos,
  normalizeReleaseIntent,
  pipelineContext,
  readRepoState,
  resolveAiProvider,
  resolveApprovalPolicy,
  targetConnection,
  walkGraph,
  withProvider,
} from "@auto-factory/shared";
import { type CliOptions, EXIT } from "./args.js";
import { type RunOutcome, writeRunRecord } from "./runRecord.js";

function appBaseUrl(): string {
  return (process.env.LD_BASE_URL || "https://app.launchdarkly.com").replace(/\/+$/, "");
}
function flagUrl(project: string, flagKey: string): string {
  return `${appBaseUrl()}/${project}/~/features/${encodeURIComponent(flagKey)}`;
}
function metricUrl(project: string, metricKey: string): string {
  return `${appBaseUrl()}/${project}/metrics/${encodeURIComponent(metricKey)}/details`;
}

/** A writer for real flag/metric creation in the app project, or undefined (dry run). */
function buildWriter(dryRun: boolean): LdResourceWriter | undefined {
  if (dryRun) return undefined;
  if (!process.env.LD_API_KEY) {
    throw new UsageError("LD_API_KEY is not set (required to create flags/metrics; use --dry-run for read-only)");
  }
  // Refuse to create flags in the factory/control-plane project: require an
  // explicit app project so we never pollute the project holding the AI configs.
  if (!process.env.LD_APP_PROJECT_KEY) {
    throw new UsageError(
      "LD_APP_PROJECT_KEY is not set — refusing to create flags in the factory project (use --dry-run for read-only)",
    );
  }
  return new LdResourceWriter(new LdClient(appConnection()));
}


/**
 * Config-drift check (same contract as the Action's): the CLI runs from a
 * checkout of the tooling repo, so hash the committed config/agentcontrol files
 * three levels up and compare against the `[cfg:…]` stamp that
 * provision/upgrade write onto the live graph's description. Best-effort.
 */
async function detectConfigDrift(graphKey: string): Promise<string | undefined> {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const base = join(repoRoot, "config", "agentcontrol");
    const local = computeConfigHash({
      aiConfigsDir: join(base, "ai-configs"),
      graphsDir: join(base, "graphs"),
      flagsDir: join(base, "flags"),
      toolsDir: join(base, "tools"),
    });
    if (!local) return undefined;
    const graph = await new LdClient(targetConnection()).getAgentGraph<{ description?: string }>(graphKey);
    if (graph.status !== 200) return undefined;
    const stamp = extractConfigStamp(graph.data.description);
    if (stamp === local) return undefined;
    const fix = "run `npm run bridge -- upgrade` from the tooling repo to sync your LaunchDarkly configs";
    return stamp
      ? `LaunchDarkly configs were provisioned from a different repo version (project has cfg:${stamp}, this CLI expects cfg:${local}) — ${fix}.`
      : `LaunchDarkly configs pre-date version stamping (no [cfg:…] marker on graph '${graphKey}') — ${fix}; it also stamps the version for this check.`;
  } catch {
    return undefined;
  }
}

/**
 * Friendly titles for the known chain agents, used in progress lines so a
 * human (or Claude Code relaying them) reads steps, not config keys. Unknown
 * keys (renamed agents, custom graphs) fall back to the key itself.
 */
const NODE_TITLES: Record<string, string> = {
  "autofactory-research-planner": "Research & plan",
  "autofactory-flag-implementer": "Flag implementation",
  "autofactory-metrics-author": "Metrics & instrumentation",
  "autofactory-manifest-steward": "Release manifest",
  "autofactory-flag-testing": "Flag tests",
  "autofactory-code-reviewer": "Code review",
};

function nodeTitle(configKey: string): string {
  const t = NODE_TITLES[configKey];
  return t ? `${t} (${configKey})` : configKey;
}

function describeStall(stall: StallInfo): string {
  const edges = stall.unmet
    .map((u) => `edge → ${u.target} requires ${Object.entries(u.requireMissing).map(([k, v]) => `${k}=${v}`).join(", ")} (never produced)`)
    .join("; ");
  return `chain stalled at '${stall.node}'; ${edges}. Downstream agents did not run.`;
}

/** A configuration/usage problem, reported without a stack trace (exit 2). */
export class UsageError extends Error {}

export async function runCli(opts: CliOptions): Promise<number> {
  try {
    return await run(opts);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`autofactory: ${e.message}`);
      return EXIT.USAGE;
    }
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return EXIT.FAILED;
  } finally {
    await closeLdSdk();
  }
}

async function run(opts: CliOptions): Promise<number> {
  // .env is read from the INVOKING directory (where the partner keeps the five
  // secrets), not from --root — the app repo under work needs no secrets.
  loadDotEnv();
  if (!process.env.LD_SDK_KEY) throw new UsageError("LD_SDK_KEY is not set (factory project server SDK key)");
  if (!process.env.LD_PROJECT_KEY) throw new UsageError("LD_PROJECT_KEY is not set (factory project key)");

  await initFactorySentry({ serviceName: "auto-factory-phase1-cli" });

  const root = resolve(opts.root);
  if (!(await isGitRepo(root))) throw new UsageError(`'${root}' is not a git repository`);
  const state = await readRepoState(root, opts.base);
  if (!hasChangeToProcess(state)) {
    throw new UsageError(
      `nothing to process: '${state.branch ?? "(detached)"}' has no commits ahead of ${state.resolvedBase ?? opts.base} and no working-tree changes`,
    );
  }

  const { ldClient, aiClient } = await getLdSdk();
  let ldContext = pipelineContext();

  // The CLI runs on Anthropic ONLY. Vega executes agents server-side, so it
  // can't edit this working tree. Cursor executes locally BUT its local agent
  // carries native shell/git tools alongside our sandbox tools — in a live run
  // (2026-07-20) it committed each step and pushed the branch itself, bypassing
  // commit_and_push (the only place gitMode "workingTree" is enforced), and the
  // SDK offers no tool-restriction API to prevent it. Only the Anthropic runner
  // is structurally confined to the sandbox tools, which is what the CLI's
  // "nothing is committed or pushed" contract requires.
  let provider = await resolveAiProvider(ldClient, ldContext);
  if (provider !== "anthropic") {
    console.log(
      `Provider flag selects '${provider}', but the CLI's working-tree mode requires the sandboxed Anthropic runner ` +
        `(${provider === "cursor" ? "Cursor local agents have native git and would commit/push" : "Vega runs server-side"}). Using Anthropic.`,
    );
    provider = "anthropic";
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new UsageError("ANTHROPIC_API_KEY is not set (the CLI always executes on the Anthropic runner)");
  }
  // Stamp the EFFECTIVE provider (always anthropic here) on the run context so
  // AI config targeting serves only models this runner can execute (rules on
  // `run.provider` — e.g. never a Cursor-catalog model to an Anthropic run).
  ldContext = withProvider(ldContext, provider);

  const context = await buildWorkingTreeContext(root, state);
  const appProjectKey = process.env.LD_APP_PROJECT_KEY || process.env.LD_PROJECT_KEY;
  const variables = buildWorkingTreeVariables(context, appProjectKey as string);

  const graphDef = await aiClient.agentGraph(opts.graphKey, ldContext, variables);
  if (!graphDef.enabled) {
    throw new Error(
      `Agent graph '${opts.graphKey}' is disabled or unavailable in LaunchDarkly. ` +
        `Most common cause: LD_SDK_KEY is not the FACTORY project's server SDK key — it must be for ` +
        `the project holding the AI configs, agent graph, and operational flags (LD_PROJECT_KEY='${process.env.LD_PROJECT_KEY}'), ` +
        `NOT the app project where flags get created. Also check --graph and that the graph is enabled in this environment.`,
    );
  }
  const graphTracker = graphDef.createTracker();

  console.log(
    `Phase 1: ${context.REPO ?? root} @ ${state.branch ?? "(detached)"} vs ${state.resolvedBase ?? opts.base} ` +
      `(${state.aheadOfBase} commit(s) ahead, ${state.dirtyFiles} dirty file(s)) → graph '${opts.graphKey}' [provider: ${provider}]`,
  );

  const configDrift = await detectConfigDrift(opts.graphKey);
  if (configDrift) console.log(`⚠ ${configDrift}`);

  // Knowledge graph (ADR 0010), behind the auto-factory-knowledge-graph flag.
  // Degrades rather than blocks: missing sources become warnings + gaps.
  const kgEnabled = (await ldClient.variation(KNOWLEDGE_GRAPH_FLAG_KEY, ldContext, false)) === true;
  let kg: AssembledGraph | undefined;
  if (kgEnabled) {
    kg = await assembleKnowledgeGraph({
      sandboxRoot: root,
      ...(state.resolvedBase ? { prBaseRef: state.resolvedBase } : {}),
      ...(state.head ? { sha: state.head } : {}),
      ...(process.env.LD_API_KEY && process.env.LD_APP_PROJECT_KEY
        ? {
            o11y: { apiKey: process.env.LD_API_KEY, projectKey: process.env.LD_APP_PROJECT_KEY },
            codeRefs: {
              apiKey: process.env.LD_API_KEY,
              projectKey: process.env.LD_APP_PROJECT_KEY,
              ...(context.REPO ? { repoName: context.REPO.split("/").pop() as string } : {}),
            },
          }
        : {}),
    });
    if (!process.env.LD_API_KEY || !process.env.LD_APP_PROJECT_KEY) {
      kg.warnings.push("LD_API_KEY / LD_APP_PROJECT_KEY unset — traces and code-refs sources skipped.");
    }
    const svcEdges = kg.graph.edges.filter((e) => e.kind === "service_calls").length;
    const wrapEdges = kg.graph.edges.filter((e) => e.kind === "flag_wraps").length;
    console.log(
      `Knowledge graph: ON — ${kg.graph.services.length} services, ${svcEdges} service edges (traces), ` +
        `${wrapEdges} wrap points (code refs), ${kg.changedFiles.length} changed files, ${kg.graph.gaps.length} gaps.`,
    );
    for (const w of kg.warnings) console.log(`⚠ knowledge graph: ${w}`);
  }

  // Cross-repo research (split-repo estates): opt-in via relatedRepos in
  // .autofactory/services.yaml. `||` not `??`: an unset var may be "".
  const relatedRepos = loadRelatedRepos(root);
  const reposToken = process.env.AUTOFACTORY_REPOS_TOKEN || process.env.GITHUB_TOKEN;
  if (relatedRepos.length > 0) {
    console.log(
      `Related repos: ${relatedRepos.length} registered (${relatedRepos.map((r) => r.repo).join(", ")})${reposToken ? "" : " — but no GitHub token; query_related_repos disabled"}.`,
    );
  }

  const writer = buildWriter(opts.dryRun);
  console.log(`Flag/metric creation: ${writer ? `enabled → app project '${writer.projectKey}'` : "disabled (dry run)"}.`);
  console.log(`Code changes: ${opts.dryRun ? "disabled (dry run)" : "enabled (edits land in your working tree; nothing is pushed)"}.`);

  const localOpts = {
    sandboxRoot: root,
    codeChangesEnabled: !opts.dryRun,
    gitMode: "workingTree" as const,
    ...(writer ? { writer } : {}),
    ...(state.branch ? { prBranch: state.branch } : {}),
    ...(state.resolvedBase ? { prBaseRef: state.resolvedBase } : {}),
    ...(kg ? { knowledgeGraph: kg.graph, changedFiles: kg.changedFiles } : {}),
    ...(relatedRepos.length > 0 && reposToken ? { relatedRepos, githubToken: reposToken } : {}),
  };
  const runner: AgentRunner = new AnthropicAgentRunner({
    ...localOpts,
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  });

  // The approval policy (mode/threshold/gates flags) compiles into
  // pre-execution gates. The CLI's gate answer is non-blocking, like the
  // Action's label lookup: a step is approved iff it was passed via --approve;
  // otherwise the walk halts (exit PENDING_APPROVAL) and a re-run proceeds.
  const policy = await resolveApprovalPolicy(ldClient, ldContext);
  const approvedSteps = new Set(opts.approve);
  const gate = createPolicyGate(policy, (node) => approvedSteps.has(node));
  const stepsDesc = policy.steps.map((s) => s.step + (s.threshold !== undefined ? `@${s.threshold}` : "")).join(", ");
  console.log(
    `Approval policy: mode=${policy.mode} (source: ${policy.modeSource === "env" ? "APPROVAL_MODE env override" : "LD flags"})` +
      (policy.mode === "risk-threshold" ? ` threshold=${policy.threshold}` : "") +
      (gate ? ` steps=[${stepsDesc}]; approved: [${[...approvedSteps].join(", ") || "none"}]` : " (no gates)"),
  );

  // Judges: agents never commit in workingTree mode, so the verified evidence
  // is the node-scoped working-tree diff instead of the commit-scoped one.
  const judgeCompletion: JudgeCompletion | undefined = createAnthropicJudgeCompletion(process.env.ANTHROPIC_API_KEY);
  const baseJudgeHook = judgeCompletion
    ? createJudgeHook({
        aiClient,
        ldContext,
        variables,
        completion: judgeCompletion,
        provider,
        evidence: createWorkingTreeEvidence(root),
      })
    : undefined;
  const judgeScores = new Map<string, number>();
  const judgeHook: JudgeHook | undefined = baseJudgeHook
    ? async (args) => {
        const results = await baseJudgeHook(args);
        for (const r of results) {
          if (r.sampled && typeof r.score === "number") judgeScores.set(args.configKey, r.score);
        }
        return results;
      }
    : undefined;

  // Deterministic handoff shims: re-derive each node's claims from primary
  // evidence (LaunchDarkly + the working tree). Read-only runs still get the
  // code-side checks.
  const verifier = buildHandoffVerifier({ sandboxRoot: root, ...(writer ? { writer } : {}) });

  const walk = await walkGraph(
    graphDef,
    runner,
    context,
    graphTracker,
    (event) => {
      if (event.type === "node-start") console.log(`\n▶ step ${event.index + 1}: ${nodeTitle(event.configKey)}`);
      else if (event.type === "node-complete") {
        console.log(
          `■ step ${event.index + 1} done: ${nodeTitle(event.run.configKey)} [${event.run.status}] tags: ${JSON.stringify(event.run.tags)}`,
        );
      } else if (event.type === "node-verified") {
        const v = event.verification;
        if (v.ok) console.log(`⛊ deterministic checks passed after ${v.node} (${v.passed.map((c) => c.name).join(", ")})`);
        else console.log(`⛔ deterministic check FAILED after ${v.node}: ${v.failures.map((c) => `[${c.name}] ${c.detail}`).join("; ")}`);
      } else if (event.type === "stalled") {
        console.log(`⚠ ${describeStall(event.stall)}`);
      } else if (event.type === "awaiting-approval") {
        console.log(`⏸ approval gate: stopped before ${event.node}`);
      }
    },
    gate,
    judgeHook,
    verifier,
  );

  console.log(`\nRan ${walk.runs.length} node(s): ${walk.runs.map((r) => r.configKey).join(" → ")}`);
  if (walk.skipped.length) console.log(`Skipped: ${walk.skipped.join(", ")}`);

  // Halted at an approval gate: the gated step (and everything downstream) did
  // NOT run — nothing was created for it. Tell the caller exactly how to
  // resume, carrying forward every already-approved step.
  if (walk.pendingApproval) {
    const node = walk.pendingApproval.node;
    const approveFlags = [...new Set([...approvedSteps, node])].map((s) => `--approve ${s}`).join(" ");
    console.log(
      [
        "",
        `⏸ Approval required before '${node}'. Nothing was created for this or later steps.`,
        "If a human approves, re-run past this gate with:",
        `  autofactory run --graph ${opts.graphKey}${opts.dryRun ? " --dry-run" : ""} ${approveFlags}`,
      ].join("\n"),
    );
    return EXIT.PENDING_APPROVAL;
  }

  const verdict = interpretWalk(walk.tags);
  const decision = decideApproval(verdict);

  // Release intent: validate the manifest's releaseIntent deterministically so
  // problems surface here, where a human can still fix them, instead of at
  // Beacon's fail-closed hold on deploy. Warning only — never fails the run.
  const manifestRel = context.PR_NUMBER ? `.release-flags/pr-${context.PR_NUMBER}.json` : undefined;
  const manifestAbs = manifestRel ? join(root, manifestRel) : undefined;
  const manifestExists = Boolean(manifestAbs && existsSync(manifestAbs));
  if (manifestAbs && manifestExists) {
    try {
      const manifest = JSON.parse(readFileSync(manifestAbs, "utf8")) as Record<string, unknown>;
      const { issues } = normalizeReleaseIntent(manifest.releaseIntent);
      if (issues.length) {
        console.log(`⚠ release intent in ${manifestRel} needs attention (Beacon will HOLD the release): ${issues.join("; ")}`);
      }
    } catch (e) {
      console.log(`⚠ could not validate ${manifestRel} (non-fatal): ${e instanceof Error ? e.message : e}`);
    }
  }

  // Final summary: what was created, where it lives, and the reviewer's verdict
  // as the standard fenced JSON block every front end ends with.
  const lines: string[] = ["", "──────── AutoFactory Phase 1 — summary ────────", `Verdict: ${decision.reason}`];
  if (walk.tags.flag_key) {
    lines.push(`Flag: ${walk.tags.flag_key} → ${flagUrl(appProjectKey as string, walk.tags.flag_key)}`);
  }
  for (const key of (walk.tags.metric_keys ?? "").split(",").map((k) => k.trim()).filter(Boolean)) {
    lines.push(`Metric: ${key} → ${metricUrl(appProjectKey as string, key)}`);
  }
  if (manifestRel && manifestExists) lines.push(`Manifest: ${manifestRel}`);
  for (const [node, score] of judgeScores) lines.push(`Judge: ${node} scored ${score.toFixed(2)}`);
  if (walk.stalledAt) lines.push(`⚠ Stalled: ${describeStall(walk.stalledAt)}`);
  if (walk.verificationFailed) {
    lines.push(
      `⛔ Deterministic check failed after '${walk.verificationFailed.node}': ` +
        walk.verificationFailed.failures.map((f) => `[${f.name}] ${f.detail}`).join("; "),
    );
  }
  lines.push(
    "```json",
    JSON.stringify({
      review_approved: verdict.hasVerdict ? verdict.reviewApproved : null,
      risk_level: verdict.risk ?? null,
      ...(verdict.skipFlagging ? { skip_flagging: true } : {}),
    }),
    "```",
  );
  if (!opts.dryRun) lines.push("Edits are in your working tree for you to review and commit. Nothing was pushed.");
  console.log(lines.join("\n"));

  // Record the completed run at <git-dir>/autofactory-last-run.json — the
  // evidence the pre-push gate reads (see runRecord.ts). Dry runs don't count.
  if (!opts.dryRun) {
    const outcome: RunOutcome = walk.verificationFailed
      ? "verification-failed"
      : decision.apply
        ? "approved"
        : decision.noop
          ? "noop"
          : decision.incomplete
            ? "incomplete"
            : "rejected";
    writeRunRecord(root, {
      ...(state.branch ? { branch: state.branch } : {}),
      ...(state.head ? { head: state.head } : {}),
      outcome,
      ...(walk.tags.flag_key ? { flagKey: walk.tags.flag_key } : {}),
      ...(manifestRel && manifestExists ? { manifest: manifestRel } : {}),
    });
  }

  return !walk.verificationFailed && (decision.apply || decision.noop) ? EXIT.OK : EXIT.FAILED;
}
