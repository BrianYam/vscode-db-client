import * as fs from "fs";
import * as vscode from "vscode";
import {
  ConnectionConfig,
  DatabaseType,
  DEFAULT_PORTS,
  SshAuth,
} from "../connections/types";
import { ConnectionStore, newId, Secrets } from "../connections/store";
import { ConnectionManager } from "../connections/manager";
import { createDriver } from "../drivers/registry";
import { SshTunnel, openTunnelForConfig } from "../connections/sshTunnel";

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
  allowInvalidCert?: boolean;
  sslCA?: string;
  sslCert?: string;
  sslKey?: string;
  useConnectionString?: boolean;
  connectionString?: string;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  sshAuth?: SshAuth;
  sshPrivateKeyPath?: string;
  sshConnectTimeout?: number;
}

interface FormSecrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
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
  private readonly extensionUri: vscode.Uri;

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly refresh: Refresh,
    private readonly existing?: ConnectionConfig
  ) {
    this.extensionUri = ctx.extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      "openDbClient.connectionForm",
      existing ? `Edit: ${existing.name}` : "New Connection",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.render();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          if (this.existing) {
            this.post({
              type: "prefill",
              password: (await this.store.getPassword(this.existing.id)) ?? "",
              sshPassword: (await this.store.getSshPassword(this.existing.id)) ?? "",
              sshPassphrase: (await this.store.getSshPassphrase(this.existing.id)) ?? "",
            });
          }
          break;
        case "test":
          await this.test(msg.payload, msg.secrets ?? {});
          break;
        case "save":
          await this.save(msg.payload, msg.secrets ?? {}, msg.thenConnect);
          break;
        case "browse":
          await this.browse(msg.field);
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
      allowInvalidCert: payload.allowInvalidCert || undefined,
      sslCA: payload.sslCA?.trim() || undefined,
      sslCert: payload.sslCert?.trim() || undefined,
      sslKey: payload.sslKey?.trim() || undefined,
      useConnectionString: payload.useConnectionString || undefined,
      connectionString: payload.connectionString?.trim() || undefined,
      sshEnabled: payload.sshEnabled || undefined,
      sshHost: payload.sshHost?.trim() || undefined,
      sshPort: payload.sshPort,
      sshUsername: payload.sshUsername?.trim() || undefined,
      sshAuth: payload.sshAuth,
      sshPrivateKeyPath: payload.sshPrivateKeyPath?.trim() || undefined,
      sshConnectTimeout: payload.sshConnectTimeout,
    };
  }

  private async test(payload: FormPayload, secrets: FormSecrets): Promise<void> {
    const config = this.toConfig(payload);
    const pw =
      secrets.password || (this.existing ? await this.store.getPassword(config.id) : undefined);
    const start = Date.now();
    let tunnel: SshTunnel | undefined;
    let driver: ReturnType<typeof createDriver> | undefined;
    try {
      let effective = config;
      if (config.sshEnabled && config.type !== "sqlite") {
        const sshPassword =
          secrets.sshPassword ||
          (this.existing ? await this.store.getSshPassword(config.id) : undefined);
        const sshPassphrase =
          secrets.sshPassphrase ||
          (this.existing ? await this.store.getSshPassphrase(config.id) : undefined);
        const opened = await openTunnelForConfig(config, { sshPassword, sshPassphrase });
        tunnel = opened.tunnel;
        effective = opened.effectiveConfig;
      }
      driver = createDriver(effective);
      await driver.connect(pw);
      this.post({ type: "testResult", ok: true, message: "Connection successful", ms: Date.now() - start });
    } catch (err) {
      this.post({ type: "testResult", ok: false, message: (err as Error).message, ms: Date.now() - start });
    } finally {
      await driver?.dispose().catch(() => undefined);
      tunnel?.close();
    }
  }

  private async save(payload: FormPayload, secrets: FormSecrets, thenConnect: boolean): Promise<void> {
    const config = this.toConfig(payload);
    if (!config.name) {
      this.post({ type: "testResult", ok: false, message: "Name is required", ms: 0 });
      return;
    }
    // Reconnect fresh if we're editing an already-open connection.
    await this.manager.disconnect(config.id);
    const secretBundle: Secrets = {
      password: secrets.password || undefined,
      sshPassword: secrets.sshPassword || undefined,
      sshPassphrase: secrets.sshPassphrase || undefined,
    };
    await this.store.save(config, secretBundle);
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

  private async browse(field: string): Promise<void> {
    const isSqlite = field === "filePath";
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: isSqlite ? "Select SQLite file" : "Select certificate",
      filters: isSqlite
        ? { SQLite: ["db", "sqlite", "sqlite3", "db3"], "All files": ["*"] }
        : { Certificates: ["pem", "crt", "cert", "key", "ca"], "All files": ["*"] },
    });
    if (picked && picked[0]) {
      this.post({ type: "browsed", field, path: picked[0].fsPath });
    }
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  /** Read a bundled engine icon and return inline-safe SVG markup. */
  private iconSvg(type: string): string {
    try {
      const file = vscode.Uri.joinPath(
        this.extensionUri,
        "media",
        "icons",
        `${type}.svg`
      ).fsPath;
      return fs
        .readFileSync(file, "utf8")
        .replace(/<\?xml[^>]*\?>/i, "")
        .replace(/<!DOCTYPE[^>]*>/i, "")
        .trim();
    } catch {
      return "";
    }
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
      allowInvalidCert: e?.allowInvalidCert ?? false,
      sslCA: e?.sslCA ?? "",
      sslCert: e?.sslCert ?? "",
      sslKey: e?.sslKey ?? "",
      useConnectionString: e?.useConnectionString ?? false,
      connectionString: e?.connectionString ?? "",
      sshEnabled: e?.sshEnabled ?? false,
      sshHost: e?.sshHost ?? "",
      sshPort: e?.sshPort ?? 22,
      sshUsername: e?.sshUsername ?? "",
      sshAuth: e?.sshAuth ?? "auto",
      sshPrivateKeyPath: e?.sshPrivateKeyPath ?? "",
      sshConnectTimeout: e?.sshConnectTimeout ?? 5000,
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
  .type { display: inline-flex; align-items: center; gap: 7px; }
  .type svg { width: 18px; height: 18px; flex: 0 0 auto; }
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
  .pwwrap { position: relative; }
  .pwwrap input { padding-right: 34px; }
  .eye { position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
         cursor: pointer; opacity: .7; user-select: none; }
  .eye:hover { opacity: 1; }
  .sslbox { border: 1px solid var(--vscode-panel-border,#4443); border-radius: 6px;
            padding: 12px 14px; margin-bottom: 16px; background: var(--vscode-editorWidget-background); }
  .sslbox .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .sslbox .row label { width: 110px; margin: 0; }
  .sslbox .row input { flex: 1; }
  .csrow { display: flex; gap: 8px; margin-bottom: 16px; }
  .csrow input { flex: 1; }
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
    <div class="type" data-t="postgres">${this.iconSvg("postgres")} PostgreSQL</div>
    <div class="type" data-t="mysql">${this.iconSvg("mysql")} MySQL / MariaDB</div>
    <div class="type" data-t="sqlite">${this.iconSvg("sqlite")} SQLite</div>
    <div class="type" data-t="redis">${this.iconSvg("redis")} Redis</div>
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
        <div class="pwwrap">
          <input type="password" id="password" placeholder="" />
          <span class="eye" id="eye" title="Show/hide password">👁</span>
        </div>
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
      <button class="secondary hidden" id="sslConfigBtn" type="button" style="margin-left:8px">⚙ SSL Config</button>
    </div>

    <div class="sslbox hidden" id="sslBox">
      <div class="row" style="margin-bottom:12px">
        <input type="checkbox" id="allowInvalidCert" style="width:auto;flex:0" />
        <label style="width:auto;margin:0">Allow self-signed / skip certificate verification</label>
      </div>
      <div class="row">
        <label>CA Certificate</label>
        <input type="text" id="sslCA" placeholder="path to CA cert (optional)" />
        <button class="secondary" data-browse="sslCA" type="button">…</button>
      </div>
      <div class="row">
        <label>Client Cert</label>
        <input type="text" id="sslCert" placeholder="path to client cert (optional)" />
        <button class="secondary" data-browse="sslCert" type="button">…</button>
      </div>
      <div class="row">
        <label>Client Key</label>
        <input type="text" id="sslKey" placeholder="path to client key (optional)" />
        <button class="secondary" data-browse="sslKey" type="button">…</button>
      </div>
    </div>

    <div class="toggle">
      <input type="checkbox" id="useCS" /> <label style="margin:0">Use Connection String</label>
    </div>
    <div class="csrow hidden" id="csRow">
      <input type="text" id="connectionString" placeholder="postgresql://user:pass@host:5432/dbname" />
      <button class="secondary" id="csUse" type="button">🔎 Use</button>
    </div>

    <div class="toggle">
      <input type="checkbox" id="sshEnable" /> <label style="margin:0">Use SSH Tunnel</label>
    </div>
    <div class="sslbox hidden" id="sshBox">
      <div class="grid">
        <div><label class="req">SSH Host</label><input type="text" id="sshHost" placeholder="bastion.example.com" /></div>
        <div><label class="req">SSH Port</label><input type="number" id="sshPort" /></div>
        <div><label>SSH Username</label><input type="text" id="sshUsername" /></div>
        <div><label>Connect Timeout (ms)</label><input type="number" id="sshConnectTimeout" /></div>
      </div>
      <label>Auth</label>
      <div class="types" id="sshAuthBtns" style="margin-bottom:12px">
        <div class="type" data-auth="auto">Auto</div>
        <div class="type" data-auth="password">Password</div>
        <div class="type" data-auth="key">Key</div>
        <div class="type" data-auth="agent">Agent</div>
      </div>
      <div class="grid">
        <div><label>SSH Password</label><input type="password" id="sshPassword" /></div>
        <div><label>Key Passphrase</label><input type="password" id="sshPassphrase" /></div>
        <div class="full"><label>Private Key Path</label>
          <div class="browse">
            <input type="text" id="sshPrivateKeyPath" placeholder="~/.ssh/id_rsa" />
            <button class="secondary" data-browse="sshPrivateKeyPath" type="button">…</button>
          </div>
        </div>
      </div>
      <div style="opacity:.65;font-size:12px">Tunnels the database host/port through this SSH server. "Auto" tries your SSH agent, then key, then password.</div>
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
    $('allowInvalidCert').checked = state.allowInvalidCert;
    $('sslCA').value = state.sslCA;
    $('sslCert').value = state.sslCert;
    $('sslKey').value = state.sslKey;
    $('useCS').checked = state.useConnectionString;
    $('connectionString').value = state.connectionString;
    if (state.isEdit) $('password').placeholder = '(unchanged — leave blank to keep)';

    // password reveal
    $('eye').addEventListener('click', () => {
      const p = $('password');
      p.type = p.type === 'password' ? 'text' : 'password';
      $('eye').textContent = p.type === 'password' ? '👁' : '🙈';
    });

    // SSL config visibility
    function syncSsl() {
      const on = $('ssl').checked;
      $('sslConfigBtn').classList.toggle('hidden', !on);
      if (!on) $('sslBox').classList.add('hidden');
    }
    $('ssl').addEventListener('change', syncSsl);
    $('sslConfigBtn').addEventListener('click', () => $('sslBox').classList.toggle('hidden'));
    syncSsl();
    if (state.sslCA || state.sslCert || state.sslKey) $('sslBox').classList.remove('hidden');

    // connection string visibility + parse
    function syncCS() { $('csRow').classList.toggle('hidden', !$('useCS').checked); }
    $('useCS').addEventListener('change', syncCS);
    syncCS();
    $('csUse').addEventListener('click', () => {
      const raw = $('connectionString').value.trim();
      if (!raw) return;
      try {
        const u = new URL(raw);
        if (u.hostname) $('host').value = u.hostname;
        if (u.port) $('port').value = u.port;
        if (u.username) $('username').value = decodeURIComponent(u.username);
        if (u.password) $('password').value = decodeURIComponent(u.password);
        const path = u.pathname.replace(/^\\//, '');
        if (state.type === 'redis') { if (path) $('redisDb').value = path; }
        else if (path) $('database').value = path;
        banner(true, 'Parsed connection string into fields');
      } catch (err) {
        banner(false, 'Could not parse connection string');
      }
    });

    // generic browse buttons (SSL certs, SSH key)
    document.querySelectorAll('[data-browse]').forEach((b) =>
      b.addEventListener('click', () => vscode.postMessage({ type:'browse', field: b.getAttribute('data-browse') })));

    // SSH tunnel
    $('sshHost').value = state.sshHost;
    $('sshPort').value = state.sshPort;
    $('sshUsername').value = state.sshUsername;
    $('sshPrivateKeyPath').value = state.sshPrivateKeyPath;
    $('sshConnectTimeout').value = state.sshConnectTimeout;
    $('sshEnable').checked = state.sshEnabled;
    function syncSsh() { $('sshBox').classList.toggle('hidden', !$('sshEnable').checked); }
    $('sshEnable').addEventListener('change', syncSsh);
    syncSsh();
    function selectAuth(a) {
      state.sshAuth = a;
      document.querySelectorAll('#sshAuthBtns .type').forEach((el) =>
        el.classList.toggle('active', el.getAttribute('data-auth') === a));
    }
    document.querySelectorAll('#sshAuthBtns .type').forEach((el) =>
      el.addEventListener('click', () => selectAuth(el.getAttribute('data-auth'))));
    selectAuth(state.sshAuth);

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
    $('browseBtn').addEventListener('click', () => vscode.postMessage({ type:'browse', field:'filePath' }));
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
        allowInvalidCert: $('allowInvalidCert').checked,
        sslCA: $('sslCA').value,
        sslCert: $('sslCert').value,
        sslKey: $('sslKey').value,
        useConnectionString: $('useCS').checked,
        connectionString: $('connectionString').value,
        sshEnabled: $('sshEnable').checked,
        sshHost: $('sshHost').value,
        sshPort: Number($('sshPort').value) || 22,
        sshUsername: $('sshUsername').value,
        sshAuth: state.sshAuth,
        sshPrivateKeyPath: $('sshPrivateKeyPath').value,
        sshConnectTimeout: Number($('sshConnectTimeout').value) || 5000,
      };
    }
    function secrets() {
      return {
        password: $('password').value,
        sshPassword: $('sshPassword').value,
        sshPassphrase: $('sshPassphrase').value,
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
      vscode.postMessage({ type:'test', payload: payload(), secrets: secrets() });
    });
    function doSave(thenConnect) {
      const err = validate(); if (err) { banner(false, err); return; }
      vscode.postMessage({ type:'save', payload: payload(), secrets: secrets(), thenConnect });
    }
    $('saveBtn').addEventListener('click', () => doSave(false));
    $('connectBtn').addEventListener('click', () => doSave(true));

    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'testResult') {
        banner(m.ok, (m.ok ? '✓ ' : '✗ ') + m.message + (m.ms != null ? '  ·  Cost: ' + m.ms + 'ms' : ''));
      } else if (m.type === 'browsed') {
        const el = $(m.field);
        if (el) el.value = m.path;
      } else if (m.type === 'prefill') {
        if (m.password) { $('password').value = m.password; $('password').placeholder = ''; }
        if (m.sshPassword) $('sshPassword').value = m.sshPassword;
        if (m.sshPassphrase) $('sshPassphrase').value = m.sshPassphrase;
      }
    });

    // Ask the extension for the stored password (edit mode).
    vscode.postMessage({ type:'ready' });
  </script>
</body>
</html>`;
  }
}
