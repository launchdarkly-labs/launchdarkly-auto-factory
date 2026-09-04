/**
 * Argument surface of the `autofactory` CLI. Kept as a pure function (argv +
 * env in, options out) so it's unit-testable without a process.
 *
 *   autofactory run [--graph <key>] [--approve <nodeKey>]... [--dry-run]
 *                   [--base <ref>] [--root <dir>]
 *   autofactory intake --issue <n> [--repo <owner/name>] [--graph <key>]
 *                   [--node <configKey>] [--base <ref>] [--root <dir>]
 *                   [--draft] [--pr-label <name>] [--no-pr] [--dry-run]
 *
 * `intake` is the ISSUE entry point (ADR 0019): it runs the graph's intake node
 * (the issue coder) on a fresh branch, pushes, and opens the PR that the regular
 * chain then processes as usual. Two runs, joined by the issue (the PR body
 * carries an intent marker the Action reads).
 *
 * `--approve` is the CLI's approval-gate answer (ADR 0008): when a run halts at
 * a gate (exit code PENDING_APPROVAL), the caller re-runs with `--approve
 * <nodeKey>` for every step the human said yes to. There is no stdin blocking —
 * the front end driving the CLI (a human, or Claude Code) owns the question.
 */

export const EXIT = {
  /** Reviewer approved, or a clean no-op (no flag needed). */
  OK: 0,
  /** Rejection, incomplete chain, failed deterministic check, or runtime error. */
  FAILED: 1,
  /** Bad usage / missing configuration / nothing to process. */
  USAGE: 2,
  /** Halted before a gated step awaiting human approval — re-run with --approve. */
  PENDING_APPROVAL: 3,
  /**
   * An agent asked a human a question it could not answer from the repo (e.g.
   * the metrics author's M14 trace-delivery pause). Answer by editing the
   * release manifest's `humanInput.answer`, then re-run the same command.
   */
  PENDING_INPUT: 4,
} as const;

export interface CliOptions {
  command: "run";
  /** Repo the chain operates on (the app repo working tree). */
  root: string;
  graphKey: string;
  /** Base branch/ref the change is diffed against. */
  base: string;
  /** Read-only: no flag/metric creation, no file edits. */
  dryRun: boolean;
  /** Gated node keys a human has approved (see EXIT.PENDING_APPROVAL). */
  approve: string[];
}

/** Options for `autofactory intake` (the issue entry point). */
export interface IntakeOptions {
  command: "intake";
  /** GitHub issue number to implement. */
  issue: number;
  /** `owner/name`; default: derived from the repo's `origin` remote. */
  repo?: string;
  /** Checkout of the app repo the coder works in (clean working tree required). */
  root: string;
  graphKey: string;
  /** Intake node (config key) to run; must be an intake node of the graph. */
  node: string;
  /** Base branch the working branch forks from and the PR targets. */
  base: string;
  /** Read-only: no branch, no edits, no push, no PR (the coder still reasons about the issue). */
  dryRun: boolean;
  /** Open the PR as a draft. */
  draft: boolean;
  /** Label to add to the opened PR (e.g. `autofactory` for label-gated repos). */
  prLabel?: string;
  /** Push the branch but do not open a PR. */
  noPr: boolean;
}

export const DEFAULT_INTAKE_NODE = "autofactory-issue-coder";

export type ParseResult = { options: CliOptions } | { intake: IntakeOptions } | { help: true } | { error: string };

export function usage(): string {
  return [
    "Usage: autofactory run [options]",
    "       autofactory intake --issue <n> [options]",
    "",
    "run: Runs AutoFactory Phase 1 (the full agent chain from LaunchDarkly) against the",
    "current working tree: flag, wiring, metrics, tests, manifest, review verdict.",
    "Edits stay in the working tree; nothing is committed or pushed.",
    "",
    "intake: The ISSUE entry point. Runs the graph's intake node (the issue coder) on a",
    "fresh branch `autofactory/issue-<n>` of the repo at --root, PUSHES it, and opens a",
    "PR (Closes #<n>, plus an intent marker) — the regular chain then runs on that PR.",
    "Requires a clean working tree and a GitHub token (AUTOFACTORY_INTAKE_TOKEN,",
    "GITHUB_TOKEN, or a logged-in `gh`).",
    "",
    "Options (run):",
    "  --graph <key>       Agent graph to walk (default: $GRAPH_KEY or gha-auto-factory)",
    "  --approve <node>    Approve a gated step; repeat per step (see exit code 3)",
    "  --dry-run           Read-only: no flags/metrics created, no files edited",
    "  --base <ref>        Base ref to diff against (default: $PR_BASE_REF or main)",
    "  --root <dir>        Repo to operate on (default: current directory)",
    "  -h, --help          Show this help",
    "",
    "Options (intake):",
    "  --issue <n>         GitHub issue number to implement (required)",
    "  --repo <owner/name> Repository (default: from the checkout's origin remote)",
    `  --node <key>        Intake node to run (default: ${DEFAULT_INTAKE_NODE})`,
    "  --draft             Open the PR as a draft",
    "  --pr-label <name>   Add a label to the opened PR (label-gated repos)",
    "  --no-pr             Push the branch but do not open a PR",
    "  --graph/--base/--root/--dry-run  as for run",
    "",
    "Environment (read from the invoking directory's .env, then the process env):",
    "  LD_SDK_KEY, LD_PROJECT_KEY            factory project (agent configs + flags)",
    "  LD_API_KEY, LD_APP_PROJECT_KEY        app project writes (not needed for --dry-run)",
    "  ANTHROPIC_API_KEY                     execution backend (default 'anthropic' provider)",
    "  AWS_REGION + AWS credential chain     execution backend when the provider flag serves 'bedrock'",
    "",
    "Exit codes:",
    "  0  reviewer approved, or clean no-op (no flag needed)",
    "  1  review rejected, chain incomplete, or a deterministic check failed",
    "  2  usage/configuration error, or nothing to process",
    "  3  paused at an approval gate — re-run with --approve <node> after a human approves",
    "  4  paused on an agent's question — answer in the manifest's humanInput.answer, re-run",
  ].join("\n");
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): ParseResult {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") return { help: true };
  if (argv[0] === "intake") return parseIntakeArgs(argv.slice(1), env);
  if (argv[0] !== "run") return { error: `unknown command '${argv[0]}' — commands are 'run' and 'intake'` };

  const options: CliOptions = {
    command: "run",
    root: process.cwd(),
    graphKey: env.GRAPH_KEY || "gha-auto-factory",
    base: env.PR_BASE_REF || "main",
    dryRun: false,
    approve: [],
  };

  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = (): string | undefined => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--graph": {
        const v = next();
        if (!v) return { error: "--graph requires a graph key" };
        options.graphKey = v;
        break;
      }
      case "--approve": {
        const v = next();
        if (!v) return { error: "--approve requires an agent node key" };
        options.approve.push(v);
        break;
      }
      case "--base": {
        const v = next();
        if (!v) return { error: "--base requires a git ref" };
        options.base = v;
        break;
      }
      case "--root": {
        const v = next();
        if (!v) return { error: "--root requires a directory" };
        options.root = v;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        return { error: `unknown option '${arg}'` };
    }
  }
  return { options };
}

function parseIntakeArgs(args: string[], env: Record<string, string | undefined>): ParseResult {
  const intake: IntakeOptions = {
    command: "intake",
    issue: 0,
    root: process.cwd(),
    graphKey: env.GRAPH_KEY || "gha-auto-factory",
    node: env.INTAKE_NODE || DEFAULT_INTAKE_NODE,
    base: env.PR_BASE_REF || "main",
    dryRun: false,
    draft: false,
    noPr: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = (): string | undefined => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--issue": {
        const v = next();
        const n = v ? Number(v.replace(/^#/, "")) : NaN;
        if (!Number.isInteger(n) || n <= 0) return { error: "--issue requires a positive issue number" };
        intake.issue = n;
        break;
      }
      case "--repo": {
        const v = next();
        if (!v || !/^[^/\s]+\/[^/\s]+$/.test(v)) return { error: "--repo requires owner/name" };
        intake.repo = v;
        break;
      }
      case "--graph": {
        const v = next();
        if (!v) return { error: "--graph requires a graph key" };
        intake.graphKey = v;
        break;
      }
      case "--node": {
        const v = next();
        if (!v) return { error: "--node requires an agent node key" };
        intake.node = v;
        break;
      }
      case "--base": {
        const v = next();
        if (!v) return { error: "--base requires a git ref" };
        intake.base = v;
        break;
      }
      case "--root": {
        const v = next();
        if (!v) return { error: "--root requires a directory" };
        intake.root = v;
        break;
      }
      case "--pr-label": {
        const v = next();
        if (!v) return { error: "--pr-label requires a label name" };
        intake.prLabel = v;
        break;
      }
      case "--draft":
        intake.draft = true;
        break;
      case "--no-pr":
        intake.noPr = true;
        break;
      case "--dry-run":
        intake.dryRun = true;
        break;
      default:
        return { error: `unknown option '${arg}'` };
    }
  }
  if (!intake.issue) return { error: "intake requires --issue <n>" };
  return { intake };
}
