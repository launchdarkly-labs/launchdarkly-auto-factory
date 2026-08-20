/**
 * LaunchDarkly resource writer for the agent write tools.
 *
 * Programmatic flag + metric creation are REST operations (no SDK creates them),
 * so this wraps the `api-`-key `LdClient` pointed at the APP/data-plane project.
 * Kept tiny and idempotent: LaunchDarkly returns 409 when the resource already
 * exists (PR re-runs on synchronize), which we report rather than treat as an
 * error.
 */

import { findActiveRelease } from "../releaseAdapter.js";
import type { LdClient } from "../ldClient.js";
import type { Scope } from "../types.js";

/**
 * AutoFactory variation convention (multivariate-only, decided 2026-07-17):
 * every flag is a STRING multivariate flag whose variation VALUES are the fixed
 * lineage `control`, `v1`, `v2`, … — deterministic for agents; semantics live
 * in the variation name/description. `control` is always the off-variation
 * (existing behavior); the latest `vN` is the current treatment. Iterations on
 * released behavior append the next `vN` instead of mutating a served one —
 * that is what keeps deploy decoupled from release across follow-up PRs.
 */
export const CONTROL_VARIATION = "control";
const VN_RE = /^v(\d+)$/;

/** Next value in the vN lineage given the existing variation values. */
export function nextVariationValue(values: unknown[]): string {
  let max = 0;
  for (const v of values) {
    const m = typeof v === "string" ? VN_RE.exec(v) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `v${max + 1}`;
}

/** Highest vN value present (the current treatment lineage tip), if any. */
/**
 * Position of a value in the vN lineage, or undefined if it is not a lineage variation
 * (`control`, a boolean, a hand-named variation).
 *
 * Exists so callers can tell FORWARD from BACKWARD along the lineage. Beacon needs that to
 * refuse a release that would move an environment to an OLDER variation than it already
 * serves — see the regression guard in `trigger.ts`.
 */
export function variationLineageIndex(value: unknown): number | undefined {
  const m = typeof value === "string" ? VN_RE.exec(value) : null;
  return m ? Number(m[1]) : undefined;
}

export function latestVariationValue(values: unknown[]): string | undefined {
  let max = 0;
  for (const v of values) {
    const m = typeof v === "string" ? VN_RE.exec(v) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max > 0 ? `v${max}` : undefined;
}

export interface CreateFlagArgs {
  /** Flag key (e.g. "enable-farewell"). */
  key: string;
  /** Human-readable name. Defaults to the key. */
  name?: string;
  description?: string;
  /** What the v1 treatment does — becomes the v1 variation's description. */
  treatmentDescription?: string;
  /** Extra tags, merged with the standard auto-factory tags. */
  tags?: string[];
  /**
   * Release scope from `.release-flags/*.json`. When `frontend` or `fullstack`,
   * the flag is exposed to the client-side SDK (browser/mobile web). Backend-only
   * flags stay server-side.
   */
  scope?: Scope;
}

/** Frontend and fullstack flags are evaluated in browser SDKs — must be client-visible. */
export function scopeNeedsClientSide(scope?: Scope): boolean {
  return scope === "frontend" || scope === "fullstack";
}

/**
 * Guarded-release metric categories. Each maps to a LaunchDarkly metric shape:
 *  - error    → occurrence (isNumeric=false), LowerThanBaseline
 *  - latency  → numeric (isNumeric=true, unit, average aggregation), LowerThanBaseline
 *  - business → occurrence (isNumeric=false), HigherThanBaseline
 */
export type MetricCategory = "error" | "latency" | "business";

export interface CreateMetricArgs {
  /** Metric key, e.g. "enable-fact-endpoint-error-rate". */
  key: string;
  /** Custom event name the app emits via `track()` — what the metric measures.
   *  Required for event-backed metrics; ignored when `traceQuery` is set. */
  eventKey?: string;
  category: MetricCategory;
  /** Human-readable name. Defaults to the key. */
  name?: string;
  description?: string;
  /** Randomization unit; MUST match the flag rollout's unit. Default "user". */
  randomizationUnit?: string;
  /** Numeric unit (latency only). Default "ms". */
  unit?: string;
  /**
   * TRACE-BACKED metric (ADR 0010): an observability span filter, e.g.
   * "service_name=togglemart-gateway AND span_name=\"GET /api/storefront\"".
   * Only valid when the flag is evaluated INSIDE the matched trace (the o11y
   * SDK's afterEvaluation hook enriches the span) — otherwise the metric
   * cannot attribute. When set, the metric is created as kind=trace with no
   * eventKey; latency-category trace metrics measure `traceValueLocation`.
   */
  traceQuery?: string;
  /** Numeric value source for latency trace metrics. Default "duration". */
  traceValueLocation?: string;
  /** Extra tags, merged with the standard auto-factory tags. */
  tags?: string[];
}

export interface LdWriteResult {
  created: boolean;
  alreadyExists: boolean;
  key: string;
  detail: string;
}

/** One environment's targeting picture in a `FlagState`. */
export interface FlagEnvState {
  on: boolean;
  /** Variation values fallthrough serves (single, or rollout arms with weight > 0). */
  fallthroughServes: string[];
  offVariation?: string;
  prerequisites: Array<{ flagKey: string }>;
  /** Variation values any targeting rule serves (>0% arms included). */
  rulesServe: string[];
  /** Individual user/context targets exist (QA pinning — NOT counted as released). */
  individualTargets: boolean;
  /** In-progress automated release, or "unknown" when the read failed. */
  activeRelease?: { status: string; kind?: string } | "unknown";
  /** Variation values serving real traffic in this env (on + fallthrough/rules). */
  released: string[];
}

/** Result of `LdResourceWriter.getFlagState` — the flag_action evidence. */
export interface FlagState {
  exists: boolean;
  key: string;
  kind: "boolean" | "multivariate";
  variations: Array<{ value: string; name?: string; description?: string }>;
  /** Tip of the vN lineage (multivariate flags), e.g. "v2". */
  latestVariation?: string;
  temporary?: boolean;
  tags?: string[];
  environments: Record<string, FlagEnvState>;
}

/** Raw REST flag shape (the fields getFlagState reads). */
interface RawFlag {
  variations?: Array<{ value?: unknown; name?: string; description?: string }>;
  temporary?: boolean;
  tags?: string[];
  environments?: Record<
    string,
    {
      on?: boolean;
      offVariation?: number;
      fallthrough?: { variation?: number; rollout?: { variations?: Array<{ variation?: number; weight?: number }> } };
      rules?: Array<{ variation?: number; rollout?: { variations?: Array<{ variation?: number; weight?: number }> } }>;
      prerequisites?: Array<{ key?: string }>;
      targets?: unknown[];
      contextTargets?: unknown[];
    }
  >;
}

/** Stable string form of a variation value (boolean true → "true"). */
function valueString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * The deterministic released-ness rule (design 2026-07-17): a variation is
 * RELEASED when, in the environment of record (`production` when the flag has
 * one, else conservatively ANY environment), the flag is on and fallthrough or
 * a rule serves it to real traffic — or an automated release is in progress
 * (mid-release counts as released; the next iteration must be a new variation).
 * Individual QA targets do NOT count. Drives ride_existing vs extend_variation.
 */
export function variationReleased(
  state: FlagState,
  variationValue: string,
): { released: boolean; envs: string[]; reason: string } {
  if (!state.exists) return { released: false, envs: [], reason: `flag '${state.key}' does not exist` };
  const envKeys = state.environments["production"] ? ["production"] : Object.keys(state.environments);
  const envs: string[] = [];
  const reasons: string[] = [];
  for (const envKey of envKeys) {
    const env = state.environments[envKey];
    if (!env) continue;
    if (env.released.includes(variationValue)) {
      envs.push(envKey);
      reasons.push(`serving in '${envKey}'`);
    } else if (env.activeRelease && env.activeRelease !== "unknown" && env.activeRelease.status === "in_progress") {
      envs.push(envKey);
      reasons.push(`automated release in progress in '${envKey}'`);
    }
  }
  return {
    released: envs.length > 0,
    envs,
    reason: envs.length
      ? reasons.join("; ")
      : `'${variationValue}' serves no real traffic in ${envKeys.map((e) => `'${e}'`).join(", ")} and no release is in progress`,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Raw REST flag shape used by the prerequisite wiring (variations + env targeting). */
interface PrereqFlag {
  variations?: Array<{ _id?: string; value?: unknown }>;
  defaults?: { onVariation?: number; offVariation?: number };
  environments?: Record<
    string,
    {
      on?: boolean;
      offVariation?: number;
      fallthrough?: { variation?: number; rollout?: { variations?: Array<{ variation?: number; weight?: number }> } };
      prerequisites?: Array<{ key?: string }>;
    }
  >;
}

/**
 * The variation id a parent flag CURRENTLY serves to real traffic in `env`:
 * fallthrough (single, else the heaviest rollout arm, else the default
 * on-variation) when on; the off-variation when off. Used to decide whether a
 * prerequisite is already MET at wire time.
 */
function servedParentVariationId(parent: PrereqFlag, env: string): string | undefined {
  const vars = parent.variations ?? [];
  const byIndex = (idx: number | undefined): string | undefined => (idx === undefined ? undefined : vars[idx]?._id);
  const cfg = parent.environments?.[env];
  if (!cfg) return undefined;
  if (cfg.on !== true) return byIndex(cfg.offVariation) ?? byIndex(parent.defaults?.offVariation);
  const single = byIndex(cfg.fallthrough?.variation);
  if (single) return single;
  const arms = [...(cfg.fallthrough?.rollout?.variations ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return byIndex(arms[0]?.variation) ?? byIndex(parent.defaults?.onVariation);
}

/**
 * Which parent variation a prerequisite should pin in `env`.
 * Boolean parents: "on" → true, "off" → false (same id in every env).
 * Multivariate parents: an explicit value ("v2") wins; "on" resolves to what
 * that environment's fallthrough points at (single variation, else the
 * heaviest rollout arm, else the flag's default on-variation) — i.e. the
 * variation the parent serves, or will serve, when live in that environment;
 * "off" resolves to the environment's off-variation.
 */
function resolveParentVariationId(parent: PrereqFlag, parentKey: string, env: string, variation: string): string {
  const vars = parent.variations ?? [];
  const isBoolean = vars.some((v) => typeof v.value === "boolean");

  if (isBoolean) {
    if (variation !== "on" && variation !== "off") {
      throw new Error(`parent flag '${parentKey}' is boolean — prerequisite variation must be 'on' or 'off', got '${variation}'`);
    }
    const want = variation === "on";
    const match = vars.find((v) => v.value === want);
    if (!match?._id) throw new Error(`parent flag '${parentKey}' has no boolean '${variation}' variation`);
    return match._id;
  }

  const byIndex = (idx: number | undefined): string | undefined =>
    idx === undefined ? undefined : vars[idx]?._id;

  if (variation !== "on" && variation !== "off") {
    const match = vars.find((v) => v.value === variation);
    if (!match?._id) throw new Error(`parent flag '${parentKey}' has no variation with value '${variation}'`);
    return match._id;
  }

  const cfg = parent.environments?.[env];
  if (variation === "off") {
    const id = byIndex(cfg?.offVariation) ?? byIndex(parent.defaults?.offVariation);
    if (!id) throw new Error(`parent flag '${parentKey}' has no resolvable off-variation in '${env}'`);
    return id;
  }
  // "on": the environment's fallthrough target — single variation, else the
  // heaviest rollout arm, else the project default on-variation.
  let id = byIndex(cfg?.fallthrough?.variation);
  if (!id) {
    const arms = [...(cfg?.fallthrough?.rollout?.variations ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    id = byIndex(arms[0]?.variation);
  }
  if (!id) id = byIndex(parent.defaults?.onVariation);
  if (!id) throw new Error(`parent flag '${parentKey}' has no resolvable serving variation in '${env}'`);
  return id;
}

export class LdResourceWriter {
  constructor(private readonly ld: LdClient) {}

  get projectKey(): string {
    return this.ld.projectKey;
  }

  /**
   * Create a STRING MULTIVARIATE feature flag following the AutoFactory
   * convention: temporary, variations `control` (off-variation, existing
   * behavior) + `v1` (treatment), created dark. Multivariate from day one is
   * deliberate — LaunchDarkly fixes a flag's kind at creation, so only flags
   * born multivariate can take `v2`, `v3`, … iteration variations later.
   */
  async createFlag(args: CreateFlagArgs): Promise<LdWriteResult & { variation: string }> {
    if (!args.key) throw new Error("flag key is required");
    const clientSide = scopeNeedsClientSide(args.scope);
    const body = {
      key: args.key,
      name: args.name || args.key,
      ...(args.description ? { description: args.description } : {}),
      temporary: true,
      tags: dedupe(["auto-factory", "auto-generated", ...(args.tags ?? [])]),
      variations: [
        {
          value: CONTROL_VARIATION,
          name: "Control",
          description: "Existing behavior — served while the flag is off (safe default).",
        },
        {
          value: "v1",
          name: "v1",
          description: args.treatmentDescription || "New behavior introduced by this PR.",
        },
      ],
      // On = v1 (index 1); Off = control (index 0) — flag-off preserves existing behavior.
      defaults: { onVariation: 1, offVariation: 0 },
      ...(clientSide
        ? { clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: false } }
        : {}),
    };
    const res = await this.ld.createFlag(body);
    const alreadyExists = res.status === 409;
    if (clientSide && alreadyExists) {
      await this.ensureClientSideAvailability(args.key);
    }
    const clientSideNote = clientSide ? " Client-side SDK availability enabled." : "";
    return {
      created: !alreadyExists,
      alreadyExists,
      key: args.key,
      variation: "v1",
      detail: alreadyExists
        ? `Flag '${args.key}' already exists in project '${this.ld.projectKey}' (no change).${clientSideNote}`
        : `Created multivariate flag '${args.key}' (control + v1, dark) in project '${this.ld.projectKey}'.${clientSideNote}`,
    };
  }

  /**
   * Append the next variation in the vN lineage to an existing MULTIVARIATE
   * flag — the iteration path for follow-up PRs whose flagged behavior is
   * already released. Adding a variation serves nothing until targeting points
   * at it, so this is always safe on a live flag.
   *
   * Idempotent per intended value: pass the `value` the research brief chose
   * (e.g. "v2") and a PR re-run reuses it instead of minting "v3".
   * Throws on legacy boolean flags — LaunchDarkly cannot add variations to
   * them; iteration there goes through a child flag instead.
   */
  async addVariation(
    flagKey: string,
    opts: { value?: string; name?: string; description?: string } = {},
  ): Promise<LdWriteResult & { variation: string }> {
    if (!flagKey) throw new Error("flag key is required");
    let flag: { data: { variations?: Array<{ value?: unknown }> } };
    try {
      flag = await this.ld.getFlag(flagKey);
    } catch {
      throw new Error(`flag '${flagKey}' not found in project '${this.ld.projectKey}'`);
    }
    const values = (flag.data.variations ?? []).map((v) => v.value);
    if (values.some((v) => typeof v === "boolean")) {
      throw new Error(
        `'${flagKey}' is a legacy BOOLEAN flag — LaunchDarkly cannot add variations to it. ` +
          `Iterate via a child flag with '${flagKey}' as its prerequisite instead.`,
      );
    }
    const value = opts.value?.trim() || nextVariationValue(values);
    if (!VN_RE.test(value)) {
      throw new Error(
        `variation value must follow the vN lineage (v2, v3, …), got '${value}' — semantics belong in the name/description`,
      );
    }
    if (values.includes(value)) {
      return {
        created: false,
        alreadyExists: true,
        key: flagKey,
        variation: value,
        detail: `Variation '${value}' already exists on '${flagKey}' (no change — safe re-run).`,
      };
    }
    await this.ld.patchFlagJson(
      flagKey,
      [
        {
          op: "add",
          path: "/variations/-",
          value: {
            value,
            name: opts.name || value,
            ...(opts.description ? { description: opts.description } : {}),
          },
        },
      ],
      `AutoFactory: add iteration variation ${value}`,
    );
    return {
      created: true,
      alreadyExists: false,
      key: flagKey,
      variation: value,
      detail:
        `Added variation '${value}' to '${flagKey}' in project '${this.ld.projectKey}'. ` +
        `Nothing is served from it yet — it goes live when a release points targeting at it.`,
    };
  }

  /**
   * Read a flag's full state — existence, kind, variation lineage, and the
   * per-environment TARGETING picture (on/off, what fallthrough and rules
   * serve, prerequisites, active automated releases). This is the research
   * planner's evidence for the flag_action decision: whether a flag exists is
   * not enough — whether its treatment is RELEASED decides ride-vs-iterate.
   */
  async getFlagState(flagKey: string): Promise<FlagState> {
    if (!flagKey) throw new Error("flag key is required");
    let res: { data: RawFlag };
    try {
      res = await this.ld.getFlag<RawFlag>(flagKey);
    } catch {
      return { exists: false, key: flagKey, kind: "multivariate", variations: [], environments: {} };
    }
    const raw = res.data;
    const variations = (raw.variations ?? []).map((v) => ({
      value: valueString(v.value),
      ...(v.name ? { name: v.name } : {}),
      ...(v.description ? { description: v.description } : {}),
    }));
    const values = (raw.variations ?? []).map((v) => v.value);
    const kind: FlagState["kind"] = values.some((v) => typeof v === "boolean") ? "boolean" : "multivariate";
    const latest = latestVariationValue(values);

    const environments: Record<string, FlagEnvState> = {};
    for (const [envKey, cfg] of Object.entries(raw.environments ?? {})) {
      const at = (idx: number | undefined): string | undefined =>
        idx === undefined ? undefined : variations[idx]?.value;
      const served = new Set<string>();
      const fallthroughServes: string[] = [];
      const single = at(cfg?.fallthrough?.variation);
      if (single !== undefined) fallthroughServes.push(single);
      for (const arm of cfg?.fallthrough?.rollout?.variations ?? []) {
        const v = at(arm.variation);
        if (v !== undefined && (arm.weight ?? 0) > 0) fallthroughServes.push(v);
      }
      const rulesServe: string[] = [];
      for (const rule of cfg?.rules ?? []) {
        const rv = at(rule.variation);
        if (rv !== undefined) rulesServe.push(rv);
        for (const arm of rule.rollout?.variations ?? []) {
          const v = at(arm.variation);
          if (v !== undefined && (arm.weight ?? 0) > 0) rulesServe.push(v);
        }
      }
      if (cfg?.on === true) {
        for (const v of [...fallthroughServes, ...rulesServe]) served.add(v);
      }

      // Active automated release: only possible on an on flag (LD refuses to
      // start one otherwise). Internal/beta read — degrade to "unknown", never throw.
      let activeRelease: FlagEnvState["activeRelease"];
      if (cfg?.on === true) {
        try {
          const rel = await findActiveRelease(this.ld, flagKey, envKey);
          if (rel) activeRelease = { status: rel.status, kind: rel.kind };
        } catch {
          activeRelease = "unknown";
        }
      }

      environments[envKey] = {
        on: cfg?.on === true,
        fallthroughServes,
        ...(at(cfg?.offVariation) !== undefined ? { offVariation: at(cfg?.offVariation) as string } : {}),
        prerequisites: (cfg?.prerequisites ?? []).map((p) => ({ flagKey: p.key ?? "" })),
        rulesServe: [...new Set(rulesServe)],
        individualTargets: (cfg?.targets?.length ?? 0) > 0 || (cfg?.contextTargets?.length ?? 0) > 0,
        ...(activeRelease !== undefined ? { activeRelease } : {}),
        released: [...served],
      };
    }

    return {
      exists: true,
      key: flagKey,
      kind,
      variations,
      ...(latest ? { latestVariation: latest } : {}),
      ...(raw.temporary !== undefined ? { temporary: raw.temporary } : {}),
      ...(raw.tags ? { tags: raw.tags } : {}),
      environments,
    };
  }

  /**
   * Wire a flag behind a parent prerequisite in EVERY environment — the
   * release-via-prerequisites pattern Beacon uses at deploy time
   * (beacon/src/trigger.ts), applied at creation time: attach the
   * prerequisite, turn the child ON, and point its fallthrough at treatment.
   *
   * TWO MODES, decided per environment by whether the prerequisite is MET:
   *  - UNMET (parent doesn't serve the required variation yet): attach the
   *    prerequisite AND turn the child on serving treatment behind it. Safe by
   *    LD semantics — while the parent serves another variation, LaunchDarkly
   *    serves the child's OFF variation (control) to everyone — and it makes
   *    the parent's release the child's release, in lockstep.
   *  - MET (parent already serves it — e.g. iterating on a RELEASED feature):
   *    attach the prerequisite only and leave the child DARK. Arming here
   *    would put the child live the moment its code deploys (re-coupling
   *    deploy with release); instead it releases through its own normal flow,
   *    structurally gated by the prerequisite.
   *
   * `variation` names the parent variation to pin: "on"/"off" for boolean
   * parents; for MULTIVARIATE parents, "on" resolves PER ENVIRONMENT to the
   * variation that environment's targeting points at (what the parent serves —
   * or will serve — when live), "off" to its off-variation, and an explicit
   * value ("v2") pins exactly that. LaunchDarkly prerequisites pin a single
   * variationId, so when a parent later iterates v1→v2 Beacon re-points
   * children as part of the variation release (see beacon/trigger.ts).
   *
   * Idempotent: environments already wired (prerequisite present + flag on)
   * are skipped. Throws only when nothing could be applied (missing parent,
   * no matching variation).
   */
  async addPrerequisite(
    childKey: string,
    parentKey: string,
    variation: string = "on",
    childVariation?: string,
  ): Promise<string> {
    let parent: { data: PrereqFlag };
    try {
      parent = await this.ld.getFlag<PrereqFlag>(parentKey);
    } catch {
      throw new Error(`parent flag '${parentKey}' not found in project '${this.ld.projectKey}'`);
    }

    const child = await this.ld.getFlag<PrereqFlag>(childKey);
    const childVars = child.data.variations ?? [];
    // Child treatment: boolean legacy → true; multivariate → the requested vN
    // (default: the lineage tip — a fresh child's v1, an iterated child's latest).
    const childIsBoolean = childVars.some((v) => typeof v.value === "boolean");
    const wantChildValue = childIsBoolean
      ? true
      : (childVariation ?? latestVariationValue(childVars.map((v) => v.value)));
    const treatment = childVars.find((v) => v.value === wantChildValue);
    if (!treatment?._id) {
      throw new Error(`flag '${childKey}' has no treatment variation ('${String(wantChildValue)}')`);
    }
    const envs = Object.entries(child.data.environments ?? {});
    if (envs.length === 0) throw new Error(`flag '${childKey}' reports no environments`);

    const armed: string[] = [];
    const dark: string[] = [];
    const failed: string[] = [];
    for (const [env, cfg] of envs) {
      const hasPrereq = (cfg?.prerequisites ?? []).some((p) => p?.key === parentKey);
      const isOn = cfg?.on === true;
      let parentVarId: string;
      try {
        parentVarId = resolveParentVariationId(parent.data, parentKey, env, variation);
      } catch (e) {
        failed.push(`${env}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // ARM (turn the child on serving treatment behind the parent) ONLY while
      // the prerequisite is UNMET — that is what makes wiring a no-op for users
      // and the parent's release the child's release. If the parent ALREADY
      // serves the required variation, arming would put the child live the
      // moment its code deploys (re-coupling deploy with release): attach the
      // prerequisite as a structural constraint and leave the child dark for
      // its own normal release.
      const met = servedParentVariationId(parent.data, env) === parentVarId;
      const instructions: Array<Record<string, unknown>> = [];
      if (!hasPrereq) {
        instructions.push({ kind: "addPrerequisite", key: parentKey, variationId: parentVarId });
      }
      if (!met && !isOn) {
        // Same instruction pair Beacon's prerequisite release uses: on +
        // fallthrough=treatment. The unmet prerequisite keeps users on control.
        instructions.push(
          { kind: "turnFlagOn" },
          { kind: "updateFallthroughVariationOrRollout", variationId: treatment._id },
        );
      }
      if (instructions.length === 0) {
        (met && !isOn ? dark : armed).push(env); // already wired (PR re-run)
        continue;
      }
      try {
        await this.ld.patchFlagSemantic(
          childKey,
          env,
          instructions,
          met
            ? `AutoFactory: prerequisite ${parentKey}=${variation} attached (parent already released — flag stays dark for its own release)`
            : `AutoFactory: on behind prerequisite ${parentKey}=${variation} (cross-repo release coordination)`,
        );
        (met && !isOn ? dark : armed).push(env);
      } catch (e) {
        failed.push(`${env}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const applied = armed.length + dark.length;
    if (applied === 0) {
      throw new Error(`prerequisite '${parentKey}' could not be applied to any environment (${failed.join("; ")})`);
    }
    const failNote = failed.length ? ` (failed in ${failed.join("; ")})` : "";
    const parts: string[] = [];
    if (armed.length) {
      parts.push(
        `armed in ${armed.join(", ")}: '${childKey}' is ON serving treatment behind '${parentKey}'=${variation} — users get control until the parent releases, then this flag goes live with it`,
      );
    }
    if (dark.length) {
      parts.push(
        `attached in ${dark.join(", ")}: '${parentKey}' already serves the required variation there, so '${childKey}' stays DARK and releases through the normal flow, structurally gated by the prerequisite`,
      );
    }
    return `Prerequisite wired in ${applied} environment(s) — ${parts.join("; ")}.${failNote}`;
  }

  /** Idempotent: turn on client-side ID availability for an existing flag. */
  private async ensureClientSideAvailability(flagKey: string): Promise<void> {
    await this.ld.patchFlagProjectSemantic(
      flagKey,
      [{ kind: "turnOnClientSideAvailability", value: "usingEnvironmentId" }],
      "AutoFactory: expose frontend-scoped flag to client-side SDK",
    );
  }

  /**
   * Compact listing of the app project's existing metrics — lets the metrics
   * author DISCOVER global/autogenerated metrics (e.g. the `otel*` and
   * `$ld:telemetry:*` autogens) before minting feature-specific ones.
   */
  async listMetrics(filter?: { prefix?: string; tag?: string }): Promise<
    Array<{ key: string; name?: string; kind?: string; isNumeric?: boolean; tags?: string[] }>
  > {
    const res = await this.ld.listMetrics<{
      items?: Array<{ key: string; name?: string; kind?: string; isNumeric?: boolean; tags?: string[] }>;
    }>();
    let items = res.data.items ?? [];
    if (filter?.prefix) items = items.filter((m) => m.key.startsWith(filter.prefix as string));
    if (filter?.tag) items = items.filter((m) => (m.tags ?? []).includes(filter.tag as string));
    return items.map(({ key, name, kind, isNumeric, tags }) => ({ key, name, kind, isNumeric, tags }));
  }

  /**
   * Create a guarded-release metric off a custom event. Maps the friendly
   * category to LaunchDarkly's metric fields (kind=custom, isNumeric/unit,
   * successCriteria). Idempotent: a 409 (key already exists) is reported, not thrown.
   */
  async createMetric(args: CreateMetricArgs): Promise<LdWriteResult> {
    if (!args.key) throw new Error("metric key is required");
    const trace = Boolean(args.traceQuery);
    if (!trace && !args.eventKey) throw new Error("metric eventKey is required (or pass traceQuery for a trace-backed metric)");
    const numeric = args.category === "latency";
    const successCriteria = args.category === "business" ? "HigherThanBaseline" : "LowerThanBaseline";
    const unit = args.randomizationUnit || "user";
    const body: Record<string, unknown> = {
      key: args.key,
      name: args.name || args.key,
      ...(args.description ? { description: args.description } : {}),
      isNumeric: numeric,
      successCriteria,
      randomizationUnits: [unit],
      tags: dedupe(["auto-factory", "auto-generated", ...(args.tags ?? [])]),
      // Numeric (latency) metrics need a unit + an aggregation; occurrence metrics don't.
      ...(numeric ? { unit: args.unit || "ms", unitAggregationType: "average" } : {}),
      ...(trace
        ? {
            // Trace-backed (verified against the live API, 2026-07-13): the
            // regular metrics POST with kind=trace + a span filter; numeric
            // metrics read their value from traceValueLocation.
            kind: "trace",
            traceQuery: args.traceQuery,
            dataSource: { key: "launchdarkly-hosted" },
            analysisType: "mean",
            eventDefault: { disabled: false, value: 0 },
            ...(numeric ? { traceValueLocation: args.traceValueLocation || "duration" } : { unitAggregationType: "sum" }),
          }
        : { kind: "custom", eventKey: args.eventKey }),
    };
    const res = await this.ld.createMetric(body);
    const alreadyExists = res.status === 409;
    return {
      created: !alreadyExists,
      alreadyExists,
      key: args.key,
      detail: alreadyExists
        ? `Metric '${args.key}' already exists in project '${this.ld.projectKey}' (no change).`
        : trace
          ? `Created ${args.category} TRACE metric '${args.key}' (traceQuery: ${args.traceQuery}) in project '${this.ld.projectKey}'.`
          : `Created ${args.category} metric '${args.key}' (event '${args.eventKey}') in project '${this.ld.projectKey}'.`,
    };
  }
}
