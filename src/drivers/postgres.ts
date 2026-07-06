import { Pool } from "pg";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import { Driver, QueryResult, TreeItemData } from "./Driver";

/** PostgreSQL driver backed by the pure-JS `pg` pool. */
export class PostgresDriver implements Driver {
  private pool?: Pool;

  constructor(public readonly config: ConnectionConfig) {}

  async connect(password?: string): Promise<void> {
    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port ?? DEFAULT_PORTS.postgres,
      user: this.config.username,
      password,
      database: this.config.database || "postgres",
      max: 4,
      connectionTimeoutMillis: 10_000,
    });
    // Fail fast so the tree shows an error instead of hanging.
    const client = await this.pool.connect();
    client.release();
  }

  async dispose(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }

  private get p(): Pool {
    if (!this.pool) {
      throw new Error("Not connected");
    }
    return this.pool;
  }

  async children(path: string[]): Promise<TreeItemData[]> {
    // Top level -> schemas
    if (path.length === 0) {
      const res = await this.p.query<{ schema_name: string }>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog','information_schema')
         ORDER BY schema_name`
      );
      return res.rows.map((r) => ({
        label: r.schema_name,
        kind: "schema" as const,
        expandable: true,
        path: [r.schema_name],
      }));
    }
    // Schema -> tables + views
    if (path.length === 1) {
      const schema = path[0];
      const res = await this.p.query<{ table_name: string; table_type: string }>(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1 ORDER BY table_name`,
        [schema]
      );
      return res.rows.map((r) => ({
        label: r.table_name,
        kind: r.table_type === "VIEW" ? ("view" as const) : ("table" as const),
        expandable: false,
        path: [schema, r.table_name],
      }));
    }
    return [];
  }

  async query(sql: string): Promise<QueryResult> {
    const res = await this.p.query(sql);
    return {
      columns: res.fields?.map((f) => f.name) ?? [],
      rows: (res.rows as Array<Record<string, unknown>>) ?? [],
      rowCount: res.rowCount ?? res.rows?.length ?? 0,
      message: res.rows?.length ? undefined : `${res.command} ${res.rowCount ?? 0}`,
    };
  }

  async previewTable(path: string[]): Promise<QueryResult> {
    const [schema, table] = path;
    return this.query(`SELECT * FROM "${schema}"."${table}" LIMIT 200`);
  }
}
