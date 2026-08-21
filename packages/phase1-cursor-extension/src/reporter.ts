/**
 * Reporting seam. `runChain` talks to a `RunReporter`; the extension's
 * implementation fans out to the output channel, the progress notification, and
 * the sidebar webview. Keeping it an interface means the orchestration has no
 * VS Code dependency and stays testable.
 */

import type { ApprovalDecision, NodeRun } from "@auto-factory/shared";

/** The five Phase 1 agents, in chain order, with display labels for the UI. */
export const NODE_SEQUENCE: ReadonlyArray<{ key: string; title: string; blurb: string }> = [
  { key: "autofactory-research-planner", title: "Research & Plan", blurb: "classify the change, plan the work" },
  { key: "autofactory-flag-implementer", title: "Flag", blurb: "create the flag, wire the code" },
  { key: "autofactory-metrics-author", title: "Metrics", blurb: "guarded-release metrics + instrumentation" },
  { key: "autofactory-flag-testing", title: "Tests", blurb: "flag-on / flag-off tests" },
  { key: "autofactory-code-reviewer", title: "Review", blurb: "verdict + risk level" },
];

export function nodeTitle(configKey: string): string {
  return NODE_SEQUENCE.find((n) => n.key === configKey)?.title ?? configKey;
}

export interface RunResult {
  runs: NodeRun[];
  skipped: string[];
  tags: Record<string, string>;
  decision: ApprovalDecision;
  mode: string;
  provider: string;
  /** Set when the run stopped at an approval gate (the user declined to proceed). */
  pendingApproval?: { node: string };
  /**
   * Set when an agent paused the chain on a question for a human (M14).
   * Answer lives in the release manifest's `humanInput.answer`; re-run after.
   */
  pendingInput?: { node: string; question?: string };
}

export interface RunReporter {
  /** A line of detail (also mirrored to the output log). */
  log(line: string): void;
  /** A node is about to run. */
  nodeStart(configKey: string): void;
  /** A node finished; `run` carries status, tags, and output. */
  nodeComplete(run: NodeRun): void;
  /** The chain completed (reached approval). */
  done(result: RunResult): void;
  /** The run failed before completing. */
  failed(message: string): void;
}
