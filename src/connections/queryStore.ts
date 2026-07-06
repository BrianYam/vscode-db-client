import * as path from "path";
import * as vscode from "vscode";

export interface QueryEntry {
  name: string;
  isDir: boolean;
}

/** Encode a connection + DB scope into one self-describing folder name. */
function encodeKey(connId: string, scope: string[]): string {
  return `${connId}@@${scope.join("@")}`;
}

/** Parse a scope-key folder name back into its connection id + scope. */
export function parseKey(key: string): { connId: string; scope: string[] } {
  const at = key.indexOf("@@");
  if (at < 0) {
    return { connId: key, scope: [] };
  }
  const connId = key.slice(0, at);
  const rest = key.slice(at + 2);
  return { connId, scope: rest ? rest.split("@") : [] };
}

/**
 * Manages saved query files/folders as real files on disk under the extension's
 * global storage:
 *   <globalStorage>/queries/<connId>/<scope...>/<relative...>/<name>.sql
 * `scope` is the DB context (e.g. [database] or [database, schema]); `relative`
 * is the nested folder path within the Query tree. They are ordinary files, so
 * VS Code's editor handles editing/saving.
 */
export class QueryStore {
  constructor(private readonly root: vscode.Uri) {}

  private san(s: string): string {
    return s.replace(/[^\w.@-]+/g, "_") || "_";
  }

  private base(connId: string, scope: string[]): vscode.Uri {
    return vscode.Uri.joinPath(
      this.root,
      "queries",
      this.san(encodeKey(connId, scope.map((s) => s || "default")))
    );
  }

  /** Resolve a `.sql` file uri back to its connection + database, if it's ours. */
  resolveUri(uri: vscode.Uri): { connId: string; database: string } | undefined {
    const marker = path.join(this.root.fsPath, "queries") + path.sep;
    if (!uri.fsPath.startsWith(marker)) {
      return undefined;
    }
    const firstSeg = uri.fsPath.slice(marker.length).split(path.sep)[0];
    const { connId, scope } = parseKey(firstSeg);
    return { connId, database: scope[0] ?? "" };
  }

  dirUri(connId: string, scope: string[], relative: string[]): vscode.Uri {
    return vscode.Uri.joinPath(this.base(connId, scope), ...relative.map((r) => this.san(r)));
  }

  fileUri(connId: string, scope: string[], relative: string[], name: string): vscode.Uri {
    const file = name.endsWith(".sql") ? name : `${name}.sql`;
    return vscode.Uri.joinPath(this.dirUri(connId, scope, relative), this.san(file));
  }

  /** List sub-folders and .sql files at scope+relative (folders first). */
  async list(connId: string, scope: string[], relative: string[]): Promise<QueryEntry[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        this.dirUri(connId, scope, relative)
      );
      const dirs = entries
        .filter(([, t]) => t === vscode.FileType.Directory)
        .map(([n]) => ({ name: n, isDir: true }));
      const files = entries
        .filter(([n, t]) => t === vscode.FileType.File && n.endsWith(".sql"))
        .map(([n]) => ({ name: n, isDir: false }));
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      return [...dirs, ...files];
    } catch {
      return [];
    }
  }

  async createFile(
    connId: string,
    scope: string[],
    relative: string[],
    name: string
  ): Promise<vscode.Uri> {
    const uri = this.fileUri(connId, scope, relative, name);
    await vscode.workspace.fs.createDirectory(this.dirUri(connId, scope, relative));
    const header = `-- ${name}\n\n`;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(header, "utf8"));
    return uri;
  }

  async createFolder(
    connId: string,
    scope: string[],
    relative: string[],
    name: string
  ): Promise<void> {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(this.dirUri(connId, scope, relative), this.san(name))
    );
  }

  async delete(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  }

  async read(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }
}
