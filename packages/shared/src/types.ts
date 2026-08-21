/**
 * Shared domain types for the LaunchDarkly Auto-Factory prototype.
 * Used across the config bridge, the Phase 1 GitHub Action, and Beacon (Phase 2).
 */

// ----------------------------------------------------------------------------
// Scope & release shape (Phase 2)
// ----------------------------------------------------------------------------

/** Which deploy path(s) must complete before a flag release triggers. */
export type Scope = "frontend" | "backend" | "fullstack";

/** How a flag is rolled out once its guarding code is deployed. */
export type ReleaseKind = "immediate" | "progressive" | "guarded";

/** A single rollout stage. `allocation` is in basis points (0–100000 = 0–100%). */
export interface Stage {
  allocation: number;
  durationMillis: number;
}

/** A metric attached to a guarded release. */
export interface MetricRef {
  key: string;
  /** True if `key` refers to a metric group rather than a single metric. */
  isGroup: boolean;
}

/**
 * Agent-computed release parameters carried in a `.release-flags/*.json` file.
 * Named for the precedence chain (releasePolicy in LD ← releasePlan in the
 * manifest ← releaseIntent from the human): the plan overrides the flag's
 * configured release policy; the human's intent directs the plan.
 * (`releaseOverrides` is the legacy name for this block — still read.)
 */
export interface ReleasePlan {
  releaseMethod?: ReleaseKind;
  randomizationUnit?: string;
  stages?: Stage[];
  /** Guarded-only; extends the final stage's monitoring window. */
  extensionDurationMillis?: number;
  metricKeys?: string[];
  metricGroupKeys?: string[];
  /**
   * AGENT-recommended flag dependencies (cross-repo coordination, from the
   * research planner's brief; `create_flag` wires them when the parent is in
   * the same project). Advisory for Phase 2 and humans — distinct from the
   * human-owned `releaseIntent.prerequisites`, which Beacon applies at release.
   */
  prerequisites?: IntentPrerequisite[];
}

/** Legacy alias for ReleasePlan (pre-1.1 manifests use this key). */
export type ReleaseOverrides = ReleasePlan;

/** What should happen when the guarding code deploys. */
export type IntentAction = "auto" | "hold" | "manual";

/** A flag-prerequisite relationship expressed in release intent (LD-native semantics). */
export interface IntentPrerequisite {
  flagKey: string;
  /** Variation the prerequisite must serve; "on" | "off". Default "on". */
  variation?: "on" | "off";
}

/**
 * HUMAN-authored release intent, captured on the PR (typically at an approval
 * gate) in the manifest. Structured fields are what deterministic execution
 * reads; `notes` is free text a steward agent may PROMOTE into structured
 * fields — visibly, on the PR, never at deploy time. Wins over `releasePlan`
 * on conflict. All fields optional; blank = today's behavior (auto-release).
 */
export interface ReleaseIntent {
  action?: IntentAction;
  /** ISO date (YYYY-MM-DD) before which the release must not start. */
  notBefore?: string;
  /** Serve to these LD segments immediately (recorded, not yet executed). */
  segments?: string[];
  prerequisites?: IntentPrerequisite[];
  /** Flags to release together (future LD multi-phase; recorded for now). */
  releaseWith?: string[];
  /** Ticket / doc URL — also feeds business-intent metrics later. */
  reference?: string;
  /** Auto-filled from the approval-gate label actor. */
  approvedBy?: string;
  notes?: string;
}

/**
 * A question an agent (today: the metrics author, rule M14) could not answer
 * from the repo and paused the chain on, plus the human's answer. The agent
 * writes `question` via write_manifest; the HUMAN writes `answer` by editing
 * the file on the PR branch (on GitHub that push re-triggers the workflow).
 * Resume is a fresh walk from the root (ADR 0009), so the manifest — the same
 * channel as releaseIntent — is what carries human text across runs: on the
 * re-run the agent finds `answer` present, treats it as authoritative, and
 * never re-asks. `answer` is structurally protected in write_manifest —
 * agents can never write or clear it.
 */
export interface HumanInput {
  question?: string;
  /** Human-authored; agents must never write or overwrite this. */
  answer?: string;
}

/** The on-disk shape of a `.release-flags/*.json` file. */
export interface ReleaseFlagFile {
  schemaVersion?: string;
  flagKey: string;
  /**
   * Variation this PR's code path lives under (vN lineage, schema 1.2+) —
   * present on iteration PRs that extended an existing multivariate flag.
   * Beacon releases exactly this variation (fallthrough vN-1 → vN); absent
   * means a fresh flag (whole-flag release of its treatment).
   */
  targetVariation?: string;
  /** Defaults to "frontend" when omitted (matches reference behavior). */
  scope?: Scope;
  /** Agent-computed parameters (canonical key since schema 1.1). */
  releasePlan?: ReleasePlan;
  /** Legacy key for releasePlan; pre-1.1 manifests. */
  releaseOverrides?: ReleasePlan;
  /** Human-authored intent (schema 1.1+). */
  releaseIntent?: ReleaseIntent;
  /** Agent question + human answer across a paused chain (M14). */
  humanInput?: HumanInput;
}

/** A release-flag file discovered during a deploy notification. */
export interface DiscoveredFlag extends ReleaseFlagFile {
  /** Repo-relative path of the file the flag was discovered in. */
  sourceFile: string;
}

// ----------------------------------------------------------------------------
// Approval modes (Phase 1)
// ----------------------------------------------------------------------------

/**
 * Whether human approvals gate the chain. Stored in the
 * `auto-factory-approval-mode` LaunchDarkly flag; defaults to "yolo". Modes
 * COMPILE INTO pre-execution gates (see approvalPolicy.ts) — they are not a
 * post-hoc decision:
 *  - yolo:           no gates; the chain runs unattended.
 *  - risk-threshold: gate the configured steps only when the research agent's
 *                    `risk_score` ≥ the `auto-factory-risk-threshold` flag.
 *  - always:         gate the configured steps on every run.
 * Legacy values are mapped: "middle" → risk-threshold, "manual" → always.
 */
export type ApprovalMode = "yolo" | "risk-threshold" | "always";

/** Categorical risk emitted alongside the numeric `risk_score` tag. */
export type RiskLevel = "low" | "medium" | "high";

// ----------------------------------------------------------------------------
// Deploy notification (Phase 2 — Notifier → Beacon)
// ----------------------------------------------------------------------------

/** Payload a post-deploy Notifier POSTs to Beacon. */
export interface DeployNotification {
  /** Newly-deployed commit SHA. */
  sha: string;
  /** Previously-deployed SHA; required to diff for newly-added release flags. */
  previousSha?: string;
  /** Logical service key (maps to a scope side). */
  service: string;
  /** Target environment key. */
  environment: string;
}
