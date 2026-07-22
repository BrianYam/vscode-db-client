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
  :root { --r: 8px; --bd: var(--vscode-panel-border, #ffffff1a); }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; padding: 30px 22px 92px; font-size: 13px; line-height: 1.4; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h2 { display: flex; align-items: center; gap: 12px; margin: 0 0 6px;
       font-size: 21px; font-weight: 600; }
  h2 svg { width: 30px; height: 30px; }
  .subtitle { opacity: .55; font-size: 12.5px; margin: 0 0 24px; }
  .slabel { font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
            opacity: .55; font-weight: 600; margin: 24px 0 10px; }
  .banner { padding: 11px 14px; border-radius: var(--r); margin-bottom: 4px; display: none;
            font-size: 12.5px; }
  .banner.ok { display: block; background: color-mix(in srgb, var(--vscode-testing-iconPassed,#3fb950) 16%, transparent);
            color: var(--vscode-testing-iconPassed, #3fb950); }
  .banner.err { display: block; background: color-mix(in srgb, var(--vscode-errorForeground,#f85149) 16%, transparent);
            color: var(--vscode-errorForeground, #f85149); }
  label { display: block; font-size: 12px; margin-bottom: 6px; opacity: .8; }
  label .opt { opacity: .5; font-weight: 400; }
  .req::before { content: "*"; color: var(--vscode-errorForeground); margin-right: 5px; }
  input[type=text], input[type=password], input[type=number] {
    width: 100%; height: 34px; padding: 0 12px; border-radius: var(--r); font-size: 13px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #ffffff1f); outline: none;
    transition: border-color .12s ease, box-shadow .12s ease; }
  input:focus { border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent); }
  input::placeholder { opacity: .45; }
  .types { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  @media (min-width: 560px) { .types { grid-template-columns: repeat(4, 1fr); } }
  .type { display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 13px 10px; border-radius: var(--r); cursor: pointer; user-select: none;
    font-size: 13px; font-weight: 500; text-align: center;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--bd);
    transition: border-color .12s ease, background .12s ease; }
  .type:hover { border-color: var(--vscode-focusBorder); }
  .type.active { border-color: var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  .type svg { width: 20px; height: 20px; flex: 0 0 auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .full { grid-column: 1 / -1; }
  .portrow { display: flex; }
  .portrow input { border-radius: 0; text-align: center; }
  .portrow button { height: 34px; width: 38px; border-radius: 0; font-size: 16px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-input-border, #ffffff1f); }
  .portrow button:first-child { border-radius: var(--r) 0 0 var(--r); border-right: none; }
  .portrow button:last-child { border-radius: 0 var(--r) var(--r) 0; border-left: none; }
  .pwwrap { position: relative; }
  .pwwrap input { padding-right: 38px; }
  .eye { position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
         cursor: pointer; opacity: .6; user-select: none; }
  .eye:hover { opacity: 1; }
  .opt-row { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
  .switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .slider { position: absolute; inset: 0; cursor: pointer; border-radius: 22px;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #ffffff2e);
    transition: .15s ease; }
  .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px;
    background: var(--vscode-foreground); opacity: .65; border-radius: 50%; transition: .15s ease; }
  .switch input:checked + .slider { background: var(--vscode-focusBorder); border-color: transparent; }
  .switch input:checked + .slider::before { transform: translateX(16px); background: #fff; opacity: 1; }
  .opt-row .lbl { cursor: pointer; }
  .opt-row .link { margin-left: auto; font-size: 12px; cursor: pointer;
    color: var(--vscode-textLink-foreground); }
  .card { border: 1px solid var(--bd); border-radius: var(--r); padding: 16px;
    margin: 6px 0 8px; background: var(--vscode-editorWidget-background); }
  .card .row { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .card .row:last-child { margin-bottom: 0; }
  .card .row > label { width: 110px; margin: 0; flex: 0 0 auto; }
  .card .row input { flex: 1; }
  .card .hint { font-size: 12px; opacity: .6; margin-top: 12px; }
  .browse { display: flex; gap: 8px; }
  .csrow { display: flex; gap: 10px; }
  .csrow input { flex: 1; }
  button { height: 34px; padding: 0 15px; border-radius: var(--r); border: none; cursor: pointer;
    font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); transition: filter .12s ease; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.ghost { background: transparent; }
  button:hover { filter: brightness(1.12); }
  .icon-sq { width: 38px; padding: 0; justify-content: center; }
  .footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 14px 22px;
    background: var(--vscode-editor-background); border-top: 1px solid var(--bd);
    backdrop-filter: blur(6px); }
  .footer .inner { max-width: 720px; margin: 0 auto; display: flex; align-items: center; gap: 10px; }
  .spacer { flex: 1; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="wrap">
    <h2>
      <svg viewBox="0 0 24 24" fill="#4E9BD6"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5c0 1.66-3.58 3-8 3S4 6.66 4 5z"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6c0 1.66-3.58 3-8 3S4 13.66 4 12z"/></svg>
      <span id="title">Connect to server</span>
    </h2>
    <p class="subtitle">Configure a database connection — no connection limit.</p>
    <div id="banner" class="banner"></div>

    <label class="req">Name</label>
    <input type="text" id="name" placeholder="my-database" />

    <div class="slabel">Server Type</div>
    <div class="types" id="types">
      <div class="type" data-t="postgres">${this.iconSvg("postgres")} PostgreSQL</div>
      <div class="type" data-t="mysql">${this.iconSvg("mysql")} MySQL / MariaDB</div>
      <div class="type" data-t="sqlite">${this.iconSvg("sqlite")} SQLite</div>
      <div class="type" data-t="redis">${this.iconSvg("redis")} Redis</div>
    </div>

    <!-- Network engines -->
    <div id="netFields">
      <div class="slabel">Connection</div>
      <div class="grid">
        <div>
          <label class="req">Host</label>
          <input type="text" id="host" />
        </div>
        <div>
          <label class="req">Port</label>
          <div class="portrow">
            <button id="portMinus" type="button">−</button>
            <input type="number" id="port" />
            <button id="portPlus" type="button">+</button>
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
          <label>Database <span class="opt">(optional)</span></label>
          <input type="text" id="database" />
        </div>
        <div class="full hidden" id="redisDbField">
          <label>Redis DB index</label>
          <input type="number" id="redisDb" value="0" />
        </div>
      </div>

      <div class="slabel">Options</div>
      <div class="opt-row">
        <label class="switch"><input type="checkbox" id="ssl" /><span class="slider"></span></label>
        <label class="lbl" for="ssl">Use SSL / TLS</label>
        <span class="link hidden" id="sslConfigBtn">⚙ Certificates</span>
      </div>
      <div class="card hidden" id="sslBox">
        <div class="row" style="margin-bottom:14px">
          <label class="switch"><input type="checkbox" id="allowInvalidCert" /><span class="slider"></span></label>
          <label class="lbl" for="allowInvalidCert" style="width:auto">Allow self-signed / skip verification</label>
        </div>
        <div class="row">
          <label>CA Certificate</label>
          <input type="text" id="sslCA" placeholder="path to CA cert (optional)" />
          <button class="icon-sq" data-browse="sslCA" type="button">…</button>
        </div>
        <div class="row">
          <label>Client Cert</label>
          <input type="text" id="sslCert" placeholder="path to client cert (optional)" />
          <button class="icon-sq" data-browse="sslCert" type="button">…</button>
        </div>
        <div class="row">
          <label>Client Key</label>
          <input type="text" id="sslKey" placeholder="path to client key (optional)" />
          <button class="icon-sq" data-browse="sslKey" type="button">…</button>
        </div>
      </div>

      <div class="opt-row">
        <label class="switch"><input type="checkbox" id="useCS" /><span class="slider"></span></label>
        <label class="lbl" for="useCS">Use Connection String</label>
      </div>
      <div class="csrow hidden" id="csRow">
        <input type="text" id="connectionString" placeholder="postgresql://user:pass@host:5432/dbname" />
        <button id="csUse" type="button">🔎 Use</button>
      </div>

      <div class="opt-row">
        <label class="switch"><input type="checkbox" id="sshEnable" /><span class="slider"></span></label>
        <label class="lbl" for="sshEnable">Use SSH Tunnel</label>
      </div>
      <div class="card hidden" id="sshBox">
        <div class="grid">
          <div><label class="req">SSH Host</label><input type="text" id="sshHost" placeholder="bastion.example.com" /></div>
          <div><label class="req">SSH Port</label><input type="number" id="sshPort" /></div>
          <div><label>SSH Username</label><input type="text" id="sshUsername" /></div>
          <div><label>Connect Timeout (ms)</label><input type="number" id="sshConnectTimeout" /></div>
        </div>
        <label style="margin-top:14px">Auth</label>
        <div id="sshAuthBtns" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
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
              <button class="icon-sq" data-browse="sshPrivateKeyPath" type="button">…</button>
            </div>
          </div>
        </div>
        <div class="hint">Tunnels the database host/port through this SSH server. "Auto" tries your SSH agent, then key, then password.</div>
      </div>
    </div>

    <!-- SQLite -->
    <div id="fileFields" class="hidden">
      <div class="slabel">Database file</div>
      <label class="req">SQLite file path</label>
      <div class="browse">
        <input type="text" id="filePath" placeholder="/path/to/database.db" />
        <button id="browseBtn" type="button">Browse…</button>
      </div>
    </div>
  </div>

  <div class="footer">
    <div class="inner">
      <button class="ghost" id="testBtn">⚡ Test Connection</button>
      <span class="spacer"></span>
      <button class="ghost" id="closeBtn">Close</button>
      <button id="saveBtn">Save</button>
      <button class="primary" id="connectBtn">＋ Save &amp; Connect</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${initial};
    const PORTS = ${ports};
    // Sample connection string shown as the input placeholder, per engine.
    const CS_PLACEHOLDER = {
      postgres: 'postgresql://user:pass@host:5432/dbname',
      mysql: 'mysql://user:pass@host:3306/dbname',
      redis: 'redis://user:pass@host:6379/0',
      sqlite: '/path/to/database.db',
    };
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
      $('connectionString').placeholder = CS_PLACEHOLDER[t] || CS_PLACEHOLDER.postgres;
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
