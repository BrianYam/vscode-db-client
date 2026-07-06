import * as fs from "fs";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { ConnectionConfig } from "../connections/types";
import {
  ColumnMeta,
  Driver,
  ForeignKey,
  PreviewFilter,
  QueryResult,
  TreeItemData,
} from "./Driver";
import { quoteIdent as qi } from "./ident";

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
        description: marker(c),
        pk: c.pk,
        fk: c.fk,
        dataType: c.type,
      }));
    }
    return [];
  }

  async query(sql: string): Promise<QueryResult> {
    const res = this.d.exec(sql);
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

  async previewTable(
    path: string[],
    offset = 0,
    limit = 100,
    filter?: PreviewFilter
  ): Promise<QueryResult> {
    const where = filter ? ` WHERE ${qi(filter.column)} = :v` : "";
    const bind = filter ? { ":v": filter.value as never } : undefined;
    const stmt = this.d.prepare(
      `SELECT * FROM ${qi(path[0])}${where} LIMIT ${limit} OFFSET ${offset}`
    );
    if (bind) {
      stmt.bind(bind);
    }
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];
    while (stmt.step()) {
      columns = stmt.getColumnNames();
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    const result: QueryResult = { columns, rows, rowCount: rows.length };
    const cols = await this.tableColumns(path);
    result.columnsMeta = cols;
    if (!columns.length) {
      result.columns = cols.map((c) => c.name);
    }
    result.foreignKeys = await this.foreignKeys(path);
    const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
    if (pkColumns.length) {
      result.editable = { table: path, pkColumns };
    }
    result.page = { offset, limit, total: await this.countRows(path, filter) };
    return result;
  }

  async countRows(path: string[], filter?: PreviewFilter): Promise<number> {
    if (filter) {
      const stmt = this.d.prepare(
        `SELECT count(*) FROM ${qi(path[0])} WHERE ${qi(filter.column)} = :v`
      );
      stmt.bind({ ":v": filter.value as never });
      let n = 0;
      if (stmt.step()) {
        n = Number(stmt.get()[0]);
      }
      stmt.free();
      return n;
    }
    const res = this.d.exec(`SELECT count(*) FROM ${qi(path[0])}`);
    return Number(res[0]?.values[0]?.[0] ?? 0);
  }

  async foreignKeys(path: string[]): Promise<ForeignKey[]> {
    const res = this.d.exec(`PRAGMA foreign_key_list("${path[0]}")`);
    if (res.length === 0) {
      return [];
    }
    const cols = res[0].columns;
    const iTable = cols.indexOf("table");
    const iFrom = cols.indexOf("from");
    const iTo = cols.indexOf("to");
    return res[0].values.map((r) => ({
      column: String(r[iFrom]),
      refTable: [String(r[iTable])],
      refColumn: String(r[iTo]),
    }));
  }

  async tableColumns(path: string[]): Promise<ColumnMeta[]> {
    const res = this.d.exec(`PRAGMA table_info(${qi(path[0])})`);
    const fkRes = this.d.exec(`PRAGMA foreign_key_list(${qi(path[0])})`);
    // foreign_key_list columns: id, seq, table, from, to, ...
    const fromIdx = fkRes[0]?.columns.indexOf("from") ?? -1;
    const fkNames = new Set(
      fkRes[0] && fromIdx >= 0
        ? fkRes[0].values.map((r) => String(r[fromIdx]))
        : []
    );
    if (res.length === 0) {
      return [];
    }
    // table_info columns: cid, name, type, notnull, dflt_value, pk
    return res[0].values.map((row) => ({
      name: String(row[1]),
      type: String(row[2] ?? ""),
      nullable: Number(row[3]) === 0,
      pk: Number(row[5]) > 0,
      fk: fkNames.has(String(row[1])),
    }));
  }

  async schemaHints(): Promise<{ tables: string[]; columns: string[] }> {
    const res = this.d.exec(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view')
       AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    const tables = res[0]?.values.map((r) => String(r[0])) ?? [];
    const columns = new Set<string>();
    for (const t of tables) {
      const info = this.d.exec(`PRAGMA table_info(${qi(t)})`);
      info[0]?.values.forEach((r) => columns.add(String(r[1])));
    }
    return { tables, columns: [...columns] };
  }

  async getDDL(path: string[]): Promise<string> {
    const stmt = this.d.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`);
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
    const where = pkCols.map((c) => `${qi(c)} = ?`).join(" AND ");
    const sql = `UPDATE ${qi(table[0])} SET ${qi(column)} = ? WHERE ${where}`;
    this.d.run(sql, [value as never, ...pkCols.map((c) => pkValues[c] as never)]);
    this.persist();
  }

  async deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void> {
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c) => `${qi(c)} = ?`).join(" AND ");
    this.d.run(
      `DELETE FROM ${qi(table[0])} WHERE ${where}`,
      pkCols.map((c) => pkValues[c] as never)
    );
    this.persist();
  }

  async insertRow(table: string[], values: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(values);
    if (!cols.length) {
      throw new Error("No values provided for insert");
    }
    const colList = cols.map((c) => qi(c)).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    this.d.run(
      `INSERT INTO ${qi(table[0])} (${colList}) VALUES (${placeholders})`,
      cols.map((c) => values[c] as never)
    );
    this.persist();
  }
}

function marker(c: ColumnMeta): string {
  return `${c.type || "?"}${c.pk ? " 🔑" : ""}${c.fk ? " 🔗" : ""}${c.nullable ? "" : " ·not null"}`;
}
