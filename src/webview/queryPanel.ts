import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ConnectionManager } from "../connections/manager";
import type { ConnectionStore } from "../connections/store";
import type {
  ColumnFilter,
  EditTarget,
  PreviewFilter,
  QueryResult,
  SortSpec,
} from "../drivers/Driver";
import { logError } from "../log";

interface PanelOptions {
  initialSql?: string;
  previewPath?: string[];
  /** Equality filter for a "view related row" preview. */
  filter?: PreviewFilter;
  /** Database to run raw queries against (multi-database servers). */
  database?: string;
  /** Backing .sql file (fsPath) — enables Save; also names the panel. */
  filePath?: string;
  /** Run the initialSql automatically on open. */
  autoRun?: boolean;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const PAGE_SIZE = 100;

/** Past this the OS clipboard — and whatever you paste into — is what stalls, so we ask first. */
const COPY_WARN_CHARS = 5 * 1024 * 1024;

/** A SQL/command editor + a rich results grid, one webview per invocation. */
export class QueryPanel {
  static create(
    ctx: vscode.ExtensionContext,
    manager: ConnectionManager,
    store: ConnectionStore,
    connectionId: string,
    options: PanelOptions = {},
  ): QueryPanel {
    return new QueryPanel(ctx, manager, store, connectionId, options);
  }

  // One reusable results panel per connection (for CodeLens "Run").
  private static results = new Map<string, QueryPanel>();

  static runInResults(
    ctx: vscode.ExtensionContext,
    manager: ConnectionManager,
    store: ConnectionStore,
    connectionId: string,
    database: string | undefined,
    sql: string,
  ): void {
    const existing = QueryPanel.results.get(connectionId);
    if (existing && !existing.disposed) {
      existing.rerun(sql, database);
      existing.panel.reveal(vscode.ViewColumn.Active, true);
      return;
    }
    const panel = new QueryPanel(ctx, manager, store, connectionId, {
      database,
      initialSql: sql,
      autoRun: true,
    });
    QueryPanel.results.set(connectionId, panel);
    panel.panel.onDidDispose(() => QueryPanel.results.delete(connectionId));
  }

  private readonly panel: vscode.WebviewPanel;
  private lastResult?: QueryResult;
  private lastEditable?: EditTarget;
  private previewPath?: string[];
  private filter?: PreviewFilter;
  private database?: string;
  private filePath?: string;
  private offset = 0;
  private sort?: SortSpec;
  private columnFilters?: ColumnFilter[];
  private disposed = false;

  private rerun(sql: string, database?: string): void {
    this.previewPath = undefined;
    this.database = database;
    this.post({ type: "setSql", sql });
    void this.run(sql);
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly store: ConnectionStore,
    private readonly connectionId: string,
    options: PanelOptions,
  ) {
    const config = this.store.get(connectionId);
    this.database = options.database;
    this.filePath = options.filePath;
    const title = options.filePath
      ? basename(options.filePath)
      : config
        ? `Query: ${config.name}`
        : "Query";
    this.panel = vscode.window.createWebviewPanel(
      "openDbClient.query",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.render(
      options.initialSql ?? "",
      config?.type ?? "postgres",
      !!options.filePath,
    );
    this.panel.onDidDispose(() => (this.disposed = true));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "run":
          this.previewPath = undefined;
          this.sort = undefined;
          this.columnFilters = undefined;
          await this.run(msg.sql);
          break;
        case "page":
          if (this.previewPath) {
            this.offset = Math.max(0, msg.offset);
            await this.runPreview(this.previewPath, this.offset);
          }
          break;
        case "refresh":
          if (this.previewPath) {
            await this.runPreview(this.previewPath, this.offset);
          }
          break;
        case "sort":
          if (this.previewPath) {
            this.sort = msg.column ? { column: msg.column, dir: msg.dir } : undefined;
            this.offset = 0;
            await this.runPreview(this.previewPath, 0);
          }
          break;
        case "filter":
          if (this.previewPath) {
            this.columnFilters = (msg.filters ?? []).filter((f: ColumnFilter) => f.value);
            this.offset = 0;
            await this.runPreview(this.previewPath, 0);
          }
          break;
        case "update":
          await this.handleUpdate(msg);
          break;
        case "delete":
          await this.handleDelete(msg.pks);
          break;
        case "insert":
          await this.handleInsert(msg.values);
          break;
        case "setTtl":
          await this.handleSetTtl(msg.action);
          break;
        case "openRelated":
          this.openRelated(msg.column, msg.value);
          break;
        case "export":
          await this.handleExport(msg.format);
          break;
        case "copy":
          await this.handleCopy(String(msg.text ?? ""), msg.rows);
          break;
        case "saveFile":
          if (this.filePath) {
            fs.writeFileSync(this.filePath, String(msg.sql ?? ""), "utf8");
            this.post({ type: "saved" });
          }
          break;
      }
    });

    if (options.previewPath) {
      this.previewPath = options.previewPath;
      this.filter = options.filter;
      void this.runPreview(options.previewPath, 0, true);
    } else if (options.initialSql && options.autoRun) {
      void this.run(options.initialSql);
    }
  }

  private async runPreview(path: string[], offset: number, fresh = false): Promise<void> {
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const start = Date.now();
      const result = await driver.previewTable(path, {
        offset,
        limit: PAGE_SIZE,
        filter: this.filter,
        sort: this.sort,
        columnFilters: this.columnFilters,
      });
      result.elapsedMs = Date.now() - start;
      this.show(result, fresh);
    } catch (err) {
      logError("previewTable", err);
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
      const start = Date.now();
      const result = await driver.query(trimmed, this.database);
      result.elapsedMs = Date.now() - start;
      this.show(result, true);
    } catch (err) {
      logError("query", err);
      this.post({ type: "error", message: (err as Error).message });
    }
  }

  private show(result: QueryResult, fresh = false): void {
    this.lastResult = result;
    this.lastEditable = result.editable;
    this.post({ type: "result", result, fresh });
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
      if (this.lastResult?.rows[msg.rowIndex]) {
        this.lastResult.rows[msg.rowIndex][msg.column] = msg.value;
      }
      this.post({ type: "updateResult", ok: true, message: `Updated ${msg.column}` });
    } catch (err) {
      this.post({ type: "updateResult", ok: false, message: (err as Error).message });
    }
  }

  private async handleDelete(pks: Array<Record<string, unknown>>): Promise<void> {
    if (!this.lastEditable || !pks?.length) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete ${pks.length} row(s)? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") {
      return;
    }
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      for (const pk of pks) {
        await driver.deleteRow(this.lastEditable.table, pk);
      }
      vscode.window.showInformationMessage(`Deleted ${pks.length} row(s).`);
      if (this.previewPath) {
        await this.runPreview(this.previewPath, this.offset);
      }
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  }

  private openRelated(column: string, value: unknown): void {
    const fk = this.lastResult?.foreignKeys?.find((f) => f.column === column);
    if (!fk) {
      vscode.window.showWarningMessage(`No foreign key found on "${column}".`);
      return;
    }
    const refName = fk.refTable.join(".");
    QueryPanel.create(this.ctx, this.manager, this.store, this.connectionId, {
      previewPath: fk.refTable,
      filter: { column: fk.refColumn, value },
      initialSql: `SELECT * FROM ${refName} WHERE ${fk.refColumn} = '${String(value)}'`,
    });
  }

  private async handleInsert(values: Record<string, unknown>): Promise<void> {
    if (!this.lastEditable) {
      return;
    }
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      await driver.insertRow(this.lastEditable.table, values ?? {});
      vscode.window.showInformationMessage("Row inserted.");
      if (this.previewPath) {
        await this.runPreview(this.previewPath, this.offset);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Insert failed: ${(err as Error).message}`);
    }
  }

  /**
   * Set or clear the previewed key's TTL. `action` is "persist" to remove the
   * expiry, or "edit" to prompt for a new one (in seconds). Only reachable for
   * a Redis key preview, where `lastEditable.table` is the key's path.
   */
  private async handleSetTtl(action: "edit" | "persist"): Promise<void> {
    const table = this.lastEditable?.table;
    if (!table) {
      return;
    }
    const key = table[table.length - 1];
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      if (!driver.setTtl) {
        return;
      }
      if (action === "persist") {
        await driver.setTtl(table, null);
        vscode.window.showInformationMessage(`"${key}" will no longer expire.`);
      } else {
        const current = this.lastResult?.ttl;
        const prefill = current && current > 0 ? String(Math.round(current / 1000)) : "";
        const answer = await vscode.window.showInputBox({
          title: `Set TTL for "${key}"`,
          prompt: "Seconds until the key expires. Leave blank or 0 to keep it forever.",
          value: prefill,
          validateInput: (v) => {
            const t = v.trim();
            if (t === "") {
              return undefined;
            }
            const n = Number(t);
            return Number.isFinite(n) && n >= 0 && Number.isInteger(n)
              ? undefined
              : "Enter a whole number of seconds (0 = no expiry)";
          },
        });
        if (answer === undefined) {
          return; // cancelled
        }
        const seconds = Number(answer.trim() || "0");
        await driver.setTtl(table, seconds > 0 ? seconds * 1000 : null);
        vscode.window.showInformationMessage(
          seconds > 0 ? `"${key}" expires in ${seconds}s.` : `"${key}" will no longer expire.`,
        );
      }
      if (this.previewPath) {
        await this.runPreview(this.previewPath, this.offset);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Set TTL failed: ${(err as Error).message}`);
    }
  }

  /**
   * Clipboard writes from the grid. The rows are already in webview memory, so the copy
   * itself is cheap — the cost lands on the paste target, hence the size gate below.
   */
  private async handleCopy(text: string, rows?: number): Promise<void> {
    if (text.length > COPY_WARN_CHARS) {
      const mb = (text.length / 1024 / 1024).toFixed(1);
      const go = await vscode.window.showWarningMessage(
        `That's about ${mb} MB${rows ? ` of JSON (${rows} rows)` : ""}. A payload this big can stall whatever you paste it into.`,
        { modal: true },
        "Copy anyway",
      );
      if (go !== "Copy anyway") {
        return;
      }
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
      rows ? `Copied ${rows} row(s) as JSON.` : "Copied to clipboard.",
    );
  }

  private async handleExport(format: "csv" | "json"): Promise<void> {
    if (!this.lastResult?.columns.length) {
      vscode.window.showWarningMessage("Nothing to export — run a query first.");
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      filters: format === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
      saveLabel: `Export ${format.toUpperCase()}`,
    });
    if (!uri) {
      return;
    }
    const content =
      format === "csv" ? toCsv(this.lastResult) : JSON.stringify(this.lastResult.rows, null, 2);
    fs.writeFileSync(uri.fsPath, content, "utf8");
    vscode.window.showInformationMessage(
      `Exported ${this.lastResult.rowCount} row(s) to ${uri.fsPath}`,
    );
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private render(initialSql: string, dbType: string, hasFile: boolean): string {
    const placeholder = dbType === "redis" ? "GET mykey" : "SELECT * FROM ... LIMIT 100";
    const nonce = String(Date.now());
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { --border: var(--vscode-panel-border, #4443); }
  body { font-family: var(--vscode-font-family); margin: 0; padding: 8px;
         color: var(--vscode-foreground); font-size: 12px; }
  #sql { width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical;
         font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
         background: var(--vscode-input-background); color: var(--vscode-input-foreground);
         border: 1px solid var(--vscode-input-border, transparent); padding: 6px; }
  .bar { margin: 6px 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 3px 10px; cursor: pointer; border-radius: 3px; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .4; cursor: default; }
  button:not(:disabled):hover { background: var(--vscode-button-hoverBackground); }
  input.search, input.filter { background: var(--vscode-input-background);
           color: var(--vscode-input-foreground); border: 1px solid var(--border);
           padding: 2px 6px; border-radius: 3px; }
  input.search { width: 160px; }
  #status, #cost, #total { opacity: .8; }
  #grid { overflow: auto; max-height: 66vh; border: 1px solid var(--border); }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--border); padding: 3px 8px; text-align: left;
           white-space: pre; vertical-align: top; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0;
       cursor: pointer; }
  th .cname { font-weight: 600; }
  th .ctype { opacity: .6; font-weight: 400; font-size: 11px; }
  th .sort { opacity: .5; font-size: 10px; }
  th.sorted .sort { opacity: 1; color: var(--vscode-focusBorder); }
  td.editable { cursor: cell; position: relative; }
  td.editable:hover { outline: 1px solid var(--vscode-focusBorder); }
  td .zoom { position: absolute; right: 2px; top: 2px; opacity: 0; cursor: pointer;
             font-size: 11px; }
  td.editable:hover .zoom { opacity: .8; }
  td.fkcell { position: relative; }
  td.fkcell .fkval { color: var(--vscode-textLink-foreground); text-decoration: underline dotted; }
  td .relbtn { position: absolute; right: 2px; bottom: 2px; opacity: 0; cursor: pointer;
             font-size: 11px; color: var(--vscode-textLink-foreground); }
  td.fkcell:hover .relbtn { opacity: 1; }
  td input.cell { width: 100%; box-sizing: border-box; font: inherit;
             background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             border: 1px solid var(--vscode-focusBorder); }
  .null { opacity: .5; font-style: italic; }
  .chk { width: 22px; text-align: center; }
  tr.selected td { background: var(--vscode-list-activeSelectionBackground); }
  .filterRow th { position: static; padding: 2px; }
  .filterRow input { width: 100%; box-sizing: border-box; }
  /* cell-detail modal */
  #overlay { position: fixed; inset: 0; background: #0008; display: none;
             align-items: center; justify-content: center; }
  #modal { background: var(--vscode-editorWidget-background);
           border: 1px solid var(--border); border-radius: 6px; padding: 14px;
           width: min(680px, 90vw); }
  #modal h3 { margin: 0 0 10px; text-align: center; }
  #modal .mbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  #modal textarea { width: 100%; box-sizing: border-box; min-height: 220px;
           font-family: var(--vscode-editor-font-family, monospace);
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--border); padding: 6px; }
  #modal .mfoot { display: flex; gap: 8px; justify-content: center; margin-top: 10px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--border); padding: 2px 6px; }
</style>
</head>
<body>
  <textarea id="sql" placeholder="${placeholder}">${escapeHtml(initialSql)}</textarea>
  <div class="bar">
    <button id="runBtn">Run ▶</button>
    ${hasFile ? '<button id="saveBtn" class="secondary" title="Save to file (Cmd/Ctrl+S)">💾 Save</button>' : ""}
    <button id="refreshBtn" class="secondary" title="Refresh">⟳</button>
    <button id="addBtn" class="secondary" title="Add row" disabled>＋ Row</button>
    <button id="delBtn" class="secondary" title="Delete selected rows" disabled>🗑 Delete</button>
    <button id="csvBtn" class="secondary">Export CSV</button>
    <button id="jsonBtn" class="secondary">Export JSON</button>
    <button id="copyJsonBtn" class="secondary" title="Copy checked rows as JSON — all rows in view if none are checked">Copy as JSON</button>
    <input id="search" class="search" placeholder="Search results…" />
    <span id="ttlWrap" style="display:none; align-items:center; gap:6px;">
      <span id="ttl" title="Remaining time-to-live"></span>
      <button id="ttlEdit" class="secondary" title="Set this key's expiry">Set TTL…</button>
      <button id="ttlPersist" class="secondary" title="Remove this key's expiry">Persist</button>
    </span>
    <span class="spacer"></span>
    <span id="cost"></span>
    <button id="prevBtn" class="secondary" disabled>‹</button>
    <span id="pageLbl">–</span>
    <button id="nextBtn" class="secondary" disabled>›</button>
    <span id="total"></span>
  </div>
  <div id="status">Ctrl/Cmd+Enter to run</div>
  <div id="grid"></div>

  <div id="overlay">
    <div id="modal">
      <h3>Edit Data</h3>
      <div class="mbar">
        <select id="mfmt"><option value="plain">Plain</option><option value="json">JSON</option></select>
        <button id="mcopy" class="secondary">Copy</button>
        <span class="spacer"></span>
      </div>
      <textarea id="mtext"></textarea>
      <div class="mfoot">
        <button id="mclose" class="secondary">Close</button>
        <button id="msave">Save</button>
      </div>
    </div>
  </div>

  <div id="addOverlay" style="position:fixed;inset:0;background:#0008;display:none;align-items:center;justify-content:center;">
    <div id="modal" style="max-height:86vh;overflow:auto;">
      <h3>Add Row</h3>
      <div style="opacity:.7;margin-bottom:8px;">Leave a field blank to use the column default / NULL.</div>
      <div id="addForm"></div>
      <div class="mfoot">
        <button id="aclose" class="secondary">Close</button>
        <button id="asave">Insert</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const sqlEl = $('sql'), statusEl = $('status'), gridEl = $('grid');
    let raw = null;                 // last QueryResult
    let sort = { col: null, dir: 1 };
    let filters = {};               // colName -> substring
    let search = '';
    let selected = new Set();       // original row indices
    let modalCtx = null;            // { ri, col }
    let filterTimer = null;         // debounce for server-side filtering
    let lastFilterCol = null;       // which column filter is being typed in
    let pendingFilterFocus = null;  // set only when a filter request is in flight
    const serverBacked = () => !!(raw && raw.page);
    function scheduleServerFilter(){
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        pendingFilterFocus = lastFilterCol;
        const arr = Object.entries(filters).filter(([,v]) => v).map(([column,value]) => ({ column, value }));
        vscode.postMessage({ type:'filter', filters: arr });
      }, 350);
    }

    function run() { statusEl.textContent = 'Running…'; vscode.postMessage({ type:'run', sql: sqlEl.value }); }
    $('runBtn').addEventListener('click', run);
    function saveFile() {
      const btn = $('saveBtn'); if (!btn) return;
      statusEl.textContent = 'Saving…';
      vscode.postMessage({ type: 'saveFile', sql: sqlEl.value });
    }
    if ($('saveBtn')) $('saveBtn').addEventListener('click', saveFile);
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveFile(); }
    });
    $('refreshBtn').addEventListener('click', () => vscode.postMessage({ type:'refresh' }));
    $('csvBtn').addEventListener('click', () => vscode.postMessage({ type:'export', format:'csv' }));
    $('jsonBtn').addEventListener('click', () => vscode.postMessage({ type:'export', format:'json' }));
    $('copyJsonBtn').addEventListener('click', copyAsJson);
    $('search').addEventListener('input', (e) => { search = e.target.value.toLowerCase(); renderGrid(); });
    sqlEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    $('prevBtn').addEventListener('click', () => pageBy(-1));
    $('nextBtn').addEventListener('click', () => pageBy(1));
    $('delBtn').addEventListener('click', deleteSelected);
    $('ttlEdit').addEventListener('click', () => vscode.postMessage({ type:'setTtl', action:'edit' }));
    $('ttlPersist').addEventListener('click', () => vscode.postMessage({ type:'setTtl', action:'persist' }));

    // Human-readable TTL from ms; -1 = no expiry, -2 = key gone.
    function fmtTtl(ms){
      if (ms === -1) return 'no expiry';
      if (ms == null || ms === -2) return '';
      const total = Math.max(0, Math.round(ms/1000));
      if (total < 60) return total + 's';
      const d = Math.floor(total/86400), h = Math.floor((total%86400)/3600),
            m = Math.floor((total%3600)/60), s = total%60;
      const parts = [['d',d],['h',h],['m',m],['s',s]];
      const first = parts.findIndex(([,v]) => v>0);
      return parts.slice(first, first+2).filter(([,v]) => v>0).map(([u,v]) => v+u).join(' ');
    }
    function updateTtl(){
      const wrap = $('ttlWrap');
      const has = raw && typeof raw.ttl === 'number';
      wrap.style.display = has ? 'inline-flex' : 'none';
      if (!has) return;
      const persistable = raw.ttl > 0;
      $('ttl').textContent = 'TTL: ' + (fmtTtl(raw.ttl) || '—');
      $('ttlPersist').disabled = !persistable;
      // Editing only makes sense while the key still exists.
      $('ttlEdit').disabled = raw.ttl === -2;
    }

    function pageBy(dir) {
      if (!raw || !raw.page) return;
      const next = raw.page.offset + dir * raw.page.limit;
      if (next < 0 || next >= raw.page.total) return;
      vscode.postMessage({ type:'page', offset: next });
    }
    function deleteSelected() {
      if (!raw || !raw.editable || !selected.size) return;
      const pks = [...selected].map((ri) => {
        const pk = {}; for (const k of raw.editable.pkColumns) pk[k] = raw.rows[ri][k]; return pk;
      });
      vscode.postMessage({ type:'delete', pks });
    }

    // Checkboxes only exist on editable results, so "nothing checked" is both "user checked
    // nothing" and "this result can't be checked at all" — both fall back to the whole view.
    // Order follows the grid (sort/filter/search applied), not raw.rows, so what lands on the
    // clipboard is what you were looking at.
    function copyAsJson(){
      if (!raw || !raw.columns.length) { statusEl.textContent = 'Nothing to copy — run a query first.'; return; }
      const view = computeView();
      const picked = selected.size ? view.filter(({ri}) => selected.has(ri)) : view;
      if (!picked.length) { statusEl.textContent = 'Nothing to copy — no rows in view.'; return; }
      // One checked row copies as a bare object; anything else stays an array so the
      // shape is predictable for whatever you paste it into.
      const payload = selected.size === 1 ? picked[0].row : picked.map(({row}) => row);
      vscode.postMessage({ type:'copy', text: JSON.stringify(payload, null, 2), rows: picked.length });
    }

    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
    function display(v){
      if (v === null || v === undefined) return '<span class="null">null</span>';
      if (typeof v === 'object') v = JSON.stringify(v);
      return esc(v);
    }
    function metaFor(name){ return (raw.columnsMeta || []).find((m) => m.name === name); }

    function computeView(){
      let rows = raw.rows.map((row, ri) => ({ row, ri }));
      const server = serverBacked();
      // Per-column filter + sort are done by the DB when server-backed.
      if (!server) for (const [col, txt] of Object.entries(filters)) {
        if (!txt) continue; const t = txt.toLowerCase();
        rows = rows.filter(({row}) => String(row[col] ?? '').toLowerCase().includes(t));
      }
      if (search) rows = rows.filter(({row}) =>
        raw.columns.some((c) => String(row[c] ?? '').toLowerCase().includes(search)));
      if (!server && sort.col) {
        rows.sort((a, b) => {
          let x = a.row[sort.col], y = b.row[sort.col];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          const nx = Number(x), ny = Number(y);
          if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * sort.dir;
          return String(x).localeCompare(String(y)) * sort.dir;
        });
      }
      return rows;
    }

    function renderGrid(){
      if (!raw || !raw.columns.length) { gridEl.innerHTML = ''; return; }
      const editable = !!raw.editable;
      const view = computeView();
      const allSel = editable && view.length > 0 && view.every(({ri}) => selected.has(ri));
      let h = '<table><thead><tr>';
      if (editable) h += '<th class="chk"><input type="checkbox" id="chkAll"'+(allSel?' checked':'')+'></th>';
      for (const c of raw.columns) {
        const m = metaFor(c);
        const mk = m ? (m.pk?' 🔑':'') + (m.fk?' 🔗':'') + (m.nullable?'':' <span style="color:var(--vscode-errorForeground)">*</span>') : '';
        const sorted = sort.col === c ? ' sorted' : '';
        const arrow = sort.col === c ? (sort.dir>0?'▲':'▼') : '⇅';
        h += '<th class="'+sorted.trim()+'" data-col="'+esc(c)+'">' +
             '<div class="cname">'+esc(c)+mk+' <span class="sort">'+arrow+'</span></div>' +
             (m ? '<div class="ctype">'+esc(m.type)+'</div>' : '') + '</th>';
      }
      h += '</tr><tr class="filterRow">';
      if (editable) h += '<th class="chk"></th>';
      for (const c of raw.columns)
        h += '<th><input class="filter" data-col="'+esc(c)+'" placeholder="filter" value="'+esc(filters[c]||'')+'"></th>';
      h += '</tr></thead><tbody>';
      const fkCols = new Set((raw.foreignKeys || []).map((f) => f.column));
      for (const { row, ri } of view) {
        h += '<tr data-ri="'+ri+'"'+(selected.has(ri)?' class="selected"':'')+'>';
        if (editable) h += '<td class="chk"><input type="checkbox" class="rowchk" data-ri="'+ri+'"'+(selected.has(ri)?' checked':'')+'></td>';
        for (const c of raw.columns) {
          const isFk = fkCols.has(c);
          const classes = [];
          if (editable) classes.push('editable');
          if (isFk) classes.push('fkcell');
          const clsAttr = classes.length ? ' class="'+classes.join(' ')+'"' : '';
          const dataCol = (editable || isFk) ? ' data-col="'+esc(c)+'"' : '';
          const val = row[c];
          let inner = (isFk && val != null) ? '<span class="fkval">'+display(val)+'</span>' : display(val);
          if (editable) inner += '<span class="zoom" data-col="'+esc(c)+'">🔍</span>';
          if (isFk && val != null) inner += '<span class="relbtn" data-col="'+esc(c)+'" title="View related row">↗</span>';
          h += '<td'+clsAttr+dataCol+'>'+inner+'</td>';
        }
        h += '</tr>';
      }
      h += '</tbody></table>';
      gridEl.innerHTML = h;
      wireGrid(editable);
      $('delBtn').disabled = !editable || selected.size === 0;
    }

    // Restore focus to a per-column filter box, but ONLY right after a
    // server-side column-filter response (never on a global-search re-render).
    function restoreFilterFocus(){
      if (!pendingFilterFocus) return;
      const col = pendingFilterFocus; pendingFilterFocus = null;
      const inp = gridEl.querySelector('input.filter[data-col="' + col.replace(/"/g,'\\\\"') + '"]');
      if (inp) { inp.focus(); const v = inp.value; inp.value = ''; inp.value = v; }
    }

    function wireGrid(editable){
      gridEl.querySelectorAll('th[data-col]').forEach((th) => {
        th.addEventListener('click', (e) => {
          if (e.target.closest('.filter')) return;
          const c = th.getAttribute('data-col');
          if (sort.col === c) sort.dir = -sort.dir; else { sort.col = c; sort.dir = 1; }
          if (serverBacked()) {
            vscode.postMessage({ type:'sort', column: sort.col, dir: sort.dir > 0 ? 'asc' : 'desc' });
          } else {
            renderGrid();
          }
        });
      });
      gridEl.querySelectorAll('input.filter').forEach((inp) => {
        inp.addEventListener('click', (e) => e.stopPropagation());
        inp.addEventListener('input', (e) => {
          const col = inp.getAttribute('data-col');
          filters[col] = e.target.value;
          lastFilterCol = col;
          if (serverBacked()) { scheduleServerFilter(); } else { renderGrid(); }
        });
      });
      gridEl.querySelectorAll('.relbtn').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const ri = Number(b.closest('tr').getAttribute('data-ri'));
          const col = b.getAttribute('data-col');
          vscode.postMessage({ type:'openRelated', column: col, value: raw.rows[ri][col] });
        });
      });
      if (!editable) return;
      const all = $('chkAll');
      if (all) all.addEventListener('change', (e) => {
        if (e.target.checked) computeView().forEach(({ri}) => selected.add(ri)); else selected.clear();
        renderGrid();
      });
      gridEl.querySelectorAll('input.rowchk').forEach((chk) => {
        chk.addEventListener('change', (e) => {
          const ri = Number(chk.getAttribute('data-ri'));
          if (e.target.checked) selected.add(ri); else selected.delete(ri);
          $('delBtn').disabled = selected.size === 0;
          chk.closest('tr').classList.toggle('selected', e.target.checked);
        });
      });
      gridEl.querySelectorAll('.zoom').forEach((z) => {
        z.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(Number(z.closest('tr').getAttribute('data-ri')), z.getAttribute('data-col'));
        });
      });
    }
    gridEl.addEventListener('dblclick', onDblEdit); // attached once

    function onDblEdit(e){
      const td = e.target.closest && e.target.closest('td.editable');
      if (!td || !raw || !raw.editable || td.querySelector('input.cell')) return;
      const ri = Number(td.parentElement.getAttribute('data-ri'));
      const col = td.getAttribute('data-col');
      const original = raw.rows[ri][col];
      const input = document.createElement('input');
      input.className = 'cell';
      input.value = (original === null || original === undefined) ? '' : String(original);
      td.textContent = ''; td.appendChild(input); input.focus(); input.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const val = input.value;
        if (String(original ?? '') === val) { td.innerHTML = display(original); return; }
        saveCell(ri, col, val);
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { done = true; renderGrid(); }
      });
      input.addEventListener('blur', commit);
    }

    function saveCell(ri, col, val){
      const pk = {}; for (const k of raw.editable.pkColumns) pk[k] = raw.rows[ri][k];
      raw.rows[ri][col] = val;              // optimistic
      statusEl.textContent = 'Saving…';
      vscode.postMessage({ type:'update', pk, column: col, value: val, rowIndex: ri });
      renderGrid();
    }

    // ---- cell modal ----
    function openModal(ri, col){
      modalCtx = { ri, col };
      const v = raw.rows[ri][col];
      $('mfmt').value = 'plain';
      $('mtext').value = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
      $('overlay').style.display = 'flex';
    }
    function closeModal(){ $('overlay').style.display = 'none'; modalCtx = null; }
    $('mclose').addEventListener('click', closeModal);
    $('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
    $('mcopy').addEventListener('click', () => vscode.postMessage({ type:'copy', text: $('mtext').value }));
    $('mfmt').addEventListener('change', () => {
      if ($('mfmt').value === 'json') {
        try { $('mtext').value = JSON.stringify(JSON.parse($('mtext').value), null, 2); } catch(_){}
      }
    });
    $('msave').addEventListener('click', () => {
      if (!modalCtx || !raw.editable) { closeModal(); return; }
      saveCell(modalCtx.ri, modalCtx.col, $('mtext').value);
      closeModal();
    });

    // ---- add-row modal ----
    $('addBtn').addEventListener('click', openAddModal);
    $('aclose').addEventListener('click', () => $('addOverlay').style.display = 'none');
    $('addOverlay').addEventListener('click', (e) => { if (e.target.id === 'addOverlay') $('addOverlay').style.display = 'none'; });
    function openAddModal(){
      if (!raw || !raw.editable) return;
      const form = $('addForm');
      form.innerHTML = raw.columns.map((c) => {
        const m = metaFor(c);
        const label = esc(c) + (m ? ' <span class="ctype">'+esc(m.type)+(m.nullable?'':' *')+'</span>' : '');
        return '<div style="margin-bottom:8px;"><div style="margin-bottom:2px;">'+label+'</div>' +
          '<input class="filter addfield" data-col="'+esc(c)+'" style="width:100%;box-sizing:border-box;"></div>';
      }).join('');
      $('addOverlay').style.display = 'flex';
    }
    $('asave').addEventListener('click', () => {
      const values = {};
      $('addForm').querySelectorAll('input.addfield').forEach((inp) => {
        const v = inp.value;
        if (v !== '') values[inp.getAttribute('data-col')] = v;
      });
      if (!Object.keys(values).length) { statusEl.textContent = 'Nothing to insert'; return; }
      vscode.postMessage({ type:'insert', values });
      $('addOverlay').style.display = 'none';
    });

    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'error') {
        statusEl.textContent = 'Error';
        gridEl.innerHTML = '<pre style="color:var(--vscode-errorForeground)">'+esc(m.message)+'</pre>';
        return;
      }
      if (m.type === 'updateResult') {
        statusEl.textContent = m.ok ? m.message : ('Update failed: ' + m.message);
        return;
      }
      if (m.type === 'saved') { statusEl.textContent = 'Saved ✓'; return; }
      if (m.type === 'setSql') { sqlEl.value = m.sql; return; }
      if (m.type === 'result') {
        raw = m.result; selected.clear();
        // Only reset sort/filters for a brand-new table/query, not sort/filter/page re-runs.
        if (m.fresh) { sort = { col:null, dir:1 }; filters = {}; search = ''; $('search').value = ''; lastFilterCol = null; }
        // Show the equivalent SQL for table previews so it can be seen/edited.
        if (raw.sql != null) sqlEl.value = raw.sql;
        $('addBtn').disabled = !raw.editable;
        updateTtl();
        const p = raw.page;
        $('cost').textContent = raw.elapsedMs != null ? ('Cost: ' + (raw.elapsedMs/1000).toFixed(2) + 's') : '';
        if (p) {
          const from = p.total ? p.offset + 1 : 0, to = Math.min(p.offset + p.limit, p.total);
          $('pageLbl').textContent = from + '–' + to;
          $('total').textContent = 'Total ' + p.total;
          $('prevBtn').disabled = p.offset <= 0;
          $('nextBtn').disabled = p.offset + p.limit >= p.total;
        } else {
          $('pageLbl').textContent = '–'; $('total').textContent = raw.rowCount + ' row(s)';
          $('prevBtn').disabled = true; $('nextBtn').disabled = true;
        }
        statusEl.textContent = (raw.message || (raw.rowCount + ' row(s)')) +
          (raw.editable ? ' · double-click or 🔍 to edit, check rows to delete' : '');
        renderGrid();
        restoreFilterFocus();
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
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = result.columns.map(esc).join(",");
  const lines = result.rows.map((row) => result.columns.map((c) => esc(row[c])).join(","));
  return [header, ...lines].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
