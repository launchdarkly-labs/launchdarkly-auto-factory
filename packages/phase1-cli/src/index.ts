/** Public surface of @auto-factory/phase1-cli (the `autofactory` bin lives in cli.ts). */

export * from "./args.js";
export { runCli, UsageError } from "./run.js";
export { deriveOutcome, type RunOutcome, type RunRecord } from "./runRecord.js";
export {
  WALK_STATE_VERSION,
  type WalkState,
  type WalkStateCheck,
  type WalkStateKeys,
  clearWalkState,
  computeTreeHash,
  parseVisitGrant,
  readWalkState,
  validateWalkState,
  walkStatePath,
  writeWalkState,
} from "./walkState.js";
