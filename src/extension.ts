import * as vscode from "vscode";
import { ConnectionStore } from "./connections/store";
import { ConnectionManager } from "./connections/manager";
import { DatabaseTreeProvider, DbNode } from "./tree/DatabaseTreeProvider";
import { ConnectionFormPanel } from "./webview/connectionFormPanel";
import { QueryPanel } from "./webview/queryPanel";
import { setSqliteWasmDir } from "./drivers/sqlite";

export function activate(ctx: vscode.ExtensionContext): void {
  // sql.js needs to locate its .wasm file inside node_modules at runtime.
  setSqliteWasmDir(vscode.Uri.joinPath(ctx.extensionUri, "node_modules", "sql.js", "dist").fsPath);

  const store = new ConnectionStore(ctx);
  const manager = new ConnectionManager(store);
  const tree = new DatabaseTreeProvider(store, manager);

  ctx.subscriptions.push(
    vscode.window.createTreeView("openDbClient.connections", {
      treeDataProvider: tree,
      dragAndDropController: tree,
    })
  );

  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("openDbClient.refresh", () => tree.refresh());

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

  reg("openDbClient.previewTable", (node: DbNode) => {
    QueryPanel.create(ctx, manager, store, node.connectionId, {
      previewPath: node.nodePath,
    });
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
