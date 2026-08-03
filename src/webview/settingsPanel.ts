import * as fs from "node:fs";
import * as vscode from "vscode";
import { renderChangelog } from "./miniMarkdown";

/** Everything a guide body may need from the running extension. */
interface GuideCtx {
  icon: (type: string) => string;
  version: string;
  /** CHANGELOG.md rendered to HTML, or "" when it could not be read. */
  changelog: string;
}

interface Guide {
  id: string;
  title: string;
  /** Returns the guide body HTML. */
  body: (g: GuideCtx) => string;
}

/**
 * Settings & Guides console. Guides are entries in the GUIDES array — add a
 * new `{ id, title, body }` object and it appears in the sidebar automatically.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static open(ctx: vscode.ExtensionContext): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    SettingsPanel.current = new SettingsPanel(ctx);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly ctx: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      "openDbClient.settings",
      "Open DB Client — Settings & Guides",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => (SettingsPanel.current = undefined));
    // The Danger-zone button posts a message; the command owns the confirm modal.
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "resetAllData") {
        vscode.commands.executeCommand("openDbClient.resetAllData");
      }
    });
    this.panel.webview.html = this.render();
  }

  /** Read a bundled engine icon and return inline-safe SVG markup. */
  private iconSvg(type: string): string {
    try {
      const file = vscode.Uri.joinPath(
        this.ctx.extensionUri,
        "media",
        "icons",
        `${type}.svg`,
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

  /**
   * The changelog shown in-app is the very `CHANGELOG.md` that ships in the
   * .vsix (`.vscodeignore` excludes `docs/**`, not the root file). Rendering the
   * shipped file at runtime means the in-app notes cannot drift from the released
   * ones — there is no second copy to forget to update.
   */
  private changelogHtml(): string {
    try {
      const file = vscode.Uri.joinPath(this.ctx.extensionUri, "CHANGELOG.md").fsPath;
      return renderChangelog(fs.readFileSync(file, "utf8"));
    } catch {
      return "";
    }
  }

  private render(): string {
    const nonce = String(Date.now());
    const version = this.ctx.extension.packageJSON.version;
    const gctx: GuideCtx = {
      icon: (t: string) => this.iconSvg(t),
      version,
      changelog: this.changelogHtml(),
    };
    const nav = GUIDES.map(
      (g, i) => `<div class="nav${i === 0 ? " active" : ""}" data-g="${g.id}">${g.title}</div>`,
    ).join("");
    const sections = GUIDES.map(
      (g, i) =>
        `<section id="g-${g.id}" class="guide${i === 0 ? " active" : ""}">
           <h2>${g.title}</h2>${g.body(gctx)}</section>`,
    ).join("");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; display: flex; min-height: 100vh; }
  #side { width: 210px; flex: 0 0 auto; border-right: 1px solid var(--vscode-panel-border,#4443);
          padding: 18px 0; background: var(--vscode-sideBar-background, transparent); }
  #side h3 { margin: 0 0 10px; padding: 0 18px; font-size: 11px; text-transform: uppercase;
          letter-spacing: .08em; opacity: .6; }
  .nav { padding: 7px 18px; cursor: pointer; font-size: 13px; }
  .nav:hover { background: var(--vscode-list-hoverBackground); }
  .nav.active { background: var(--vscode-list-activeSelectionBackground);
          color: var(--vscode-list-activeSelectionForeground); }
  #main { flex: 1; padding: 22px 30px; max-width: 760px; }
  .guide { display: none; }
  .guide.active { display: block; }
  h2 { margin-top: 0; }
  h4 { margin: 18px 0 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0 16px; }
  th, td { border: 1px solid var(--vscode-panel-border,#4443); padding: 6px 10px; text-align: left; }
  th { background: var(--vscode-editorWidget-background); }
  td.ic { width: 60px; text-align: center; }
  td.ic svg { width: 20px; height: 20px; vertical-align: middle; }
  .glyph { font-weight: 700; font-family: var(--vscode-editor-font-family, monospace); }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
         background:#3fb950; border:1.5px solid #fff; vertical-align:middle; }
  kbd { background: var(--vscode-keybindingLabel-background,#3334); border-radius: 3px;
        padding: 1px 5px; font-size: 11px; border: 1px solid var(--vscode-panel-border,#4443); }
  ol li, ul li { margin: 5px 0; }
  .tip { border-left: 3px solid var(--vscode-focusBorder); padding: 6px 10px; margin: 10px 0;
         background: var(--vscode-editorWidget-background); border-radius: 0 4px 4px 0; }
  #side .ver { margin-top: 18px; padding: 0 18px; font-size: 11px; opacity: .5; }
  .changelog h3.rel { margin: 22px 0 4px; padding-bottom: 4px; font-size: 15px;
         border-bottom: 1px solid var(--vscode-panel-border,#4443); }
  .changelog h4 { margin: 12px 0 4px; font-size: 12px; text-transform: uppercase;
         letter-spacing: .06em; opacity: .7; }
  .changelog ul { margin: 4px 0 10px; padding-left: 20px; font-size: 13px; }
  .changelog code { background: var(--vscode-textCodeBlock-background,#8882);
         padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  .changelog a { color: var(--vscode-textLink-foreground); }
  pre { background: var(--vscode-textCodeBlock-background,#8882); padding: 10px 12px;
         border-radius: 4px; overflow-x: auto; border: 1px solid var(--vscode-panel-border,#4443); }
  pre code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
         white-space: pre; }
  .danger-zone { margin-top: 34px; padding-top: 18px;
         border-top: 1px solid var(--vscode-panel-border,#4443); }
  .danger-zone h4 { color: var(--vscode-errorForeground); margin-top: 0; }
  .danger-zone p { font-size: 13px; opacity: .85; margin: 6px 0 12px; }
  .danger-btn { font-family: var(--vscode-font-family); font-size: 13px; cursor: pointer;
         padding: 6px 12px; border-radius: 4px; background: transparent;
         color: var(--vscode-errorForeground);
         border: 1px solid var(--vscode-errorForeground); }
  .danger-btn:hover { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
</style>
</head>
<body>
  <div id="side">
    <h3>Guides</h3>
    ${nav}
    <div class="ver">Open DB Client v${version}</div>
  </div>
  <div id="main">
    ${sections}
    <div class="danger-zone">
      <h4>Danger zone</h4>
      <p>Permanently remove every saved connection, all stored passwords &amp; SSH secrets,
         and all saved query files. This cannot be undone.</p>
      <button id="resetBtn" class="danger-btn">🗑 Reset all data</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'resetAllData' }));
    }
    document.querySelectorAll('.nav').forEach((n) => {
      n.addEventListener('click', () => {
        document.querySelectorAll('.nav').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.guide').forEach((x) => x.classList.remove('active'));
        n.classList.add('active');
        document.getElementById('g-' + n.getAttribute('data-g')).classList.add('active');
      });
    });
  </script>
</body>
</html>`;
  }
}

const GUIDES: Guide[] = [
  {
    id: "how-to-use",
    title: "How to use",
    body: () => `
      <h4>1 · Add a connection</h4>
      <ol>
        <li>Click the <b>＋</b> button in the panel title bar.</li>
        <li>Pick a server type (PostgreSQL, MySQL/MariaDB, SQLite, Redis), fill in the details — or flip <b>Use Connection String</b> and paste a URL, then hit <b>🔎 Use</b> to auto-fill.</li>
        <li>Optional: enable <b>SSL/TLS</b> (with CA / client cert) or an <b>SSH Tunnel</b> (password, key, or agent auth).</li>
        <li><b>⚡ Test Connection</b> shows success/failure with timing, then <b>Save &amp; Connect</b>.</li>
      </ol>
      <div class="tip">There is no connection limit — add as many as you want. Reorder them by dragging.</div>

      <h4>2 · Browse</h4>
      <ul>
        <li>Expand a connection → databases → schemas → tables → columns. Everything is fetched live.</li>
        <li>Right-click a connection for <b>Connect</b> / <b>Close Connection</b>; a green dot on the icon means it's live.</li>
        <li>Hover any level and click <b>↻</b> to re-fetch just that subtree after schema changes.</li>
        <li><b>Redis:</b> hover a <span class="glyph">db0</span> node and click <b>🔍</b> to search its keys — the tree filters as you type. Plain text matches anywhere in the key; globs like <span class="glyph">bull:erp-queue:*</span> work too. Click the pinned <b>Filter:</b> row to clear it. Right-click a key for <b>View Value</b> or <b>Delete Key</b>.</li>
      </ul>

      <h4>3 · Query &amp; edit data</h4>
      <ul>
        <li>Click a table to preview rows (paginated, 100/page). Sort by clicking a column header; filter with the per-column boxes or the global search.</li>
        <li><b>Double-click a cell</b> (or click its 🔍) to edit — saved as a parameterized UPDATE using the primary key.</li>
        <li><b>＋ Row</b> inserts; check rows and <b>🗑 Delete</b> removes them (with confirmation).</li>
        <li>Click the <b>↗</b> on a foreign-key cell to jump to the referenced row in the other table.</li>
        <li><b>Export CSV / JSON</b> saves the current grid. Right-click a table for <b>View DDL / Structure</b>.</li>
        <li><b>Redis values are editable too:</b> click a key, then double-click a cell. Strings edit in place (the TTL is kept), lists edit by <span class="glyph">index</span>, hashes by <span class="glyph">field</span>, sorted sets by <span class="glyph">score</span>. <b>🗑 Delete</b> in the grid removes only the checked elements — deleting the whole key is the tree's <b>Delete Key</b>.</li>
        <li><b>Redis TTL:</b> a key's remaining life shows next to volatile keys in the tree and in the grid toolbar. Use <b>Set TTL…</b> to set an expiry (in seconds) or <b>Persist</b> to make a key permanent — also on a key's right-click menu.</li>
        <li>Right-click a connection or database → <b>New Query</b> for raw SQL (<kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to run). For Redis, type commands like <span class="glyph">GET mykey</span>.</li>
      </ul>

      <h4>4 · Move your connections to another machine</h4>
      <ul>
        <li>The <b>…</b> menu in the panel title bar (also the Command Palette) has
            <b>Export Connections…</b> and <b>Import Connections…</b>. Export asks whether to
            include passwords — without them, encrypted, or in plain text.</li>
        <li><b>Import only ever adds.</b> Your existing connections are never overwritten, renamed,
            or reordered — and a connection you already have is skipped, so importing the same file
            twice changes nothing.</li>
      </ul>
      <div class="tip">Full details — which export to pick, how to open an encrypted file, and what
        is inside it — are in the <b>Backup &amp; transfer</b> guide.</div>

      <h4>5 · Troubleshooting</h4>
      <ul>
        <li>A tree node showing <b>⚠</b> is a connection/query error — right-click → Edit Connection to fix.</li>
        <li>Deeper diagnostics: <b>View → Output → "Open DB Client"</b> logs failures with stack traces.</li>
      </ul>`,
  },
  {
    id: "icon-legend",
    title: "What icon means what",
    body: ({ icon }) => `
      <h4>Connections</h4>
      <table>
        <tr><th>Icon</th><th>Meaning</th></tr>
        <tr><td class="ic">${icon("postgres")}</td><td>PostgreSQL connection</td></tr>
        <tr><td class="ic">${icon("mysql")}</td><td>MySQL / MariaDB connection</td></tr>
        <tr><td class="ic">${icon("sqlite")}</td><td>SQLite connection (a local .db file)</td></tr>
        <tr><td class="ic">${icon("redis")}</td><td>Redis connection</td></tr>
        <tr><td class="ic"><span class="dot"></span></td><td>Green dot on the icon = currently <b>connected</b>; no dot = disconnected</td></tr>
      </table>

      <h4>Tree structure</h4>
      <table>
        <tr><th>Icon</th><th>Meaning</th></tr>
        <tr><td class="ic"><span class="glyph" style="color:#4E9BD6">🛢</span></td><td>Database (blue cylinder)</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#4E9BD6">⊞</span></td><td>Schema</td></tr>
        <tr><td class="ic"><span class="glyph">▦</span></td><td>Table</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#B180D7">👁</span></td><td>View (purple eye)</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#E2C08D">🔑</span></td><td>Redis key</td></tr>
      </table>

      <h4>Columns (colored by role &amp; data type)</h4>
      <table>
        <tr><th>Icon</th><th>Meaning</th></tr>
        <tr><td class="ic"><span class="glyph" style="color:#E2C08D">🔑</span></td><td><b>Primary key</b> column (gold key)</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#4E9BD6">🔗</span></td><td><b>Foreign key</b> column (blue link) — its cells get a ↗ jump button in the grid</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#89D185">#</span></td><td>Numeric (int, bigint, numeric, float…) — green</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#CE9178">abc</span></td><td>Text (varchar, text, uuid, enum…) — orange</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#4E9BD6">{}</span></td><td>JSON / JSONB — blue</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#B180D7">✓</span></td><td>Boolean — purple</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#F14C4C">📅</span></td><td>Date / time / timestamp — red</td></tr>
      </table>

      <h4>Grid header markers</h4>
      <table>
        <tr><th>Marker</th><th>Meaning</th></tr>
        <tr><td class="ic"><span class="glyph">🔑</span></td><td>Column is part of the primary key</td></tr>
        <tr><td class="ic"><span class="glyph">🔗</span></td><td>Column is a foreign key</td></tr>
        <tr><td class="ic"><span class="glyph" style="color:#F14C4C">*</span></td><td>NOT NULL — required when inserting a row</td></tr>
        <tr><td class="ic"><span class="glyph">⇅ ▲ ▼</span></td><td>Sortable / currently sorted column</td></tr>
      </table>`,
  },
  {
    id: "backup-transfer",
    title: "Backup & transfer",
    body: () => `
      <h4>Which export do I want?</h4>
      <p><b>Export Connections…</b> asks you this first. Three choices, safest at the top:</p>
      <table>
        <tr><th>Choice</th><th>Contains</th><th>Use it for</th></tr>
        <tr>
          <td><b>Without passwords</b><br><span style="opacity:.7">safe to share</span></td>
          <td>Servers, ports, users, options. <b>No passwords</b> — and any password embedded in a
              connection string is stripped out (the username is kept).</td>
          <td>Sharing a starting set with a teammate, committing a team template, any file that
              might end up in chat or a backup.</td>
        </tr>
        <tr>
          <td><b>With passwords — encrypted</b><br><span style="opacity:.7">needs a passphrase</span></td>
          <td>Everything above <b>plus</b> database passwords, SSH passwords and SSH key
              passphrases — sealed with a passphrase you choose.</td>
          <td>Moving your own setup to a new machine, or a backup before <b>Reset all data</b>.</td>
        </tr>
        <tr>
          <td><b>With passwords — PLAIN TEXT</b><br><span style="opacity:.7">readable by anyone</span></td>
          <td>The same passwords, <b>unencrypted</b>. Saved as
              <span class="glyph">…PLAINTEXT.json</span> and stamped with a warning inside the file.</td>
          <td>When you need to read or edit the values yourself, or feed them to another tool.
              Not for sharing, storing, or syncing.</td>
        </tr>
      </table>
      <p>Import reads all three — you are never asked which kind of file you have.</p>

      <h4>About the plain-text option</h4>
      <p>It exists because sometimes you genuinely need to see the values. It is deliberately the
         slowest path: you get a confirmation dialog that counts exactly what is about to be
         written — including passwords hidden inside connection strings — and offers the encrypted
         export instead. The file is created with owner-only permissions
         (<span class="glyph">0600</span>) where the filesystem supports it.</p>
      <div class="tip"><b>What that file means in practice:</b> anything with access to the folder
        has your databases. Cloud sync, Time Machine, a search index, and a careless
        <span class="glyph">git add</span> all count. <b>Delete it as soon as you are done</b> —
        it is a password, not a document. If you only need to move machines, the encrypted export
        carries exactly the same credentials and none of this risk.</div>
      <div class="tip">Whichever you pick, <b>import only ever appends</b>. Nothing you already have
        is overwritten, renamed or reordered, and a connection you already have is skipped — so
        importing the same file twice is a no-op.</div>

      <h4>How do I open the encrypted file?</h4>
      <p>You don't open it by hand — you <b>import</b> it, and the extension asks for the passphrase:</p>
      <ol>
        <li>Panel <b>…</b> menu → <b>Import Connections…</b> (or the Command Palette).</li>
        <li>Pick the <span class="glyph">.encrypted.json</span> file. The passphrase prompt appears
            automatically — the file is recognised by its contents, not its name.</li>
        <li>Type the passphrase, then confirm the summary of what will be added and skipped.</li>
      </ol>
      <p>Opening it in a text editor is fine, but there is nothing readable inside: everything sits
         in one base64 <span class="glyph">data</span> field. The surrounding fields
         (<span class="glyph">kdf</span>, <span class="glyph">iv</span>,
         <span class="glyph">tag</span>) are the parameters needed to decrypt — they are not secret
         and they are useless on their own.</p>

      <div class="tip"><b>Lose the passphrase and the file is gone.</b> It is never stored anywhere,
        not in the file and not in the extension. There is no reset and no recovery — keep it where
        you keep passwords.</div>

      <h4>Wrong passphrase, or a file that won't open</h4>
      <ul>
        <li><i>"Wrong passphrase, or the file has been modified"</i> — the file is authenticated, so a
            bad passphrase and a corrupted/edited file give the same error. Re-download or re-copy
            the file before assuming the passphrase is wrong.</li>
        <li><i>"This file is encrypted — it needs its passphrase"</i> — you picked an encrypted file
            somewhere that expected a plain one; use <b>Import Connections</b>, which handles both.</li>
        <li>Editing an encrypted file by hand — even reformatting the JSON — will break it. Keep the
            <span class="glyph">data</span>, <span class="glyph">iv</span> and
            <span class="glyph">tag</span> values byte-for-byte.</li>
      </ul>

      <h4>The format is open — you are not locked in</h4>
      <p>The file is scrypt (N=16384, r=8, p=1) → AES-256-GCM, all standard, all in Node's built-in
         <span class="glyph">crypto</span>. If you ever want the contents without this extension —
         to audit what you exported, or to recover after uninstalling — this reads it back:</p>
      <pre><code>node -e '
const fs = require("fs"), c = require("crypto");
const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const key = c.scryptSync(process.argv[2], Buffer.from(b.kdf.salt, "base64"), 32,
                         { N: b.kdf.N, r: b.kdf.r, p: b.kdf.p });
const d = c.createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "base64"));
d.setAuthTag(Buffer.from(b.tag, "base64"));
console.log(Buffer.concat([d.update(Buffer.from(b.data, "base64")), d.final()]).toString());
' open-db-client-connections.encrypted.json 'your passphrase'</code></pre>
      <div class="tip"><b>That prints your passwords to the terminal.</b> Your shell history will
        also keep the passphrase you typed. Use it to inspect or recover, not as a routine step —
        importing never exposes either.</div>`,
  },
  {
    id: "whats-new",
    title: "What's new",
    body: ({ version, changelog }) => `
      <p>You're running <b>v${version}</b>. Every released change is listed below, newest first.</p>
      ${
        changelog
          ? `<div class="changelog">${changelog}</div>`
          : `<div class="tip">The changelog file could not be read from this install.
               The full history is on the extension's Marketplace page under
               <b>Changelog</b>.</div>`
      }`,
  },
  {
    id: "uninstalling",
    title: "Uninstalling & your data",
    body: () => `
      <h4>Where your data lives</h4>
      <ul>
        <li><b>Connection details</b> (host, port, user, options) are stored in VS Code's <b>globalState</b>.</li>
        <li><b>Passwords and SSH secrets</b> (DB password, SSH password, SSH passphrase) are stored in VS Code's <b>SecretStorage</b> — your OS keychain / credential vault, never in plain globalState.</li>
        <li><b>Saved query files</b> (.sql) live as real files under the extension's <b>global storage folder</b>.</li>
      </ul>

      <div class="tip"><b>Uninstalling the extension does NOT remove any of this.</b>
        VS Code leaves your globalState, SecretStorage secrets, and the storage folder on disk
        even after you uninstall — so your saved connections, stored passwords, and query files persist.</div>

      <h4>How to purge everything</h4>
      <ul>
        <li>Use the <b>🗑 Reset all data</b> button at the bottom of this page. It deletes every saved
            connection, all stored passwords &amp; SSH secrets, and all saved query files in one step.</li>
        <li>This is <b>irreversible</b> — there is no undo. Do it before uninstalling if you want to leave
            nothing behind.</li>
        <li><b>Back up first if you may come back:</b> <b>Export Connections…</b> from the panel's
            <b>…</b> menu, choose <b>With passwords — encrypted</b>, then import it later. Keep that
            file somewhere you would keep a password — it is your credentials, encrypted.</li>
      </ul>

      <div class="tip"><b>One caveat worth knowing:</b> a connection saved via <b>Use Connection
        String</b> keeps the whole URL — including any <code>user:password@</code> in it — in
        globalState, which is not encrypted. Connections set up with the separate host/user/password
        fields keep the password in SecretStorage instead. If that matters to you, re-save those
        connections using the individual fields.</div>`,
  },
];
