import * as fs from "fs";
import * as vscode from "vscode";
import { ConnectionManager } from "../connections/manager";
import { ConnectionStore } from "../connections/store";
import { EditTarget, QueryResult } from "../drivers/Driver";

interface PanelOptions {
  initialSql?: string;
  /** When set, run driver.previewTable(previewPath) as soon as the panel opens. */
  previewPath?: string[];
}

/** A SQL/command editor + results grid, one webview per invocation. */
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
  private lastResult?: QueryResult;
  private lastEditable?: EditTarget;

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
      switch (msg.type) {
        case "run":
          await this.run(msg.sql);
          break;
        case "update":
          await this.handleUpdate(msg);
          break;
        case "export":
          await this.handleExport(msg.format);
          break;
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
      this.show(await driver.previewTable(path));
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
      this.show(await driver.query(trimmed));
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
    }
  }

  private show(result: QueryResult): void {
    this.lastResult = result;
    this.lastEditable = result.editable;
    this.post({ type: "result", result });
  }

  private async handleUpdate(msg: {
    pk: Record<string, unknown>;
    column: string;
    value: unknown;
    rowIndex: number;
  }): Promise<void> {
    if (!this.lastEditable) {
      return;
    }
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      await driver.updateCell(this.lastEditable.table, msg.pk, msg.column, msg.value);
      // Keep local state in sync for future PK lookups.
      if (this.lastResult?.rows[msg.rowIndex]) {
        this.lastResult.rows[msg.rowIndex][msg.column] = msg.value;
      }
      this.post({
        type: "updateResult",
        ok: true,
        rowIndex: msg.rowIndex,
        column: msg.column,
        value: msg.value,
        message: `Updated ${msg.column}`,
      });
    } catch (err) {
      this.post({
        type: "updateResult",
        ok: false,
        rowIndex: msg.rowIndex,
        column: msg.column,
        message: (err as Error).message,
      });
    }
  }

  private async handleExport(format: "csv" | "json"): Promise<void> {
    if (!this.lastResult || !this.lastResult.columns.length) {
      vscode.window.showWarningMessage("Nothing to export — run a query first.");
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      filters:
        format === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
      saveLabel: `Export ${format.toUpperCase()}`,
    });
    if (!uri) {
      return;
    }
    const content =
      format === "csv"
        ? toCsv(this.lastResult)
        : JSON.stringify(this.lastResult.rows, null, 2);
    fs.writeFileSync(uri.fsPath, content, "utf8");
    vscode.window.showInformationMessage(
      `Exported ${this.lastResult.rowCount} row(s) to ${uri.fsPath}`
    );
  }

  private post(msg: Record<string, unknown>): void {
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
  .spacer { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 4px 12px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #status { opacity: .8; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid var(--vscode-panel-border, #4443); padding: 3px 8px;
           text-align: left; white-space: pre; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
  td.editable { cursor: cell; }
  td.editable:hover { outline: 1px solid var(--vscode-focusBorder); }
  td input { width: 100%; box-sizing: border-box; font: inherit;
             background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             border: 1px solid var(--vscode-focusBorder); }
  .null { opacity: .5; font-style: italic; }
  #grid { overflow: auto; max-height: 68vh; }
  #hint { font-size: 11px; opacity: .7; margin-left: 4px; }
</style>
</head>
<body>
  <textarea id="sql" placeholder="${placeholder}">${escapeHtml(initialSql)}</textarea>
  <div class="bar">
    <button id="runBtn">Run ▶</button>
    <button id="csvBtn" class="secondary">Export CSV</button>
    <button id="jsonBtn" class="secondary">Export JSON</button>
    <span class="spacer"></span>
    <span id="status">Ctrl/Cmd+Enter to run</span>
  </div>
  <div id="grid"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sqlEl = document.getElementById('sql');
    const statusEl = document.getElementById('status');
    const gridEl = document.getElementById('grid');
    let current = null; // { columns, rows, editable }

    function run() {
      statusEl.textContent = 'Running…';
      vscode.postMessage({ type: 'run', sql: sqlEl.value });
    }
    document.getElementById('runBtn').addEventListener('click', run);
    document.getElementById('csvBtn').addEventListener('click',
      () => vscode.postMessage({ type: 'export', format: 'csv' }));
    document.getElementById('jsonBtn').addEventListener('click',
      () => vscode.postMessage({ type: 'export', format: 'json' }));
    sqlEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
    function display(v) {
      if (v === null || v === undefined) return '<span class="null">null</span>';
      if (typeof v === 'object') v = JSON.stringify(v);
      return esc(v);
    }

    function renderTable(r) {
      current = r;
      if (!r.columns.length) { gridEl.innerHTML = ''; return; }
      const editable = !!r.editable;
      let html = '<table><thead><tr>';
      for (const c of r.columns) html += '<th>' + esc(c) + '</th>';
      html += '</tr></thead><tbody>';
      r.rows.forEach((row, ri) => {
        html += '<tr data-ri="' + ri + '">';
        for (const c of r.columns) {
          const cls = editable ? ' class="editable" data-col="' + esc(c) + '"' : '';
          html += '<td' + cls + '>' + display(row[c]) + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      gridEl.innerHTML = html;
    }

    // Inline edit: double-click a cell in an editable (table-preview) grid.
    gridEl.addEventListener('dblclick', (e) => {
      const td = e.target.closest && e.target.closest('td.editable');
      if (!td || !current || !current.editable) return;
      if (td.querySelector('input')) return;
      const ri = Number(td.parentElement.getAttribute('data-ri'));
      const col = td.getAttribute('data-col');
      const original = current.rows[ri][col];
      const input = document.createElement('input');
      input.value = (original === null || original === undefined) ? '' : String(original);
      td.textContent = '';
      td.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const val = input.value;
        if (String(original ?? '') === val) { td.innerHTML = display(original); return; }
        const pk = {};
        for (const k of current.editable.pkColumns) pk[k] = current.rows[ri][k];
        statusEl.textContent = 'Saving…';
        vscode.postMessage({ type: 'update', pk, column: col, value: val, rowIndex: ri });
        td.innerHTML = display(val); // optimistic
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { done = true; td.innerHTML = display(original); }
      });
      input.addEventListener('blur', commit);
    });

    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'error') {
        statusEl.textContent = 'Error';
        gridEl.innerHTML = '<pre style="color:var(--vscode-errorForeground)">' +
          esc(m.message) + '</pre>';
        return;
      }
      if (m.type === 'updateResult') {
        if (m.ok) {
          current.rows[m.rowIndex][m.column] = m.value;
          statusEl.textContent = m.message;
        } else {
          statusEl.textContent = 'Update failed: ' + m.message;
          renderTable(current); // revert optimistic change
        }
        return;
      }
      if (m.type === 'result') {
        const r = m.result;
        statusEl.textContent = (r.message || (r.rowCount + ' row(s)')) +
          (r.editable ? ' · double-click a cell to edit' : '');
        renderTable(r);
      }
    });
  </script>
</body>
</html>`;
  }
}

function toCsv(result: QueryResult): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) {
      return "";
    }
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = result.columns.map(esc).join(",");
  const lines = result.rows.map((row) =>
    result.columns.map((c) => esc(row[c])).join(",")
  );
  return [header, ...lines].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
