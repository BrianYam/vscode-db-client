import * as vscode from "vscode";
import { ConnectionStore } from "./connections/store";
import { ConnectionManager } from "./connections/manager";
import { DatabaseTreeProvider, DbNode } from "./tree/DatabaseTreeProvider";
import { promptForConnection } from "./webview/connectionForm";
import { QueryPanel } from "./webview/queryPanel";
import { setSqliteWasmDir } from "./drivers/sqlite";

export function activate(ctx: vscode.ExtensionContext): void {
  // sql.js needs to locate its .wasm file inside node_modules at runtime.
  setSqliteWasmDir(vscode.Uri.joinPath(ctx.extensionUri, "node_modules", "sql.js", "dist").fsPath);

  const store = new ConnectionStore(ctx);
  const manager = new ConnectionManager(store);
  const tree = new DatabaseTreeProvider(store, manager);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("openDbClient.connections", tree)
  );

  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("openDbClient.refresh", () => tree.refresh());

  reg("openDbClient.addConnection", async () => {
    const result = await promptForConnection();
    if (result) {
      await store.save(result.config, result.password);
      tree.refresh();
      vscode.window.showInformationMessage(`Saved connection "${result.config.name}".`);
    }
  });

  reg("openDbClient.editConnection", async (node: DbNode) => {
    const existing = store.get(node.connectionId);
    if (!existing) {
      return;
    }
    const result = await promptForConnection(existing);
    if (result) {
      await manager.disconnect(existing.id);
      await store.save(result.config, result.password);
      tree.refresh();
    }
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
    QueryPanel.create(ctx, manager, store, node.connectionId);
  });

  reg("openDbClient.previewTable", (node: DbNode) => {
    QueryPanel.create(ctx, manager, store, node.connectionId, {
      previewPath: node.nodePath,
    });
  });

  ctx.subscriptions.push({ dispose: () => void manager.disposeAll() });
}

export function deactivate(): void {
  // Drivers are disposed via the subscription registered in activate().
}
