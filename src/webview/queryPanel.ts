import * as vscode from "vscode";
import { ConnectionManager } from "../connections/manager";
import { ConnectionStore } from "../connections/store";
import { QueryResult } from "../drivers/Driver";

/** A SQL/command editor + results grid, one webview per invocation. */
interface PanelOptions {
  initialSql?: string;
  /** When set, run driver.previewTable(previewPath) as soon as the panel opens. */
  previewPath?: string[];
}

export class QueryPanel {
  static create(
    ctx: vscode.ExtensionContext,
    manager: ConnectionManager,
    store: ConnectionStore,
    connectionId: string,
    options: PanelOptions = {}
  ): QueryPanel {
    return new QueryPanel(ctx, manager, store, connectionId, options);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    store: ConnectionStore,
    private readonly connectionId: string,
    options: PanelOptions
  ) {
    const config = store.get(connectionId);
    const title = config ? `Query: ${config.name}` : "Query";
    this.panel = vscode.window.createWebviewPanel(
      "openDbClient.query",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.render(options.initialSql ?? "", config?.type ?? "postgres");

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "run") {
        await this.run(msg.sql);
      }
    });

    if (options.previewPath) {
      void this.runPreview(options.previewPath);
    } else if (options.initialSql) {
      void this.run(options.initialSql);
    }
  }

  private async runPreview(path: string[]): Promise<void> {
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const result = await driver.previewTable(path);
      this.post({ type: "result", result });
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
    }
  }

  private async run(sql: string): Promise<void> {
    const trimmed = (sql ?? "").trim();
    if (!trimmed) {
      return;
    }
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const result = await driver.query(trimmed);
      this.post({ type: "result", result });
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
    }
  }

  private post(msg: { type: string; result?: QueryResult; message?: string }): void {
    void this.panel.webview.postMessage(msg);
  }

  private render(initialSql: string, dbType: string): string {
    const placeholder =
      dbType === "redis" ? "GET mykey" : "SELECT * FROM ... LIMIT 100";
    const nonce = String(Date.now());
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); margin: 0; padding: 8px;
         color: var(--vscode-foreground); }
  #sql { width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical;
         font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
         background: var(--vscode-input-background); color: var(--vscode-input-foreground);
         border: 1px solid var(--vscode-input-border, transparent); padding: 6px; }
  .bar { margin: 6px 0; display: flex; gap: 8px; align-items: center; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 4px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #status { opacity: .8; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid var(--vscode-panel-border, #4443); padding: 3px 8px;
           text-align: left; white-space: pre; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
  .null { opacity: .5; font-style: italic; }
  #grid { overflow: auto; max-height: 70vh; }
</style>
</head>
<body>
  <textarea id="sql" placeholder="${placeholder}">${escapeHtml(initialSql)}</textarea>
  <div class="bar">
    <button id="runBtn">Run ▶</button>
    <span id="status">Ctrl/Cmd+Enter to run</span>
  </div>
  <div id="grid"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sqlEl = document.getElementById('sql');
    const statusEl = document.getElementById('status');
    const gridEl = document.getElementById('grid');
    function run() {
      statusEl.textContent = 'Running…';
      vscode.postMessage({ type: 'run', sql: sqlEl.value });
    }
    document.getElementById('runBtn').addEventListener('click', run);
    sqlEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });
    function cell(v) {
      if (v === null || v === undefined) return '<td class="null">null</td>';
      if (typeof v === 'object') v = JSON.stringify(v);
      return '<td>' + String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</td>';
    }
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'error') {
        statusEl.textContent = 'Error';
        gridEl.innerHTML = '<pre style="color:var(--vscode-errorForeground)">' +
          String(m.message).replace(/</g,'&lt;') + '</pre>';
        return;
      }
      const r = m.result;
      statusEl.textContent = (m.result.message || (r.rowCount + ' row(s)'));
      if (!r.columns.length) { gridEl.innerHTML = ''; return; }
      let html = '<table><thead><tr>';
      for (const c of r.columns) html += '<th>' + String(c).replace(/</g,'&lt;') + '</th>';
      html += '</tr></thead><tbody>';
      for (const row of r.rows) {
        html += '<tr>';
        for (const c of r.columns) html += cell(row[c]);
        html += '</tr>';
      }
      html += '</tbody></table>';
      gridEl.innerHTML = html;
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
