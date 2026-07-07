import * as fs from "fs";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { ConnectionConfig } from "../connections/types";
import {
  ColumnMeta,
  Driver,
  ForeignKey,
  PreviewOptions,
  QueryResult,
  TreeItemData,
} from "./Driver";
import { quoteIdent as qi } from "./ident";
import { tableFolders } from "./postgres";

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
      return tableFolders(path);
    }
    if (path.length === 2) {
      const tablePath = path.slice(0, 1);
      switch (path[1]) {
        case "@columns":
          return this.columnNodes(tablePath);
        case "@indexes":
          return this.indexNodes(tablePath);
        case "@fk":
          return this.fkNodes(tablePath);
        case "@triggers":
          return this.triggerNodes(tablePath);
      }
    }
    return [];
  }

  private async columnNodes(tablePath: string[]): Promise<TreeItemData[]> {
    const cols = await this.tableColumns(tablePath);
    return cols.map((c) => ({
      label: c.name,
      kind: "column" as const,
      expandable: false,
      path: [...tablePath, "@columns", c.name],
      description: marker(c),
      pk: c.pk,
      fk: c.fk,
      dataType: c.type,
    }));
  }

  private async indexNodes(tablePath: string[]): Promise<TreeItemData[]> {
    const res = this.d.exec(`PRAGMA index_list(${qi(tablePath[0])})`);
    if (res.length === 0) {
      return [];
    }
    const cols = res[0].columns;
    const iName = cols.indexOf("name");
    const iUnique = cols.indexOf("unique");
    return res[0].values.map((r) => {
      const name = String(r[iName]);
      const unique = Number(r[iUnique]) === 1;
      return {
        label: name,
        kind: "info" as const,
        icon: unique ? "key" : "list-selection",
        expandable: false,
        path: [...tablePath, "@indexes", name],
        description: unique ? "unique" : undefined,
      };
    });
  }

  private async fkNodes(tablePath: string[]): Promise<TreeItemData[]> {
    const fks = await this.foreignKeys(tablePath);
    return fks.map((fk) => ({
      label: fk.column,
      kind: "info" as const,
      icon: "references",
      expandable: false,
      path: [...tablePath, "@fk", fk.column],
      description: `→ ${fk.refTable.join(".")}.${fk.refColumn}`,
    }));
  }

  private async triggerNodes(tablePath: string[]): Promise<TreeItemData[]> {
    const stmt = this.d.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`
    );
    stmt.bind([tablePath[0]]);
    const out: TreeItemData[] = [];
    while (stmt.step()) {
      const name = String(stmt.get()[0]);
      out.push({
        label: name,
        kind: "info",
        icon: "zap",
        expandable: false,
        path: [...tablePath, "@triggers", name],
      });
    }
    stmt.free();
    return out;
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

  private buildWhere(opts: PreviewOptions): { where: string; bind: Record<string, never> } {
    const conds: string[] = [];
    const bind: Record<string, never> = {};
    let i = 0;
    if (opts.filter) {
      const k = `:f${i++}`;
      bind[k] = opts.filter.value as never;
      conds.push(`${qi(opts.filter.column)} = ${k}`);
    }
    for (const f of opts.columnFilters ?? []) {
      if (!f.value) {
        continue;
      }
      const k = `:f${i++}`;
      bind[k] = `%${f.value}%` as never;
      conds.push(`${qi(f.column)} LIKE ${k}`);
    }
    return { where: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", bind };
  }

  async previewTable(path: string[], opts: PreviewOptions = {}): Promise<QueryResult> {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const { where, bind } = this.buildWhere(opts);
    const order = opts.sort
      ? ` ORDER BY ${qi(opts.sort.column)} ${opts.sort.dir === "desc" ? "DESC" : "ASC"}`
      : "";
    const stmt = this.d.prepare(
      `SELECT * FROM ${qi(path[0])}${where}${order} LIMIT ${limit} OFFSET ${offset}`
    );
    if (Object.keys(bind).length) {
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
    result.page = { offset, limit, total: await this.countRows(path, opts) };
    return result;
  }

  async countRows(path: string[], opts: PreviewOptions = {}): Promise<number> {
    const { where, bind } = this.buildWhere(opts);
    const stmt = this.d.prepare(`SELECT count(*) FROM ${qi(path[0])}${where}`);
    if (Object.keys(bind).length) {
      stmt.bind(bind);
    }
    let n = 0;
    if (stmt.step()) {
      n = Number(stmt.get()[0]);
    }
    stmt.free();
    return n;
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
