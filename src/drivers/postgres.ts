import { Pool } from "pg";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import {
  ColumnMeta,
  Driver,
  ForeignKey,
  PreviewFilter,
  QueryResult,
  TreeItemData,
} from "./Driver";

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
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
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
        description: marker(c),
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

  async previewTable(
    path: string[],
    offset = 0,
    limit = 100,
    filter?: PreviewFilter
  ): Promise<QueryResult> {
    const [schema, table] = path;
    const where = filter ? ` WHERE "${filter.column}" = $1` : "";
    const params = filter ? [filter.value] : [];
    const res = await this.p.query(
      `SELECT * FROM "${schema}"."${table}"${where} LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const result: QueryResult = {
      columns: res.fields?.map((f) => f.name) ?? [],
      rows: (res.rows as Array<Record<string, unknown>>) ?? [],
      rowCount: res.rowCount ?? res.rows?.length ?? 0,
    };
    const cols = await this.tableColumns(path);
    result.columnsMeta = cols;
    result.foreignKeys = await this.foreignKeys(path);
    const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
    if (pkColumns.length) {
      result.editable = { table: path, pkColumns };
    }
    const total = await this.countRows(path, filter);
    result.page = { offset, limit, total };
    return result;
  }

  async countRows(path: string[], filter?: PreviewFilter): Promise<number> {
    const [schema, table] = path;
    const where = filter ? ` WHERE "${filter.column}" = $1` : "";
    const params = filter ? [filter.value] : [];
    const res = await this.p.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${schema}"."${table}"${where}`,
      params
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async foreignKeys(path: string[]): Promise<ForeignKey[]> {
    const [schema, table] = path;
    const res = await this.p.query<{
      col: string;
      ref_schema: string;
      ref_table: string;
      ref_col: string;
    }>(
      `SELECT kcu.column_name AS col,
              ccu.table_schema AS ref_schema,
              ccu.table_name   AS ref_table,
              ccu.column_name  AS ref_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table]
    );
    return res.rows.map((r) => ({
      column: r.col,
      refTable: [r.ref_schema, r.ref_table],
      refColumn: r.ref_col,
    }));
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
    const fk = await this.p.query<{ column_name: string }>(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table]
    );
    const pkNames = new Set(pk.rows.map((r) => r.attname));
    const fkNames = new Set(fk.rows.map((r) => r.column_name));
    return cols.rows.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === "YES",
      pk: pkNames.has(c.column_name),
      fk: fkNames.has(c.column_name),
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

  async deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void> {
    const [schema, tbl] = table;
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c, i) => `"${c}" = $${i + 1}`).join(" AND ");
    await this.p.query(
      `DELETE FROM "${schema}"."${tbl}" WHERE ${where}`,
      pkCols.map((c) => pkValues[c])
    );
  }

  async insertRow(table: string[], values: Record<string, unknown>): Promise<void> {
    const [schema, tbl] = table;
    const cols = Object.keys(values);
    if (!cols.length) {
      throw new Error("No values provided for insert");
    }
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    await this.p.query(
      `INSERT INTO "${schema}"."${tbl}" (${colList}) VALUES (${placeholders})`,
      cols.map((c) => values[c])
    );
  }
}

function marker(c: ColumnMeta): string {
  return `${c.type}${c.pk ? " 🔑" : ""}${c.fk ? " 🔗" : ""}${c.nullable ? "" : " ·not null"}`;
}
