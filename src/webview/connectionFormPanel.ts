import * as vscode from "vscode";
import { ConnectionConfig, DatabaseType, DEFAULT_PORTS } from "../connections/types";
import { ConnectionStore, newId } from "../connections/store";
import { ConnectionManager } from "../connections/manager";
import { createDriver } from "../drivers/registry";

interface FormPayload {
  type: DatabaseType;
  name: string;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  filePath?: string;
  redisDb?: number;
  ssl?: boolean;
}

type Refresh = () => void;

/** A single-page webview for creating/editing a connection. */
export class ConnectionFormPanel {
  static open(
    ctx: vscode.ExtensionContext,
    store: ConnectionStore,
    manager: ConnectionManager,
    refresh: Refresh,
    existing?: ConnectionConfig
  ): void {
    new ConnectionFormPanel(ctx, store, manager, refresh, existing);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly refresh: Refresh,
    private readonly existing?: ConnectionConfig
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "openDbClient.connectionForm",
      existing ? `Edit: ${existing.name}` : "New Connection",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.render();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "test":
          await this.test(msg.payload, msg.password);
          break;
        case "save":
          await this.save(msg.payload, msg.password, msg.thenConnect);
          break;
        case "browse":
          await this.browse();
          break;
        case "close":
          this.panel.dispose();
          break;
      }
    });
  }

  private toConfig(payload: FormPayload): ConnectionConfig {
    return {
      id: this.existing?.id ?? newId(),
      type: payload.type,
      name: payload.name.trim(),
      host: payload.host?.trim() || undefined,
      port: payload.port,
      username: payload.username?.trim() || undefined,
      database: payload.database?.trim() || undefined,
      filePath: payload.filePath?.trim() || undefined,
      redisDb: payload.redisDb,
      ssl: payload.ssl || undefined,
    };
  }

  private async test(payload: FormPayload, password?: string): Promise<void> {
    const config = this.toConfig(payload);
    const pw = password || (this.existing ? await this.store.getPassword(config.id) : undefined);
    const start = Date.now();
    const driver = createDriver(config);
    try {
      await driver.connect(pw);
      const ms = Date.now() - start;
      this.post({ type: "testResult", ok: true, message: `Connection successful`, ms });
    } catch (err) {
      this.post({ type: "testResult", ok: false, message: (err as Error).message, ms: Date.now() - start });
    } finally {
      await driver.dispose().catch(() => undefined);
    }
  }

  private async save(payload: FormPayload, password: string, thenConnect: boolean): Promise<void> {
    const config = this.toConfig(payload);
    if (!config.name) {
      this.post({ type: "testResult", ok: false, message: "Name is required", ms: 0 });
      return;
    }
    // Reconnect fresh if we're editing an already-open connection.
    await this.manager.disconnect(config.id);
    await this.store.save(config, password || undefined);
    this.refresh();
    if (thenConnect) {
      try {
        await this.manager.getDriver(config.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Saved, but connect failed: ${(err as Error).message}`);
      }
    }
    vscode.window.showInformationMessage(`Saved connection "${config.name}".`);
    this.panel.dispose();
  }

  private async browse(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Select SQLite file",
      filters: { SQLite: ["db", "sqlite", "sqlite3", "db3"], "All files": ["*"] },
    });
    if (picked && picked[0]) {
      this.post({ type: "browsed", path: picked[0].fsPath });
    }
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private render(): string {
    const e = this.existing;
    const nonce = String(Date.now());
    const initial = JSON.stringify({
      type: e?.type ?? "postgres",
      name: e?.name ?? "",
      host: e?.host ?? "127.0.0.1",
      port: e?.port ?? DEFAULT_PORTS.postgres,
      username: e?.username ?? "",
      database: e?.database ?? "",
      filePath: e?.filePath ?? "",
      redisDb: e?.redisDb ?? 0,
      ssl: e?.ssl ?? false,
      isEdit: !!e,
    });
    const ports = JSON.stringify(DEFAULT_PORTS);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 18px 22px; max-width: 720px; margin: 0 auto; }
  h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; }
  .banner { padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; display: none;
            border-left: 4px solid; }
  .banner.ok { display: block; background: var(--vscode-inputValidation-infoBackground, #06344d);
            border-color: var(--vscode-testing-iconPassed, #3fb950); }
  .banner.err { display: block; background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
            border-color: var(--vscode-errorForeground, #f85149); }
  label { display: block; font-size: 12px; margin-bottom: 4px; opacity: .85; }
  .req::before { content: "• "; color: var(--vscode-errorForeground); }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); }
  .types { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .type { padding: 8px 14px; border-radius: 6px; cursor: pointer; user-select: none;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border, #4443); font-size: 13px; }
  .type.active { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: transparent; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; margin-bottom: 16px; }
  .full { grid-column: 1 / -1; }
  .portrow { display: flex; gap: 6px; }
  .portrow button { width: 30px; }
  .toggle { display: flex; align-items: center; gap: 8px; margin: 8px 0 18px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .footer { display: flex; gap: 10px; margin-top: 22px; border-top: 1px solid var(--vscode-panel-border,#4443);
    padding-top: 16px; }
  .spacer { flex: 1; }
  .browse { display: flex; gap: 8px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <h2>🛢️ <span id="title">Connect to server</span></h2>
  <div id="banner" class="banner"></div>

  <label class="req">Name</label>
  <input type="text" id="name" placeholder="my-database" />

  <div style="height:16px"></div>
  <label>Server Type</label>
  <div class="types" id="types">
    <div class="type" data-t="postgres">🐘 PostgreSQL</div>
    <div class="type" data-t="mysql">🐬 MySQL / MariaDB</div>
    <div class="type" data-t="sqlite">📁 SQLite</div>
    <div class="type" data-t="redis">🟥 Redis</div>
  </div>

  <!-- Network engines -->
  <div id="netFields">
    <div class="grid">
      <div>
        <label class="req">Host</label>
        <input type="text" id="host" />
      </div>
      <div>
        <label class="req">Port</label>
        <div class="portrow">
          <button class="secondary" id="portMinus" type="button">−</button>
          <input type="number" id="port" />
          <button class="secondary" id="portPlus" type="button">+</button>
        </div>
      </div>
      <div>
        <label>Username</label>
        <input type="text" id="username" />
      </div>
      <div>
        <label>Password</label>
        <input type="password" id="password" placeholder="" />
      </div>
      <div class="full" id="dbField">
        <label>Database <span style="opacity:.6">(optional)</span></label>
        <input type="text" id="database" />
      </div>
      <div class="full hidden" id="redisDbField">
        <label>Redis DB index</label>
        <input type="number" id="redisDb" value="0" />
      </div>
    </div>
    <div class="toggle">
      <input type="checkbox" id="ssl" /> <label style="margin:0">Use SSL / TLS</label>
    </div>
  </div>

  <!-- SQLite -->
  <div id="fileFields" class="hidden">
    <label class="req">SQLite file path</label>
    <div class="browse">
      <input type="text" id="filePath" placeholder="/path/to/database.db" />
      <button class="secondary" id="browseBtn" type="button">Browse…</button>
    </div>
  </div>

  <div class="footer">
    <button class="secondary" id="testBtn">⚡ Test Connection</button>
    <span class="spacer"></span>
    <button class="secondary" id="closeBtn">Close</button>
    <button class="secondary" id="saveBtn">Save</button>
    <button id="connectBtn">Save &amp; Connect</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${initial};
    const PORTS = ${ports};
    const $ = (id) => document.getElementById(id);

    // hydrate
    $('name').value = state.name;
    $('host').value = state.host;
    $('port').value = state.port;
    $('username').value = state.username;
    $('database').value = state.database;
    $('filePath').value = state.filePath;
    $('redisDb').value = state.redisDb;
    $('ssl').checked = state.ssl;
    if (state.isEdit) $('password').placeholder = '(unchanged — leave blank to keep)';

    function selectType(t) {
      state.type = t;
      document.querySelectorAll('.type').forEach((el) =>
        el.classList.toggle('active', el.getAttribute('data-t') === t));
      const isSqlite = t === 'sqlite';
      const isRedis = t === 'redis';
      $('netFields').classList.toggle('hidden', isSqlite);
      $('fileFields').classList.toggle('hidden', !isSqlite);
      $('dbField').classList.toggle('hidden', isRedis || isSqlite);
      $('redisDbField').classList.toggle('hidden', !isRedis);
      if (!isSqlite && (!$('port').value || Number($('port').value) === 0)) $('port').value = PORTS[t];
    }
    document.querySelectorAll('.type').forEach((el) =>
      el.addEventListener('click', () => selectType(el.getAttribute('data-t'))));
    selectType(state.type);

    $('portMinus').addEventListener('click', () => $('port').value = Math.max(0, Number($('port').value||0) - 1));
    $('portPlus').addEventListener('click', () => $('port').value = Number($('port').value||0) + 1);
    $('browseBtn').addEventListener('click', () => vscode.postMessage({ type:'browse' }));
    $('closeBtn').addEventListener('click', () => vscode.postMessage({ type:'close' }));

    function payload() {
      return {
        type: state.type,
        name: $('name').value,
        host: $('host').value,
        port: Number($('port').value) || undefined,
        username: $('username').value,
        database: $('database').value,
        filePath: $('filePath').value,
        redisDb: Number($('redisDb').value) || 0,
        ssl: $('ssl').checked,
      };
    }
    function validate() {
      if (!$('name').value.trim()) return 'Name is required';
      if (state.type === 'sqlite') { if (!$('filePath').value.trim()) return 'SQLite file path is required'; }
      else if (!$('host').value.trim()) return 'Host is required';
      return null;
    }
    function banner(ok, text) {
      const b = $('banner');
      b.className = 'banner ' + (ok ? 'ok' : 'err');
      b.textContent = text;
    }
    $('testBtn').addEventListener('click', () => {
      const err = validate(); if (err) { banner(false, err); return; }
      banner(true, 'Testing…');
      vscode.postMessage({ type:'test', payload: payload(), password: $('password').value });
    });
    function doSave(thenConnect) {
      const err = validate(); if (err) { banner(false, err); return; }
      vscode.postMessage({ type:'save', payload: payload(), password: $('password').value, thenConnect });
    }
    $('saveBtn').addEventListener('click', () => doSave(false));
    $('connectBtn').addEventListener('click', () => doSave(true));

    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'testResult') {
        banner(m.ok, (m.ok ? '✓ ' : '✗ ') + m.message + (m.ms != null ? '  ·  Cost: ' + m.ms + 'ms' : ''));
      } else if (m.type === 'browsed') {
        $('filePath').value = m.path;
      }
    });
  </script>
</body>
</html>`;
  }
}
