/**
 * Preflight checks for bootstrap: Node version, LD connection env, and that the
 * target LaunchDarkly project is reachable + the key is authorized.
 * Imported dynamically by create.mjs (after the workspace is built).
 */

import { LdClient, targetConnection, validateProjectKey } from "@auto-factory/shared";

export async function preflight() {
  const ok = [];
  const issues = [];
  const notes = [];

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok.push(`Node ${process.versions.node}`);
  else issues.push(`Node >= 20 required (have ${process.versions.node})`);

  let conn = null;
  try {
    conn = targetConnection();
    ok.push(`Target: project '${conn.projectKey}' @ ${conn.baseUrl}`);
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  // The app/data-plane project key is only USED mid-run (create_flag), where a
  // malformed value surfaces as an opaque HTTP 405 — catch the paste error here.
  if (process.env.LD_APP_PROJECT_KEY) {
    try {
      validateProjectKey("LD_APP_PROJECT_KEY", process.env.LD_APP_PROJECT_KEY);
      ok.push(`App project key: '${process.env.LD_APP_PROJECT_KEY}'`);
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (conn) {
    try {
      const ld = new LdClient(conn);
      await ld.request({ path: `/api/v2/projects/${conn.projectKey}` });
      ok.push("LaunchDarkly API reachable + authorized");
    } catch (e) {
      issues.push(`LaunchDarkly API check failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Phase 1 runtime keys. LD_SDK_KEY is hard-required (the server + AI SDKs read
  // the provider flag, agent graph, and agent configs); without it the action
  // fails on the first PR even though the REST check above passed.
  if (process.env.LD_SDK_KEY) ok.push("LD_SDK_KEY present");
  else issues.push("LD_SDK_KEY not set (required at runtime by the server + AI SDKs)");

  // ANTHROPIC_API_KEY is required on the default ('anthropic') provider path but
  // optional if the auto-factory-ai-provider flag serves 'vega' — so it's a note.
  if (process.env.ANTHROPIC_API_KEY) ok.push("ANTHROPIC_API_KEY present");
  else notes.push("ANTHROPIC_API_KEY not set (required when the auto-factory-ai-provider flag serves 'anthropic' — the default)");

  // AWS credentials are only needed when the provider flag serves 'bedrock'
  // (Claude via Amazon Bedrock). The runner uses the standard AWS chain, so any
  // of these signals is enough; nothing is validated until the first API call.
  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const awsCreds =
    process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (awsRegion && awsCreds) ok.push(`AWS region + credentials present (Bedrock provider ready, region ${awsRegion})`);
  else if (awsRegion || awsCreds) {
    notes.push(
      `AWS ${awsRegion ? "credentials" : "region"} not set (Bedrock needs AWS_REGION AND credentials — access keys, a profile, an ambient role, or AWS_BEARER_TOKEN_BEDROCK; only needed when the auto-factory-ai-provider flag serves 'bedrock')`,
    );
  } else {
    notes.push("AWS region/credentials not set (only needed when the auto-factory-ai-provider flag serves 'bedrock')");
  }

  // CURSOR_API_KEY is only needed when the provider flag serves 'cursor' (Cursor
  // agents). That path also needs the checkout+npm-ci workflow, not the plain
  // drop-in template, and Node >= 22.13 in the action runtime.
  if (process.env.CURSOR_API_KEY) ok.push("CURSOR_API_KEY present");
  else notes.push("CURSOR_API_KEY not set (only needed when the auto-factory-ai-provider flag serves 'cursor')");

  for (const k of ["GITHUB_TOKEN", "BEACON_WEBHOOK_SECRET"]) {
    if (!process.env[k]) notes.push(`${k} not set (needed for Phase 2)`);
  }

  return { ok, issues, notes };
}
