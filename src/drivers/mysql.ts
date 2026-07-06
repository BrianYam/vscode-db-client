import * as mysql from "mysql2/promise";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import {
  ColumnMeta,
  Driver,
  ForeignKey,
  PreviewFilter,
  QueryResult,
  TreeItemData,
} from "./Driver";

/** MySQL / MariaDB driver backed by the pure-JS `mysql2` pool. */
export class MySqlDriver implements Driver {
  private pool?: mysql.Pool;

  constructor(public readonly config: ConnectionConfig) {}

  async connect(password?: string): Promise<void> {
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port ?? DEFAULT_PORTS.mysql,
      user: this.config.username,
      password,
      database: this.config.database || undefined,
      connectionLimit: 4,
      connectTimeout: 10_000,
    });
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
         ORDER BY schema_name`
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
        [db]
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
      const cols = await this.tableColumns(path);
      return cols.map((c) => ({
        label: c.name,
        kind: "column" as const,
        expandable: false,
        path: [...path, c.name],
        description: marker(c),
      }));
    }
    return [];
  }

  async query(sql: string): Promise<QueryResult> {
    const [result, fields] = await this.p.query(sql);
    if (Array.isArray(result)) {
      const rows = result as Array<Record<string, unknown>>;
      return {
        columns: (fields as mysql.FieldPacket[] | undefined)?.map((f) => f.name) ??
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

  async previewTable(
    path: string[],
    offset = 0,
    limit = 100,
    filter?: PreviewFilter
  ): Promise<QueryResult> {
    const [db, table] = path;
    const where = filter ? ` WHERE \`${filter.column}\` = ?` : "";
    const params = filter ? [filter.value] : [];
    const [rows, fields] = await this.p.query(
      `SELECT * FROM \`${db}\`.\`${table}\`${where} LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const data = (rows as Array<Record<string, unknown>>) ?? [];
    const result: QueryResult = {
      columns: (fields as mysql.FieldPacket[] | undefined)?.map((f) => f.name) ??
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
    result.page = { offset, limit, total: await this.countRows(path, filter) };
    return result;
  }

  async countRows(path: string[], filter?: PreviewFilter): Promise<number> {
    const [db, table] = path;
    const where = filter ? ` WHERE \`${filter.column}\` = ?` : "";
    const params = filter ? [filter.value] : [];
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT count(*) AS n FROM \`${db}\`.\`${table}\`${where}`,
      params
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
      [db, table]
    );
    return rows.map((r) => ({
      column: String(r.col ?? r.COL),
      refTable: [
        String(r.ref_schema ?? r.REF_SCHEMA),
        String(r.ref_table ?? r.REF_TABLE),
      ],
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
      [db, table]
    );
    const [fkRows] = await this.p.query<mysql.RowDataPacket[]>(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [db, table]
    );
    const fkNames = new Set(
      fkRows.map((r) => String(r.column_name ?? r.COLUMN_NAME))
    );
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

  async getDDL(path: string[]): Promise<string> {
    const [db, table] = path;
    const [rows] = await this.p.query<mysql.RowDataPacket[]>(
      `SHOW CREATE TABLE \`${db}\`.\`${table}\``
    );
    const row = rows[0] ?? {};
    return String(row["Create Table"] ?? row["Create View"] ?? "-- unavailable");
  }

  async updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void> {
    const [db, tbl] = table;
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c) => `\`${c}\` = ?`).join(" AND ");
    const sql = `UPDATE \`${db}\`.\`${tbl}\` SET \`${column}\` = ? WHERE ${where}`;
    await this.p.query(sql, [value, ...pkCols.map((c) => pkValues[c])]);
  }

  async deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void> {
    const [db, tbl] = table;
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c) => `\`${c}\` = ?`).join(" AND ");
    await this.p.query(
      `DELETE FROM \`${db}\`.\`${tbl}\` WHERE ${where}`,
      pkCols.map((c) => pkValues[c])
    );
  }

  async insertRow(table: string[], values: Record<string, unknown>): Promise<void> {
    const [db, tbl] = table;
    const cols = Object.keys(values);
    if (!cols.length) {
      throw new Error("No values provided for insert");
    }
    const colList = cols.map((c) => `\`${c}\``).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    await this.p.query(
      `INSERT INTO \`${db}\`.\`${tbl}\` (${colList}) VALUES (${placeholders})`,
      cols.map((c) => values[c])
    );
  }
}

function marker(c: ColumnMeta): string {
  return `${c.type}${c.pk ? " 🔑" : ""}${c.fk ? " 🔗" : ""}${c.nullable ? "" : " ·not null"}`;
}
