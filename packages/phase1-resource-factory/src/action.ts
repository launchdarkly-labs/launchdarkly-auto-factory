#!/usr/bin/env node
/**
 * Phase 1 GitHub Action entrypoint. Triggered on PR open/synchronize (no label
 * gate). Built natively on LaunchDarkly: the server SDK evaluates the AI-provider
 * flag, and the AI SDK resolves the agent graph + per-node agent configs. It
 * assembles PR context, compiles the approval policy (mode/threshold/gates
 * flags) into pre-execution gates, walks the graph through the selected
 * provider, and reports the reviewer's verdict.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentRunner,
  AnthropicAgentRunner,
  type AssembledGraph,
  buildHandoffVerifier,
  CursorAgentRunner,
  KNOWLEDGE_GRAPH_FLAG_KEY,
  assembleKnowledgeGraph,
  GraphQLVegaTransport,
  type JudgeCompletion,
  type JudgeHook,
  createAnthropicJudgeCompletion,
  createCursorJudgeCompletion,
  createGitDiffEvidence,
  createJudgeHook,
  LdClient,
  LdResourceWriter,
  type StallInfo,
  StubVegaTransport,
  VegaAgentRunner,
  VegaClient,
  type VegaTransport,
  appConnection,
  closeLdSdk,
  computeConfigHash,
  createPolicyGate,
  decideApproval,
  extractConfigStamp,
  getLdSdk,
  interpretWalk,
  intentIsDefault,
  initFactorySentry,
  loadRelatedRepos,
  normalizeReleaseIntent,
  pipelineContext,
  resolveAiProvider,
  resolveApprovalPolicy,
  targetConnection,
  walkGraph,
  withProvider,
} from "@auto-factory/shared";
import { postCheckRun } from "./checkRun.js";
import { postPrComment } from "./comment.js";
import { approveLabel, ensureLabel, fetchApprovalActor, fetchApprovedSteps } from "./labels.js";
import { type PrContext, assemblePrContext } from "./prContext.js";

/**
 * Use the real GraphQL transport when VEGA_ENDPOINT + VEGA_TOKEN are set; else
 * fall back to the stub (no agent execution). Endpoint/auth are env-configured —
 * the dispatch host and auth header name are deployment-specific.
 */
function createVegaClient(): VegaClient {
  const endpoint = process.env.VEGA_ENDPOINT;
  // Auth is a regular LaunchDarkly API key — reuse LD_API_KEY unless overridden.
  const token = process.env.VEGA_TOKEN ?? process.env.LD_API_KEY;
  if (endpoint && token) {
    const transport: VegaTransport = new GraphQLVegaTransport({
      endpoint,
      token,
      ...(process.env.VEGA_AUTH_HEADER ? { authHeaderName: process.env.VEGA_AUTH_HEADER } : {}),
      ...(process.env.VEGA_REQUEST_TYPE ? { requestType: process.env.VEGA_REQUEST_TYPE } : {}),
      ...(process.env.GITHUB_REPOSITORY ? { repositories: [process.env.GITHUB_REPOSITORY] } : {}),
      // Dispatch's `project_slug` is the internal LD project ID — prefer LD_PROJECT_SLUG,
      // fall back to the human project key only if the slug isn't provided.
      ...(process.env.LD_PROJECT_SLUG ?? process.env.LD_PROJECT_KEY
        ? { projectSlug: process.env.LD_PROJECT_SLUG ?? process.env.LD_PROJECT_KEY }
        : {}),
    });
    return new VegaClient(transport);
  }
  console.log("VEGA_ENDPOINT/VEGA_TOKEN not set — using stub transport (no agent execution).");
  return new VegaClient(new StubVegaTransport());
}

/**
 * Build the agent runner for the provider the LaunchDarkly flag selects.
 * The Vega path dispatches to LaunchDarkly's hosted runtime; the Anthropic and
 * Cursor paths run the deterministic graph locally with the SAME sandbox tools
 * (see shared/anthropic/ and shared/cursor/) — only the model brain differs.
 *
 * Flag creation is enabled (real `create_flag` against the app project) when
 * ENABLE_FLAG_CREATION=true and an api- key is present; otherwise read-only.
 */
function createAgentRunner(provider: string, kg?: AssembledGraph): AgentRunner {
  if (provider === "vega") {
    if (kg) console.log("Knowledge graph: composed, but the Vega provider runs tools server-side — enrichment applies to local providers only.");
    return new VegaAgentRunner(createVegaClient());
  }

  // Local-execution providers (Anthropic default, or Cursor): sandbox root is the
  // repo the agents inspect. Locally this is the bundled demo app; in CI it
  // defaults to the checked-out workspace. Both share these options.
  const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "examples/demo-app");
  const writer = flagCreationWriter();
  const codeChangesEnabled = process.env.ENABLE_CODE_CHANGES === "true";
  console.log(`Flag creation: ${writer ? `ENABLED → app project '${writer.projectKey}'` : "disabled"}.`);
  console.log(`Code changes (edit + commit/push): ${codeChangesEnabled ? "ENABLED" : "disabled"}.`);
  // Cross-repo research (split-repo estates): the app repo opts in by
  // registering relatedRepos in .autofactory/services.yaml. AUTOFACTORY_REPOS_TOKEN
  // overrides the default token for private sibling repos.
  const relatedRepos = loadRelatedRepos(sandboxRoot);
  // `||` not `??`: an unset workflow secret arrives as an empty string.
  const reposToken = process.env.AUTOFACTORY_REPOS_TOKEN || process.env.GITHUB_TOKEN;
  if (relatedRepos.length > 0) {
    console.log(
      `Related repos: ${relatedRepos.length} registered (${relatedRepos.map((r) => r.repo).join(", ")})${reposToken ? "" : " — but no GitHub token; query_related_repos disabled"}.`,
    );
  }
  const localOpts = {
    sandboxRoot,
    codeChangesEnabled,
    ...(writer ? { writer } : {}),
    ...(process.env.PR_BRANCH ? { prBranch: process.env.PR_BRANCH } : {}),
    ...(process.env.PR_BASE_REF ? { prBaseRef: process.env.PR_BASE_REF } : {}),
    ...(kg ? { knowledgeGraph: kg.graph, changedFiles: kg.changedFiles } : {}),
    ...(relatedRepos.length > 0 && reposToken ? { relatedRepos, githubToken: reposToken } : {}),
  };

  if (provider === "cursor") {
    // Cursor agents via @cursor/sdk. Model + parameters are mapped from the LD AI
    // config (see shared/cursor/cursorModel.ts); inference runs on Cursor's hosted
    // models. CURSOR_MODEL is the fallback when an LD model has no Cursor match.
    return new CursorAgentRunner({
      ...localOpts,
      ...(process.env.CURSOR_API_KEY ? { apiKey: process.env.CURSOR_API_KEY } : {}),
      ...(process.env.CURSOR_MODEL ? { model: process.env.CURSOR_MODEL } : {}),
    });
  }

  // Anthropic (default).
  return new AnthropicAgentRunner({
    ...localOpts,
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  });
}

/**
 * The provider-matched completion that executes attached LaunchDarkly judges
 * (see shared/judges.ts). Vega has no local judge execution — judges are skipped
 * there with a log note.
 */
function createJudgeCompletion(provider: string): JudgeCompletion | undefined {
  if (provider === "cursor") {
    return createCursorJudgeCompletion({
      ...(process.env.CURSOR_API_KEY ? { apiKey: process.env.CURSOR_API_KEY } : {}),
      ...(process.env.CURSOR_MODEL ? { model: process.env.CURSOR_MODEL } : {}),
    });
  }
  if (provider === "anthropic") {
    return createAnthropicJudgeCompletion(process.env.ANTHROPIC_API_KEY);
  }
  console.log(`Judges: no local judge execution on provider '${provider}' — attached judges are skipped.`);
  return undefined;
}

/** A writer for real flag creation in the app project, or undefined for read-only. */
function flagCreationWriter(): LdResourceWriter | undefined {
  if (process.env.ENABLE_FLAG_CREATION !== "true") return undefined;
  if (!process.env.LD_API_KEY) {
    throw new Error("ENABLE_FLAG_CREATION=true but LD_API_KEY is not set");
  }
  // Refuse to create flags in the factory/control-plane project: require an
  // explicit app project so we never pollute the project holding the AI configs.
  if (!process.env.LD_APP_PROJECT_KEY) {
    throw new Error(
      "ENABLE_FLAG_CREATION=true but LD_APP_PROJECT_KEY is not set — refusing to create flags in the factory project",
    );
  }
  return new LdResourceWriter(new LdClient(appConnection()));
}

/**
 * HEAD of the checkout after the chain ran. The agents push commits with
 * [skip ci], which moves the PR head PAST the workflow's own check — so the
 * final verdict check run must attach to this SHA to be visible on the PR's
 * latest commit. Falls back to undefined (caller uses the event's head SHA).
 */
function checkoutHeadSha(root: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}


/**
 * Post-chain release-intent handling: validate the manifest's releaseIntent
 * (deterministic normalizer — surface issues on the PR before merge, where a
 * human can still fix them instead of hitting Beacon's fail-closed hold at
 * deploy), and stamp `approvedBy` from the gate-label actor when gates cleared.
 * Best-effort: never fails the run.
 */
async function reviewManifestIntent(opts: {
  sandboxRoot: string;
  prNumber?: string;
  repo?: string;
  gatesCleared: boolean;
  prBranch?: string;
}): Promise<{ line?: string; warning?: string }> {
  try {
    if (!opts.prNumber) return {};
    const rel = `.release-flags/pr-${opts.prNumber}.json`;
    const abs = join(opts.sandboxRoot, rel);
    if (!existsSync(abs)) return {};
    const manifest = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    const { intent, issues } = normalizeReleaseIntent(manifest.releaseIntent);

    // approvedBy: auto-filled from whoever added the af-approve:* label.
    if (opts.gatesCleared && !intent.approvedBy) {
      const actor = await fetchApprovalActor(opts.repo, opts.prNumber, process.env.GITHUB_TOKEN);
      const rawIntent = (manifest.releaseIntent ?? {}) as Record<string, unknown>;
      if (actor && !rawIntent.approvedBy) {
        rawIntent.approvedBy = actor;
        manifest.releaseIntent = rawIntent;
        writeFileSync(abs, JSON.stringify(manifest, null, 2) + "\n", "utf8");
        try {
          const git = (args: string[]) =>
            execFileSync("git", args, { cwd: opts.sandboxRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          git(["config", "user.email", "autofactory@launchdarkly.com"]);
          git(["config", "user.name", "LaunchDarkly AutoFactory"]);
          git(["add", rel]);
          if (git(["diff", "--cached", "--name-only"]).trim()) {
            git(["commit", "-m", `chore(auto-factory): record approvedBy=${actor} in ${rel}\n\n[skip ci]`]);
            const branch = opts.prBranch ?? process.env.PR_BRANCH;
            git(branch ? ["push", "origin", `HEAD:${branch}`] : ["push"]);
            console.log(`Release intent: recorded approvedBy=${actor} in ${rel}.`);
          }
        } catch (e) {
          console.warn(`Release intent: could not commit approvedBy (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
        intent.approvedBy = actor;
      }
    }

    const parts: string[] = [];
    if (!intentIsDefault(intent)) {
      parts.push(
        `action=${intent.action}` +
          (intent.notBefore ? `, notBefore=${intent.notBefore}` : "") +
          (intent.prerequisites?.length ? `, prerequisites=[${intent.prerequisites.map((x) => x.flagKey).join(", ")}]` : "") +
          (intent.segments?.length ? `, segments=[${intent.segments.join(", ")}]` : "") +
          (intent.notes ? `, notes present` : ""),
      );
    }
    if (intent.approvedBy) parts.push(`approved by @${intent.approvedBy}`);
    if (intent.reference) parts.push(`ref ${intent.reference}`);
    const line = parts.length ? `**Release intent:** ${parts.join(" — ")}` : undefined;
    const warning = issues.length
      ? `release intent in ${rel} needs attention (Beacon will HOLD the release): ${issues.join("; ")}`
      : undefined;
    return { ...(line ? { line } : {}), ...(warning ? { warning } : {}) };
  } catch (e) {
    console.warn(`Release intent review failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

/**
 * Human-readable description of a chain stall (unmet handoff) for logs, the GH
 * annotation, and the PR comment.
 */
function describeStall(stall: StallInfo): string {
  const edges = stall.unmet
    .map((u) => `edge → ${u.target} requires ${Object.entries(u.requireMissing).map(([k, v]) => `${k}=${v}`).join(", ")} (never produced)`)
    .join("; ");
  return `chain stalled at '${stall.node}'; ${edges}. Downstream agents did not run.`;
}

/**
 * Status-board PR comment when the chain halts at an approval gate: lists every
 * gated step with its state (✓ approved / ⏸ awaiting now / ⬜ gated, later), and
 * the exact label to add to proceed. This is the human-readable view; the label
 * chips are the at-a-glance approved state.
 */
function buildGateComment(gatedSteps: string[], approved: Set<string>, pendingNode: string): string {
  const lines = gatedSteps.map((step) => {
    if (approved.has(step)) return `- ✓ \`${step}\` — approved`;
    if (step === pendingNode) return `- ⏸ \`${step}\` — **awaiting approval**: add the label \`${approveLabel(step)}\``;
    return `- ⬜ \`${step}\` — gated (after the step above)`;
  });
  return [
    "### LaunchDarkly Auto-Factory — Phase 1 ⏸ awaiting approval",
    "",
    `The chain paused before **${pendingNode}**. Nothing was created for this or later steps yet.`,
    "Approve by adding the labeled step below; the chain resumes on the next run.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Variables for AI-config instruction interpolation (done by LaunchDarkly's AI
 * SDK). Run-level values only; per-step output flows through the node prompt.
 * LAUNCHDARKLY_PROJECT points at the data-plane app project where flags are created.
 */
function buildVariables(ctx: PrContext): Record<string, unknown> {
  return {
    PR_NUMBER: ctx.PR_NUMBER ?? "",
    PR_TITLE: ctx.PR_TITLE ?? "",
    PR_BODY: ctx.PR_BODY ?? "",
    REPO: ctx.REPO ?? "",
    PR_BRANCH: process.env.PR_BRANCH ?? "",
    TICKET_ID: process.env.TICKET_ID ?? "",
    LAUNCHDARKLY_PROJECT: process.env.LD_APP_PROJECT_KEY ?? "autofactory-demo",
  };
}

/** GitHub Actions exposes `with:` inputs as INPUT_<NAME>. Map them to the plain
 *  env vars the rest of the code reads. */
function mapActionInputs(): void {
  const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`];
  const set = (envName: string, inputName: string) => {
    const v = input(inputName);
    if (v && !process.env[envName]) process.env[envName] = v;
  };
  set("LD_SDK_KEY", "ld_sdk_key");
  set("ANTHROPIC_API_KEY", "anthropic_api_key");
  set("CURSOR_API_KEY", "cursor_api_key");
  set("CURSOR_MODEL", "cursor_model");
  set("LD_API_KEY", "ld_api_key");
  set("LD_BASE_URL", "ld_base_url");
  set("LD_PROJECT_KEY", "ld_project_key");
  set("LD_PROJECT_SLUG", "ld_project_slug");
  set("LD_APP_PROJECT_KEY", "ld_app_project_key");
  set("GRAPH_KEY", "graph_key");
  set("SANDBOX_ROOT", "sandbox_root");
  set("ENABLE_FLAG_CREATION", "enable_flag_creation");
  set("ENABLE_CODE_CHANGES", "enable_code_changes");
  set("PR_BRANCH", "pr_branch");
  set("PR_BASE_REF", "pr_base");
  set("APPROVAL_MODE", "approval_mode");
  set("RISK_THRESHOLD", "risk_threshold");
  set("GITHUB_TOKEN", "github_token");
  set("VEGA_ENDPOINT", "vega_endpoint");
  set("VEGA_TOKEN", "vega_token");
  set("VEGA_AUTH_HEADER", "vega_auth_header");
  set("VEGA_REQUEST_TYPE", "vega_request_type");
}

/**
 * Config-drift check: this action runs from a checkout of the tooling repo
 * (the `uses:` ref pulls the whole repo), so it can hash the committed
 * config/agentcontrol files three levels up and compare against the
 * `[cfg:…]` stamp that provision/upgrade write onto the live graph's
 * description. A mismatch is the "new runtime, stale configs" mixed state —
 * agent instructions that don't know about the runtime's tools. Best-effort:
 * never blocks the run.
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
    if (!local) return undefined; // no repo checkout alongside the bundle — nothing to compare
    const graph = await new LdClient(targetConnection()).getAgentGraph<{ description?: string }>(graphKey);
    if (graph.status !== 200) return undefined;
    const stamp = extractConfigStamp(graph.data.description);
    if (stamp === local) return undefined;
    const fix = "run `npm run bridge -- upgrade` from the tooling repo to sync your LaunchDarkly configs";
    return stamp
      ? `LaunchDarkly configs were provisioned from a different repo version (project has cfg:${stamp}, this action expects cfg:${local}) — ${fix}.`
      : `LaunchDarkly configs pre-date version stamping (no [cfg:…] marker on graph '${graphKey}') — ${fix}; it also stamps the version for this check.`;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  mapActionInputs();
  const context = assemblePrContext();

  // Sentry AI agent monitoring for factory runners (ADR 0014). No-op without DSN.
  await initFactorySentry({ serviceName: "auto-factory-phase1-gha" });

  // Native LaunchDarkly: server SDK (flag eval) + AI SDK (graph + agent configs).
  const { ldClient, aiClient } = await getLdSdk();
  let ldContext = pipelineContext();

  const provider = await resolveAiProvider(ldClient, ldContext);
  // Stamp the resolved provider on the run context so AI config targeting can
  // serve provider-compatible model variations (rules on `run.provider`).
  ldContext = withProvider(ldContext, provider);
  const graphKey = process.env.GRAPH_KEY ?? "gha-auto-factory";
  const graphDef = await aiClient.agentGraph(graphKey, ldContext, buildVariables(context));
  if (!graphDef.enabled) {
    throw new Error(
      `Agent graph '${graphKey}' is disabled or unavailable in LaunchDarkly. ` +
        `Most common cause: LD_SDK_KEY is not the FACTORY project's server SDK key — it must be for ` +
        `the project holding the AI configs, agent graph, and operational flags (LD_PROJECT_KEY='${process.env.LD_PROJECT_KEY ?? "?"}'), ` +
        `NOT the app project where flags get created. Also check GRAPH_KEY and that the graph is enabled in this environment.`,
    );
  }
  const graphTracker = graphDef.createTracker();

  console.log(`Phase 1: PR #${context.PR_NUMBER ?? "?"} → graph '${graphKey}' [provider: ${provider}]`);

  // Emit the drift warning up front so it lands even when the run later halts
  // at an approval gate or fails; it also joins the PR summary comment below.
  const configDrift = await detectConfigDrift(graphKey);
  if (configDrift) console.log(`::warning::AutoFactory: ${configDrift}`);

  // Knowledge graph (ADR 0010), behind the auto-factory-knowledge-graph flag.
  // Assembly DEGRADES rather than blocks: every missing source (uninstrumented
  // estate, no service registry, absent find-code-refs binary) becomes a
  // ::warning:: + a `gaps` entry the agents are told to treat as unknown — a
  // PR check must never fail because an observability read did.
  const kgEnabled = (await ldClient.variation(KNOWLEDGE_GRAPH_FLAG_KEY, ldContext, false)) === true;
  let kg: AssembledGraph | undefined;
  if (kgEnabled) {
    const kgSandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "examples/demo-app");
    const appProject = process.env.LD_APP_PROJECT_KEY;
    kg = await assembleKnowledgeGraph({
      sandboxRoot: kgSandboxRoot,
      ...(process.env.PR_BASE_REF ? { prBaseRef: process.env.PR_BASE_REF } : {}),
      ...(context.HEAD_SHA ? { sha: context.HEAD_SHA } : {}),
      ...(process.env.LD_API_KEY && appProject
        ? {
            o11y: { apiKey: process.env.LD_API_KEY, projectKey: appProject },
            codeRefs: {
              apiKey: process.env.LD_API_KEY,
              projectKey: appProject,
              ...(context.REPO ? { repoName: context.REPO.split("/").pop() as string } : {}),
            },
          }
        : {}),
    });
    if (!process.env.LD_API_KEY || !appProject) {
      kg.warnings.push("LD_API_KEY / LD_APP_PROJECT_KEY unset — traces and code-refs sources skipped.");
    }
    const svcEdges = kg.graph.edges.filter((e) => e.kind === "service_calls").length;
    const wrapEdges = kg.graph.edges.filter((e) => e.kind === "flag_wraps").length;
    console.log(
      `Knowledge graph: ON — ${kg.graph.services.length} services, ${svcEdges} service edges (traces), ` +
        `${wrapEdges} wrap points (code refs), ${kg.changedFiles.length} changed files, ${kg.graph.gaps.length} gaps.`,
    );
    for (const w of kg.warnings) console.log(`::warning::AutoFactory knowledge graph: ${w}`);
  } else {
    console.log("Knowledge graph: off (auto-factory-knowledge-graph) — agents run un-enriched (baseline).");
  }

  const runner = createAgentRunner(provider, kg);

  // The approval policy: mode (yolo / risk-threshold / always) + risk threshold
  // + gated steps, all from LaunchDarkly flags, COMPILED into pre-execution
  // gates (see approvalPolicy.ts). A gate is satisfied by a PR label
  // `af-approve:<nodeKey>`; the chain halts before a gated node until its label
  // is present (a re-run after the label is added proceeds past it).
  const policy = await resolveApprovalPolicy(ldClient, ldContext);
  let approvedSteps = new Set<string>();
  if (policy.mode !== "yolo") {
    approvedSteps = await fetchApprovedSteps(context.REPO, context.PR_NUMBER, process.env.GITHUB_TOKEN);
  }
  const gate = createPolicyGate(policy, (node) => approvedSteps.has(node));
  const stepsDesc = policy.steps.map((s) => s.step + (s.threshold !== undefined ? `@${s.threshold}` : "")).join(", ");
  console.log(
    `Approval policy: mode=${policy.mode} (source: ${policy.modeSource === "env" ? "APPROVAL_MODE env override" : "LD flags"})` +
      (policy.mode === "risk-threshold" ? ` threshold=${policy.threshold}` : "") +
      (gate ? ` steps=[${stepsDesc}]; approved: [${[...approvedSteps].join(", ") || "none"}]` : " (no gates)"),
  );

  // Judges attached to agent configs in LaunchDarkly (e.g. implementation- and
  // metrics-quality judges) score node outputs 0..1; scores record per-variation
  // in AI Config monitoring — the quality dimension of the model A/B. Evidence:
  // each judged node's ACTUAL commits (node-scoped git diff of the checkout the
  // agents push to) so judges verify the agent's report rather than trust it.
  const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "examples/demo-app");
  const judgeCompletion = createJudgeCompletion(provider);
  const baseJudgeHook = judgeCompletion
    ? createJudgeHook({
        aiClient,
        ldContext,
        variables: buildVariables(context),
        completion: judgeCompletion,
        provider,
        evidence: createGitDiffEvidence(sandboxRoot),
      })
    : undefined;
  // Capture judge scores per node for the PR summary table.
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
  // evidence (LaunchDarkly + the checkout). Same connection flag creation uses;
  // without one the LD-side checks are skipped and code-side checks still run.
  const verifierWriter = flagCreationWriter();
  const verifier = buildHandoffVerifier({ sandboxRoot, ...(verifierWriter ? { writer: verifierWriter } : {}) });

  const walk = await walkGraph(graphDef, runner, context, graphTracker, undefined, gate, judgeHook, verifier);

  // Per-node visibility: dump each agent's terminal status, routing tags, and final output.
  for (const r of walk.runs) {
    console.log(`\n════════ ${r.configKey} [${r.status}] ════════`);
    console.log(`tags: ${JSON.stringify(r.tags)}`);
    console.log((r.output || "(no output)").slice(0, 4000));
  }
  console.log("\n──────── walk summary ────────");

  console.log(`Ran ${walk.runs.length} node(s): ${walk.runs.map((r) => r.configKey).join(" → ")}`);
  if (walk.skipped.length) console.log(`Skipped: ${walk.skipped.join(", ")}`);

  // Make a stall observable: when the chain stops on an unmet handoff (a required
  // routing tag was never produced) rather than at a terminal node, say so loudly
  // — as a GitHub Actions warning annotation and in the PR comment — instead of
  // letting it surface only as a misleading verdict (issue #9 item #3).
  const stallText = walk.stalledAt ? describeStall(walk.stalledAt) : "";
  if (stallText) console.log(`::warning::AutoFactory: ${stallText}`);

  // A deterministic handoff shim failed: a claim could not be re-derived from
  // primary evidence. This is a mechanical finding, not a model judgment —
  // surface it as an error annotation and fail the run below.
  const verifyText = walk.verificationFailed
    ? `deterministic check failed after '${walk.verificationFailed.node}': ` +
      walk.verificationFailed.failures.map((f) => `[${f.name}] ${f.detail}`).join("; ")
    : "";
  if (verifyText) console.log(`::error::AutoFactory: ${verifyText}`);

  // Halted at an approval gate: report what's pending + how to approve, then
  // stop. The flag/code for the gated step have NOT been created. A re-run once
  // the label is added proceeds past the gate.
  if (walk.pendingApproval) {
    const node = walk.pendingApproval.node;
    const label = approveLabel(node);
    await ensureLabel(context.REPO, label, process.env.GITHUB_TOKEN);
    console.log(`::warning::AutoFactory: awaiting approval before '${node}'. Add the PR label '${label}' to proceed.`);
    const summary = buildGateComment(policy.steps.map((s) => s.step), approvedSteps, node);
    await postPrComment(summary, { prNumber: context.PR_NUMBER, repo: context.REPO });
    // Carry the pause as a distinct `action_required` check run rather than a red
    // failure, so it doesn't read as a pipeline error or a reviewer rejection
    // (which also exit 1). The job itself exits 0 — the check run is the signal.
    await postCheckRun({
      repo: context.REPO,
      headSha: context.HEAD_SHA,
      conclusion: "action_required",
      title: `Approval required before ${node}`,
      summary: `The AutoFactory chain paused before \`${node}\`. Nothing was created for this or later steps. Add the PR label \`${label}\` to approve; the chain resumes on the next run.`,
    });
    return;
  }

  // Gates were active and all cleared: post a `success` check under the same
  // name so it supersedes any earlier `action_required` on this head SHA.
  if (gate) {
    await postCheckRun({
      repo: context.REPO,
      headSha: context.HEAD_SHA,
      conclusion: "success",
      title: "Approval gates satisfied",
      summary: `Approved step(s): ${[...approvedSteps].join(", ") || "(none gated this run)"}. The chain proceeded past all gates.`,
    });
  }

  // Release intent: validate + surface on the PR; stamp approvedBy on gate clear.
  const intentReview = await reviewManifestIntent({
    sandboxRoot,
    ...(context.PR_NUMBER ? { prNumber: context.PR_NUMBER } : {}),
    ...(context.REPO ? { repo: context.REPO } : {}),
    gatesCleared: gate !== undefined && approvedSteps.size > 0,
    ...(process.env.PR_BRANCH ? { prBranch: process.env.PR_BRANCH } : {}),
  });
  if (intentReview.warning) console.log(`::warning::AutoFactory: ${intentReview.warning}`);

  const verdict = interpretWalk(walk.tags);
  const decision = decideApproval(verdict);

  console.log(`Verdict → ${decision.reason}`);
  if (decision.apply) {
    console.log("✓ Changes approved and applied by the agents.");
  } else if (decision.noop) {
    console.log("• No flag needed — nothing to apply.");
  } else if (decision.incomplete) {
    console.log("⚠ Incomplete — the chain did not complete a code review (see the stall above).");
  } else {
    console.log("✗ Not applied — code review REJECTED.");
  }

  // Per-agent results table: status, routing tags, and judge score (when a
  // LaunchDarkly judge evaluated the node). This is the at-a-glance record the
  // PR reader gets without opening the Actions log.
  const agentRows = walk.runs.map((r) => {
    const judge = judgeScores.get(r.configKey);
    const tags =
      Object.entries(r.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
        .slice(0, 140) || "—";
    return `| \`${r.configKey}\` | ${r.status} | ${judge !== undefined ? judge.toFixed(2) : "—"} | ${tags} |`;
  });
  const summary = [
    "### LaunchDarkly Auto-Factory — Phase 1",
    "",
    `**Verdict:** ${decision.reason}` +
      (policy.mode !== "yolo" ? ` _(approval mode: ${policy.mode}${policy.mode === "risk-threshold" ? ` @ ${policy.threshold}` : ""})_` : ""),
    intentReview.line ?? "",
    intentReview.warning ? `**⚠ Release intent:** ${intentReview.warning}` : "",
    configDrift ? `**⚠ Config drift:** ${configDrift}` : "",
    kg
      ? `**Knowledge graph:** on — ${kg.graph.edges.filter((e) => e.kind === "service_calls").length} service edges (traces), ` +
        `${kg.graph.edges.filter((e) => e.kind === "flag_wraps").length} wrap points (code refs)` +
        (kg.warnings.length ? `; ⚠ ${kg.warnings.map((w) => w.split(" — ")[0]).join("; ⚠ ")}` : "")
      : "",
    walk.skipped.length ? `**Skipped:** ${walk.skipped.join(", ")}` : "",
    stallText ? `**⚠ Stalled:** ${stallText}` : "",
    verifyText ? `**⛔ Deterministic check failed:** ${verifyText}` : "",
    "",
    "| Agent | Status | Judge | Tags |",
    "|---|---|---|---|",
    ...(agentRows.length ? agentRows : ["| (none ran) | — | — | — |"]),
  ]
    .filter(Boolean)
    .join("\n");
  await postPrComment(summary, { prNumber: context.PR_NUMBER, repo: context.REPO });

  // Always post the verdict as a named check run, attached to the POST-chain
  // HEAD: the agents' [skip ci] commits move the PR head past the workflow's own
  // check, so without this the PR's latest commit shows no AutoFactory status.
  await postCheckRun({
    name: "AutoFactory — Phase 1",
    repo: context.REPO,
    headSha: checkoutHeadSha(sandboxRoot) ?? context.HEAD_SHA,
    conclusion: !walk.verificationFailed && (decision.apply || decision.noop) ? "success" : "failure",
    title: walk.verificationFailed ? `Deterministic check failed after ${walk.verificationFailed.node}` : decision.reason,
    summary,
  });

  // Non-zero exit fails the PR check. Green: applied, human-approval pause, or a
  // no-op (no flag needed). Red: a genuine rejection, an incomplete run (the
  // chain stalled / never reviewed), or a failed deterministic check — each
  // carries its own distinct message above.
  if (walk.verificationFailed || (!decision.apply && !decision.noop)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    // Close the SDK so the event loop drains and the process exits (use
    // exitCode above, not process.exit, so this still runs).
    .finally(() => closeLdSdk());
}
