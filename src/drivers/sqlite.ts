import * as fs from "fs";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { ConnectionConfig } from "../connections/types";
import { ColumnMeta, Driver, QueryResult, TreeItemData } from "./Driver";

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
 * SQLite driver on WASM sql.js. Works on an in-memory copy of the file; writes
 * are persisted back to disk after each modifying statement (see persist()).
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
    this.db = new SQL.Database(fs.readFileSync(path));
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

  /** Write the in-memory database back to the source file. */
  private persist(): void {
    fs.writeFileSync(this.config.filePath!, Buffer.from(this.d.export()));
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
        expandable: true,
        path: [String(row[0])],
      }));
    }
    if (path.length === 1) {
      const cols = await this.tableColumns(path);
      return cols.map((c) => ({
        label: c.name,
        kind: "column" as const,
        expandable: false,
        path: [...path, c.name],
        description: `${c.type || "?"}${c.pk ? " 🔑" : ""}${c.nullable ? "" : " ·not null"}`,
      }));
    }
    return [];
  }

  async query(sql: string): Promise<QueryResult> {
    const res = this.d.exec(sql);
    // Any statement can mutate; persist if it wasn't a pure SELECT.
    if (!/^\s*select/i.test(sql)) {
      this.persist();
    }
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
    const result = await this.query(`SELECT * FROM "${path[0]}" LIMIT 200`);
    const cols = await this.tableColumns(path);
    const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
    if (pkColumns.length) {
      result.editable = { table: path, pkColumns };
    }
    return result;
  }

  async tableColumns(path: string[]): Promise<ColumnMeta[]> {
    const res = this.d.exec(`PRAGMA table_info("${path[0]}")`);
    if (res.length === 0) {
      return [];
    }
    // columns: cid, name, type, notnull, dflt_value, pk
    return res[0].values.map((row) => ({
      name: String(row[1]),
      type: String(row[2] ?? ""),
      nullable: Number(row[3]) === 0,
      pk: Number(row[5]) > 0,
    }));
  }

  async getDDL(path: string[]): Promise<string> {
    const stmt = this.d.prepare(
      `SELECT sql FROM sqlite_master WHERE name = ?`
    );
    stmt.bind([path[0]]);
    let ddl = "-- unavailable";
    if (stmt.step()) {
      ddl = String(stmt.get()[0]);
    }
    stmt.free();
    return ddl;
  }

  async updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void> {
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c) => `"${c}" = ?`).join(" AND ");
    const sql = `UPDATE "${table[0]}" SET "${column}" = ? WHERE ${where}`;
    this.d.run(sql, [
      value as never,
      ...pkCols.map((c) => pkValues[c] as never),
    ]);
    this.persist();
  }
}
