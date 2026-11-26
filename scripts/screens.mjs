#!/usr/bin/env node
// Takes the system map's screenshots: the real extension, running in
// code-server against throwaway seeded databases, driven by a browser.
// Writes docs/screens/<id>.png and records the commit in manifest.json, so the
// map can tell when a screen's code changed after it was taken.
//
//   npm run screens                 every screen in docs/screens/screens.json
//   npm run screens -- tree-five    only these ids
//   npm run screens -- --keep       leave the containers running afterwards
//   npm run screens -- --vsix f.vsix  install this build instead of packaging one
//
// Needs Docker and Playwright's Chromium (playwright-core is pinned to the
// version whose browser is already cached). Nothing touches your own VS Code,
// databases or connections: everything lives in containers named shots-* on
// a private network, removed at the end unless --keep.
//
// The setup follows the README media capture (docs/DISCOVERY_README_MEDIA.md):
// scripts/demo-seed.sql for data that looks real, connections seeded through
// the extension's own Import Connections file, and workspace trust off, or the
// extension never activates.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { SHOTS } from "./screens/shots.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = join(root, "docs/screens");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--vsix");

const NET = "shots-net";
const PG = "shots-postgres";
const REDIS = "shots-redis";
const CODE = "shots-code";
const PORT = 18080;
const CODE_IMAGE = "codercom/code-server:4.103.2";
// Inside code-server, where the workspace folder is mounted.
const WS = "/home/coder/project";
const VIEWPORT = { width: 1280, height: 800 };

const sh = (cmd, args, input) =>
  execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: input ? ["pipe", "pipe", "pipe"] : undefined,
  });
const docker = (...a) => sh("docker", a);
const quiet = (...a) => spawnSync("docker", a, { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`· ${m}`);

const { screens } = JSON.parse(readFileSync(join(shotsDir, "screens.json"), "utf8"));
// A shot named on the command line runs even when screens.json does not list it
// yet, which is how a new one gets written and checked.
const wanted = only.length
  ? only.filter((id) => SHOTS[id]).map((id) => screens.find((s) => s.id === id) || { id })
  : screens.filter((s) => SHOTS[s.id]);
const unknown = only.filter((id) => !SHOTS[id]);
if (unknown.length) {
  console.error(`No capture for: ${unknown.join(", ")}. Known: ${Object.keys(SHOTS).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------- build
function vsixPath() {
  if (opt("--vsix")) return opt("--vsix");
  const out = join(mkdtempSync(join(tmpdir(), "odbc-vsix-")), "ext.vsix");
  log("packaging the extension (npm run package)");
  sh("npx", ["--yes", "@vscode/vsce", "package", "--out", out]);
  return out;
}

// ---------------------------------------------------------------- stack
function down() {
  for (const c of [CODE, PG, REDIS]) quiet("rm", "-f", c);
  quiet("network", "rm", NET);
}

async function waitFor(what, fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The workspace folder code-server opens: the import file, a SQLite copy and saved queries live here. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "odbc-shots-"));
  copyFileSync(join(root, "samples/sample.db"), join(dir, "sample.db"));
  // The extension's own export format, with demo passwords: these databases
  // exist only for the length of this run.
  const connections = {
    kind: "open-db-client/connections",
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: "screens.mjs",
    secrets: "included",
    connections: [
      {
        type: "postgres",
        name: "Shop (Postgres)",
        host: PG,
        port: 5432,
        username: "demo",
        database: "shop",
        password: "demo",
        notes: "Demo store database. Seeded by scripts/demo-seed.sql.",
      },
      { type: "redis", name: "Sessions (Redis)", host: REDIS, port: 6379, redisDb: 0 },
      { type: "sqlite", name: "Sample (SQLite)", filePath: `${WS}/sample.db` },
    ],
  };
  writeFileSync(join(dir, "connections.json"), JSON.stringify(connections, null, 2));
  // A second file, never confirmed: only its Import dialog is photographed.
  const more = {
    ...connections,
    secrets: "omitted",
    connections: [
      {
        type: "mysql",
        name: "Legacy CRM (MySQL)",
        host: "crm-db.example.com",
        port: 3306,
        username: "crm_ro",
        database: "crm",
      },
      { type: "redis", name: "Cache (Redis)", host: "cache.example.com", port: 6379, redisDb: 2 },
    ],
  };
  writeFileSync(join(dir, "more-connections.json"), JSON.stringify(more, null, 2));
  return dir;
}

async function up(vsix) {
  down();
  docker("network", "create", NET);
  log("starting Postgres and Redis");
  docker(
    "run",
    "-d",
    "--name",
    PG,
    "--network",
    NET,
    "-e",
    "POSTGRES_USER=demo",
    "-e",
    "POSTGRES_PASSWORD=demo",
    "-e",
    "POSTGRES_DB=shop",
    "postgres:16-alpine",
  );
  docker("run", "-d", "--name", REDIS, "--network", NET, "redis:7-alpine");
  await waitFor(
    "Postgres",
    () => spawnSync("docker", ["exec", PG, "pg_isready", "-U", "demo", "-d", "shop"]).status === 0,
  );
  await sleep(1500);
  sh(
    "docker",
    ["exec", "-i", PG, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "demo", "-d", "shop"],
    readFileSync(join(root, "scripts/demo-seed.sql"), "utf8"),
  );
  sh(
    "docker",
    ["exec", "-i", REDIS, "redis-cli"],
    readFileSync(join(root, "scripts/screens/redis-seed.txt"), "utf8"),
  );

  const ws = workspace();
  const vs = join(ws, ".vscode");
  execFileSync("mkdir", ["-p", vs]);
  log("starting code-server");
  docker(
    "run",
    "-d",
    "--name",
    CODE,
    "--network",
    NET,
    "-p",
    `127.0.0.1:${PORT}:8080`,
    "-v",
    `${ws}:${WS}`,
    "-v",
    `${vsix}:/tmp/ext.vsix:ro`,
    "-v",
    `${join(root, "scripts/screens/settings.json")}:/tmp/settings.json:ro`,
    "-e",
    "PASSWORD=unused",
    CODE_IMAGE,
    "--auth",
    "none",
    "--disable-telemetry",
    "--disable-workspace-trust",
    WS,
  );
  // Copied, not mounted: a mount would create code-server's data folders as
  // root, and it could no longer write to them.
  docker(
    "exec",
    CODE,
    "sh",
    "-c",
    "mkdir -p ~/.local/share/code-server/User && cp /tmp/settings.json ~/.local/share/code-server/User/settings.json",
  );
  docker("exec", CODE, "code-server", "--install-extension", "/tmp/ext.vsix");
  await waitFor("code-server", async () => (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok);
  return ws;
}

// ---------------------------------------------------------------- driving
/** Helpers every shot gets: the page, and the moves VS Code needs over and over. */
function kit(page) {
  const k = {
    page,
    async command(title) {
      await page.keyboard.press("F1");
      const box = page.locator(".quick-input-widget input:visible");
      await box.waitFor();
      await box.fill(`>${title}`);
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
    },
    async quickInput(text) {
      const box = page.locator(".quick-input-widget input:visible");
      await box.waitFor();
      await box.fill(text);
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
    },
    async dialogButton(label) {
      await page
        .locator(".monaco-dialog-box:visible .monaco-button", { hasText: label })
        .first()
        .click();
      await page.waitForTimeout(500);
    },
    /** The activity-bar view of the extension. */
    async openView() {
      const title = page.locator(".sidebar .title-label", { hasText: /open db client/i });
      // Clicking the icon of a view that is already showing hides the sidebar.
      if (!(await title.isVisible().catch(() => false))) {
        await page.locator('.activitybar [aria-label^="Open DB Client"]').first().click();
      }
      await title.waitFor();
      await page.waitForTimeout(800);
    },
    /** A tree row by its exact label, optionally at a depth (1 = connections). */
    treeItem(label, level) {
      const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      let rows = page.locator(".sidebar .monaco-list-row");
      if (level) rows = page.locator(`.sidebar .monaco-list-row[aria-level="${level}"]`);
      return rows.filter({ has: page.locator(".label-name", { hasText: exact }) }).first();
    },
    /** Expand a path of tree labels from the top, e.g. ["Shop (Postgres)", "shop", "public"]. */
    async expand(...path) {
      for (const [i, label] of path.entries()) {
        const row = k.treeItem(label, i + 1);
        await row.waitFor();
        if ((await row.getAttribute("aria-expanded")) === "false") {
          await row.locator(".monaco-tl-twistie").click();
          await page.waitForTimeout(900);
        }
      }
    },
    async collapseAll() {
      await page
        .locator(
          '.sidebar .title-actions [aria-label^="Collapse"], .sidebar .actions-container [aria-label^="Collapse"]',
        )
        .first()
        .click({ timeout: 1500 })
        .catch(() => {});
    },
    async contextMenu(row, item) {
      await (typeof row === "string" ? k.treeItem(row) : row).click({ button: "right" });
      const menu = page.locator(".monaco-menu .action-label:visible", { hasText: item }).first();
      await menu.waitFor();
      // VS Code's menus ignore a click that lands right after they open; hover
      // the item, let it settle, and activate it from the keyboard instead.
      await menu.hover();
      await page.waitForTimeout(350);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
    },
    // VS Code keeps closed menus, dialogs and pickers in the page, hidden, so
    // every locator for one matches visible elements only.
    dialog() {
      return page.locator(".monaco-dialog-box:visible");
    },
    input() {
      return page.locator(".quick-input-widget input:visible");
    },
    /** The innermost frame of the active webview panel. */
    webview() {
      return page.frameLocator("iframe.webview.ready").last().frameLocator("#active-frame");
    },
    async closeEditors() {
      await k.command("View: Close All Editors");
      await page.waitForTimeout(300);
    },
    async notificationsClear() {
      await k.command("Notifications: Clear All Notifications");
    },
    async shot(id, opts = {}) {
      await page.mouse.move(2, 2);
      await page.waitForTimeout(opts.settle ?? 500);
      const file = join(shotsDir, `${id}.png`);
      await page.screenshot({ path: file, clip: opts.clip });
      return file;
    },
  };
  return k;
}

async function importConnections(k) {
  await k.command("Import Connections");
  // code-server has no native dialog: VS Code's simple file picker takes a typed path.
  await k.quickInput(`${WS}/connections.json`);
  await k.dialogButton("Import");
  await k.notificationsClear();
}

// ---------------------------------------------------------------- run
const head = sh("git", ["rev-parse", "--short", "HEAD"]).trim();
const vsix = flag("--reuse") ? null : vsixPath();
let ws;
// --reuse: drive a stack an earlier --keep run left up (for working on shots).
const reuse =
  flag("--reuse") && spawnSync("docker", ["inspect", CODE], { stdio: "ignore" }).status === 0;
try {
  if (!reuse) ws = await up(vsix);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: "dark" });
  // Leaving a window with an unsaved editor asks first; always leave.
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const k = kit(page);
  // Every shot starts from a freshly loaded window: a new extension host, so
  // no tree filter, open menu or unsaved editor from the last shot leaks in.
  const fresh = async () => {
    await page.goto(`http://127.0.0.1:${PORT}/?folder=${WS}`);
    await page.locator(".monaco-workbench").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    // An unsaved editor (a DDL view is one) would be restored into every
    // later shot: revert and close each one.
    for (let i = 0; i < 5 && (await page.locator(".tab.dirty").count()); i++) {
      await page.locator(".tab.dirty").first().click();
      await k.command("View: Revert and Close Editor");
    }
    await k.notificationsClear();
    await k.openView();
  };
  await fresh();
  if (!(await k.treeItem("Shop (Postgres)").count())) await importConnections(k);

  const manifestFile = join(shotsDir, "manifest.json");
  const manifest = existsSync(manifestFile)
    ? JSON.parse(readFileSync(manifestFile, "utf8"))
    : { screens: [] };
  const failed = [];
  for (const s of wanted) {
    try {
      log(`shot ${s.id}`);
      await fresh();
      await SHOTS[s.id](k);
      const file = `${s.id}.png`;
      const entry = {
        id: s.id,
        file,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        capturedAt: head,
      };
      manifest.screens = [...manifest.screens.filter((m) => m.id !== s.id), entry];
    } catch (err) {
      failed.push(s.id);
      console.error(`  ✗ ${s.id}: ${err.message.split("\n")[0]}`);
      await page.screenshot({ path: join(tmpdir(), `odbc-shot-fail-${s.id}.png`) });
    }
  }
  manifest.screens.sort(
    (a, b) => screens.findIndex((s) => s.id === a.id) - screens.findIndex((s) => s.id === b.id),
  );
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await browser.close();
  const bytes = readdirSync(shotsDir)
    .filter((f) => f.endsWith(".png"))
    .reduce((n, f) => n + statSync(join(shotsDir, f)).size, 0);
  log(
    `${wanted.length - failed.length} of ${wanted.length} screens at ${head} (${(bytes / 1024 / 1024).toFixed(1)} MB of PNGs)`,
  );
  if (failed.length) {
    console.error(
      `failed: ${failed.join(", ")} (last frame of each in ${tmpdir()}/odbc-shot-fail-*.png)`,
    );
    process.exitCode = 1;
  }
} finally {
  if (!flag("--keep") && !reuse) {
    down();
    if (ws) rmSync(ws, { recursive: true, force: true });
  } else log(`kept: http://127.0.0.1:${PORT}/?folder=${WS}`);
}
