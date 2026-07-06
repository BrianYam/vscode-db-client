import * as mysql from "mysql2/promise";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import { Driver, QueryResult, TreeItemData } from "./Driver";

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
    // Top level -> databases (schemas)
    if (path.length === 0) {
      const [rows] = await this.p.query<mysql.RowDataPacket[]>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN
           ('information_schema','performance_schema','mysql','sys')
         ORDER BY schema_name`
      );
      return rows.map((r) => ({
        label: String(r.schema_name ?? r.SCHEMA_NAME),
        kind: "database" as const,
        expandable: true,
        path: [String(r.schema_name ?? r.SCHEMA_NAME)],
      }));
    }
    // Database -> tables
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
          expandable: false,
          path: [db, name],
        };
      });
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
    return this.query(`SELECT * FROM \`${db}\`.\`${table}\` LIMIT 200`);
  }
}
