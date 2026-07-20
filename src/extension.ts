import * as vscode from "vscode";
import { ConnectionStore } from "./connections/store";
import { ConnectionManager } from "./connections/manager";
import { DatabaseTreeProvider, DbNode, splitQueryPath } from "./tree/DatabaseTreeProvider";
import { ConnectionFormPanel } from "./webview/connectionFormPanel";
import { SettingsPanel } from "./webview/settingsPanel";
import { QueryStore } from "./connections/queryStore";
import { registerSqlFeatures, bindQueryDoc } from "./sqlFeatures";
import { QueryPanel } from "./webview/queryPanel";
import { setSqliteWasmDir } from "./drivers/sqlite";
import { initLog, logInfo } from "./log";

const LAST_SEEN_VERSION_KEY = "openDbClient.lastSeenVersion";

export function activate(ctx: vscode.ExtensionContext): void {
  initLog(ctx);

  // Track the version we last activated under, so future features (What's New,
  // one-time upgrade migrations) can react to a fresh install or an upgrade.
  const version = ctx.extension.packageJSON.version;
  const lastSeen = ctx.globalState.get<string>(LAST_SEEN_VERSION_KEY);
  if (lastSeen !== version) {
    logInfo("activate", lastSeen ? `Upgraded ${lastSeen} → ${version}` : `First run at ${version}`);
    void ctx.globalState.update(LAST_SEEN_VERSION_KEY, version);
  }

  // sql.js needs to locate its .wasm file at runtime. It is bundled into dist/
  // by esbuild.js; fall back to node_modules for unbundled (F5 without bundle).
  setSqliteWasmDir(vscode.Uri.joinPath(ctx.extensionUri, "dist").fsPath);

  const store = new ConnectionStore(ctx);
  const manager = new ConnectionManager(store);
  const queries = new QueryStore(ctx.globalStorageUri);
  const tree = new DatabaseTreeProvider(store, manager, ctx.extensionUri, queries);
  registerSqlFeatures(ctx, queries, manager);

  ctx.subscriptions.push(
    vscode.window.createTreeView("openDbClient.connections", {
      treeDataProvider: tree,
      dragAndDropController: tree,
    })
  );

  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("openDbClient.refresh", () => tree.refresh());

  reg("openDbClient.settings", () => SettingsPanel.open(ctx));

  // Purge every trace of user data: live connections, stored secrets, saved
  // connection configs, and all saved query files. VS Code keeps all of this
  // after an uninstall, so this is the user's one-click "remove everything".
  reg("openDbClient.resetAllData", async () => {
    const choice = await vscode.window.showWarningMessage(
      "Remove ALL Open DB Client data? This deletes every saved connection, all stored passwords/SSH secrets, and all saved query files. This cannot be undone.",
      { modal: true },
      "Remove Everything"
    );
    if (choice !== "Remove Everything") {
      return;
    }
    // Best-effort purge: attempt every step, always refresh the tree afterward,
    // and report truthfully whether anything might remain.
    try {
      await manager.disposeAll();
      const { secretsFailed } = await store.deleteAll();
      await queries.deleteAll();
      if (secretsFailed > 0) {
        vscode.window.showWarningMessage(
          `Open DB Client: connections and query files were removed, but ${secretsFailed} stored secret(s) may still remain in the OS keychain.`
        );
      } else {
        vscode.window.showInformationMessage("Open DB Client: all data removed.");
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Open DB Client: reset failed — some data may remain. ${(err as Error).message}`
      );
    } finally {
      tree.refresh();
    }
  });

  reg("openDbClient.refreshNode", (node: DbNode) => tree.refresh(node));

  reg("openDbClient.connect", async (node: DbNode) => {
    try {
      await manager.getDriver(node.connectionId);
      tree.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Connect failed: ${(err as Error).message}`);
      tree.refresh();
    }
  });

  reg("openDbClient.disconnect", async (node: DbNode) => {
    await manager.disconnect(node.connectionId);
    tree.markDisconnected(node.connectionId);
  });

  reg("openDbClient.addConnection", () => {
    ConnectionFormPanel.open(ctx, store, manager, () => tree.refresh());
  });

  reg("openDbClient.editConnection", (node: DbNode) => {
    const existing = store.get(node.connectionId);
    if (!existing) {
      return;
    }
    ConnectionFormPanel.open(ctx, store, manager, () => tree.refresh(), existing);
  });

  reg("openDbClient.deleteConnection", async (node: DbNode) => {
    const existing = store.get(node.connectionId);
    if (!existing) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete connection "${existing.name}"?`,
      { modal: true },
      "Delete"
    );
    if (ok === "Delete") {
      await manager.disconnect(existing.id);
      await store.delete(existing.id);
      tree.refresh();
    }
  });

  reg("openDbClient.newQuery", (node: DbNode) => {
    QueryPanel.create(ctx, manager, store, node.connectionId, {
      database: node.nodePath[0],
    });
  });

  const preview = (node: DbNode) =>
    QueryPanel.create(ctx, manager, store, node.connectionId, {
      previewPath: node.nodePath,
    });

  reg("openDbClient.previewTable", preview);
  // Same action, honest title for Redis keys ("Select Top 200" means nothing there).
  reg("openDbClient.viewKey", preview);

  // Live key search on a Redis db node. The tree re-filters as you type
  // (debounced), so the box behaves like a search field, not a prompt.
  reg("openDbClient.searchKeys", (node: DbNode) => {
    const input = vscode.window.createInputBox();
    input.title = `Search keys in ${node.label}`;
    input.placeholder = "Type to filter — glob supported, e.g. bull:erp-queue:*";
    input.prompt = "Matches server-side (SCAN MATCH). Plain text matches anywhere in the key.";
    input.value = tree.getKeyFilter(node);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (value: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => tree.setKeyFilter(node, value), 300);
    };
    input.onDidChangeValue(apply);
    input.onDidAccept(() => {
      clearTimeout(timer);
      tree.setKeyFilter(node, input.value);
      input.hide();
    });
    input.onDidHide(() => {
      clearTimeout(timer);
      input.dispose();
    });
    input.show();
  });

  // The pinned "Filter: …" row: clicking it drops the filter. Its path is
  // [db, "@keyfilter"], so the filter is keyed on the parent db path.
  reg("openDbClient.clearKeyFilter", (node: DbNode) => {
    tree.clearKeyFilter(node.connectionId, node.nodePath.slice(0, -1));
  });

  reg("openDbClient.deleteKey", async (node: DbNode) => {
    const key = node.nodePath[node.nodePath.length - 1];
    const ok = await vscode.window.showWarningMessage(
      `Delete key "${key}" from db${node.nodePath[0]}? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (ok !== "Delete") {
      return;
    }
    try {
      const driver = await manager.getDriver(node.connectionId);
      await driver.deleteRow(node.nodePath, {});
      vscode.window.showInformationMessage(`Deleted key "${key}".`);
    } catch (err) {
      vscode.window.showErrorMessage(`Delete key failed: ${(err as Error).message}`);
    } finally {
      tree.refresh();
    }
  });

  reg("openDbClient.newQueryFile", async (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    const name = await vscode.window.showInputBox({
      prompt: "Query file name",
      value: "query",
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) {
      return;
    }
    const uri = await queries.createFile(node.connectionId, scope, relative, name.trim());
    tree.refresh();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "sql");
    await vscode.window.showTextDocument(doc);
  });

  reg("openDbClient.newQueryFolder", async (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    const name = await vscode.window.showInputBox({
      prompt: "Folder name",
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) {
      return;
    }
    await queries.createFolder(node.connectionId, scope, relative, name.trim());
    tree.refresh();
  });

  const fileParts = (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    return { scope, parent: relative.slice(0, -1), name: relative[relative.length - 1] };
  };

  // Open a query file in VS Code's NATIVE editor. We bind the doc to its
  // connection so our CompletionItemProvider (native IntelliSense) and CodeLens
  // (▶ Run / { } JSON) light up and run against the right server in OUR grid.
  reg("openDbClient.openQueryFile", async (node: DbNode) => {
    const { scope, parent, name } = fileParts(node);
    const uri = queries.fileUri(node.connectionId, scope, parent, name);
    bindQueryDoc(uri, node.connectionId, scope[0] ?? "");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "sql");
    await vscode.window.showTextDocument(doc);
  });

  reg("openDbClient.runQueryFile", async (node: DbNode) => {
    const { scope, parent, name } = fileParts(node);
    const sql = await queries.read(queries.fileUri(node.connectionId, scope, parent, name));
    QueryPanel.runInResults(ctx, manager, store, node.connectionId, scope[0], sql);
  });

  // Invoked by the inline CodeLens on query files.
  reg("openDbClient.runSql", (connId: string, database: string, sql: string) => {
    QueryPanel.runInResults(ctx, manager, store, connId, database || undefined, sql);
  });

  reg("openDbClient.runSqlJson", async (connId: string, database: string, sql: string) => {
    try {
      const driver = await manager.getDriver(connId);
      const result = await driver.query(sql, database || undefined);
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(result.rows, null, 2),
        language: "json",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  reg("openDbClient.deleteQueryFile", async (node: DbNode) => {
    const { scope, parent, name } = fileParts(node);
    const ok = await vscode.window.showWarningMessage(
      `Delete query file "${name}"?`,
      { modal: true },
      "Delete"
    );
    if (ok === "Delete") {
      await queries.delete(queries.fileUri(node.connectionId, scope, parent, name));
      tree.refresh();
    }
  });

  reg("openDbClient.deleteQueryFolder", async (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    const ok = await vscode.window.showWarningMessage(
      `Delete folder "${relative[relative.length - 1]}" and everything in it?`,
      { modal: true },
      "Delete"
    );
    if (ok === "Delete") {
      await queries.delete(queries.dirUri(node.connectionId, scope, relative));
      tree.refresh();
    }
  });

  reg("openDbClient.showDDL", async (node: DbNode) => {
    try {
      const driver = await manager.getDriver(node.connectionId);
      const ddl = await driver.getDDL(node.nodePath);
      const doc = await vscode.workspace.openTextDocument({
        content: ddl,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  ctx.subscriptions.push({ dispose: () => void manager.disposeAll() });
}

export function deactivate(): void {
  // Drivers are disposed via the subscription registered in activate().
}
