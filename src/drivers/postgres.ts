import { Pool } from "pg";
import { type ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import type {
  ColumnMeta,
  Driver,
  ForeignKey,
  PreviewOptions,
  QueryResult,
  SchemaHints,
  TreeItemData,
} from "./Driver";
import { groupColumns, HINT_COLUMN_LIMIT, HINT_TABLE_LIMIT } from "./hints";
import { displayIdent as di, parseFromTable, quoteIdent as qi, sqlLiteral } from "./ident";
import { buildTls } from "./ssl";

// Sentinel pool key for connection-string mode (single database).
const CS_KEY = "\u0000cs";

/**
 * PostgreSQL driver. A Postgres server hosts many databases and a single
 * connection is bound to one of them, so we keep a pool PER database and open
 * them lazily. The tree is: connection -> databases -> schemas -> tables -> columns.
 * In connection-string mode the database is fixed, so we fall back to a
 * schema-first tree (schemas -> tables -> columns).
 */
export class PostgresDriver implements Driver {
  private pools = new Map<string, Pool>();
  private password?: string;

  constructor(public readonly config: ConnectionConfig) {}

  private get usingCS(): boolean {
    return !!(this.config.useConnectionString && this.config.connectionString);
  }

  async connect(password?: string): Promise<void> {
    this.password = password;
    const client = await this.entryPool().connect();
    client.release();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }

  private makePool(key: string): Pool {
    const ssl = buildTls(this.config);
    const connString = this.config.connectionString;
    if (this.usingCS && connString) {
      // Rewrite the database path segment so each database gets its own pool,
      // exactly as with the individual-field mode.
      let connectionString = connString;
      if (key !== CS_KEY) {
        try {
          const u = new URL(connectionString);
          u.pathname = `/${encodeURIComponent(key)}`;
          connectionString = u.toString();
        } catch {
          /* fall back to the string as-is */
        }
      }
      return new Pool({
        connectionString,
        max: 4,
        connectionTimeoutMillis: 10_000,
        ssl,
      });
    }
    return new Pool({
      host: this.config.host,
      port: this.config.port ?? DEFAULT_PORTS.postgres,
      user: this.config.username,
      password: this.password,
      database: key,
      max: 4,
      connectionTimeoutMillis: 10_000,
      ssl,
    });
  }

  private poolFor(key: string): Pool {
    let p = this.pools.get(key);
    if (!p) {
      p = this.makePool(key);
      this.pools.set(key, p);
    }
    return p;
  }

  private entryKey(): string {
    return this.usingCS ? CS_KEY : this.config.database || "postgres";
  }

  private entryPool(): Pool {
    return this.poolFor(this.entryKey());
  }

  /** Resolve a table path ([db,schema,table]) to its pool. */
  private resolve(path: string[]): { pool: Pool; schema: string; table: string; db: string } {
    const [db, schema, table] = path;
    return { pool: this.poolFor(db), schema, table, db };
  }

  async children(path: string[]): Promise<TreeItemData[]> {
    // Same layout for both field and connection-string modes:
    // connection -> [Security, databases...] -> schemas -> tables -> columns.
    if (path[0] === "@security") return this.securityNodes(path);
    if (path.length === 0) {
      const security: TreeItemData = {
        label: "Security",
        kind: "folder",
        icon: "shield",
        expandable: true,
        path: ["@security"],
      };
      return [security, ...(await this.databaseNodes())];
    }
    if (path.length === 1) return this.schemaNodes(this.poolFor(path[0]), path);
    if (path.length === 2) return this.tableNodes(this.poolFor(path[0]), path);
    if (path.length === 3) return tableFolders(path);
    if (path.length === 4) {
      const tablePath = path.slice(0, 3);
      switch (path[3]) {
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

  private async indexNodes(tablePath: string[]): Promise<TreeItemData[]> {
    const { pool, schema, table } = this.resolve(tablePath);
    const res = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [schema, table],
    );
    return res.rows.map((r) => ({
      label: r.indexname,
      kind: "info" as const,
      icon: r.indexdef.includes("UNIQUE") ? "key" : "list-selection",
      expandable: false,
      path: [...tablePath, "@indexes", r.indexname],
      description: r.indexdef.includes("UNIQUE") ? "unique" : undefined,
      tooltip: r.indexdef,
    }));
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
    const { pool, schema, table } = this.resolve(tablePath);
    const res = await pool.query<{
      trigger_name: string;
      action_timing: string;
      event_manipulation: string;
    }>(
      `SELECT trigger_name, action_timing, string_agg(event_manipulation, '/') AS event_manipulation
       FROM information_schema.triggers
       WHERE event_object_schema = $1 AND event_object_table = $2
       GROUP BY trigger_name, action_timing ORDER BY trigger_name`,
      [schema, table],
    );
    return res.rows.map((r) => ({
      label: r.trigger_name,
      kind: "info" as const,
      icon: "zap",
      expandable: false,
      path: [...tablePath, "@triggers", r.trigger_name],
      description: `${r.action_timing} ${r.event_manipulation}`.toLowerCase(),
    }));
  }

  private async databaseNodes(): Promise<TreeItemData[]> {
    // List ALL non-template databases (including ones like rdsadmin that this
    // role cannot enter) — expanding a no-connect DB surfaces the error inline.
    const res = await this.entryPool().query<{ datname: string; datallowconn: boolean }>(
      `SELECT datname, datallowconn FROM pg_database
       WHERE datistemplate = false ORDER BY datname`,
    );
    return res.rows.map((r) => ({
      label: r.datname,
      kind: "database" as const,
      expandable: true,
      path: [r.datname],
      description: r.datallowconn ? undefined : "no connect",
    }));
  }

  private async securityNodes(path: string[]): Promise<TreeItemData[]> {
    if (path.length === 1) {
      return [
        {
          label: "Users",
          kind: "folder",
          icon: "account",
          expandable: true,
          path: ["@security", "users"],
        },
        {
          label: "Roles",
          kind: "folder",
          icon: "organization",
          expandable: true,
          path: ["@security", "roles"],
        },
      ];
    }
    const wantUsers = path[1] === "users";
    const res = await this.entryPool().query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
    }>(
      `SELECT rolname, rolsuper, rolcreatedb FROM pg_roles
       WHERE rolcanlogin = $1 ORDER BY rolname`,
      [wantUsers],
    );
    return res.rows.map((r) => ({
      label: r.rolname,
      kind: wantUsers ? ("user" as const) : ("role" as const),
      expandable: false,
      path: [...path, r.rolname],
      description:
        [r.rolsuper ? "superuser" : "", r.rolcreatedb ? "createdb" : ""]
          .filter(Boolean)
          .join(" · ") || undefined,
    }));
  }

  private async schemaNodes(pool: Pool, parent: string[]): Promise<TreeItemData[]> {
    const res = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
       ORDER BY schema_name`,
    );
    return res.rows.map((r) => ({
      label: r.schema_name,
      kind: "schema" as const,
      expandable: true,
      path: [...parent, r.schema_name],
    }));
  }

  private async tableNodes(pool: Pool, parent: string[]): Promise<TreeItemData[]> {
    const schema = parent[parent.length - 1];
    const res = await pool.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    return res.rows.map((r) => ({
      label: r.table_name,
      kind: r.table_type === "VIEW" ? ("view" as const) : ("table" as const),
      expandable: true,
      path: [...parent, r.table_name],
    }));
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

  async query(sql: string, database?: string): Promise<QueryResult> {
    const dbKey = database || this.entryKey();
    const pool = this.poolFor(dbKey);
    const res = await pool.query(sql);
    const result: QueryResult = {
      columns: res.fields?.map((f) => f.name) ?? [],
      rows: (res.rows as Array<Record<string, unknown>>) ?? [],
      rowCount: res.rowCount ?? res.rows?.length ?? 0,
      message: res.rows?.length ? undefined : `${res.command} ${res.rowCount ?? 0}`,
    };
    await this.attachEditable(result, sql, dbKey);
    return result;
  }

  /**
   * Hand-typed SQL (unlike a tree-driven preview) carries no known table/PK,
   * so `query()` never got to offer row editing or multi-select — even for a
   * trivial `SELECT * FROM t WHERE ...`. Best-effort detect a single-table
   * SELECT and resolve its PK the same way `previewTable` does.
   */
  private async attachEditable(result: QueryResult, sql: string, dbKey: string): Promise<void> {
    const parts = parseFromTable(sql);
    if (!parts || parts.length > 2) {
      return;
    }
    const [schema, table] = parts.length === 2 ? parts : ["public", parts[0]];
    try {
      const cols = await this.tableColumns([dbKey, schema, table]);
      const pkColumns = cols.filter((c) => c.pk).map((c) => c.name);
      if (pkColumns.length && pkColumns.every((pk) => result.columns.includes(pk))) {
        result.editable = { table: [dbKey, schema, table], pkColumns };
      }
    } catch {
      // Not a real/accessible table (view, mis-parsed syntax) — stay read-only.
    }
  }

  private buildWhere(opts: PreviewOptions): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.filter) {
      params.push(opts.filter.value);
      conds.push(`${qi(opts.filter.column)} = $${params.length}`);
    }
    for (const f of opts.columnFilters ?? []) {
      if (!f.value) {
        continue;
      }
      params.push(`%${f.value}%`);
      conds.push(`${qi(f.column)}::text ILIKE $${params.length}`);
    }
    return { where: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
  }

  async previewTable(path: string[], opts: PreviewOptions = {}): Promise<QueryResult> {
    const { pool, schema, table } = this.resolve(path);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const { where, params } = this.buildWhere(opts);
    const order = opts.sort
      ? ` ORDER BY ${qi(opts.sort.column)} ${opts.sort.dir === "desc" ? "DESC" : "ASC"}`
      : "";
    const res = await pool.query(
      `SELECT * FROM ${qi(schema)}.${qi(table)}${where}${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
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
    result.page = { offset, limit, total: await this.countRows(path, opts) };
    result.sql = displaySql(`${di(schema)}.${di(table)}`, opts, "ILIKE");
    return result;
  }

  async countRows(path: string[], opts: PreviewOptions = {}): Promise<number> {
    const { pool, schema, table } = this.resolve(path);
    const { where, params } = this.buildWhere(opts);
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${qi(schema)}.${qi(table)}${where}`,
      params,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async tableColumns(path: string[]): Promise<ColumnMeta[]> {
    const { pool, schema, table } = this.resolve(path);
    const cols = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table],
    );
    const pk = await pool.query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
      [`${qi(schema)}.${qi(table)}`],
    );
    const fk = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table],
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

  async foreignKeys(path: string[]): Promise<ForeignKey[]> {
    const { pool, schema, table, db } = this.resolve(path);
    const res = await pool.query<{
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
      [schema, table],
    );
    return res.rows.map((r) => ({
      column: r.col,
      refTable: [db, r.ref_schema, r.ref_table],
      refColumn: r.ref_col,
    }));
  }

  async schemaHints(database?: string): Promise<SchemaHints> {
    const pool = database ? this.poolFor(database) : this.entryPool();
    // The column query now carries table_name so columns can be grouped per
    // table; it used to SELECT DISTINCT column_name and throw that association
    // away, which is why suggestions could only ever be database-wide.
    // Fetch LIMIT+1 so hitting the cap is proof of truncation, not a guess.
    const [t, c] = await Promise.all([
      pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_name LIMIT ${HINT_TABLE_LIMIT + 1}`,
      ),
      pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_name, ordinal_position LIMIT ${HINT_COLUMN_LIMIT + 1}`,
      ),
    ]);
    const truncated = t.rows.length > HINT_TABLE_LIMIT || c.rows.length > HINT_COLUMN_LIMIT;
    const grouped = groupColumns(
      c.rows.slice(0, HINT_COLUMN_LIMIT).map((r) => ({
        table: r.table_name,
        column: r.column_name,
      })),
    );
    return {
      tables: t.rows.slice(0, HINT_TABLE_LIMIT).map((r) => r.table_name),
      ...grouped,
      truncated,
    };
  }

  async getDDL(path: string[]): Promise<string> {
    const { schema, table } = this.resolve(path);
    const cols = await this.tableColumns(path);
    const lines = cols.map((c) => `  ${qi(c.name)} ${c.type}${c.nullable ? "" : " NOT NULL"}`);
    const pk = cols.filter((c) => c.pk).map((c) => qi(c.name));
    if (pk.length) {
      lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
    }
    return `-- Reconstructed from information_schema (approximate)\nCREATE TABLE ${qi(schema)}.${qi(table)} (\n${lines.join(",\n")}\n);`;
  }

  async updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void> {
    const { pool, schema, table: tbl } = this.resolve(table);
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c, i) => `${qi(c)} = $${i + 2}`).join(" AND ");
    await pool.query(`UPDATE ${qi(schema)}.${qi(tbl)} SET ${qi(column)} = $1 WHERE ${where}`, [
      value,
      ...pkCols.map((c) => pkValues[c]),
    ]);
  }

  async deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void> {
    const { pool, schema, table: tbl } = this.resolve(table);
    const pkCols = Object.keys(pkValues);
    const where = pkCols.map((c, i) => `${qi(c)} = $${i + 1}`).join(" AND ");
    await pool.query(
      `DELETE FROM ${qi(schema)}.${qi(tbl)} WHERE ${where}`,
      pkCols.map((c) => pkValues[c]),
    );
  }

  async insertRow(table: string[], values: Record<string, unknown>): Promise<void> {
    const { pool, schema, table: tbl } = this.resolve(table);
    const cols = Object.keys(values);
    if (!cols.length) {
      throw new Error("No values provided for insert");
    }
    const colList = cols.map((c) => qi(c)).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(
      `INSERT INTO ${qi(schema)}.${qi(tbl)} (${colList}) VALUES (${placeholders})`,
      cols.map((c) => values[c]),
    );
  }
}

function marker(c: ColumnMeta): string {
  return `${c.type}${c.pk ? " 🔑" : ""}${c.fk ? " 🔗" : ""}${c.nullable ? "" : " ·not null"}`;
}

/**
 * Build a readable, editable SQL string mirroring a table preview. `qualified`
 * is the already-formatted table reference; `like` is the case-insensitive
 * operator for the engine (ILIKE for pg, LIKE for mysql/sqlite). `ident` quotes
 * column names for display. Values are inlined as literals for display only.
 */
export function displaySql(
  qualified: string,
  opts: PreviewOptions,
  like: string,
  ident: (n: string) => string = di,
): string {
  const conds: string[] = [];
  if (opts.filter) {
    conds.push(`${ident(opts.filter.column)} = ${sqlLiteral(opts.filter.value)}`);
  }
  for (const f of opts.columnFilters ?? []) {
    if (f.value) {
      conds.push(`${ident(f.column)} ${like} ${sqlLiteral(`%${f.value}%`)}`);
    }
  }
  let sql = `SELECT * FROM ${qualified}`;
  if (conds.length) {
    sql += ` WHERE ${conds.join(" AND ")}`;
  }
  if (opts.sort) {
    sql += ` ORDER BY ${ident(opts.sort.column)} ${opts.sort.dir === "desc" ? "DESC" : "ASC"}`;
  }
  sql += ` LIMIT ${opts.limit ?? 100}`;
  if (opts.offset) {
    sql += ` OFFSET ${opts.offset}`;
  }
  return sql;
}

/**
 * The sub-folders shown under a table: Columns / Indexes / Foreign Keys /
 * Triggers. `tablePath` is the table's own node path; each folder appends a
 * "@..." sentinel the driver dispatches on.
 */
export function tableFolders(tablePath: string[]): TreeItemData[] {
  const folder = (label: string, sentinel: string, icon: string): TreeItemData => ({
    label,
    kind: "folder",
    icon,
    expandable: true,
    path: [...tablePath, sentinel],
  });
  return [
    folder("Columns", "@columns", "symbol-field"),
    folder("Indexes", "@indexes", "key"),
    folder("Foreign Keys", "@fk", "references"),
    folder("Triggers", "@triggers", "zap"),
  ];
}
