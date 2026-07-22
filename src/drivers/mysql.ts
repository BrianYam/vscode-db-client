import * as mysql from "mysql2/promise";
import { type ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import type {
  ColumnMeta,
  Driver,
  ForeignKey,
  PreviewOptions,
  QueryResult,
  TreeItemData,
} from "./Driver";
import { displayBacktick as db2, quoteBacktick as qb } from "./ident";
import { displaySql, tableFolders } from "./postgres";
import { buildTls } from "./ssl";

/** MySQL / MariaDB driver backed by the pure-JS `mysql2` pool. */
export class MySqlDriver implements Driver {
  private pool?: mysql.Pool;

  constructor(public readonly config: ConnectionConfig) {}

  async connect(password?: string): Promise<void> {
    if (this.config.useConnectionString && this.config.connectionString) {
      this.pool = mysql.createPool(this.config.connectionString);
    } else {
      const ssl = buildTls(this.config);
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port ?? DEFAULT_PORTS.mysql,
        user: this.config.username,
        password,
        database: this.config.database || undefined,
        connectionLimit: 4,
        connectTimeout: 10_000,
        ssl: ssl
          ? { ca: ssl.ca, cert: ssl.cert, key: ssl.key, rejectUnauthorized: ssl.rejectUnauthorized }
          : undefined,
      });
    }
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async dispose(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }

  private get p(): mysql.Pool {
    if (!this.pool) {
      throw new Error("Not connected");
    }
    return this.pool;
  }

  async children(path: string[]): Promise<TreeItemData[]> {
    if (path.length === 0) {
      const [rows] = await this.p.query<mysql.RowDataPacket[]>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN
           ('information_schema','performance_schema','mysql','sys')
         ORDER BY schema_name`,
      );
      return rows.map((r) => {
        const name = String(r.schema_name ?? r.SCHEMA_NAME);
        return { label: name, kind: "database" as const, expandable: true, path: [name] };
      });
    }
    if (path.length === 1) {
      const db = path[0];
      const [rows] = await this.p.query<mysql.RowDataPacket[]>(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = ? ORDER BY table_name`,
        [db],
      );
      return rows.map((r) => {
        const name = String(r.table_name ?? r.TABLE_NAME);
        const type = String(r.table_type ?? r.TABLE_TYPE);
        return {
          label: name,
          kind: type === "VIEW" ? ("view" as const) : ("table" as const),
          expandable: true,
          path: [db, name],
        };
      });
    }
    if (path.length === 2) {
      return tableFolders(path);
    }
    if (path.length === 3) {
      const tablePath = path.slice(0, 2);
      switch (path[2]) {
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
    const [db, table] = tablePath;
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ?
       GROUP BY index_name, non_unique ORDER BY index_name`,
      [db, table],
    );
    return rows.map((r) => {
      const name = String(r.index_name ?? r.INDEX_NAME);
      const unique = Number(r.non_unique ?? r.NON_UNIQUE) === 0;
      const cols = String(r.cols ?? r.COLS ?? "");
      return {
        label: name,
        kind: "info" as const,
        icon: unique ? "key" : "list-selection",
        expandable: false,
        path: [...tablePath, "@indexes", name],
        description: `${unique ? "unique " : ""}(${cols})`,
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
    const [db, table] = tablePath;
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT trigger_name, action_timing, event_manipulation
       FROM information_schema.triggers
       WHERE event_object_schema = ? AND event_object_table = ?
       ORDER BY trigger_name`,
      [db, table],
    );
    return rows.map((r) => {
      const name = String(r.trigger_name ?? r.TRIGGER_NAME);
      const timing = String(r.action_timing ?? r.ACTION_TIMING ?? "");
      const event = String(r.event_manipulation ?? r.EVENT_MANIPULATION ?? "");
      return {
        label: name,
        kind: "info" as const,
        icon: "zap",
        expandable: false,
        path: [...tablePath, "@triggers", name],
        description: `${timing} ${event}`.toLowerCase(),
      };
    });
  }

  async query(sql: string): Promise<QueryResult> {
    const [result, fields] = await this.p.query(sql);
    if (Array.isArray(result)) {
      const rows = result as Array<Record<string, unknown>>;
      return {
        columns:
          (fields as mysql.FieldPacket[] | undefined)?.map((f) => f.name) ??
          (rows[0] ? Object.keys(rows[0]) : []),
        rows,
        rowCount: rows.length,
      };
    }
    const info = result as mysql.ResultSetHeader;
    return {
      columns: [],
      rows: [],
      rowCount: info.affectedRows ?? 0,
      message: `OK, ${info.affectedRows ?? 0} row(s) affected`,
    };
  }

  private buildWhere(opts: PreviewOptions): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.filter) {
      params.push(opts.filter.value);
      conds.push(`${qb(opts.filter.column)} = ?`);
    }
    for (const f of opts.columnFilters ?? []) {
      if (!f.value) {
        continue;
      }
      params.push(`%${f.value}%`);
      conds.push(`${qb(f.column)} LIKE ?`);
    }
    return { where: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
  }

  async previewTable(path: string[], opts: PreviewOptions = {}): Promise<QueryResult> {
    const [db, table] = path;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const { where, params } = this.buildWhere(opts);
    const order = opts.sort
      ? ` ORDER BY ${qb(opts.sort.column)} ${opts.sort.dir === "desc" ? "DESC" : "ASC"}`
      : "";
    const [rows, fields] = await this.p.query(
      `SELECT * FROM ${qb(db)}.${qb(table)}${where}${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const data = (rows as Array<Record<string, unknown>>) ?? [];
    const result: QueryResult = {
      columns:
        (fields as mysql.FieldPacket[] | undefined)?.map((f) => f.name) ??
        (data[0] ? Object.keys(data[0]) : []),
      rows: data,
      rowCount: data.length,
    };
    const cols = await this.tableColumns(path);
    result.columnsMeta = cols;
    result.foreignKeys = await this.foreignKeys(path);
    const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
    if (pkColumns.length) {
      result.editable = { table: path, pkColumns };
    }
    result.page = { offset, limit, total: await this.countRows(path, opts) };
    result.sql = displaySql(`${db2(db)}.${db2(table)}`, opts, "LIKE", db2);
    return result;
  }

  async countRows(path: string[], opts: PreviewOptions = {}): Promise<number> {
    const [db, table] = path;
    const { where, params } = this.buildWhere(opts);
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT count(*) AS n FROM ${qb(db)}.${qb(table)}${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async foreignKeys(path: string[]): Promise<ForeignKey[]> {
    const [db, table] = path;
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS col, referenced_table_schema AS ref_schema,
              referenced_table_name AS ref_table, referenced_column_name AS ref_col
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [db, table],
    );
    return rows.map((r) => ({
      column: String(r.col ?? r.COL),
      refTable: [String(r.ref_schema ?? r.REF_SCHEMA), String(r.ref_table ?? r.REF_TABLE)],
      refColumn: String(r.ref_col ?? r.REF_COL),
    }));
  }

  async tableColumns(path: string[]): Promise<ColumnMeta[]> {
    const [db, table] = path;
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT column_name, column_type, is_nullable, column_key
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [db, table],
    );
    const [fkRows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [db, table],
    );
    const fkNames = new Set(fkRows.map((r) => String(r.column_name ?? r.COLUMN_NAME)));
    return rows.map((c) => {
      const name = String(c.column_name ?? c.COLUMN_NAME);
      return {
        name,
        type: String(c.column_type ?? c.COLUMN_TYPE),
        nullable: String(c.is_nullable ?? c.IS_NULLABLE) === "YES",
        pk: String(c.column_key ?? c.COLUMN_KEY) === "PRI",
        fk: fkNames.has(name),
      };
    });
  }

  async schemaHints(database?: string): Promise<{ tables: string[]; columns: string[] }> {
    const db = database ?? this.config.database ?? "";
    if (!db) {
      return { tables: [], columns: [] };
    }
    const [t] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? ORDER BY table_name LIMIT 2000`,
      [db],
    );
    const [c] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT DISTINCT column_name FROM information_schema.columns
       WHERE table_schema = ? ORDER BY column_name LIMIT 4000`,
      [db],
    );
    return {
      tables: t.map((r) => String(r.table_name ?? r.TABLE_NAME)),
      columns: c.map((r) => String(r.column_name ?? r.COLUMN_NAME)),
    };
  }

  async getDDL(path: string[]): Promise<string> {
    const [db, table] = path;
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SHOW CREATE TABLE ${qb(db)}.${qb(table)}`,
    );
    const row = rows[0] ?? {};
    return String(row["Create Table"] ?? row["Create View"] ?? "-- unavailable");
  }

  async updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void> {
    const [db, tbl] = table;
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c) => `${qb(c)} = ?`).join(" AND ");
    const sql = `UPDATE ${qb(db)}.${qb(tbl)} SET ${qb(column)} = ? WHERE ${where}`;
    await this.p.query(sql, [value, ...pkCols.map((c) => pkValues[c])]);
  }

  async deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void> {
    const [db, tbl] = table;
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c) => `${qb(c)} = ?`).join(" AND ");
    await this.p.query(
      `DELETE FROM ${qb(db)}.${qb(tbl)} WHERE ${where}`,
      pkCols.map((c) => pkValues[c]),
    );
  }

  async insertRow(table: string[], values: Record<string, unknown>): Promise<void> {
    const [db, tbl] = table;
    const cols = Object.keys(values);
    if (!cols.length) {
      throw new Error("No values provided for insert");
    }
    const colList = cols.map((c) => qb(c)).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    await this.p.query(
      `INSERT INTO ${qb(db)}.${qb(tbl)} (${colList}) VALUES (${placeholders})`,
      cols.map((c) => values[c]),
    );
  }
}

function marker(c: ColumnMeta): string {
  return `${c.type}${c.pk ? " 🔑" : ""}${c.fk ? " 🔗" : ""}${c.nullable ? "" : " ·not null"}`;
}
