/**
 * Beacon runtime configuration: the service registry (config/services.yaml),
 * the release-flags directory (config/release-source.yaml), and secrets/env.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadReleaseSource, releaseFlagsDir } from "@auto-factory/shared";
import { parse as parseYaml } from "yaml";
import { parseRepo, type RepoRef } from "./github.js";

export type Side = "frontend" | "backend";

export interface ServiceDef {
  side: Side;
  repo: RepoRef;
  statusUrl: string;
  statusShaField: string;
  /**
   * True when `statusUrl` is NOT reachable from Beacon (a Railway private-network
   * address, a VPC-internal host). Such a service is not a fullstack readiness
   * WITNESS: it is skipped outright rather than counted as a failed read.
   *
   * Load-bearing since the readiness check became tri-state. Before that, an
   * unreachable counterpart fell through a `continue` and was silently ignored —
   * which is what `config/services.yaml` documents. Now an unread counterpart makes
   * the whole answer `unknown`, so a permanently-unreachable one would turn every
   * normal "the other side has not deployed yet" into a reported error, forever.
   */
  privateNetwork: boolean;
}

export interface BeaconConfig {
  /** Shared secret a Notifier must present in the X-Beacon-Secret header. */
  secret: string;
  githubToken: string;
  /** LD environment releases target when a notification omits one. */
  ldEnvironmentKey: string;
  releaseFlagsDir: string;
  /** Path of the JSON file the deploy-state store persists to. */
  stateFile: string;
  services: Record<string, ServiceDef>;
}

interface RawServices {
  services: Record<
    string,
    { side: Side; repo: string; statusUrl: string; statusShaField?: string; privateNetwork?: boolean }
  >;
}

export function loadBeaconConfig(repoRoot: string = process.cwd()): BeaconConfig {
  const raw = parseYaml(readFileSync(resolve(repoRoot, "config/services.yaml"), "utf8")) as RawServices;
  const services: Record<string, ServiceDef> = {};
  for (const [key, def] of Object.entries(raw.services ?? {})) {
    services[key] = {
      side: def.side,
      repo: parseRepo(def.repo),
      statusUrl: def.statusUrl,
      statusShaField: def.statusShaField ?? "version",
      privateNetwork: def.privateNetwork === true,
    };
  }

  const releaseSource = loadReleaseSource(repoRoot);

  return {
    secret: required("BEACON_WEBHOOK_SECRET"),
    githubToken: required("GITHUB_TOKEN"),
    ldEnvironmentKey: process.env.LD_ENVIRONMENT_KEY || "production",
    releaseFlagsDir: releaseFlagsDir(releaseSource),
    stateFile: process.env.BEACON_STATE_FILE || "beacon-state.json",
    services,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** All services on the opposite side from `side`. */
export function otherSideServices(cfg: BeaconConfig, side: Side): ServiceDef[] {
  return Object.values(cfg.services).filter((s) => s.side !== side);
}
