/**
 * Sidebar webview: a live checklist of the five Phase 1 agents, a Run button,
 * and the final verdict. The extension drives it through the small method API
 * below; the webview only renders state and posts a "run" message back.
 */

import * as vscode from "vscode";
import type { NodeRun } from "@auto-factory/shared";
import type { CreatedLinks } from "./ldLinks.js";
import { NODE_SEQUENCE, type RunResult } from "./reporter.js";

type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export class AutoFactoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "launchdarkly-autofactory.panel";
  private view?: vscode.WebviewView;
  // Buffer of state messages since the last run start, replayed when the
  // webview is (re)created — switching the sidebar away tears the webview down,
  // so without this the chain's progress/verdict would reset to blank.
  private buffer: Array<Record<string, unknown>> = [];

  constructor(private readonly onRun: () => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "run") this.onRun();
      // The webview announces readiness on load; replay whatever state we have
      // so a recreated view restores instead of showing a blank chain.
      else if (msg?.type === "ready") this.replay();
      else if (msg?.type === "open" && typeof msg.url === "string") {
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
    });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Post + remember, so the message survives a webview teardown/recreate. */
  private send(message: Record<string, unknown>): void {
    if (message.type === "start" || message.type === "reset") this.buffer = [];
    this.buffer.push(message);
    this.post(message);
  }

  private replay(): void {
    if (this.buffer.length === 0) this.post({ type: "reset" });
    else for (const m of this.buffer) this.post(m);
  }

  /** Reveal the view (used when a run starts from elsewhere). */
  reveal(): void {
    void vscode.commands.executeCommand(`${AutoFactoryViewProvider.viewId}.focus`);
  }

  // --- driven by the extension's reporter ---

  start(subtitle: string): void {
    this.send({ type: "start", subtitle });
  }
  status(text: string): void {
    this.send({ type: "status", text });
  }
  nodeStart(configKey: string): void {
    this.send({ type: "node", configKey, status: "running" as NodeStatus });
  }
  nodeComplete(run: NodeRun): void {
    const status: NodeStatus = run.status === "failed" ? "failed" : "done";
    this.send({ type: "node", configKey: run.configKey, status, tags: run.tags });
  }
  done(result: RunResult, links: CreatedLinks): void {
    const ran = new Set(result.runs.map((r) => r.configKey));
    for (const n of NODE_SEQUENCE) {
      if (!ran.has(n.key)) this.send({ type: "node", configKey: n.key, status: "skipped" as NodeStatus });
    }
    const verdict = result.loopExhausted
      ? `did not converge (loop budget exhausted at ${result.loopExhausted.node})`
      : result.pendingApproval
        ? `stopped before ${result.pendingApproval.node}`
        : result.tags.review_approved
          ? `${result.tags.review_approved} (risk: ${result.tags.risk_level ?? "?"})`
          : "no verdict";
    this.send({
      type: "done",
      verdict,
      reason: result.loopExhausted
        ? `loop did not converge — ${result.loopExhausted.reason}`
        : result.pendingApproval
          ? "approval gate — the gated step was not run (approval declined)"
          : result.decision.reason,
      // A non-converged loop is a hard failure: force apply off regardless of the
      // (possibly stale) verdict.
      apply: result.decision.apply && !result.loopExhausted,
      noop: result.decision.noop,
      incomplete: result.decision.incomplete || !!result.loopExhausted,
      pending: !!result.pendingApproval,
      flag: links.flag ?? null,
      metrics: links.metrics,
    });
  }
  failed(message: string): void {
    this.send({ type: "failed", message });
  }

  private html(webview: vscode.Webview): string {
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const steps = NODE_SEQUENCE.map(
      (n) =>
        `<li class="step" data-key="${n.key}"><span class="dot"></span><span class="label"><b>${n.title}</b><span class="blurb">${n.blurb}</span></span><span class="tag"></span></li>`,
    ).join("");
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 6px; }
  button.run { width: 100%; padding: 7px; margin-bottom: 10px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; font-weight: 600; }
  button.run:hover { background: var(--vscode-button-hoverBackground); }
  button.run:disabled { opacity: .5; cursor: default; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 10px; min-height: 1.2em; }
  ul { list-style: none; padding: 0; margin: 0; }
  .step { display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px; border-radius: 4px; }
  .step .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; flex: 0 0 auto;
    background: var(--vscode-descriptionForeground); opacity: .4; }
  .step.running .dot { background: var(--vscode-progressBar-background); opacity: 1; animation: pulse 1s infinite; }
  .step.done .dot { background: #3fb950; opacity: 1; }
  .step.failed .dot { background: var(--vscode-errorForeground); opacity: 1; }
  .step.skipped { opacity: .45; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .label { display: flex; flex-direction: column; flex: 1; }
  .blurb { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .tag { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .summary { margin-top: 12px; padding: 8px; border-radius: 4px; background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border); display: none; }
  .summary.show { display: block; }
  .summary .verdict { font-weight: 600; }
  .summary code { font-size: 11px; }
  .summary .hint { margin-top: 6px; color: var(--vscode-descriptionForeground); }
  a.ldlink { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a.ldlink:hover { text-decoration: underline; }
</style></head>
<body>
  <button class="run" id="run">▶ Run on current changes</button>
  <div class="sub" id="sub">Ready.</div>
  <ul>${steps}</ul>
  <div class="summary" id="summary"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const runBtn = $("run");
  runBtn.addEventListener("click", () => vscode.postMessage({ type: "run" }));
  // Open LaunchDarkly deep links externally (the extension calls openExternal).
  $("summary").addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a.ldlink");
    if (a) { e.preventDefault(); vscode.postMessage({ type: "open", url: a.getAttribute("data-url") }); }
  });
  function setStep(key, status, tag) {
    const el = document.querySelector('.step[data-key="' + key + '"]');
    if (!el) return;
    el.classList.remove("running","done","failed","skipped");
    el.classList.add(status);
    if (tag !== undefined) el.querySelector(".tag").textContent = tag;
  }
  function resetSteps() {
    document.querySelectorAll(".step").forEach((el) => {
      el.classList.remove("running","done","failed","skipped");
      el.querySelector(".tag").textContent = "";
    });
    $("summary").classList.remove("show");
    $("summary").innerHTML = "";
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "reset") { resetSteps(); $("sub").textContent = "Ready."; runBtn.disabled = false; }
    else if (m.type === "start") { resetSteps(); $("sub").textContent = m.subtitle; runBtn.disabled = true; }
    else if (m.type === "status") { $("sub").textContent = m.text; }
    else if (m.type === "node") {
      let tag;
      if (m.status === "done" && m.tags) {
        if (m.tags.flag_key) tag = m.tags.flag_key;
        else if (m.tags.metric_keys) tag = (m.tags.metric_keys.split(",").filter(Boolean).length) + " metrics";
        else if (m.tags.review_approved) tag = m.tags.review_approved;
        else if (m.tags.skip_flagging === "true") tag = "no flag needed";
      }
      setStep(m.configKey, m.status, tag);
    }
    else if (m.type === "done") {
      runBtn.disabled = false;
      $("sub").textContent = "Done.";
      const s = $("summary"); s.classList.add("show");
      const icon = (m.pending || m.requiresHuman) ? "⏸" : (m.apply ? "✓" : (m.noop ? "•" : (m.incomplete ? "⚠" : "✗")));
      const link = (r) => '<a class="ldlink" data-url="' + r.url + '" href="#" title="Open in LaunchDarkly">' + r.key + '</a>';
      let html = '<div class="verdict">' + icon + ' Review: ' + m.verdict + '</div>';
      html += '<div>' + m.reason + '</div>';
      if (m.flag) html += '<div>Flag: ' + link(m.flag) + '</div>';
      if (m.metrics && m.metrics.length) html += '<div>Metrics: ' + m.metrics.map(link).join(', ') + '</div>';
      html += '<div class="hint">Edits are in your working tree — review and commit them.</div>';
      s.innerHTML = html;
    }
    else if (m.type === "failed") {
      runBtn.disabled = false;
      $("sub").textContent = "Failed.";
      const s = $("summary"); s.classList.add("show");
      s.innerHTML = '<div class="verdict">✗ Run failed</div><div>' + m.message + '</div>';
    }
  });
  // Tell the extension we're listening so it can replay state into a freshly
  // (re)created view — restores the chain after switching the sidebar away.
  vscode.postMessage({ type: "ready" });
</script></body></html>`;
  }
}
