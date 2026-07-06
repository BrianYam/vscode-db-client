import * as mysql from "mysql2/promise";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import { ColumnMeta, Driver, QueryResult, TreeItemData } from "./Driver";

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
        description: `${c.type}${c.pk ? " 🔑" : ""}${c.nullable ? "" : " ·not null"}`,
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

  async previewTable(path: string[]): Promise<QueryResult> {
    const [db, table] = path;
    const result = await this.query(`SELECT * FROM \`${db}\`.\`${table}\` LIMIT 200`);
    const cols = await this.tableColumns(path);
    const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
    if (pkColumns.length) {
      result.editable = { table: path, pkColumns };
    }
    return result;
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
    return rows.map((c) => ({
      name: String(c.column_name ?? c.COLUMN_NAME),
      type: String(c.column_type ?? c.COLUMN_TYPE),
      nullable: String(c.is_nullable ?? c.IS_NULLABLE) === "YES",
      pk: String(c.column_key ?? c.COLUMN_KEY) === "PRI",
    }));
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
}
