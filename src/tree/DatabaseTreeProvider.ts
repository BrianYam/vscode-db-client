import * as vscode from "vscode";
import { ConnectionStore } from "../connections/store";
import { ConnectionManager } from "../connections/manager";
import { QueryStore } from "../connections/queryStore";
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
    private readonly extensionUri: vscode.Uri,
    private readonly queries: QueryStore
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

    // Query folders: extension-managed saved .sql files (not a driver concern).
    if (element.contextValue === "queryroot" || element.contextValue === "queryfolder") {
      return this.queryChildNodes(element);
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
      const nodes = kids.map((k) => this.toNode(element.connectionId, k));
      // Give each database AND schema a "Query" folder for saved .sql files.
      if (element.contextValue === "database" || element.contextValue === "schema") {
        nodes.unshift(this.queryRootNode(element.connectionId, element.nodePath));
      }
      return nodes;
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

  /** Root "Query" node under a database/schema node (scopePath = its nodePath). */
  private queryRootNode(connectionId: string, scopePath: string[]): DbNode {
    const nodePath = [...scopePath, "@queries"];
    const node = new DbNode(
      connectionId,
      nodePath,
      "Query",
      "queryroot",
      vscode.TreeItemCollapsibleState.Collapsed
    );
    node.id = `${connectionId}#${this.genOf(connectionId)}:${nodePath.join("/")}`;
    node.iconPath = new vscode.ThemeIcon("save-all", new vscode.ThemeColor("charts.yellow"));
    return node;
  }

  private async queryChildNodes(folder: DbNode): Promise<DbNode[]> {
    const { scope, relative } = splitQueryPath(folder.nodePath);
    const entries = await this.queries.list(folder.connectionId, scope, relative);
    if (entries.length === 0) {
      const empty = new DbNode(
        folder.connectionId,
        [...folder.nodePath, "@empty"],
        "Empty — click + to add a file or folder",
        "queryempty",
        vscode.TreeItemCollapsibleState.None
      );
      empty.iconPath = new vscode.ThemeIcon("info");
      return [empty];
    }
    return entries.map((e) => {
      const nodePath = [...folder.nodePath, e.name];
      const node = new DbNode(
        folder.connectionId,
        nodePath,
        e.name,
        e.isDir ? "queryfolder" : "queryfile",
        e.isDir
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      node.id = `${folder.connectionId}#${this.genOf(folder.connectionId)}:${nodePath.join("/")}`;
      node.iconPath = e.isDir
        ? new vscode.ThemeIcon("folder")
        : new vscode.ThemeIcon("file-code");
      if (!e.isDir) {
        node.command = {
          command: "openDbClient.openQueryFile",
          title: "Open Query",
          arguments: [node],
        };
      }
      return node;
    });
  }

  private toNode(connectionId: string, data: TreeItemData): DbNode {
    const collapsible = data.expandable
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const node = new DbNode(connectionId, data.path, data.label, data.kind, collapsible);
    node.id = `${connectionId}#${this.genOf(connectionId)}:${data.path.join("/")}`;
    node.iconPath = data.icon
      ? new vscode.ThemeIcon(data.icon)
      : data.kind === "column"
        ? columnIcon(data)
        : iconFor(data.kind);
    if (data.description) {
      node.description = data.description;
    }
    if (data.tooltip) {
      node.tooltip = data.tooltip;
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

/** Split a query-node path into its DB scope and the relative folder path. */
export function splitQueryPath(nodePath: string[]): { scope: string[]; relative: string[] } {
  const qi = nodePath.indexOf("@queries");
  if (qi < 0) {
    return { scope: nodePath, relative: [] };
  }
  return { scope: nodePath.slice(0, qi), relative: nodePath.slice(qi + 1) };
}

function describe(type: string): string {
  return { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", redis: "Redis" }[
    type
  ] ?? type;
}

const color = (id: string) => new vscode.ThemeColor(id);

/** Icon for structural node kinds (databases, schemas, tables, views, keys). */
function iconFor(kind: string): vscode.ThemeIcon {
  switch (kind) {
    case "database":
      return new vscode.ThemeIcon("database", color("charts.blue"));
    case "schema":
      return new vscode.ThemeIcon("symbol-structure", color("charts.blue"));
    case "table":
      return new vscode.ThemeIcon("table");
    case "view":
      return new vscode.ThemeIcon("eye", color("charts.purple"));
    case "key":
      return new vscode.ThemeIcon("key", color("charts.yellow"));
    case "folder":
      return new vscode.ThemeIcon("folder");
    case "user":
      return new vscode.ThemeIcon("account", color("charts.blue"));
    case "role":
      return new vscode.ThemeIcon("organization", color("charts.purple"));
    default:
      return new vscode.ThemeIcon("circle-small");
  }
}

/** Icon for a column, keyed on primary/foreign key and data type. */
function columnIcon(data: TreeItemData): vscode.ThemeIcon {
  if (data.pk) {
    return new vscode.ThemeIcon("key", color("charts.yellow"));
  }
  if (data.fk) {
    return new vscode.ThemeIcon("references", color("charts.blue"));
  }
  const t = (data.dataType ?? "").toLowerCase();
  if (/json/.test(t)) {
    return new vscode.ThemeIcon("symbol-object", color("charts.blue"));
  }
  if (/int|serial|numeric|decimal|real|double|float|money|bigint/.test(t)) {
    return new vscode.ThemeIcon("symbol-number", color("charts.green"));
  }
  if (/bool/.test(t)) {
    return new vscode.ThemeIcon("symbol-boolean", color("charts.purple"));
  }
  if (/time|date/.test(t)) {
    return new vscode.ThemeIcon("calendar", color("charts.red"));
  }
  if (/char|text|uuid|name|enum/.test(t)) {
    return new vscode.ThemeIcon("symbol-string", color("charts.orange"));
  }
  return new vscode.ThemeIcon("symbol-field", color("charts.foreground"));
}
