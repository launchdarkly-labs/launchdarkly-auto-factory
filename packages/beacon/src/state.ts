/**
 * Deploy-state store: the SHAs Beacon has seen per (service, environment).
 *
 * Why state at all: discovery diffs `.release-flags/` between the current and
 * previous deploy SHAs, and most CD systems (Railway included) don't tell you
 * what was deployed before. Beacon remembering what it last processed is
 * deploy-system-agnostic and survives batched merges and redeploys. An
 * explicit `previousSha` in a notification always wins — callers that DO know
 * it stay authoritative.
 *
 * Two-deep history (`last` + `prior`), not just `last`: re-delivering the
 * current SHA's notification (provider retry, service restart, or the manual
 * recovery for a "waiting" fullstack flag) must re-diff the SAME range, not
 * the empty `sha..sha` range — so a re-notification resolves previousSha to
 * `prior` and `record` of an unchanged SHA is a no-op.
 *
 * The interface is the seam; the file-backed default suits a single-instance
 * prototype. Swap in a KV/DB-backed store for multi-instance deployments.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface DeployState {
  /** SHA of the most recent recorded deploy. */
  last?: string;
  /** SHA of the deploy before that. */
  prior?: string;
}

export interface DeployStateStore {
  get(service: string, environment: string): DeployState;
  /** Record a deploy. Re-recording the current `last` SHA is a no-op. */
  record(service: string, environment: string, sha: string): void;
}

/**
 * Resolve the previousSha for a notification: an explicit value wins; else the
 * store's `last` (or `prior` when this is a re-notification of `last` itself);
 * else undefined — first deploy, all current release-flags treated as new.
 */
export function resolvePreviousSha(
  store: DeployStateStore,
  service: string,
  environment: string,
  sha: string,
  explicit: string | undefined,
): { previousSha: string | undefined; source: "request" | "state" | "none" } {
  if (explicit) return { previousSha: explicit, source: "request" };
  const state = store.get(service, environment);
  const previousSha = state.last === sha ? state.prior : state.last;
  return previousSha ? { previousSha, source: "state" } : { previousSha: undefined, source: "none" };
}

const key = (service: string, environment: string): string => `${service}@${environment}`;

/**
 * The two-deep record rule as a pure function: the NEXT state after recording
 * `sha`, or null when the record is a no-op (history not swapped). Shared by
 * the memory, file, and S3 stores so the semantics live in exactly one place.
 */
export function mergeState(current: DeployState, sha: string): DeployState | null {
  if (current.last === sha) return null;
  // Re-processing the PRIOR sha must not rewrite history either. Without this, a re-POST
  // of an older sha set {last: prior, prior: last} — swapping them — so the NEXT deploy
  // diffed a range that had already been processed and re-evaluated finished flags.
  //
  // THIS CLOSES THE WINDOW, NOT THE PATH, and an earlier version of this comment claimed the
  // path — "the path by which a manual recovery attempt could re-release a reverted flag".
  // The window is two deep. A notification for any sha FURTHER back still advances the
  // window and inverts the history ({last: old, prior: current}), and the next ordinary
  // deploy then re-diffs an already-processed range. Because that deploy's sha is genuinely
  // new, `shaAlreadyProcessed` is false and `terminalHistoryRefusal` is never consulted, so a
  // flag whose release LaunchDarkly REVERTED can be re-released unattended. Reproduced end to
  // end: three deploys, a revert, a Railway "Redeploy" of the first sha, then one more deploy.
  //
  // Not fixed here because the fix is a shape change — a bounded list of processed shas per
  // service/environment, with `resolvePreviousSha` generalising the `last → prior` rule — and it
  // belongs in its own change with its own review rather than bolted onto a finished branch.
  // Tracked in issue #21; the honest summary is that a re-POST inside the window is safe and one
  // outside it is not.
  if (current.prior === sha) return null;
  return { last: sha, ...(current.last ? { prior: current.last } : {}) };
}

/** In-memory store (tests, or callers that always supply previousSha). */
export class MemoryDeployStateStore implements DeployStateStore {
  protected states = new Map<string, DeployState>();

  get(service: string, environment: string): DeployState {
    return this.states.get(key(service, environment)) ?? {};
  }

  record(service: string, environment: string, sha: string): void {
    const k = key(service, environment);
    const next = mergeState(this.states.get(k) ?? {}, sha);
    if (next) this.states.set(k, next);
  }
}

/**
 * JSON-file-backed store ({"service@environment": {last, prior}}). Loads on
 * construction, rewrites the file on every record (atomically via rename) —
 * fine at deploy-notification frequency.
 */
export class FileDeployStateStore extends MemoryDeployStateStore {
  private readonly file: string;

  constructor(filePath: string) {
    super();
    this.file = resolve(filePath);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, DeployState>;
      this.states = new Map(Object.entries(raw));
    } catch (e) {
      // ENOENT is a first run. ANYTHING ELSE must not read as one.
      //
      // Collapsing "no state yet" and "state unreadable" into "start empty" is destructive:
      // with no state, `resolvePreviousSha` returns undefined, discovery treats EVERY
      // manifest in .release-flags/ as new, and Beacon re-triggers all of them. For a flag
      // whose guarded release was already REVERTED by a metric regression, the environment
      // serves the original variation again — so it is not a no-op, and a guardrail's
      // rollback gets silently undone.
      //
      // Throwing here fails at construction (createApp, before any webhook is served), so an
      // operator sees it at boot rather than as a mass re-release. Deliberate reset is still
      // available: delete the file.
      if ((e as { code?: string }).code === "ENOENT") return;
      throw new Error(
        `deploy-state file '${this.file}' exists but could not be read — refusing to start with empty ` +
          `state, because that would re-trigger every release manifest in the repo. Fix or delete the ` +
          `file (deleting it deliberately resets to full re-discovery). Cause: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
    }
  }

  override record(service: string, environment: string, sha: string): void {
    super.record(service, environment, sha);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.states), null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * S3-backed store: one durable JSON object per (service, environment) under
 * the configured key prefix. It extends MemoryDeployStateStore so `get` reads
 * the in-process map, but `record` is where the semantics live, and this
 * class deliberately REDERIVES them from the remote object on every write:
 *
 * - the recording is durable-then-ack: the record's `await` resolves only
 *   after the conditional put has landed, so the notification response's 200
 *   means the durable history is in (the R-B-4 record class); a record from a
 *   sibling instance cannot be clobbered — the put is conditioned on the
 *   object's ETag and a `PreconditionFailed` replays reload-merge-put a
 *   bounded number of times instead of blind-overwriting. That is the
 *   multi-instance primitive PREMORTEM row 6 names; the full claim semantics
 *   stay a follow-up decision, not something shipped silently here.
 * - a record that could not reach S3 rolls the in-process map back and
 *   throws: answering 200 for a SHA whose durable history never landed would
 *   advertise a discovery range the next boot cannot re-derive (fail-closed,
 *   the same rule the file store's unreadable-object refusal follows).
 * - boot reads MUST NOT read a corrupt object as "no state" — that would
 *   re-trigger every release manifest. The file store's identical refusal
 *   carries the same message shape here.
 *
 * Env: `BEACON_STATE_STORE=s3` opts in; `BEACON_STATE_BUCKET` and the
 * optional `BEACON_STATE_PREFIX` (default `deploy-state/`) choose the
 * location; the SDK's standard `AWS_ENDPOINT_URL` redirects to the twin in
 * tests. `forcePathStyle` is on unless `BEACON_S3_FORCE_PATH_STYLE=false` —
 * the local twins need it and it is valid against AWS as well.
 */
export class S3DeployStateStore extends MemoryDeployStateStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  /** Per-object write chain (keys are object keys) — nothing is awaited twice. */
  private flight = new Map<string, Promise<void>>();

  constructor(bucket: string, prefix: string, client?: S3Client) {
    super();
    if (!bucket) throw new Error("S3DeployStateStore: bucket is required (env BEACON_STATE_BUCKET)");
    this.bucket = bucket;
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    this.s3 = client ?? new S3Client({ forcePathStyle: process.env.BEACON_S3_FORCE_PATH_STYLE !== "false" });
  }

  private objKey(k: string): string {
    return `${this.prefix}${k}.json`;
  }

  /** Boot: load every `{prefix}<service@env>.json`, newest-write acknowledged. */
  static async open(
    opts: { bucket?: string; prefix?: string; client?: S3Client } = {},
  ): Promise<S3DeployStateStore> {
    const bucket = opts.bucket ?? process.env.BEACON_STATE_BUCKET ?? "";
    const prefix = opts.prefix ?? process.env.BEACON_STATE_PREFIX ?? "deploy-state/";
    const store = new S3DeployStateStore(bucket, prefix, opts.client);
    let listed;
    try {
      listed = await store.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    } catch (e) {
      // A missing prefix is a first boot; any other listing failure must not
      // read as empty (see the class doc on the unreadable-refusal clause).
      if ((e as { name?: string }).name === "NoSuchBucket" || (e as { name?: string }).name === "NotFound") {
        return store;
      }
      throw unreadableError(bucket, `${store.prefix}*`, e);
    }
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      const k = decodeObjKey(obj.Key.slice(store.prefix.length));
      try {
        const got = await store.s3.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
        store.states.set(k, (JSON.parse(await got.Body!.transformToString("utf8")) ?? {}) as DeployState);
      } catch (e) {
        // A listed-then-deleted object reads as absent for THAT service/env
        // (deliberate reset); anything else is the refusal-to-boot class.
        if ((e as { name?: string }).name === "NoSuchKey") continue;
        throw unreadableError(bucket, obj.Key!, e);
      }
    }
    return store;
  }

  override async record(service: string, environment: string, sha: string): Promise<void> {
    const k = key(service, environment);
    const prior = this.flight.get(k) ?? Promise.resolve();
    // Per-object write chain: overlapping records on ONE key stay ordered,
    // and a failed write does not strand the ones queued after it.
    const work = prior.then(() => this.writeThrough(k, sha));
    this.flight.set(
      k,
      work.then(
        () => {},
        () => {},
      ),
    );
    try {
      await work;
    } catch (e) {
      throw recordRefusal(k, this.bucket, e);
    }
  }

  /** One durable write: reload → merge → conditional put → retry on 412. */
  private async writeThrough(k: string, sha: string): Promise<void> {
    const objKey = this.objKey(k);
    const attemptDeadline = Date.now() + 10_000;
    for (;;) {
      let head: DeployState = {};
      let etag: string | undefined;
      try {
        const got = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objKey }));
        head = (JSON.parse(await got.Body!.transformToString("utf8")) ?? {}) as DeployState;
        etag = got.ETag;
      } catch (e) {
        if ((e as { name?: string }).name !== "NoSuchKey") throw e; // e.g. NoSuchBucket: an operator problem
      }
      const next = mergeState(head, sha);
      if (!next) {
        // The durable history already carries this sha (a redelivery raced
        // us to the put): align the local map and acknowledge.
        this.states.set(k, head);
        return;
      }
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: objKey,
            Body: JSON.stringify(next, null, 2),
            ContentType: "application/json",
            ...(etag ? { IfMatch: etag } : {}),
          }),
        );
        this.states.set(k, next);
        return;
      } catch (e) {
        if ((e as { name?: string }).name === "PreconditionFailed" && Date.now() < attemptDeadline) {
          continue; // a sibling wrote the object; reload-merge-put again
        }
        throw e;
      }
    }
  }

  /** Test/ops hook: resolves once every in-flight put has landed or failed. */
  flush(): Promise<void> {
    return Promise.all([...this.flight.values()].map((p) => p.catch(() => {}))).then(() => {});
  }
}

function unreadableError(bucket: string, objKey: string, cause: unknown): Error {
  return new Error(
    `deploy-state object '${objKey}' in bucket '${bucket}' exists but could not be read or parsed — ` +
      `refusing to start with empty state, because that would re-trigger every release manifest in the ` +
      `repo. Fix or delete the object (deleting it deliberately resets to full re-discovery). Cause: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

function recordRefusal(k: string, bucket: string, cause: unknown): Error {
  return new Error(
    `deploy-state record for '${k}' did not reach bucket '${bucket}' — the notification must not ack a ` +
      `SHA whose durable history never landed (the async-throw class; the SHA stays unrecorded). Cause: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

function decodeObjKey(obj: string): string {
  return obj.replace(/\.json$/, "");
}

/**
 * Boot seam: the file-backed default unless `BEACON_STATE_STORE=s3` opts in.
 * S3 boot is an async load, so the entry point awaits this BEFORE createApp —
 * the store's unreadable-object refusal then fails at boot, not as a webhook.
 */
export async function deployStateStore(stateFile: string): Promise<DeployStateStore> {
  if (process.env.BEACON_STATE_STORE === "s3") return S3DeployStateStore.open();
  return new FileDeployStateStore(stateFile);
}
