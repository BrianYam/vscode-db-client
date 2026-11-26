// One function per screen in docs/screens/screens.json, keyed by its id.
// Each gets the kit from scripts/screens.mjs (command palette, tree, webview
// and dialog helpers) and ends by calling k.shot(id). A shot that opens a
// dialog closes it again: the runner closes editors between shots, but a
// modal left open would swallow the next shot's clicks.
const PUBLIC = ["Shop (Postgres)", "shop", "public"];
const REDIS = "Sessions (Redis)";

/** Open a Postgres table's preview and wait for its grid. */
async function preview(k, table) {
  await k.expand(...PUBLIC);
  await k.treeItem(table, 4).click();
  const wv = k.webview();
  await wv.locator("#grid table").first().waitFor({ timeout: 20000 });
  await k.page.waitForTimeout(800);
  return wv;
}

/** Replace the panel's SQL and run it. Set, not typed: typing would let autocomplete take keys. */
async function run(k, wv, sql) {
  await wv.locator("#sql").fill(sql);
  await wv.locator("#runBtn").click();
  await k.page.waitForTimeout(1500);
}

async function openForm(k) {
  await k.command("Add Connection");
  const wv = k.webview();
  await wv.locator("#name").waitFor({ timeout: 20000 });
  await k.page.waitForTimeout(600);
  return wv;
}

async function redisKeys(k) {
  await k.expand(REDIS, "db0");
  await k.page.waitForTimeout(800);
}

export const SHOTS = {
  // ------------------------------------------------------------ connections
  async "add-connection"(k) {
    const wv = await openForm(k);
    await wv.locator("#name").fill("Analytics (Postgres)");
    await wv.locator("#host").fill("db.internal.example.com");
    await wv.locator("#username").fill("analyst");
    await wv.locator("#database").fill("analytics");
    await k.shot("add-connection");
  },
  async "form-ssh"(k) {
    const wv = await openForm(k);
    await wv.locator("#name").fill("Analytics via bastion");
    await wv.locator("#host").fill("10.0.4.12");
    await wv.locator("#username").fill("analyst");
    await wv.getByText("Use SSH Tunnel", { exact: true }).click();
    await wv.locator("#sshHost").fill("bastion.example.com");
    await wv.locator("#sshUsername").fill("ubuntu");
    await wv.locator("#sshBox").scrollIntoViewIfNeeded();
    await k.shot("form-ssh");
  },
  async "form-connection-string"(k) {
    const wv = await openForm(k);
    await wv.locator("#name").fill("Reporting replica");
    await wv.getByText("Use Connection String", { exact: true }).click();
    await wv
      .locator("#connectionString")
      .fill("postgres://reporter@replica.example.com:5432/reporting?sslmode=require");
    await k.shot("form-connection-string");
  },
  async "export-connections"(k) {
    await k.command("Export Connections");
    await k.page.locator(".quick-input-widget .monaco-list-row").first().waitFor();
    await k.shot("export-connections");
    await k.page.keyboard.press("Escape");
  },
  async "import-confirm"(k) {
    await k.command("Import Connections");
    await k.quickInput("/home/coder/project/more-connections.json");
    await k.dialog().waitFor();
    await k.shot("import-confirm");
    await k.dialogButton("Cancel");
  },
  async "reset-all-data"(k) {
    await k.command("Reset All Data");
    await k.dialog().waitFor();
    await k.shot("reset-all-data");
    await k.dialogButton("Cancel");
  },

  // ------------------------------------------------------------ browsing
  async "tree-connections"(k) {
    await k.expand(...PUBLIC);
    await k.shot("tree-connections");
  },
  async "preview-table"(k) {
    await preview(k, "customers");
    await k.shot("preview-table");
  },
  async "table-ddl"(k) {
    await k.expand(...PUBLIC);
    await k.contextMenu(k.treeItem("customers", 4), "View DDL");
    await k.page.waitForTimeout(1500);
    await k.shot("table-ddl");
  },
  async "search-tables"(k) {
    await k.expand(...PUBLIC);
    await k.contextMenu(k.treeItem("public", 3), "Search Tables");
    const box = k.input();
    await box.waitFor();
    await box.fill("ord");
    await k.page.waitForTimeout(800);
    await k.shot("search-tables");
    await k.page.keyboard.press("Escape");
  },

  // ------------------------------------------------------------ redis
  async "redis-keys"(k) {
    await redisKeys(k);
    await k.shot("redis-keys");
  },
  async "redis-search"(k) {
    await redisKeys(k);
    await k.contextMenu(k.treeItem("db0", 2), "Search Keys");
    const box = k.input();
    await box.waitFor();
    await box.fill("session:*");
    await k.page.waitForTimeout(800);
    await k.shot("redis-search");
    await k.page.keyboard.press("Escape");
  },
  async "redis-view-key"(k) {
    await redisKeys(k);
    await k.treeItem("user:1001").click();
    await k.webview().locator("#grid table").first().waitFor({ timeout: 20000 });
    await k.page.waitForTimeout(800);
    await k.shot("redis-view-key");
  },
  async "redis-ttl"(k) {
    await redisKeys(k);
    await k.contextMenu(k.treeItem("session:7f3a9c21"), "Set TTL");
    await k.input().waitFor();
    await k.page.waitForTimeout(400);
    await k.shot("redis-ttl");
    await k.page.keyboard.press("Escape");
  },
  async "redis-delete"(k) {
    await redisKeys(k);
    await k.contextMenu(k.treeItem("config:maintenance"), "Delete Key");
    await k.dialog().waitFor();
    await k.shot("redis-delete");
    await k.dialogButton("Cancel");
  },

  // ------------------------------------------------------------ querying
  async "run-query"(k) {
    const wv = await preview(k, "customers");
    await run(
      k,
      wv,
      "SELECT c.country, count(DISTINCT c.id) AS customers, count(o.id) AS orders, round(sum(o.total), 2) AS revenue\nFROM customers c JOIN orders o ON o.customer_id = c.id\nGROUP BY c.country ORDER BY revenue DESC;",
    );
    await k.shot("run-query");
  },
  async autocomplete(k) {
    const wv = await preview(k, "customers");
    await wv.locator("#sql").click();
    await k.page.keyboard.press("ControlOrMeta+A");
    await k.page.keyboard.type("SELECT name, lifetime_value FROM customers WHERE ti", {
      delay: 30,
    });
    await wv.locator("#ac").waitFor({ state: "visible", timeout: 5000 });
    await k.page.waitForTimeout(400);
    await k.shot("autocomplete");
    await k.page.keyboard.press("Escape");
  },
  async "edit-cell"(k) {
    const wv = await preview(k, "customers");
    await wv.locator('#grid tr[data-ri="2"] td.editable[data-col="tier"]').dblclick();
    const input = wv.locator("#grid input.cell");
    await input.waitFor();
    await input.fill("enterprise");
    await k.shot("edit-cell");
    await k.page.keyboard.press("Escape");
  },
  async "related-row"(k) {
    const wv = await preview(k, "orders");
    await wv.locator('#grid tr[data-ri="0"] .relbtn').first().click();
    await k.page.waitForTimeout(2000);
    await k.shot("related-row");
  },
  async "json-viewer"(k) {
    const wv = await preview(k, "customers");
    await wv.locator('#grid tr[data-ri="0"] .jsonopen').first().click();
    await wv.locator("#mtree").waitFor({ state: "visible" });
    await k.page.waitForTimeout(600);
    await k.shot("json-viewer");
    await k.page.keyboard.press("Escape");
  },
  async "column-picker"(k) {
    const wv = await preview(k, "customers");
    await wv.locator("#colsBtn").click();
    await wv.locator("#colsMenu").waitFor({ state: "visible" });
    for (const c of ["email", "status", "orders_count"]) {
      await wv.locator("#colsList label", { hasText: c }).first().click();
    }
    await k.page.waitForTimeout(400);
    await k.shot("column-picker");
    await k.page.keyboard.press("Escape");
  },
  async "export-results"(k) {
    const wv = await preview(k, "customers");
    await wv.locator("#csvBtn").click();
    await k.input().waitFor();
    await k.page.waitForTimeout(500);
    await k.shot("export-results");
    await k.page.keyboard.press("Escape");
  },
  async "lock-panel"(k) {
    const wv = await preview(k, "customers");
    await wv.locator("#lockBtn").click();
    await k.page.waitForTimeout(500);
    await k.shot("lock-panel");
    await wv.locator("#lockBtn").click();
  },
  async "saved-query"(k) {
    await k.expand(...PUBLIC);
    await k.contextMenu(k.treeItem("Query", 4), "New Query File");
    await k.quickInput("top-customers");
    await k.page.locator(".monaco-editor textarea").first().waitFor();
    await k.page.waitForTimeout(800);
    // Inserted, not typed, so the editor's suggestions cannot rewrite it.
    await k.page.keyboard.press("ControlOrMeta+A");
    await k.page.keyboard.insertText(
      "-- Best customers by lifetime value\nSELECT name, country, lifetime_value\nFROM customers\nORDER BY lifetime_value DESC\nLIMIT 10;\n",
    );
    await k.page.waitForTimeout(800);
    await k.expand(...PUBLIC, "Query");
    await k.shot("saved-query");
  },

  // ------------------------------------------------------------ sqlite
  async "sqlite-preview"(k) {
    await k.expand("Sample (SQLite)");
    await k.treeItem("customers", 2).click();
    await k.webview().locator("#grid table").first().waitFor({ timeout: 20000 });
    await k.page.waitForTimeout(800);
    await k.shot("sqlite-preview");
  },

  // ------------------------------------------------------------ settings
  async "settings-ai"(k) {
    await k.command("Settings & Guides");
    const wv = k.webview();
    await wv.locator("#side").waitFor({ timeout: 20000 });
    await wv.locator("#side").getByText("AI", { exact: false }).first().click();
    await k.page.waitForTimeout(800);
    await k.shot("settings-ai");
  },
};
