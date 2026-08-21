/**
 * Extension entry point. Registers the Run command (exposed as a status-bar
 * button, an SCM title button, and a sidebar view), the secret-management
 * commands, and the auto-run git watcher. Owns the single run orchestrator with
 * a busy guard so the button and the auto-trigger never overlap.
 */

import * as vscode from "vscode";
import { closeLdSdk, type NodeRun } from "@auto-factory/shared";
import { registerAutoTrigger } from "./autoTrigger.js";
import { SECRET_IDS, SECRET_LABELS, applyConfig, clearSecrets, setSecret } from "./config.js";
import { buildCursorContext } from "./cursorContext.js";
import { hasChangeToProcess, isGitRepo, readRepoState } from "./git.js";
import { buildCreatedLinks } from "./ldLinks.js";
import { AutoFactoryViewProvider } from "./panel.js";
import { nodeTitle, type RunReporter } from "./reporter.js";
import { runPhase1 } from "./runChain.js";

let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let panel: AutoFactoryViewProvider;
let running = false;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("LaunchDarkly AutoFactory");
  context.subscriptions.push(output);

  panel = new AutoFactoryViewProvider(() => void runOnce(context, "button"));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AutoFactoryViewProvider.viewId, panel, {
      // Keep the webview's DOM alive when the view is hidden, so switching the
      // sidebar away and back doesn't blank the in-progress chain.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "launchdarkly-autofactory.run";
  setIdleStatus();
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("launchdarkly-autofactory.run", () => void runOnce(context, "command")),
    vscode.commands.registerCommand("launchdarkly-autofactory.showOutput", () => output.show()),
    vscode.commands.registerCommand("launchdarkly-autofactory.setSecrets", () => promptSecrets(context)),
    vscode.commands.registerCommand("launchdarkly-autofactory.clearSecrets", async () => {
      await clearSecrets(context);
      void vscode.window.showInformationMessage("LaunchDarkly AutoFactory: stored API keys cleared.");
    }),
  );

  context.subscriptions.push(registerAutoTrigger((reason) => void runOnce(context, reason)));
}

export function deactivate(): Promise<void> {
  return closeLdSdk();
}

function setIdleStatus(): void {
  statusItem.text = "$(rocket) AutoFactory";
  statusItem.tooltip = "Run LaunchDarkly AutoFactory Phase 1 on your current changes";
}

/** Prompt for each API key and store it in SecretStorage. */
async function promptSecrets(context: vscode.ExtensionContext): Promise<void> {
  for (const id of SECRET_IDS) {
    const value = await vscode.window.showInputBox({
      title: "LaunchDarkly AutoFactory — API keys",
      prompt: SECRET_LABELS[id],
      password: true,
      ignoreFocusOut: true,
      placeHolder: "leave blank to keep the current value",
    });
    if (value) await setSecret(context, id, value);
  }
  void vscode.window.showInformationMessage("LaunchDarkly AutoFactory: API keys saved.");
}

/** The single run path. Guards against concurrent/overlapping runs. */
async function runOnce(context: vscode.ExtensionContext, reason: string): Promise<void> {
  if (running) {
    void vscode.window.showInformationMessage("LaunchDarkly AutoFactory is already running.");
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("LaunchDarkly AutoFactory: open a folder first.");
    return;
  }
  const root = folder.uri.fsPath;
  if (!(await isGitRepo(root))) {
    void vscode.window.showErrorMessage("LaunchDarkly AutoFactory needs a git repository.");
    return;
  }

  const cfg = await applyConfig(context, root);
  if (cfg.missing.length) {
    const choice = await vscode.window.showErrorMessage(
      `LaunchDarkly AutoFactory is missing: ${cfg.missing.join(", ")}.`,
      "Set API Keys",
    );
    if (choice === "Set API Keys") await promptSecrets(context);
    return;
  }

  const state = await readRepoState(root, cfg.baseBranch);
  if (!hasChangeToProcess(state)) {
    void vscode.window.showInformationMessage(
      `LaunchDarkly AutoFactory: no changes vs "${cfg.baseBranch}" to process (commit or edit something first).`,
    );
    return;
  }
  const ctx = await buildCursorContext(root, state);

  running = true;
  statusItem.text = "$(sync~spin) AutoFactory";
  panel.reveal();
  const subtitle = `${ctx.PR_BRANCH ?? "working tree"} vs ${state.resolvedBase ?? cfg.baseBranch}`;
  panel.start(subtitle);
  output.clear();
  output.appendLine(`LaunchDarkly AutoFactory — Phase 1 (${reason})`);
  output.appendLine(`Repo: ${ctx.REPO ?? root}  Branch: ${ctx.PR_BRANCH ?? "(detached)"}  vs ${state.resolvedBase ?? cfg.baseBranch}`);
  output.appendLine("");

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "LaunchDarkly AutoFactory", cancellable: false },
    async (progress) => {
      const reporter: RunReporter = {
        log: (line) => output.appendLine(line),
        nodeStart: (key) => {
          progress.report({ message: nodeTitle(key) });
          panel.status(`Running: ${nodeTitle(key)}`);
          panel.nodeStart(key);
          output.appendLine(`▶ ${nodeTitle(key)} (${key})`);
        },
        nodeComplete: (run: NodeRun) => {
          panel.nodeComplete(run);
          output.appendLine(`  ${run.status === "failed" ? "✗" : "✓"} ${nodeTitle(run.configKey)} [${run.status}]`);
          if (Object.keys(run.tags).length) output.appendLine(`    tags: ${JSON.stringify(run.tags)}`);
          const text = (run.output || "").trim();
          if (text) output.appendLine(indent(text.slice(0, 4000)));
        },
        done: () => undefined, // handled below with the returned result
        failed: (m) => output.appendLine(`ERROR: ${m}`),
      };

      try {
        const result = await runPhase1({
          workspaceRoot: root,
          context: ctx,
          graphKey: cfg.graphKey,
          appProjectKey: cfg.appProjectKey,
          flagCreation: cfg.flagCreation,
          codeChanges: cfg.codeChanges,
          reporter,
          // Approval gate → a modal that blocks the run until the human decides.
          confirmGate: async (nodeKey) => {
            const choice = await vscode.window.showInformationMessage(
              `LaunchDarkly AutoFactory: approve running "${nodeTitle(nodeKey)}"?`,
              { modal: true, detail: "This step is gated by auto-factory-approval-gates. Approve to run it (and continue), or stop the chain before it." },
              "Approve",
            );
            return choice === "Approve";
          },
        });
        const links = buildCreatedLinks(cfg.appProjectKey, result.tags);
        panel.done(result, links);
        output.appendLine("");
        output.appendLine(`──── ${result.runs.map((r) => nodeTitle(r.configKey)).join(" → ")}`);
        if (result.skipped.length) output.appendLine(`Skipped: ${result.skipped.join(", ")}`);
        output.appendLine(`Approval [${result.mode}]: ${result.decision.reason}`);
        // Output-channel URLs are auto-linkified by the editor.
        if (links.flag) output.appendLine(`Flag → ${links.flag.url}`);
        for (const m of links.metrics) output.appendLine(`Metric ${m.key} → ${m.url}`);

        const verb = result.pendingInput
          ? `⏸ ${nodeTitle(result.pendingInput.node)} needs a human answer (see Output; reply in the manifest's humanInput.answer, then re-run)`
          : result.pendingApproval
          ? `⏸ stopped before ${nodeTitle(result.pendingApproval.node)} (approval declined)`
          : result.decision.apply
              ? "✓ approved"
              : result.decision.noop
                ? "• no flag needed"
                : result.decision.incomplete
                  ? "⚠ incomplete"
                  : "✗ rejected";
        const detail = links.flag ? ` — flag ${links.flag.key}` : "";
        const buttons = links.flag ? ["Open Flag in LaunchDarkly", "Show Output"] : ["Show Output"];
        const choice = await vscode.window.showInformationMessage(
          `AutoFactory: ${verb}${detail}. Edits are in your working tree.`,
          ...buttons,
        );
        if (choice === "Open Flag in LaunchDarkly" && links.flag) {
          void vscode.env.openExternal(vscode.Uri.parse(links.flag.url));
        } else if (choice === "Show Output") {
          output.show();
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        reporter.failed(message);
        panel.failed(message);
        const choice = await vscode.window.showErrorMessage(`AutoFactory failed: ${message}`, "Show Output");
        if (choice === "Show Output") output.show();
      } finally {
        running = false;
        setIdleStatus();
      }
    },
  );
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
