import * as fs from "fs";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { ConnectionConfig } from "../connections/types";
import { Driver, QueryResult, TreeItemData } from "./Driver";

// sql.js is a WASM build — no native compilation needed. The .wasm file lives
// in node_modules/sql.js/dist and is located via this directory, set once at
// activation so drivers don't need the extension context.
let wasmDir = "";
export function setSqliteWasmDir(dir: string): void {
  wasmDir = dir;
}

let sqlJs: SqlJsStatic | undefined;
async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJs) {
    sqlJs = await initSqlJs({
      locateFile: (file: string) => `${wasmDir}/${file}`,
    });
  }
  return sqlJs;
}

/**
 * SQLite driver. NOTE: sql.js works on an in-memory copy of the file, so writes
 * do not persist back to disk yet (see task.md — "SQLite write-back"). Reads and
 * SELECT queries work fully.
 */
export class SqliteDriver implements Driver {
  private db?: Database;

  constructor(public readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    const path = this.config.filePath;
    if (!path || !fs.existsSync(path)) {
      throw new Error(`SQLite file not found: ${path}`);
    }
    const SQL = await getSqlJs();
    const bytes = fs.readFileSync(path);
    this.db = new SQL.Database(bytes);
  }

  async dispose(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  private get d(): Database {
    if (!this.db) {
      throw new Error("Not connected");
    }
    return this.db;
  }

  async children(path: string[]): Promise<TreeItemData[]> {
    if (path.length === 0) {
      const res = this.d.exec(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      );
      if (res.length === 0) {
        return [];
      }
      return res[0].values.map((row) => ({
        label: String(row[0]),
        kind: row[1] === "view" ? ("view" as const) : ("table" as const),
        expandable: false,
        path: [String(row[0])],
      }));
    }
    return [];
  }

  async query(sql: string): Promise<QueryResult> {
    const res = this.d.exec(sql);
    if (res.length === 0) {
      return { columns: [], rows: [], rowCount: 0, message: "OK" };
    }
    const { columns, values } = res[0];
    const rows = values.map((v) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((c, i) => (obj[c] = v[i]));
      return obj;
    });
    return { columns, rows, rowCount: rows.length };
  }

  async previewTable(path: string[]): Promise<QueryResult> {
    return this.query(`SELECT * FROM "${path[0]}" LIMIT 200`);
  }
}
