import { Pool } from "pg";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import { ColumnMeta, Driver, QueryResult, TreeItemData } from "./Driver";

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
        expandable: true,
        path: [schema, r.table_name],
      }));
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
    const result = await this.query(`SELECT * FROM "${schema}"."${table}" LIMIT 200`);
    const cols = await this.tableColumns(path);
    const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
    if (pkColumns.length) {
      result.editable = { table: path, pkColumns };
    }
    return result;
  }

  async tableColumns(path: string[]): Promise<ColumnMeta[]> {
    const [schema, table] = path;
    const cols = await this.p.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    );
    const pk = await this.p.query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
      [`"${schema}"."${table}"`]
    );
    const pkNames = new Set(pk.rows.map((r) => r.attname));
    return cols.rows.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === "YES",
      pk: pkNames.has(c.column_name),
    }));
  }

  async getDDL(path: string[]): Promise<string> {
    const [schema, table] = path;
    const cols = await this.tableColumns(path);
    const lines = cols.map(
      (c) => `  "${c.name}" ${c.type}${c.nullable ? "" : " NOT NULL"}`
    );
    const pk = cols.filter((c) => c.pk).map((c) => `"${c.name}"`);
    if (pk.length) {
      lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
    }
    return `-- Reconstructed from information_schema (approximate)\nCREATE TABLE "${schema}"."${table}" (\n${lines.join(",\n")}\n);`;
  }

  async updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void> {
    const [schema, tbl] = table;
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c, i) => `"${c}" = $${i + 2}`).join(" AND ");
    const sql = `UPDATE "${schema}"."${tbl}" SET "${column}" = $1 WHERE ${where}`;
    await this.p.query(sql, [value, ...pkCols.map((c) => pkValues[c])]);
  }
}
