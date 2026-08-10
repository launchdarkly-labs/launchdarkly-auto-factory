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
  type ResumeInput,
  type LoopGrant,
  type StallInfo,
  appConnection,
  assembleKnowledgeGraph,
  buildHandoffVerifier,
  buildWorkingTreeContext,
  buildWorkingTreeVariables,
  closeLdSdk,
  MAX_VISITS_HARD_CAP,
  computeConfigHash,
  declaredMaxVisits,
  createAnthropicJudgeCompletion,
  createJudgeHook,
  createPolicyGate,
  createWorkingTreeEvidence,
  decideApproval,
  describeLoopBudgetSpent,
  describeLoopExhausted,
  extractConfigStamp,
  getLdSdk,
  hasChangeToProcess,
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
import {
  clearWalkState,
  computeTreeHash,
  appendGrants,
  grantIsAbsorbedByCap,
  readWalkState,
  validateGrants,
  validateWalkState,
  type WalkStateKeys,
  writeWalkState,
} from "./walkState.js";
import { type RunOutcome, deriveOutcome, writeRunRecord } from "./runRecord.js";

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
 * Content hash of this build's committed agent configs. Doubles as a resume
 * invalidation key: if the configs changed, a saved journal describes a graph that
 * no longer exists. Cheap enough to call more than once.
 */
function localConfigHash(): string | undefined {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const base = join(repoRoot, "config", "agentcontrol");
    return computeConfigHash({
      aiConfigsDir: join(base, "ai-configs"),
      graphsDir: join(base, "graphs"),
      flagsDir: join(base, "flags"),
      toolsDir: join(base, "tools"),
    });
  } catch {
    return undefined;
  }
}

/**
 * Config-drift check (same contract as the Action's): compare the committed config
 * hash against the `[cfg:…]` stamp that provision/upgrade write onto the live
 * graph's description. Best-effort.
 */
async function detectConfigDrift(graphKey: string): Promise<string | undefined> {
  try {
    const local = localConfigHash();
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

  // Resume: replay the saved journal through the same walk loop, then continue
  // live from where it stopped. Fail-closed — every key must match, because the
  // agents' recorded work only means anything against the files it was recorded
  // from. Refusing costs a re-run; replaying stale state corrupts the result.
  // These are the keys as of NOW, before anything runs — correct for VALIDATING a
  // saved journal (has the world moved since the halt?). They are deliberately not
  // reused when persisting: `writeWalkState` re-hashes the tree itself, because by
  // then the agents have edited it. See the comment on writeWalkState.
  const configStamp = localConfigHash();
  // Hoisted: computing it twice ran git twice AND could store a hash that was never the
  // one compared, if a file changed between the two calls.
  const treeHash = computeTreeHash(root);
  const stateKeys: WalkStateKeys = {
    graphKey: opts.graphKey,
    ...(configStamp ? { configStamp } : {}),
    ...(state.head ? { head: state.head } : {}),
    ...(treeHash ? { treeHash } : {}),
    policyMode: policy.mode,
    base: opts.base,
  };
  let resume: ResumeInput | undefined;
  // Grants carried in from a saved walk, each keeping the position it took effect at.
  let priorGrants: LoopGrant[] = [];
  // Length of the journal replayed this round — the point any NEW grant takes effect.
  let replayedRuns = 0;
  if (opts.resume) {
    const check = validateWalkState(readWalkState(root), stateKeys);
    if (!check.ok) {
      console.error(`⛔ cannot resume: ${check.reason}`);
      console.error("   Run again without --resume to start a fresh walk.");
      return EXIT.USAGE;
    }
    // A grant may only target a loop edge whose exhaustion ENDED the saved walk. Any
    // other edge is incoherent to grant (see validateGrants) and would make every later
    // resume diverge, so refuse before doing any work.
    const grantCheck = validateGrants(check.state, opts.grantVisits);
    if (!grantCheck.ok) {
      console.error(`⛔ cannot resume: ${grantCheck.reason}`);
      return EXIT.USAGE;
    }
    // A grant the hard cap would swallow does nothing: the resume replays, performs no
    // live work, and re-halts identically — while the halt message suggests granting
    // again. Refuse it with the reason instead of looping the human.
    for (const edge of Object.keys(opts.grantVisits)) {
      const declared = declaredMaxVisits(graphDef, edge);
      if (declared !== undefined && grantIsAbsorbedByCap(declared, check.state.grants, edge, MAX_VISITS_HARD_CAP)) {
        console.error(
          `⛔ cannot resume: ${edge.replace("→", ":")} has already reached the hard cap of ` +
            `${MAX_VISITS_HARD_CAP} traversals, so a further grant would have no effect.`,
        );
        return EXIT.USAGE;
      }
    }
    const grants = Object.entries(opts.grantVisits);
    priorGrants = check.state.grants ?? [];
    replayedRuns = check.state.runs.length;
    // One list: prior grants keep their positions, and this round's grant takes effect at
    // the frontier (after the replayed runs). Replay then re-derives the original budget
    // decisions exactly, with no assumption about the graph's shape.
    const allGrants = appendGrants(priorGrants, opts.grantVisits, replayedRuns);
    resume = {
      journal: check.state.runs,
      ...(allGrants.length > 0 ? { grants: allGrants } : {}),
      ...(opts.feedback ? { humanFeedback: opts.feedback } : {}),
    };
    console.log(
      `Resuming the walk saved at ${check.state.at}: replaying ${check.state.runs.length} step(s) ` +
        `(no model calls, no duplicate LaunchDarkly writes), then continuing from '${check.state.haltedAt.node}'.` +
        (grants.length > 0 ? `\n  Extra loop budget: ${grants.map(([k, n]) => `${k} +${n}`).join(", ")}` : ""),
    );
  }

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
          // Key by node#iteration so a looped node's re-runs don't overwrite.
          if (r.sampled && typeof r.score === "number") judgeScores.set(`${args.configKey}#${args.iteration}`, r.score);
        }
        return results;
      }
    : undefined;

  // Deterministic handoff shims: re-derive each node's claims from primary
  // evidence (LaunchDarkly + the working tree). Read-only runs still get the
  // code-side checks.
  const verifier = buildHandoffVerifier({ sandboxRoot: root, ...(writer ? { writer } : {}) });

  const walk = await walkGraph(graphDef, runner, context, {
    graphTracker,
    onEvent: (event) => {
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
      } else if (event.type === "loop-exhausted") {
        console.log(`⚠ ${describeLoopExhausted(event.info)}`);
      } else if (event.type === "awaiting-approval") {
        console.log(`⏸ approval gate: stopped before ${event.node}`);
      } else if (event.type === "replay-diverged") {
        console.log(`⛔ resume aborted: ${event.info.detail}`);
      }
    },
    gate,
    judgeHook,
    verifier,
    ...(resume ? { resume } : {}),
  });

  // Journal bookkeeping, before any early return. A halted walk saves its journal
  // so `--resume` can replay it; a walk that reached a real terminal clears it, so
  // a stale journal can never be replayed against a later run. Dry runs touch
  // neither: they create nothing, and clearing would discard a real pause.
  if (!opts.dryRun) {
    const halt = walk.pendingApproval
      ? ({ kind: "pending-approval", node: walk.pendingApproval.node } as const)
      : walk.loopExhausted
        ? ({
            kind: "loop-exhausted",
            node: walk.loopExhausted.node,
            // Only the edges that ENDED this walk — not `loopBudgetSpent`, which includes
            // advisory loops that fell through and whose downstream work is recorded.
            exhaustedEdges: walk.loopExhausted.exhausted.map((e) => `${e.source}→${e.target}`),
          } as const)
        : undefined;
    if (walk.replayDiverged) {
      // Left in place, NOT deleted: the cause may be reversible (a served-graph edit
      // reverted, configs re-synced), and a plain run clears it at its own terminal.
      // Note it is the REPLAY that refuses, not validation — the invalidation keys are
      // all local and still match, so `--resume` will keep reaching this same point
      // until the underlying change is undone or a fresh run is taken. Deleting
      // recoverable state on a refusal is the wrong trade.
    } else if (halt) {
      // NOTE: no treeHash here — writeWalkState hashes the tree itself, at the halt,
      // after the agents have edited it.
      writeWalkState(root, {
        graphKey: opts.graphKey,
        ...(stateKeys.configStamp ? { configStamp: stateKeys.configStamp } : {}),
        ...(state.branch ? { branch: state.branch } : {}),
        ...(stateKeys.head ? { head: stateKeys.head } : {}),
        ...(stateKeys.policyMode ? { policyMode: stateKeys.policyMode } : {}),
        base: opts.base,
        // Positional, so a later round replays this round's granted traversals at the
        // position they actually happened rather than from the start of the journal.
        ...((): { grants?: LoopGrant[] } => {
          const all = appendGrants(priorGrants, opts.grantVisits, replayedRuns);
          return all.length > 0 ? { grants: all } : {};
        })(),
        haltedAt: halt,
        runs: walk.runs,
      });
    } else {
      clearWalkState(root);
    }
  }

  // A diverged replay is a mix of two different walks. Report and stop WITHOUT
  // writing a run record — like an approval pause or a crash, it is not evidence
  // that AutoFactory ran on this branch, so the pre-push gate must stay closed.
  if (walk.replayDiverged) {
    const d = walk.replayDiverged;
    console.error(
      [
        "",
        `⛔ Resume aborted at journal position ${d.atIndex}: expected '${d.expected}', the walk re-derived '${d.actual}'.`,
        `   ${d.detail}`,
        "   Run again without --resume to start a fresh walk (the saved journal is left in place but will keep being refused).",
      ].join("\n"),
    );
    return EXIT.FAILED;
  }

  console.log(`\nRan ${walk.runs.length} node(s): ${walk.runs.map((r) => r.configKey).join(" → ")}`);
  if (walk.skipped.length) console.log(`Skipped: ${walk.skipped.join(", ")}`);

  // Halted at an approval gate: the gated step (and everything downstream) did
  // NOT run — nothing was created for it. Tell the caller exactly how to
  // resume, carrying forward every already-approved step.
  if (walk.pendingApproval) {
    const node = walk.pendingApproval.node;
    const approveFlags = [...new Set([...approvedSteps, node])].map((s) => `--approve ${s}`).join(" ");
    const lines = [
      "",
      `⏸ Approval required before '${node}'. Nothing was created for this or later steps.`,
      "If a human approves, re-run past this gate with:",
      `  autofactory run --graph ${opts.graphKey}${opts.dryRun ? " --dry-run" : ""} ${approveFlags}`,
    ];
    // --resume replays the completed steps instead of re-running them, which also
    // keeps the planner from re-analysing the agents' own working-tree edits as if
    // a human had written them.
    if (!opts.dryRun && walk.runs.length > 0) {
      lines.push(
        `Add --resume to replay the ${walk.runs.length} completed step(s) instead of re-running them:`,
        `  autofactory run --graph ${opts.graphKey} --resume ${approveFlags}`,
      );
    }
    console.log(lines.join("\n"));
    return EXIT.PENDING_APPROVAL;
  }

  const verdict = interpretWalk(walk.tags, walk.inventory, walk.runs);
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
  // Links come from the never-rewound inventory, so a loop rewind can't erase
  // the record of resources that really exist.
  if (walk.inventory.flag_key) {
    lines.push(`Flag: ${walk.inventory.flag_key} → ${flagUrl(appProjectKey as string, walk.inventory.flag_key)}`);
  }
  for (const key of (walk.inventory.metric_keys ?? "").split(",").map((k) => k.trim()).filter(Boolean)) {
    lines.push(`Metric: ${key} → ${metricUrl(appProjectKey as string, key)}`);
  }
  if (manifestRel && manifestExists) lines.push(`Manifest: ${manifestRel}`);
  for (const [node, score] of judgeScores) {
    // Keys are `configKey#iteration`; show "(iter N)" only for re-runs.
    const parts = node.split("#");
    const k = parts[0] ?? node;
    const iter = parts[1];
    const label = iter && iter !== "1" ? `${k} (iter ${iter})` : k;
    lines.push(`Judge: ${label} scored ${score.toFixed(2)}`);
  }
  // Advisory quality loops that gave up. Not a failure, but the run is worse than a
  // clean first pass and nothing else would say so.
  if (walk.loopBudgetSpent) for (const l of describeLoopBudgetSpent(walk.loopBudgetSpent)) lines.push(`⚠ ${l}`);
  if (walk.loopExhausted) {
    lines.push(`⚠ ${describeLoopExhausted(walk.loopExhausted)}`);
    // Budget alone would repeat the same failure, so the grant requires feedback.
    if (!opts.dryRun) {
      const spent = walk.loopExhausted.exhausted[0];
      const grant = spent ? `${spent.source}:${spent.target}=1` : "<source>:<target>=1";
      lines.push(
        `  To give it another pass WITH guidance (replays the completed steps, no duplicate writes):`,
        `    autofactory run --graph ${opts.graphKey} --resume --grant-visits ${grant} --feedback "what to change"`,
      );
    }
  }
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
    // Outcome mapping lives in a pure, unit-tested helper (runRecord.ts): a
    // non-converged loop records as `incomplete` (so already-deployed pre-push
    // hooks stay safe) plus a `loopExhausted` discriminator for updated hooks.
    const outcome: RunOutcome = deriveOutcome({
      verificationFailed: !!walk.verificationFailed,
      loopExhausted: !!walk.loopExhausted,
      apply: decision.apply,
      noop: decision.noop,
      incomplete: decision.incomplete,
    });
    const orphanedResources = verdict.orphanedFlagKeys;
    writeRunRecord(root, {
      ...(state.branch ? { branch: state.branch } : {}),
      ...(state.head ? { head: state.head } : {}),
      outcome,
      ...(walk.loopExhausted ? { loopExhausted: true } : {}),
      ...(orphanedResources.length ? { orphanedResources } : {}),
      ...(walk.inventory.flag_key ? { flagKey: walk.inventory.flag_key } : {}),
      ...(manifestRel && manifestExists ? { manifest: manifestRel } : {}),
    });
  }

  return !walk.verificationFailed && !walk.loopExhausted && (decision.apply || decision.noop) ? EXIT.OK : EXIT.FAILED;
}
