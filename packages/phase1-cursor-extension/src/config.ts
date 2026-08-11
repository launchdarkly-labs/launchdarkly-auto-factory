/**
 * Bridges VS Code settings + SecretStorage into the `process.env` the shared
 * Phase 1 core reads. This is the extension's analog of the Action's
 * `mapActionInputs()`: the core is unchanged; only where its configuration
 * comes from differs.
 *
 * Non-secret options live in workspace/user settings; the three API keys live
 * in SecretStorage (never written to settings.json) and are set via the
 * "Set API Keys" command.
 */

import * as vscode from "vscode";

export const SECRET_IDS = ["ldSdkKey", "ldApiKey", "anthropicApiKey"] as const;
export type SecretId = (typeof SECRET_IDS)[number];

/** SecretStorage id → the env var the shared core reads. */
const SECRET_ENV: Record<SecretId, string> = {
  ldSdkKey: "LD_SDK_KEY",
  ldApiKey: "LD_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
};

/** Human labels for the "Set API Keys" prompts. */
export const SECRET_LABELS: Record<SecretId, string> = {
  ldSdkKey: "LaunchDarkly server SDK key (sdk-…) for the factory project",
  ldApiKey: "LaunchDarkly API token (api-…) — needed to create flags/metrics",
  anthropicApiKey: "Anthropic API key",
};

const secretKey = (id: SecretId): string => `launchdarkly-autofactory.${id}`;

export async function getSecret(context: vscode.ExtensionContext, id: SecretId): Promise<string | undefined> {
  return context.secrets.get(secretKey(id));
}

export async function setSecret(context: vscode.ExtensionContext, id: SecretId, value: string): Promise<void> {
  await context.secrets.store(secretKey(id), value);
}

export async function clearSecrets(context: vscode.ExtensionContext): Promise<void> {
  await Promise.all(SECRET_IDS.map((id) => context.secrets.delete(secretKey(id))));
}

export interface ResolvedConfig {
  missing: string[];
  flagCreation: boolean;
  codeChanges: boolean;
  approvalMode: string;
  baseBranch: string;
  graphKey: string;
  appProjectKey: string;
}

/**
 * Read settings + secrets and populate `process.env` for the shared core, then
 * return what (if anything) is still missing for a real run.
 */
export async function applyConfig(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<ResolvedConfig> {
  const cfg = vscode.workspace.getConfiguration("launchdarkly-autofactory");
  const setEnv = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== "") process.env[k] = v;
  };

  const appProjectKey = cfg.get<string>("ldAppProjectKey", "autofactory-demo");
  const baseBranch = cfg.get<string>("baseBranch", "main");
  const graphKey = cfg.get<string>("graphKey", "gha-auto-factory");
  const approvalMode = cfg.get<string>("approvalMode", "yolo");
  const flagCreation = cfg.get<boolean>("enableFlagCreation", true);
  const codeChanges = cfg.get<boolean>("enableCodeChanges", true);

  setEnv("LD_PROJECT_KEY", cfg.get<string>("ldProjectKey"));
  setEnv("LD_APP_PROJECT_KEY", appProjectKey);
  setEnv("LD_BASE_URL", cfg.get<string>("ldBaseUrl"));
  setEnv("GRAPH_KEY", graphKey);
  setEnv("APPROVAL_MODE", approvalMode);
  setEnv("PR_BASE_REF", baseBranch);
  setEnv("SANDBOX_ROOT", workspaceRoot);
  process.env.ENABLE_FLAG_CREATION = flagCreation ? "true" : "false";
  process.env.ENABLE_CODE_CHANGES = codeChanges ? "true" : "false";

  // Secrets win; fall back to any pre-existing env (useful when launched from a
  // dev shell that already exported the keys).
  for (const id of SECRET_IDS) {
    setEnv(SECRET_ENV[id], (await getSecret(context, id)) ?? process.env[SECRET_ENV[id]]);
  }

  const missing: string[] = [];
  // The provider flag is only evaluated at run time (runChain), so accept an
  // AWS credential signal in place of an Anthropic key here: on the 'bedrock'
  // provider the runner authenticates via the AWS chain instead.
  const hasAwsCreds = Boolean(
    process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK,
  );
  if (!process.env.ANTHROPIC_API_KEY && !hasAwsCreds) missing.push(SECRET_LABELS.anthropicApiKey);
  if (!process.env.LD_SDK_KEY) missing.push(SECRET_LABELS.ldSdkKey);
  if (flagCreation && !process.env.LD_API_KEY) missing.push(SECRET_LABELS.ldApiKey);

  return { missing, flagCreation, codeChanges, approvalMode, baseBranch, graphKey, appProjectKey };
}
