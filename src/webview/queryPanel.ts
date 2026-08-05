import * as fs from "node:fs";
import * as vscode from "vscode";
import { AiService } from "../ai/aiService";
import { AiStore } from "../ai/aiStore";
import type { AiVerb } from "../ai/prompts";
import { UsageStore } from "../ai/usageStore";
import type { ConnectionManager } from "../connections/manager";
import type { ConnectionStore } from "../connections/store";
import type { DatabaseType } from "../connections/types";
import type {
  ColumnFilter,
  EditTarget,
  PreviewFilter,
  QueryResult,
  SchemaHints,
  SortSpec,
} from "../drivers/Driver";
import { logError } from "../log";
import { suggest } from "../sqlComplete";
import { canFormat, formatSql, vocabularyFor } from "../sqlDialect";

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
  private hints?: SchemaHints;
  private hintsDb?: string;
  private hintsPending = false;
  private disposed = false;
  private readonly ai: AiService;
  private aiBarShown = false;

  private rerun(sql: string, database?: string): void {
    this.previewPath = undefined;
    this.database = database;
    this.post({ type: "setSql", sql });
    // The panel may now target a different database — keep the badge honest.
    this.post({ type: "context", label: this.contextLabel(), tooltip: this.contextTooltip() });
    void this.run(sql);
  }

  /**
   * What this panel's queries actually run against. The database is a hard
   * binding (`driver.query(sql, database)`); the SCHEMA deliberately is not
   * shown — a session isn't pinned to one, unqualified names resolve through
   * search_path, and suggestions already cover every schema's tables.
   */
  private contextLabel(): string {
    const config = this.store.get(this.connectionId);
    if (!config) {
      return "";
    }
    if (config.type === "sqlite") {
      return basename(config.filePath ?? "");
    }
    if (config.type === "redis") {
      return `db${this.database ?? config.redisDb ?? 0}`;
    }
    return this.database ?? config.database ?? "default DB";
  }

  private contextTooltip(): string {
    const name = this.store.get(this.connectionId)?.name ?? "this connection";
    return (
      `Queries in this panel run against "${this.contextLabel()}" on ${name}. ` +
      `To target another database, use New Query on that database in the tree.`
    );
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly store: ConnectionStore,
    private readonly connectionId: string,
    options: PanelOptions,
  ) {
    const config = this.store.get(connectionId);
    this.ai = new AiService(new AiStore(ctx), new UsageStore(ctx));
    this.database = options.database;
    // A preview's path starts with the database on multi-database engines
    // (postgres/mysql: db name, redis: db number). Bind the panel to it, so that
    // Run on the shown SQL and completion hints target the database the preview
    // came from — not the connection's entry database. Previewing
    // drizzle.__drizzle_migrations and hitting Run used to fail with
    // "relation does not exist" precisely because of this gap. SQLite is
    // excluded: its path[0] is a table name, and it has one database anyway.
    if (this.database === undefined && options.previewPath?.length && config?.type !== "sqlite") {
      this.database = options.previewPath[0];
    }
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
      this.contextLabel(),
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
            await this.runPreview(this.previewPath, this.offset, false, msg.seq);
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
            await this.runPreview(this.previewPath, 0, false, msg.seq);
          }
          break;
        case "filter":
          if (this.previewPath) {
            this.columnFilters = (msg.filters ?? []).filter((f: ColumnFilter) => f.value);
            this.offset = 0;
            await this.runPreview(this.previewPath, 0, false, msg.seq);
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
        case "format":
          this.handleFormat(String(msg.sql ?? ""));
          break;
        case "complete":
          await this.handleComplete(String(msg.text ?? ""), Number(msg.seq ?? 0));
          break;
        case "ai":
          await this.handleAi(msg);
          break;
        case "aiComplete":
          await this.handleAiComplete(String(msg.word ?? ""), Number(msg.seq ?? 0));
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

    void this.syncAiBar();
    // A provider configured in settings after this panel opened should still
    // light the bar up — re-check whenever the panel comes back into view.
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        void this.syncAiBar();
      }
    });
  }

  /**
   * Show the assist bar only when a provider is fully configured and AI is not
   * disabled for this connection. Redis is out of scope for v1 (different
   * language — same deferral as autocomplete), so its panels never get the bar.
   */
  private async syncAiBar(): Promise<void> {
    if (this.aiBarShown || this.disposed) {
      return;
    }
    const type = this.store.get(this.connectionId)?.type;
    if (!type || type === "redis") {
      return;
    }
    if ((await this.ai.isConfigured()) && this.ai.enabledFor(this.connectionId)) {
      this.aiBarShown = true;
      this.post({ type: "aiEnabled" });
    }
  }

  private async handleAi(msg: {
    verb: AiVerb;
    prompt?: string;
    sql?: string;
    error?: string;
    seq?: number;
  }): Promise<void> {
    const config = this.store.get(this.connectionId);
    if (!config || config.type === "redis") {
      return;
    }
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const res = await this.ai.run(
        {
          verb: msg.verb,
          connId: this.connectionId,
          connType: config.type,
          database: this.database,
          prompt: msg.prompt,
          sql: msg.sql,
          error: msg.error,
        },
        driver,
      );
      if (!res) {
        this.post({ type: "aiResult", seq: msg.seq, cancelled: true });
        return;
      }
      this.post({
        type: "aiResult",
        seq: msg.seq,
        verb: msg.verb,
        sql: res.sql,
        text: res.text,
        trimmedTo: res.trimmedTo,
        destructive: res.destructive,
        ms: res.ms,
        tokens: res.tokens,
      });
    } catch (err) {
      logError("ai", err);
      this.post({ type: "aiResult", seq: msg.seq, error: (err as Error).message });
    }
  }

  /**
   * Identifier suggestions for the assist bar's natural-language prompt:
   * tables and columns only — keywords are noise in prose. Prefix matches
   * outrank contains, mirroring the SQL widget's feel.
   */
  private async handleAiComplete(word: string, seq: number): Promise<void> {
    await this.ensureHints();
    const w = word.toLowerCase();
    if (!w || !this.hints) {
      this.post({ type: "aiCompletions", items: [], seq });
      return;
    }
    const candidates: Array<{ label: string; kind: string; detail?: string }> = [];
    for (const t of this.hints.tables) {
      candidates.push({ label: t, kind: "table" });
    }
    if (this.hints.columnsByTable) {
      for (const [table, cols] of Object.entries(this.hints.columnsByTable)) {
        for (const c of cols) {
          candidates.push({ label: c, kind: "column", detail: table });
        }
      }
    } else {
      for (const c of this.hints.columns) {
        candidates.push({ label: c, kind: "column" });
      }
    }
    const starts = candidates.filter((c) => c.label.toLowerCase().startsWith(w));
    const contains = candidates.filter(
      (c) => !c.label.toLowerCase().startsWith(w) && c.label.toLowerCase().includes(w),
    );
    this.post({ type: "aiCompletions", items: [...starts, ...contains].slice(0, 12), seq });
  }

  private async runPreview(
    path: string[],
    offset: number,
    fresh = false,
    seq?: number,
  ): Promise<void> {
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
      this.show(result, fresh, seq);
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

  /** `seq` echoes the webview's request counter so it can drop an out-of-order response. */
  private show(result: QueryResult, fresh = false, seq?: number): void {
    this.lastResult = result;
    this.lastEditable = result.editable;
    this.post({ type: "result", result, fresh, seq });
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

  /**
   * Schema names for completion, fetched lazily and cached.
   *
   * Only ever loaded when the connection is ALREADY live: typing in the editor
   * must never trigger a connect (and a password prompt) as a side effect.
   * Until then completion still works off the dialect vocabulary, which needs no
   * connection at all.
   */
  private async ensureHints(): Promise<void> {
    // Keyed by database: a panel can be re-pointed (rerun, preview) at another
    // database on the same server, and serving the old database's tables is
    // exactly the "suggestions stopped working" failure mode.
    if (
      (this.hints && this.hintsDb === this.database) ||
      !this.manager.isConnected(this.connectionId)
    ) {
      return;
    }
    // One fetch at a time — completion fires per keystroke, and a slow catalog
    // read shouldn't be issued five times in parallel.
    if (this.hintsPending) {
      return;
    }
    this.hintsPending = true;
    try {
      const driver = await this.manager.getDriver(this.connectionId);
      const forDb = this.database;
      this.hints = await driver.schemaHints(forDb);
      this.hintsDb = forDb;
    } catch (err) {
      // Completion is an assist, never an error path — fall back to vocabulary.
      logError("schemaHints", err);
    } finally {
      this.hintsPending = false;
    }
  }

  /**
   * Answer a completion request. The reasoning lives in `sqlComplete.ts` (pure
   * and unit-tested) rather than in the webview, so this is the bridge: text in,
   * ranked items out. `seq` guards against an older reply landing last, the same
   * way the results grid does.
   */
  private async handleComplete(textBeforeCaret: string, seq: number): Promise<void> {
    await this.ensureHints();
    const type = this.store.get(this.connectionId)?.type ?? "postgres";
    const vocab = vocabularyFor(type);
    const { items, truncated } = suggest(textBeforeCaret, {
      tables: this.hints?.tables ?? [],
      columns: this.hints?.columns ?? [],
      columnsByTable: this.hints?.columnsByTable,
      keywords: vocab.keywords,
      functions: vocab.functions,
      dataTypes: vocab.dataTypes,
    });
    this.post({
      type: "completions",
      items,
      seq,
      // Two independent truncations to be honest about: the visible list was cut,
      // and/or the schema itself was too big to read fully.
      listTruncated: truncated,
      schemaTruncated: !!this.hints?.truncated,
    });
  }

  /** Format the editor's contents in place. On a parse error the buffer is left
   *  exactly as typed — a half-parsed reformat would destroy unrecoverable work. */
  private handleFormat(sql: string): void {
    const type = this.store.get(this.connectionId)?.type;
    if (!type || !canFormat(type)) {
      return;
    }
    try {
      const formatted = formatSql(sql, type, {
        tabWidth: vscode.workspace.getConfiguration("editor").get<number>("tabSize") ?? 2,
      });
      if (formatted !== sql) {
        this.post({ type: "setSql", sql: formatted });
      }
      this.post({ type: "status", message: "Formatted ✓" });
    } catch (err) {
      this.post({ type: "status", message: `Format failed: ${(err as Error).message}` });
    }
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private render(initialSql: string, dbType: string, hasFile: boolean, dbLabel: string): string {
    const placeholder = dbType === "redis" ? "GET mykey" : "SELECT * FROM ... LIMIT 100";
    // Redis has no SQL dialect, so the button is omitted rather than shown inert.
    const formattable = canFormat(dbType as DatabaseType);
    // Same reasoning for the comment toggle: a Redis buffer is one command, and `--`
    // would be sent as an argument rather than ignored. No binding beats a broken one.
    const commentable = dbType !== "redis";
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
  /* Which database this panel's queries actually hit. Deliberately visible — a
     panel silently bound to the wrong database is how "relation does not exist"
     surprises happen on multi-database servers. */
  #dbctx { padding: 2px 8px; border: 1px solid var(--border); border-radius: 3px;
           opacity: .85; white-space: nowrap; max-width: 180px; overflow: hidden;
           text-overflow: ellipsis; cursor: default; }
  #dbctx:empty { display: none; }
  #status, #cost, #total { opacity: .8; }
  #scope { opacity: .8; margin-bottom: 4px; }
  #scope:empty { display: none; }
  #scope .warn { color: var(--vscode-editorWarning-foreground); }
  #grid { overflow: auto; max-height: 66vh; border: 1px solid var(--border); }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--border); padding: 3px 8px; text-align: left;
           white-space: pre; vertical-align: top; }
  /* z-index keeps the header above the body cells, which are positioned
     (td.editable / td.fkcell are relative) and would otherwise paint over it as
     they scroll underneath. See .filterRow th for the second header row. */
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0;
       cursor: pointer; z-index: 3; }
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
  /* --- completion dropdown --- */
  /* Invisible clone of the editor used only to measure where the caret is on
     screen; a textarea exposes no caret coordinates of its own. */
  #acmirror { position: absolute; top: 0; left: 0; visibility: hidden;
              white-space: pre-wrap; word-wrap: break-word; pointer-events: none;
              z-index: -1; }
  #ac { position: fixed; z-index: 50; display: none; max-height: 240px;
        overflow-y: auto; min-width: 220px; max-width: 420px;
        background: var(--vscode-editorWidget-background, #252526);
        border: 1px solid var(--vscode-editorWidget-border, var(--border));
        box-shadow: 0 2px 8px #0006; padding: 2px 0; }
  #ac .row { display: flex; align-items: baseline; gap: 6px; padding: 2px 8px;
             cursor: pointer; white-space: nowrap; }
  #ac .row.sel { background: var(--vscode-list-activeSelectionBackground, #04395e);
                 color: var(--vscode-list-activeSelectionForeground, #fff); }
  #ac .ico { width: 1em; text-align: center; opacity: .85; flex: none; }
  #ac .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #ac .det { opacity: .55; font-size: 11px; }
  /* Per-kind colour so keyword / function / table / column are distinguishable
     at a glance, as in the reference clients. */
  #ac .k-keyword  .ico { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  #ac .k-function .ico { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  #ac .k-table    .ico { color: var(--vscode-symbolIcon-structForeground, #4ec9b0); }
  #ac .k-column   .ico { color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe); }
  #ac .k-dataType .ico { color: var(--vscode-symbolIcon-typeParameterForeground, #569cd6); }
  #ac .more { padding: 2px 8px; opacity: .6; font-size: 11px; font-style: italic;
              border-top: 1px solid var(--border); }
  /* --- AI assist bar --- */
  #aibar { display: none; gap: 6px; margin-bottom: 6px; align-items: center; }
  #aiPrompt { flex: 1; background: var(--vscode-input-background);
              color: var(--vscode-input-foreground); padding: 4px 8px; border-radius: 3px;
              border: 1px solid var(--vscode-input-border, var(--border)); font-size: 12px; }
  #ainote { opacity: .85; margin: 4px 0; }
  #ainote:empty { display: none; }
  #aispin { display: none; white-space: nowrap; font-variant-numeric: tabular-nums;
            color: var(--vscode-textLink-foreground); }
  .aiwarn { color: var(--vscode-editorWarning-foreground); font-weight: 600; }
  .aitrim { color: var(--vscode-editorWarning-foreground); }
  .aidim { opacity: .6; }
  .null { opacity: .5; font-style: italic; }
  .chk { width: 22px; text-align: center; }
  tr.selected td { background: var(--vscode-list-activeSelectionBackground); }
  /* Second sticky header row, pinned directly below the name row. This was
     position:static, which — being more specific than the th rule above —
     silently opted the filter boxes out of the sticky header, so they scrolled
     away with the body and you lost the filters on any result taller than the
     grid. The top offset must be the name row's real height, which varies with
     the type sub-label and the user's font, so syncHeaderOffset() measures it
     into --hdr-h after every render. */
  .filterRow th { position: sticky; top: var(--hdr-h, 0px); z-index: 2; padding: 2px; }
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
  <div id="aibar">
    <input id="aiPrompt" placeholder="✨ Ask AI — describe the query you want; table names autocomplete" spellcheck="false" />
    <button id="aiGenBtn" title="Generate SQL from the description (Enter)">✨ Generate</button>
    <button id="aiExplainBtn" class="secondary" title="Explain the selected SQL (or the whole editor)">Explain</button>
    <button id="aiFixBtn" class="secondary" title="Fix the last failed query using its error message" disabled>Fix</button>
    <span id="aispin"></span>
  </div>
  <textarea id="sql" placeholder="${placeholder}">${escapeHtml(initialSql)}</textarea>
  <div id="ainote"></div>
  <div class="bar">
    <button id="runBtn" title="Run (Ctrl/Cmd+Enter) — runs the highlighted text only, when something is highlighted">Run ▶</button>
    ${hasFile ? '<button id="saveBtn" class="secondary" title="Save to file (Cmd/Ctrl+S)">💾 Save</button>' : ""}
    <button id="refreshBtn" class="secondary" title="Refresh">⟳</button>
    <span id="dbctx" title="${escapeHtml(this.contextTooltip())}">${escapeHtml(dbLabel)}</span>
    ${formattable ? '<button id="formatBtn" class="secondary" title="Format SQL (Shift+Alt+F)">Format</button>' : ""}
    <button id="addBtn" class="secondary" title="Add row" disabled>＋ Row</button>
    <button id="delBtn" class="secondary" title="Delete selected rows" disabled>🗑 Delete</button>
    <button id="csvBtn" class="secondary">Export CSV</button>
    <button id="jsonBtn" class="secondary">Export JSON</button>
    <button id="copyJsonBtn" class="secondary" title="Copy checked rows as JSON — all rows in view if none are checked">Copy as JSON</button>
    <input id="search" class="search" placeholder="Search results…" />
    <button id="clearFiltersBtn" class="secondary" title="Clear the search box and every column filter" disabled>Clear filters</button>
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
  <div id="ac"></div>
  <div id="status">Ctrl/Cmd+Enter to run — highlight to run only that${
    commentable ? " · Ctrl/Cmd+/ to comment" : ""
  }</div>
  <div id="scope"></div>
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
    // Filter/sort/page round-trips can overlap, and a slow one landing last would
    // otherwise repaint the grid with rows that no longer match the boxes.
    let reqSeq = 0, renderedSeq = 0;
    const serverBacked = () => !!(raw && raw.page);
    function scheduleServerFilter(){
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        const arr = Object.entries(filters).filter(([,v]) => v).map(([column,value]) => ({ column, value }));
        vscode.postMessage({ type:'filter', filters: arr, seq: ++reqSeq });
      }, 350);
    }

    // Highlight-to-run: with a selection, only that text is sent. The textarea keeps
    // its selection after losing focus, so the Run button behaves the same as
    // Ctrl/Cmd+Enter — one rule, not two. A whitespace-only selection is ignored.
    function run() {
      const sel = sqlEl.value.slice(sqlEl.selectionStart, sqlEl.selectionEnd);
      const partial = !!sel.trim();
      statusEl.textContent = partial ? 'Running selection…' : 'Running…';
      vscode.postMessage({ type:'run', sql: partial ? sel : sqlEl.value });
    }
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
    // Formatting runs on the host (that is where sql-formatter lives). The reply
    // is a normal setSql, so an unparseable statement simply never comes back and
    // the editor keeps what the user typed.
    if ($('formatBtn')) {
      $('formatBtn').addEventListener('click', () => {
        vscode.postMessage({ type:'format', sql: sqlEl.value });
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.shiftKey && e.altKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        if ($('formatBtn')) vscode.postMessage({ type:'format', sql: sqlEl.value });
      }
    });
    $('csvBtn').addEventListener('click', () => vscode.postMessage({ type:'export', format:'csv' }));
    $('jsonBtn').addEventListener('click', () => vscode.postMessage({ type:'export', format:'json' }));
    $('copyJsonBtn').addEventListener('click', copyAsJson);
    $('search').addEventListener('input', (e) => { search = e.target.value.toLowerCase(); renderGrid(); });

    const hasAnyFilter = () => !!search || Object.values(filters).some((v) => v);
    function syncClearBtn(){ $('clearFiltersBtn').disabled = !hasAnyFilter(); }

    // Drop the search term and every column filter in one go. The two are
    // applied in different places — search is always client-side, while column
    // filters hit the database on a paginated preview — so both paths have to be
    // reset, not just the boxes.
    function clearFilters(){
      if (!hasAnyFilter()) return;
      filters = {}; search = '';
      $('search').value = '';
      // Cancel a debounced filter still in flight, or it would re-query with the
      // terms we just cleared.
      clearTimeout(filterTimer);
      // Redraw first so the boxes empty immediately; a server-backed preview then
      // needs a round-trip to get the unfiltered rows back.
      renderGrid();
      if (serverBacked()) vscode.postMessage({ type:'filter', filters: [], seq: ++reqSeq });
    }
    $('clearFiltersBtn').addEventListener('click', clearFilters);
    sqlEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    // ---------------- line comment toggle (Ctrl/Cmd+/) ----------------
    // VS Code's own editor.action.commentLine is gated on editorTextFocus, so it
    // never fires inside a webview — the panel has to bring its own.
    function toggleComment(){
      const v = sqlEl.value, s = sqlEl.selectionStart, e = sqlEl.selectionEnd;
      // Whole lines only. A selection ending exactly on a line break stops at the
      // line it visibly covers rather than pulling in the next one.
      const from = v.lastIndexOf('\\n', s - 1) + 1;
      let tail = e;
      if (tail > s && v[tail-1] === '\\n') tail--;
      let to = v.indexOf('\\n', tail);
      if (to < 0) to = v.length;

      const block = v.slice(from, to);
      const lines = block.split('\\n');
      const filled = lines.filter((l) => l.trim());
      if (!filled.length) return;
      // Uncomment only when every line is already commented — on a mixed block,
      // "toggle" that uncommented half the selection would be a surprise.
      const off = filled.every((l) => /^\\s*--/.test(l));
      // Comment at the shallowest indent so the block keeps its shape.
      const col = off ? 0 : Math.min.apply(null, filled.map((l) => l.match(/^\\s*/)[0].length));
      const out = lines.map((l) => !l.trim() ? l
        : off ? l.replace(/^(\\s*)--[ ]?/, '$1')
        : l.slice(0, col) + '-- ' + l.slice(col));
      const text = out.join('\\n');
      if (text === block) return;

      // Map a caret through the edit: columns before the edit point stay put,
      // the rest shift by their own line's delta.
      function mapPos(pos){
        let src = from, dst = from;
        for (let i = 0; i < lines.length; i++) {
          if (pos <= src + lines[i].length) {
            const c = pos - src, d = out[i].length - lines[i].length;
            return dst + (c <= col ? c : Math.max(col, c + d));
          }
          src += lines[i].length + 1;
          dst += out[i].length + 1;
        }
        return dst;
      }
      const ns = mapPos(s), ne = mapPos(e);

      // insertText keeps the browser's native undo stack; assigning .value wipes it,
      // so that path is only the fallback.
      sqlEl.setSelectionRange(from, to);
      let ok = false;
      // insertText fires an input event, but a comment toggle is not someone typing
      // an identifier — don't let it pop the completion list.
      acQuiet = true;
      try { ok = document.execCommand('insertText', false, text); } catch (err) { ok = false; }
      acQuiet = false;
      if (!ok) sqlEl.value = v.slice(0, from) + text + v.slice(to);
      sqlEl.setSelectionRange(ns, ne);
    }
    ${
      commentable
        ? `sqlEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault();
        acClose();
        toggleComment();
      }
    });`
        : ""
    }

    // ---------------- completion dropdown ----------------
    // The reasoning lives on the host (sqlComplete.ts, unit-tested); this owns
    // only the UI: where to draw, what is selected, and how to insert.
    const acEl = $('ac');
    let acItems = [], acSel = 0, acOpen = false, acMore = false;
    let acSeq = 0, acRendered = 0, acComposing = false, acQuiet = false;
    const ICON = { keyword:'◇', function:'ƒ', table:'▦', column:'▪', dataType:'T' };

    // A textarea gives no caret coordinates, so measure with a hidden clone that
    // has identical text metrics and read the offset of a marker at the caret.
    let mirror = null;
    function caretPoint(){
      if (!mirror) { mirror = document.createElement('div'); mirror.id = 'acmirror'; document.body.appendChild(mirror); }
      const cs = getComputedStyle(sqlEl);
      for (const p of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing',
                       'lineHeight','textTransform','paddingTop','paddingRight','paddingBottom',
                       'paddingLeft','borderTopWidth','borderLeftWidth','boxSizing','tabSize']) {
        mirror.style[p] = cs[p];
      }
      mirror.style.width = sqlEl.clientWidth + 'px';
      mirror.textContent = sqlEl.value.slice(0, sqlEl.selectionStart);
      const marker = document.createElement('span');
      marker.textContent = '\\u200b';
      mirror.appendChild(marker);
      const box = sqlEl.getBoundingClientRect();
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      return {
        // Drop the list one line below the caret so it never covers what is typed.
        top: box.top + marker.offsetTop - sqlEl.scrollTop + lh,
        left: box.left + marker.offsetLeft - sqlEl.scrollLeft,
        lineHeight: lh,
      };
    }

    function acClose(){ acOpen = false; acEl.style.display = 'none'; acItems = []; }

    function acRender(){
      if (!acItems.length) { acClose(); return; }
      let h = '';
      acItems.forEach((it, i) => {
        h += '<div class="row k-'+it.kind+(i===acSel?' sel':'')+'" data-i="'+i+'">' +
             '<span class="ico">'+(ICON[it.kind]||'•')+'</span>' +
             '<span class="lbl">'+esc(it.label)+'</span>' +
             (it.detail ? '<span class="det">'+esc(it.detail)+'</span>' : '') + '</div>';
      });
      // Never imply the list is everything when it isn't.
      if (acMore) h += '<div class="more">more matches — keep typing to narrow</div>';
      acEl.innerHTML = h;
      const pt = caretPoint();
      acEl.style.display = 'block';
      acOpen = true;
      // Measure after display so the height is real, then flip above the caret
      // when there is not enough room below.
      const h2 = acEl.offsetHeight;
      const below = window.innerHeight - pt.top;
      acEl.style.top = (h2 > below && pt.top - pt.lineHeight - h2 > 0
        ? pt.top - pt.lineHeight - h2 : pt.top) + 'px';
      acEl.style.left = Math.min(pt.left, window.innerWidth - acEl.offsetWidth - 8) + 'px';
      const sel = acEl.querySelector('.row.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    function acRequest(){
      if (acComposing || acQuiet) return;
      // Never awaits the database: the host replies from cached hints, and a
      // stale reply is dropped by seq (same guard the results grid uses).
      vscode.postMessage({ type:'complete', text: sqlEl.value.slice(0, sqlEl.selectionStart), seq: ++acSeq });
    }

    function acAccept(){
      const it = acItems[acSel];
      if (!it) return;
      const caret = sqlEl.selectionStart;
      const v = sqlEl.value;
      // Replace just the identifier being typed. Word chars only, so a preceding
      // "." or quote is preserved.
      let start = caret;
      while (start > 0 && /[A-Za-z0-9_$#]/.test(v[start-1])) start--;
      // Trailing space is a convenience for typing on, but not when it would
      // double up an existing one (accepting mid-statement).
      const insert = it.label + (/^\\s/.test(v.slice(caret)) ? '' : ' ');
      sqlEl.value = v.slice(0, start) + insert + v.slice(caret);
      const pos = start + insert.length;
      sqlEl.setSelectionRange(pos, pos);
      acClose();
      sqlEl.focus();
    }

    sqlEl.addEventListener('input', acRequest);
    // IME: a composing keystroke is not a completion trigger, and committing one
    // should not leave a stale list open.
    sqlEl.addEventListener('compositionstart', () => { acComposing = true; acClose(); });
    sqlEl.addEventListener('compositionend', () => { acComposing = false; acRequest(); });
    sqlEl.addEventListener('blur', acClose);
    sqlEl.addEventListener('scroll', () => { if (acOpen) acRender(); });

    // Registered before the Ctrl+Enter handler above only in the sense that it
    // handles UNMODIFIED keys — Ctrl/Cmd+Enter and Cmd+S never reach here as
    // completion keys, so both keep working while the list is open.
    sqlEl.addEventListener('keydown', (e) => {
      if (!acOpen) {
        // Ctrl/Cmd+Space asks explicitly, which is what people expect.
        if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); acRequest(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); acSel = (acSel+1) % acItems.length; acRender(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acSel = (acSel-1+acItems.length) % acItems.length; acRender(); }
      else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); acAccept(); }
      else if (e.key === 'Tab') { e.preventDefault(); acAccept(); }
      // Only closes the list — the panel itself is unaffected.
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acClose(); }
    });

    acEl.addEventListener('mousedown', (e) => {
      // mousedown, not click: blur would close the list before click landed.
      const row = e.target.closest('.row');
      if (!row) return;
      e.preventDefault();
      // The dropdown element is shared between the SQL editor and the AI
      // prompt field — route the click to whichever widget owns it right now.
      if (pcOpen) { pcSel = Number(row.getAttribute('data-i')); pcAccept(); }
      else { acSel = Number(row.getAttribute('data-i')); acAccept(); }
    });

    // ---------------- AI assist bar ----------------
    // Hidden until the host confirms a configured provider (aiEnabled). All
    // reasoning is host-side; this owns only input, insert, and the note line.
    const aiBar = $('aibar'), aiPromptEl = $('aiPrompt'), aiNote = $('ainote');
    let aiSeq = 0, lastError = null;

    // Live progress: an animated spinner + elapsed seconds right in the bar, so
    // a long provider round-trip reads as "working" rather than "stuck".
    const AI_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let aiTimer = null, aiStart = 0, aiFrame = 0;
    function aiSpinStart(){
      aiStart = Date.now();
      const spin = $('aispin');
      spin.textContent = AI_FRAMES[0] + ' Asking AI… 0s';
      spin.style.display = 'inline';
      clearInterval(aiTimer);
      aiTimer = setInterval(() => {
        aiFrame = (aiFrame + 1) % AI_FRAMES.length;
        const secs = Math.floor((Date.now() - aiStart) / 1000);
        spin.textContent = AI_FRAMES[aiFrame] + ' Asking AI… ' + secs + 's';
      }, 120);
    }
    function aiSpinStop(){
      clearInterval(aiTimer);
      aiTimer = null;
      $('aispin').style.display = 'none';
      return ((Date.now() - aiStart) / 1000).toFixed(1);
    }

    function setAiBusy(b){
      $('aiGenBtn').disabled = b;
      $('aiExplainBtn').disabled = b;
      $('aiFixBtn').disabled = b || !lastError;
    }
    function aiSend(verb){
      const payload = { type:'ai', verb, seq: ++aiSeq };
      if (verb === 'generate') {
        const p = aiPromptEl.value.trim();
        if (!p) { aiPromptEl.focus(); return; }
        payload.prompt = p;
      } else if (verb === 'explain') {
        const sel = sqlEl.value.slice(sqlEl.selectionStart, sqlEl.selectionEnd);
        const sql = sel.trim() ? sel : sqlEl.value;
        if (!sql.trim()) { statusEl.textContent = 'Nothing to explain — the editor is empty.'; return; }
        payload.sql = sql;
      } else {
        if (!lastError) return;
        payload.sql = sqlEl.value;
        payload.error = lastError;
      }
      aiNote.textContent = '';
      aiSpinStart();
      setAiBusy(true);
      vscode.postMessage(payload);
    }
    $('aiGenBtn').addEventListener('click', () => aiSend('generate'));
    $('aiExplainBtn').addEventListener('click', () => aiSend('explain'));
    $('aiFixBtn').addEventListener('click', () => aiSend('fix'));

    // Generated SQL never destroys typed work: it replaces the selection when
    // there is one, fills an empty editor, and otherwise appends on a new line.
    // Always left selected, so one keystroke discards it and Ctrl+Enter runs it.
    function aiInsertSql(sql){
      const v = sqlEl.value;
      let start, end, insert = sql;
      if (sqlEl.selectionStart !== sqlEl.selectionEnd) { start = sqlEl.selectionStart; end = sqlEl.selectionEnd; }
      else if (!v.trim()) { start = 0; end = v.length; }
      else { start = v.length; end = v.length; insert = (v.endsWith('\\n') ? '' : '\\n') + sql; }
      sqlEl.value = v.slice(0, start) + insert + v.slice(end);
      sqlEl.setSelectionRange(start + (insert.length - sql.length), start + insert.length);
      sqlEl.focus();
    }

    // --- identifier completion inside the prompt field (tables/columns only) ---
    // Shares the #ac dropdown element with the SQL widget; pcOpen decides who owns it.
    let pcItems = [], pcSel = 0, pcOpen = false, pcSeq = 0;
    function pcClose(){
      pcItems = [];
      if (pcOpen) { pcOpen = false; if (!acOpen) acEl.style.display = 'none'; }
    }
    function pcWord(){
      const caret = aiPromptEl.selectionStart, v = aiPromptEl.value;
      let start = caret;
      while (start > 0 && /[A-Za-z0-9_.]/.test(v[start-1])) start--;
      return { word: v.slice(start, caret), start, caret };
    }
    function pcRender(){
      if (!pcItems.length) { pcClose(); return; }
      let h = '';
      pcItems.forEach((it, i) => {
        h += '<div class="row k-'+it.kind+(i===pcSel?' sel':'')+'" data-i="'+i+'">' +
             '<span class="ico">'+(ICON[it.kind]||'•')+'</span>' +
             '<span class="lbl">'+esc(it.label)+'</span>' +
             (it.detail ? '<span class="det">'+esc(it.detail)+'</span>' : '') + '</div>';
      });
      acEl.innerHTML = h;
      // Anchored under the input, not per-character: precision matters less in prose.
      const box = aiPromptEl.getBoundingClientRect();
      acEl.style.display = 'block';
      pcOpen = true;
      acEl.style.top = (box.bottom + 2) + 'px';
      acEl.style.left = box.left + 'px';
    }
    function pcAccept(){
      const it = pcItems[pcSel];
      if (!it) return;
      const { start, caret } = pcWord(), v = aiPromptEl.value;
      aiPromptEl.value = v.slice(0, start) + it.label + v.slice(caret);
      const pos = start + it.label.length;
      aiPromptEl.setSelectionRange(pos, pos);
      pcClose();
      aiPromptEl.focus();
    }
    aiPromptEl.addEventListener('input', () => {
      const { word } = pcWord();
      if (word.length < 2) { pcClose(); return; }
      vscode.postMessage({ type:'aiComplete', word, seq: ++pcSeq });
    });
    aiPromptEl.addEventListener('blur', pcClose);
    aiPromptEl.addEventListener('keydown', (e) => {
      if (pcOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); pcSel = (pcSel+1) % pcItems.length; pcRender(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); pcSel = (pcSel-1+pcItems.length) % pcItems.length; pcRender(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pcAccept(); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pcClose(); return; }
      }
      if (e.key === 'Enter') { e.preventDefault(); aiSend('generate'); }
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
      vscode.postMessage({ type:'page', offset: next, seq: ++reqSeq });
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
    // The one place a cell becomes text. Search, filters and sort all go through it so
    // they match what's on screen — a jsonb column arrives as a parsed object, and
    // String(obj) is "[object Object]", which no search term will ever match.
    function cellText(v){
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
      return String(v);
    }
    function display(v){
      if (v === null || v === undefined) return '<span class="null">null</span>';
      return esc(cellText(v));
    }
    function metaFor(name){ return (raw.columnsMeta || []).find((m) => m.name === name); }

    function computeView(){
      let rows = raw.rows.map((row, ri) => ({ row, ri }));
      const server = serverBacked();
      // Per-column filter + sort are done by the DB when server-backed.
      if (!server) for (const [col, txt] of Object.entries(filters)) {
        if (!txt) continue; const t = txt.toLowerCase();
        rows = rows.filter(({row}) => cellText(row[col]).toLowerCase().includes(t));
      }
      if (search) rows = rows.filter(({row}) =>
        raw.columns.some((c) => cellText(row[c]).toLowerCase().includes(search)));
      if (!server && sort.col) {
        rows.sort((a, b) => {
          let x = a.row[sort.col], y = b.row[sort.col];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          const nx = Number(x), ny = Number(y);
          if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * sort.dir;
          return cellText(x).localeCompare(cellText(y)) * sort.dir;
        });
      }
      return rows;
    }

    // The global search runs over raw.rows, which for a paginated preview is only the
    // page in hand — so an empty result means "not on this page", not "not in the table".
    // Say which, rather than letting it read as a broken search.
    function pageLocal(){ return serverBacked() && raw.page.total > raw.rows.length; }
    function updateScope(matched){
      const el = $('scope');
      if (!raw || !search) { el.textContent = ''; return; }
      const loaded = raw.rows.length;
      if (!pageLocal()) { el.textContent = matched + ' of ' + loaded + ' row(s) match'; return; }
      const p = raw.page;
      const page = Math.floor(p.offset / p.limit) + 1, pages = Math.ceil(p.total / p.limit);
      el.innerHTML = matched + ' of ' + loaded + ' rows on this page match · page ' + page +
        ' of ' + pages + ' — Total ' + p.total +
        ' <span class="warn">(search covers the loaded page only)</span>';
    }

    function renderGrid(){
      if (!raw || !raw.columns.length) { gridEl.innerHTML = ''; updateScope(0); return; }
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
      // The filter boxes live inside the grid, so this wipes out the one being typed in.
      // Whatever had focus goes back afterwards, caret included — re-render can be driven
      // by a keystroke, a filter response, a sort, a page or a refresh, and every one of
      // them used to be able to drop the user out of the box mid-word.
      const keep = focusedFilter();
      gridEl.innerHTML = h;
      wireGrid(editable);
      if (keep) {
        const inp = filterBox(keep.col);
        if (inp) {
          inp.focus();
          try { inp.setSelectionRange(keep.start, keep.end); } catch (_) {}
        }
      }
      syncHeaderOffset();
      syncClearBtn();
      $('delBtn').disabled = !editable || selected.size === 0;
      updateScope(view.length);
    }

    // Pin the filter row directly under the name row. Measured, not hard-coded:
    // the name row grows when columns carry a type sub-label, and the font is
    // the user's. Runs after every render, and again on resize because a column
    // name wrapping onto a second line changes the row's height.
    function syncHeaderOffset(){
      const nameRow = gridEl.querySelector('thead tr');
      if (!nameRow) return;
      const h = nameRow.getBoundingClientRect().height;
      if (h) gridEl.style.setProperty('--hdr-h', h + 'px');
    }
    window.addEventListener('resize', syncHeaderOffset);

    function filterBox(col){
      return gridEl.querySelector('input.filter[data-col="' + col.replace(/"/g,'\\\\"') + '"]');
    }
    function focusedFilter(){
      const el = document.activeElement;
      if (!el || !el.classList || !el.classList.contains('filter')) return null;
      return { col: el.getAttribute('data-col'), start: el.selectionStart, end: el.selectionEnd };
    }

    function wireGrid(editable){
      gridEl.querySelectorAll('th[data-col]').forEach((th) => {
        th.addEventListener('click', (e) => {
          if (e.target.closest('.filter')) return;
          const c = th.getAttribute('data-col');
          if (sort.col === c) sort.dir = -sort.dir; else { sort.col = c; sort.dir = 1; }
          if (serverBacked()) {
            vscode.postMessage({ type:'sort', column: sort.col, dir: sort.dir > 0 ? 'asc' : 'desc', seq: ++reqSeq });
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
          // The server-backed path debounces instead of redrawing, so the Clear
          // button would stay stale until the response landed.
          if (serverBacked()) { syncClearBtn(); scheduleServerFilter(); } else { renderGrid(); }
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
      input.value = cellText(original);
      td.textContent = ''; td.appendChild(input); input.focus(); input.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const val = input.value;
        if (cellText(original) === val) { td.innerHTML = display(original); return; }
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
        // A failure is what arms Fix — it carries the exact error to the AI.
        lastError = m.message;
        $('aiFixBtn').disabled = false;
        return;
      }
      if (m.type === 'aiEnabled') { aiBar.style.display = 'flex'; return; }
      if (m.type === 'aiCompletions') {
        if (m.seq < pcSeq) return; // stale reply overtaken by newer typing
        if (document.activeElement !== aiPromptEl) { pcClose(); return; }
        pcItems = m.items || [];
        pcSel = 0;
        pcRender();
        return;
      }
      if (m.type === 'aiResult') {
        if (m.seq != null && m.seq !== aiSeq) return; // superseded request
        const waited = aiSpinStop();
        setAiBusy(false);
        if (m.cancelled) { statusEl.textContent = 'AI request cancelled.'; return; }
        if (m.error) {
          aiNote.innerHTML = '<span class="aiwarn">' + esc(m.error) + '</span>' +
                             ' <span class="aidim">(after ' + waited + 's)</span>';
          return;
        }
        if (m.verb !== 'explain' && m.sql) {
          if (m.verb === 'fix') {
            // The buffer holds the failed statement — replace it, selected.
            sqlEl.value = m.sql;
            sqlEl.setSelectionRange(0, m.sql.length);
            sqlEl.focus();
          } else {
            aiInsertSql(m.sql);
          }
        }
        let note = esc(m.text || '');
        if (m.destructive) {
          note = '<span class="aiwarn">⚠ ' + esc(m.destructive) + ' — review before running</span>' +
                 (note ? ' · ' + note : '');
        }
        if (m.trimmedTo) {
          note += (note ? ' · ' : '') +
                  '<span class="aitrim">schema context trimmed to ' + m.trimmedTo + ' table(s)</span>';
        }
        // What it cost, where the user is looking: seconds + tokens per answer.
        const meta = '<span class="aidim">✓ ' + (m.ms != null ? (m.ms/1000).toFixed(1) : waited) + 's' +
                     (m.tokens ? ' · ' + m.tokens + ' tokens' : '') + '</span>';
        aiNote.innerHTML = meta + (note ? ' · ' + note : '');
        return;
      }
      if (m.type === 'updateResult') {
        statusEl.textContent = m.ok ? m.message : ('Update failed: ' + m.message);
        return;
      }
      if (m.type === 'saved') { statusEl.textContent = 'Saved ✓'; return; }
      if (m.type === 'status') { statusEl.textContent = m.message; return; }
      if (m.type === 'context') {
        $('dbctx').textContent = m.label;
        $('dbctx').title = m.tooltip;
        return;
      }
      if (m.type === 'completions') {
        // Drop a reply that a newer request has already overtaken.
        if (m.seq < acRendered) return;
        acRendered = m.seq;
        // Only show the list while the editor has focus — a reply can land after
        // the user has clicked away.
        if (document.activeElement !== sqlEl) { acClose(); return; }
        acItems = m.items || [];
        acMore = !!m.listTruncated || !!m.schemaTruncated;
        acSel = 0;
        acRender();
        return;
      }
      if (m.type === 'setSql') { sqlEl.value = m.sql; return; }
      if (m.type === 'result') {
        // Drop a response that a newer request has already overtaken. Results with no
        // seq (fresh runs, post-edit refreshes) are never stale — always render those.
        if (m.seq != null) {
          if (m.seq < renderedSeq) return;
          renderedSeq = m.seq;
        }
        // A successful run clears the failure Fix was armed with.
        lastError = null;
        $('aiFixBtn').disabled = true;
        raw = m.result; selected.clear();
        // Only reset sort/filters for a brand-new table/query, not sort/filter/page re-runs.
        if (m.fresh) { sort = { col:null, dir:1 }; filters = {}; search = ''; $('search').value = ''; }
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
        // Don't promise more reach than the box has: on a paginated preview it only
        // sees the loaded page. Column filters (which do hit the DB) still cover the table.
        $('search').placeholder = pageLocal() ? 'Search this page…' : 'Search results…';
        renderGrid();
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
