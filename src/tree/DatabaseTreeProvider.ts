import * as vscode from "vscode";
import { ConnectionStore } from "../connections/store";
import { ConnectionManager } from "../connections/manager";
import { TreeItemData } from "../drivers/Driver";

/** A node in the connections tree. */
export class DbNode extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly nodePath: string[],
    label: string,
    contextValue: string,
    collapsible: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsible);
    this.contextValue = contextValue;
  }
}

const DND_MIME = "application/vnd.code.tree.opendbclient.connections";

export class DatabaseTreeProvider
  implements vscode.TreeDataProvider<DbNode>, vscode.TreeDragAndDropController<DbNode>
{
  private readonly _onDidChange = new vscode.EventEmitter<DbNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // Drag-and-drop: reorder top-level connections.
  readonly dragMimeTypes = [DND_MIME];
  readonly dropMimeTypes = [DND_MIME];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager
  ) {}

  handleDrag(source: DbNode[], dataTransfer: vscode.DataTransfer): void {
    const ids = source
      .filter((n) => n.contextValue === "connection")
      .map((n) => n.connectionId);
    if (ids.length) {
      dataTransfer.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
    }
  }

  async handleDrop(target: DbNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DND_MIME);
    if (!item) {
      return;
    }
    let ids: string[];
    try {
      ids = JSON.parse(await item.asString());
    } catch {
      return;
    }
    await this.store.reorder(ids, target?.connectionId);
    this.refresh();
  }

  refresh(node?: DbNode): void {
    this._onDidChange.fire(node);
  }

  getTreeItem(element: DbNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbNode): Promise<DbNode[]> {
    // Root: one node per saved connection.
    if (!element) {
      return this.store.all().map((c) => {
        const node = new DbNode(
          c.id,
          [],
          c.name,
          "connection",
          vscode.TreeItemCollapsibleState.Collapsed
        );
        node.description = describe(c.type);
        node.iconPath = new vscode.ThemeIcon("database");
        return node;
      });
    }

    // Expand a connection or an inner node via its driver.
    try {
      const driver = await this.manager.getDriver(element.connectionId);
      const kids = await driver.children(element.nodePath);
      return kids.map((k) => this.toNode(element.connectionId, k));
    } catch (err) {
      const node = new DbNode(
        element.connectionId,
        element.nodePath,
        `⚠ ${(err as Error).message}`,
        "error",
        vscode.TreeItemCollapsibleState.None
      );
      node.iconPath = new vscode.ThemeIcon("error");
      return [node];
    }
  }

  private toNode(connectionId: string, data: TreeItemData): DbNode {
    const collapsible = data.expandable
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const node = new DbNode(connectionId, data.path, data.label, data.kind, collapsible);
    node.iconPath = new vscode.ThemeIcon(iconFor(data.kind));
    if (data.description) {
      node.description = data.description;
    }
    if (data.kind === "table" || data.kind === "view" || data.kind === "key") {
      node.command = {
        command: "openDbClient.previewTable",
        title: "Preview",
        arguments: [node],
      };
    }
    return node;
  }
}

function describe(type: string): string {
  return { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", redis: "Redis" }[
    type
  ] ?? type;
}

function iconFor(kind: string): string {
  switch (kind) {
    case "schema":
    case "database":
      return "symbol-namespace";
    case "table":
      return "table";
    case "view":
      return "eye";
    case "column":
      return "symbol-field";
    case "key":
      return "key";
    default:
      return "circle-small";
  }
}
