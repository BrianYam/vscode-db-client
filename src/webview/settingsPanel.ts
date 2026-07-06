import * as fs from "fs";
import * as vscode from "vscode";

interface Guide {
  id: string;
  title: string;
  /** Returns the guide body HTML. */
  body: (icon: (type: string) => string) => string;
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
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => (SettingsPanel.current = undefined));
    this.panel.webview.html = this.render();
  }

  /** Read a bundled engine icon and return inline-safe SVG markup. */
  private iconSvg(type: string): string {
    try {
      const file = vscode.Uri.joinPath(
        this.ctx.extensionUri,
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
    const icon = (t: string) => this.iconSvg(t);
    const nonce = String(Date.now());
    const nav = GUIDES.map(
      (g, i) =>
        `<div class="nav${i === 0 ? " active" : ""}" data-g="${g.id}">${g.title}</div>`
    ).join("");
    const sections = GUIDES.map(
      (g, i) =>
        `<section id="g-${g.id}" class="guide${i === 0 ? " active" : ""}">
           <h2>${g.title}</h2>${g.body(icon)}</section>`
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
</style>
</head>
<body>
  <div id="side">
    <h3>Guides</h3>
    ${nav}
  </div>
  <div id="main">
    ${sections}
  </div>
  <script nonce="${nonce}">
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
      </ul>

      <h4>3 · Query &amp; edit data</h4>
      <ul>
        <li>Click a table to preview rows (paginated, 100/page). Sort by clicking a column header; filter with the per-column boxes or the global search.</li>
        <li><b>Double-click a cell</b> (or click its 🔍) to edit — saved as a parameterized UPDATE using the primary key.</li>
        <li><b>＋ Row</b> inserts; check rows and <b>🗑 Delete</b> removes them (with confirmation).</li>
        <li>Click the <b>↗</b> on a foreign-key cell to jump to the referenced row in the other table.</li>
        <li><b>Export CSV / JSON</b> saves the current grid. Right-click a table for <b>View DDL / Structure</b>.</li>
        <li>Right-click a connection or database → <b>New Query</b> for raw SQL (<kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to run). For Redis, type commands like <span class="glyph">GET mykey</span>.</li>
      </ul>

      <h4>4 · Troubleshooting</h4>
      <ul>
        <li>A tree node showing <b>⚠</b> is a connection/query error — right-click → Edit Connection to fix.</li>
        <li>Deeper diagnostics: <b>View → Output → "Open DB Client"</b> logs failures with stack traces.</li>
      </ul>`,
  },
  {
    id: "icon-legend",
    title: "What icon means what",
    body: (icon) => `
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
];
