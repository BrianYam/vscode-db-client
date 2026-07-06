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

  // Per-connection generation. Bumped on disconnect so the tree item's id
  // changes and VS Code renders the node fresh (collapsed) instead of
  // re-querying its children and silently reconnecting.
  private gen = new Map<string, number>();
  private genOf(id: string): number {
    return this.gen.get(id) ?? 0;
  }

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly extensionUri: vscode.Uri
  ) {}

  private engineIcon(type: string, connected: boolean): vscode.Uri {
    const name = connected ? `${type}-connected` : type;
    return vscode.Uri.joinPath(this.extensionUri, "media", "icons", `${name}.svg`);
  }

  /** Close a connection: bump its generation so the subtree collapses. */
  markDisconnected(id: string): void {
    this.gen.set(id, this.genOf(id) + 1);
    this._onDidChange.fire(undefined);
  }

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
        const connected = this.manager.isConnected(c.id);
        const node = new DbNode(
          c.id,
          [],
          c.name,
          connected ? "connectionActive" : "connection",
          vscode.TreeItemCollapsibleState.Collapsed
        );
        node.id = `${c.id}#${this.genOf(c.id)}`;
        node.description = describe(c.type);
        node.iconPath = this.engineIcon(c.type, connected);
        return node;
      });
    }

    // Expand a connection or an inner node via its driver.
    try {
      const wasConnected = this.manager.isConnected(element.connectionId);
      const driver = await this.manager.getDriver(element.connectionId);
      const kids = await driver.children(element.nodePath);
      // If expanding a connection just brought it online, refresh so the root
      // node's icon/context reflect the live state.
      if (!wasConnected && element.nodePath.length === 0) {
        this._onDidChange.fire(undefined);
      }
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
    node.id = `${connectionId}#${this.genOf(connectionId)}:${data.path.join("/")}`;
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
