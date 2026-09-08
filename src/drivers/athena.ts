import {
  AthenaClient,
  type Datum,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  GetTableMetadataCommand,
  GetWorkGroupCommand,
  ListDatabasesCommand,
  ListDataCatalogsCommand,
  ListTableMetadataCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
  type TableMetadata,
} from "@aws-sdk/client-athena";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { ConnectionConfig } from "../connections/types";
import type {
  ColumnMeta,
  ConnectSecrets,
  Driver,
  ForeignKey,
  PreviewOptions,
  QueryResult,
  SchemaHints,
  TreeItemData,
} from "./Driver";

/**
 * Athena's own cap: GetQueryResults returns at most 1000 rows per page — and it
 * counts the repeated header row (see stripHeaderRow) against that cap, so a
 * single call yields at most 999 DATA rows. Asking for exactly 1000 and
 * returning what came back is how a `LIMIT 1000` arrives one row short.
 */
const RESULTS_PAGE_MAX = 1000;
/**
 * Ceiling on rows a Run collects. NOT Athena's limit and not a billing one —
 * walking a completed execution's pages costs API calls, never another scan. It
 * exists because the results grid renders every row it is handed rather than
 * virtualising them. A query returning fewer is unaffected.
 */
const MAX_RUN_ROWS = 10000;
/** A preview must never become an unbounded scan of a terabyte-scale table. */
const PREVIEW_MAX = 500;
/** Poll backoff for a running execution: start responsive, settle down. */
const POLL_MIN_MS = 200;
const POLL_MAX_MS = 1000;
/** Bound schemaHints so a wide lake cannot hang the panel. */
const HINT_TABLE_LIMIT = 300;

/** Error names the SDK uses for "your credentials expired". */
const EXPIRY_ERRORS = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "CredentialsProviderError",
]);

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * AWS Athena.
 *
 * Athena is not a connection — it is signed HTTPS — so `connect()` resolves
 * credentials and makes one cheap validating call, and `dispose()` drops the
 * client. Three things make this driver unlike the others, and all three are
 * cost, not taste (docs/BLUEPRINT_ATHENA.md):
 *
 * - **Metadata never runs a query.** The tree, `schemaHints`, `tableColumns`
 *   and `getDDL` come from Athena's metadata APIs, which scan no S3.
 *   `information_schema` would be billed DML, so it is never used.
 * - **`countRows` refuses.** Counting means a full scan; on a 2 TB table one
 *   pagination click would bill roughly $10. An honest unknown is better.
 * - **Nothing is editable.** Glue/Hive has no primary keys, so there is no way
 *   to address a row for UPDATE/DELETE.
 */
export class AthenaDriver implements Driver {
  private client?: AthenaClient;
  /** Effective results prefix — read back, because a workgroup may override. */
  private outputLocation?: string;
  /**
   * Query-panel token → Athena execution id. The panel's `cancel(token)` has no
   * idea what an execution id is, and a driver instance is shared by every
   * panel on the connection, so the mapping has to live here.
   */
  private readonly running = new Map<string, string>();

  constructor(readonly config: ConnectionConfig) {}

  /** Athena really does stop the statement server-side, not just the wait. */
  readonly canCancel = true;

  private get catalog(): string {
    return this.config.athenaCatalog || "AwsDataCatalog";
  }

  private get workgroup(): string {
    return this.config.athenaWorkgroup || "primary";
  }

  async connect(secrets?: ConnectSecrets): Promise<void> {
    const region = this.config.awsRegion?.trim();
    if (!region) {
      throw new Error("AWS region is required for Athena.");
    }

    this.client = new AthenaClient({
      region,
      endpoint: this.config.awsEndpoint?.trim() || undefined,
      useFipsEndpoint: this.config.awsUseFips || undefined,
      credentials: this.credentialProvider(secrets),
    });

    // One cheap, free call proves the credentials resolve AND that the
    // workgroup exists — and it hands back the effective output location, the
    // only trustworthy source when the workgroup enforces its own (a
    // client-supplied location is silently OVERRIDDEN there, not rejected).
    const wg = await this.send<{
      WorkGroup?: {
        Configuration?: {
          EnforceWorkGroupConfiguration?: boolean;
          ResultConfiguration?: { OutputLocation?: string };
        };
      };
    }>(new GetWorkGroupCommand({ WorkGroup: this.workgroup }));
    const cfg = wg.WorkGroup?.Configuration;
    const enforced = cfg?.EnforceWorkGroupConfiguration === true;
    const wgLocation = cfg?.ResultConfiguration?.OutputLocation;
    this.outputLocation =
      enforced || !this.config.athenaOutputLocation?.trim()
        ? wgLocation
        : this.config.athenaOutputLocation.trim();
  }

  /**
   * A credential PROVIDER, not resolved credentials — the SDK then refreshes
   * SSO and assume-role sessions itself instead of dying an hour in.
   *
   * `profile` is the default because one profile name resolves SSO,
   * `credential_process`, `source_profile` chains and web identity through the
   * SDK's own chain. A profile that needs an interactive MFA code is not
   * handled: the chain rejects it, and the error says so rather than hanging.
   */
  private credentialProvider(secrets?: ConnectSecrets) {
    const mode = this.config.awsAuthMode ?? "profile";
    if (mode === "keys") {
      const accessKeyId = this.config.awsAccessKeyId?.trim();
      const secretAccessKey = secrets?.awsSecretAccessKey;
      if (!accessKeyId || !secretAccessKey) {
        throw new Error("Access key ID and secret access key are required.");
      }
      return { accessKeyId, secretAccessKey, sessionToken: secrets?.awsSessionToken };
    }
    return fromNodeProviderChain({
      profile: mode === "profile" ? this.config.awsProfile?.trim() || undefined : undefined,
    });
  }

  /** One transparent retry on an expired session, then surface it. */
  private async send<T>(command: unknown): Promise<T> {
    if (!this.client) {
      throw new Error("Not connected.");
    }
    try {
      return (await this.client.send(command as never)) as T;
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (!EXPIRY_ERRORS.has(name)) {
        throw err;
      }
      // The provider refreshes itself; a second attempt is usually enough.
      return (await this.client.send(command as never)) as T;
    }
  }

  async dispose(): Promise<void> {
    // Deliberately does NOT cancel what is running. AWS bills a cancelled query
    // in full for what it scanned, and Athena has already written the result to
    // S3 — cancelling on close would spend the user's money and then throw away
    // the thing they paid for.
    this.running.clear();
    this.client?.destroy();
    this.client = undefined;
  }

  async cancel(token: string): Promise<void> {
    const id = this.running.get(token);
    if (!id) {
      return; // Already finished, or never started. Cancelling is racy.
    }
    await this.send(new StopQueryExecutionCommand({ QueryExecutionId: id }));
    this.running.delete(token);
  }

  // ---- tree ---------------------------------------------------------------

  async children(path: string[], filter?: string): Promise<TreeItemData[]> {
    // catalog → database → table → column. The catalog level is one deeper than
    // any other engine here; Glue puts it above the database.
    if (path.length === 0) {
      return this.catalogNodes();
    }
    if (path.length === 1) {
      return this.databaseNodes(path[0], filter);
    }
    if (path.length === 2) {
      return this.tableNodes(path[0], path[1], filter);
    }
    if (path.length === 3) {
      return this.columnNodes(path[0], path[1], path[2]);
    }
    return [];
  }

  private async catalogNodes(): Promise<TreeItemData[]> {
    const res = await this.send<{ DataCatalogsSummary?: Array<{ CatalogName?: string }> }>(
      new ListDataCatalogsCommand({}),
    );
    const names = (res.DataCatalogsSummary ?? [])
      .map((c) => c.CatalogName)
      .filter((n): n is string => !!n);
    // Fall back to the configured catalog if the account denies listing them.
    const list = names.length ? names : [this.catalog];
    return list.map((name) => ({
      // A catalog is a container, not something you query — "New Query" belongs
      // on the DATABASE below it, so this is a folder, not a database.
      label: name,
      kind: "folder" as const,
      expandable: true,
      icon: "library",
      path: [name],
    }));
  }

  private async databaseNodes(catalog: string, filter?: string): Promise<TreeItemData[]> {
    const res = await this.send<{ DatabaseList?: Array<{ Name?: string }> }>(
      new ListDatabasesCommand({ CatalogName: catalog }),
    );
    const f = filter?.toLowerCase();
    return (res.DatabaseList ?? [])
      .map((d) => d.Name)
      .filter((n): n is string => !!n && (!f || n.toLowerCase().includes(f)))
      .map((name) => ({
        label: name,
        kind: "database" as const,
        expandable: true,
        path: [catalog, name],
      }));
  }

  private async tableNodes(
    catalog: string,
    database: string,
    filter?: string,
  ): Promise<TreeItemData[]> {
    const { tables, truncated } = await this.listTables(catalog, database, filter);
    const nodes: TreeItemData[] = tables.map((t) => ({
      label: t.Name ?? "",
      // Athena documents TableType as only ever EXTERNAL_TABLE, so it cannot
      // tell us view-vs-table. `Parameters` is where the truth lives.
      kind: isView(t) ? ("view" as const) : ("table" as const),
      expandable: true,
      path: [catalog, database, t.Name ?? ""],
      description: t.Parameters?.table_type,
    }));
    if (truncated) {
      // Same honesty as the Redis "Showing first 500 keys" node.
      nodes.push({
        label: `Showing first ${tables.length} tables — type to filter`,
        kind: "info",
        expandable: false,
        path: [catalog, database, "__truncated__"],
      });
    }
    return nodes;
  }

  private async listTables(
    catalog: string,
    database: string,
    filter?: string,
    limit = HINT_TABLE_LIMIT,
  ): Promise<{ tables: TableMetadata[]; truncated: boolean }> {
    const tables: TableMetadata[] = [];
    let token: string | undefined;
    do {
      const res = await this.send<{ TableMetadataList?: TableMetadata[]; NextToken?: string }>(
        new ListTableMetadataCommand({
          CatalogName: catalog,
          DatabaseName: database,
          Expression: filter || undefined,
          NextToken: token,
        }),
      );
      tables.push(...(res.TableMetadataList ?? []));
      token = res.NextToken;
    } while (token && tables.length < limit);
    return { tables: tables.slice(0, limit), truncated: !!token || tables.length > limit };
  }

  private async columnNodes(
    catalog: string,
    database: string,
    table: string,
  ): Promise<TreeItemData[]> {
    const meta = await this.tableMetadata(catalog, database, table);
    const partitions = new Set((meta.PartitionKeys ?? []).map((c) => c.Name));
    const all = [...(meta.Columns ?? []), ...(meta.PartitionKeys ?? [])];
    return all.map((c) => ({
      label: c.Name ?? "",
      kind: "column" as const,
      expandable: false,
      path: [catalog, database, table, c.Name ?? ""],
      // Partition columns are the cost-relevant ones — filtering on them is the
      // difference between scanning a day and scanning the lake.
      description: partitions.has(c.Name) ? `${c.Type ?? ""} · partition key` : (c.Type ?? ""),
      icon: partitions.has(c.Name) ? "key" : undefined,
      dataType: c.Type,
    }));
  }

  private async tableMetadata(
    catalog: string,
    database: string,
    table: string,
  ): Promise<TableMetadata> {
    const res = await this.send<{ TableMetadata?: TableMetadata }>(
      new GetTableMetadataCommand({
        CatalogName: catalog,
        DatabaseName: database,
        TableName: table,
      }),
    );
    if (!res.TableMetadata) {
      throw new Error(`Table not found: ${database}.${table}`);
    }
    return res.TableMetadata;
  }

  // ---- queries ------------------------------------------------------------

  async query(sql: string, database?: string, token?: string): Promise<QueryResult> {
    const started = Date.now();
    const executionId = await this.startExecution(sql, database);
    if (token) {
      this.running.set(token, executionId);
    }
    try {
      const exec = await this.pollUntilDone(executionId);
      const collected = await this.collectRows(executionId, sql, MAX_RUN_ROWS);
      const result: QueryResult = {
        columns: collected.columns,
        rows: collected.rows,
        rowCount: collected.rowCount,
        message: collected.message,
        elapsedMs: Date.now() - started,
      };
      if (collected.more) {
        // Say it plainly, and say what it did NOT cost — a user who reads
        // "truncated" on a billed engine will otherwise assume that reading the
        // rest means paying for another scan.
        result.message =
          `Showing the first ${collected.rowCount.toLocaleString()} rows — the query ` +
          `returned more. This is the grid's limit, not Athena's, and reading these ` +
          `rows scanned no additional data. Narrow the statement to see the rest.`;
      }
      const scanned = exec.Statistics?.DataScannedInBytes;
      if (scanned != null) {
        result.bytesScanned = scanned;
      }
      return result;
    } finally {
      if (token) {
        this.running.delete(token);
      }
    }
  }

  private async startExecution(sql: string, database?: string): Promise<string> {
    const res = await this.send<{ QueryExecutionId?: string }>(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: this.workgroup,
        QueryExecutionContext: {
          Catalog: this.catalog,
          Database: database || this.config.database || undefined,
        },
        // Omitted entirely when the workgroup enforces its own — passing one
        // there is silently ignored, so sending it would only mislead us.
        ResultConfiguration: this.outputLocation
          ? { OutputLocation: this.outputLocation }
          : undefined,
      }),
    );
    const id = res.QueryExecutionId;
    if (!id) {
      throw new Error("Athena did not return a query execution id.");
    }
    return id;
  }

  private async pollUntilDone(id: string) {
    let wait = POLL_MIN_MS;
    for (;;) {
      const res = await this.send<{
        QueryExecution?: {
          Status?: { State?: string; StateChangeReason?: string };
          Statistics?: { DataScannedInBytes?: number };
        };
      }>(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      const exec = res.QueryExecution;
      const state = exec?.Status?.State ?? "";
      if (TERMINAL.has(state)) {
        if (state !== "SUCCEEDED") {
          const why = exec?.Status?.StateChangeReason ?? state;
          // A cancelled query is STILL BILLED for everything it scanned before
          // stopping. Warning about a charge and then hiding its size would be
          // worse than not warning at all, so the figure travels with the
          // failure rather than being dropped with the result.
          const scanned = exec?.Statistics?.DataScannedInBytes;
          const suffix =
            scanned == null
              ? ""
              : state === "CANCELLED"
                ? ` — you are still billed for the ${formatBytes(scanned)} scanned before it stopped.`
                : ` — ${formatBytes(scanned)} scanned.`;
          throw new Error(`Query ${state.toLowerCase()}: ${why}${suffix}`);
        }
        return exec ?? {};
      }
      await sleep(wait);
      wait = Math.min(wait * 2, POLL_MAX_MS);
    }
  }

  private async fetchResults(
    id: string,
    sql: string,
    opts: { token?: string; max?: number } = {},
  ): Promise<QueryResult & { nextToken?: string }> {
    const res = await this.send<{
      NextToken?: string;
      ResultSet?: {
        Rows?: Array<{ Data?: Datum[] }>;
        ResultSetMetadata?: { ColumnInfo?: Array<{ Name?: string; Type?: string }> };
      };
    }>(
      new GetQueryResultsCommand({
        QueryExecutionId: id,
        MaxResults: pageSize(opts.max, opts.token !== undefined),
        NextToken: opts.token,
      }),
    );

    const info = res.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [];
    const columns = info.map((c) => c.Name ?? "");
    const raw = res.ResultSet?.Rows ?? [];
    // The header row is only ever repeated on the FIRST page of an execution.
    const body = opts.token ? raw : stripHeaderRow(raw, columns);

    const rows = body.map((r) => {
      const out: Record<string, unknown> = {};
      columns.forEach((name, i) => {
        out[name] = r.Data?.[i]?.VarCharValue ?? null;
      });
      return out;
    });

    if (!columns.length) {
      return { columns: [], rows: [], rowCount: 0, message: describeDml(sql) };
    }
    return { columns, rows, rowCount: rows.length, nextToken: res.NextToken };
  }

  /**
   * Collect up to `max` rows from a COMPLETED execution by walking its pages.
   *
   * One GetQueryResults call can never return more than 999 data rows, so
   * reading a single page and returning it would silently cap every result — a
   * `LIMIT 10000` coming back with 999 rows and no sign that 9001 were dropped.
   * Truncating is fine; hiding it is not.
   *
   * We read one row PAST the cap so `more` is a fact rather than a guess: a
   * NextToken can be present on a page that turns out to be the last one, so
   * inferring truncation from the token alone would sometimes cry wolf.
   */
  private async collectRows(
    id: string,
    sql: string,
    max: number,
  ): Promise<QueryResult & { more: boolean }> {
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];
    let message: string | undefined;
    let token: string | undefined;
    let first = true;

    while (rows.length <= max) {
      const page = await this.fetchResults(id, sql, {
        token,
        max: Math.min(max + 1 - rows.length, RESULTS_PAGE_MAX),
      });
      if (first) {
        columns = page.columns;
        message = page.message;
        first = false;
      }
      rows.push(...page.rows);
      token = page.nextToken;
      // No token, or a page that added nothing: that was the end of the result.
      if (!token || !page.rows.length) {
        return { columns, rows, rowCount: rows.length, message, more: false };
      }
    }

    rows.length = max;
    return { columns, rows, rowCount: max, message, more: true };
  }

  // ---- previews and metadata ----------------------------------------------

  /**
   * ONE bounded statement, read in full, and it is BOTH what runs and what the
   * editor displays. Never show a statement we are not running.
   *
   * There is deliberately no server-side paging: on a billed engine a "next
   * page" click that silently starts a second scan of the same table is a way
   * to spend money by accident. Everything the preview will ever show is
   * fetched by this one execution, so `page.total` equals the rows in hand and
   * the pager stops rather than re-querying.
   */
  async previewTable(path: string[], opts?: PreviewOptions): Promise<QueryResult> {
    const [catalog, database, table] = path;
    const limit = Math.min(opts?.limit ?? PREVIEW_MAX, PREVIEW_MAX);
    const meta = await this.tableMetadata(catalog, database, table);

    const where = buildWhere(opts);
    const order = opts?.sort
      ? ` ORDER BY ${q(opts.sort.column)} ${opts.sort.dir.toUpperCase()}`
      : "";
    const sql = `SELECT * FROM ${q(database)}.${q(table)}${where}${order} LIMIT ${limit}`;

    const run = await this.query(sql, database);
    const result: QueryResult = {
      ...run,
      sql,
      columnsMeta: toColumnMeta(meta),
      // No editable target: Glue has no primary keys to address a row by.
      page: { offset: 0, limit, total: run.rows.length },
      foreignKeys: [],
    };
    if (run.rows.length >= limit) {
      result.message =
        `Previews read at most ${PREVIEW_MAX} rows. Edit the statement above and Run to go further — ` +
        `that is a new query, and Athena bills it.`;
    }
    return result;
  }

  /** Athena has no foreign keys — Glue/Hive has no such concept. */
  async foreignKeys(): Promise<ForeignKey[]> {
    return [];
  }

  async tableColumns(path: string[]): Promise<ColumnMeta[]> {
    return toColumnMeta(await this.tableMetadata(path[0], path[1], path[2]));
  }

  /**
   * Bounded on purpose: this runs on every panel open and every completion.
   * Enumerating a lake unbounded would mean thousands of paged calls — minutes
   * of latency and a real Glue request bill.
   */
  async schemaHints(database?: string): Promise<SchemaHints> {
    const db = database || this.config.database;
    if (!db) {
      return { tables: [], columns: [] };
    }
    const { tables, truncated } = await this.listTables(this.catalog, db);
    const columnsByTable: Record<string, string[]> = {};
    const typesByTable: Record<string, Record<string, string>> = {};
    const columns = new Set<string>();
    for (const t of tables) {
      // Free: ListTableMetadata already returned columns AND types, so carrying
      // the types costs no extra call. They matter more here than on a real
      // database — a lake table is often entirely string-typed, and a model
      // given only names will write `month IN (7, 8)` against a column holding
      // "july": valid Trino, zero rows, and no error saying why.
      const partitions = new Set((t.PartitionKeys ?? []).map((c) => c.Name));
      const all = [...(t.Columns ?? []), ...(t.PartitionKeys ?? [])];
      const name = t.Name ?? "";
      const names = all.map((c) => c.Name).filter((n): n is string => !!n);
      columnsByTable[name] = names;
      typesByTable[name] = {};
      for (const c of all) {
        if (c.Name) {
          // Partition keys are flagged, not just typed: they are the columns
          // that decide how much of the lake a statement scans, so a model
          // choosing what to filter on needs to know which ones they are.
          typesByTable[name][c.Name] = partitions.has(c.Name)
            ? `${c.Type ?? "string"} partition key`
            : (c.Type ?? "string");
        }
      }
      for (const n of names) {
        columns.add(n);
      }
    }
    return {
      tables: tables.map((t) => t.Name ?? ""),
      columns: [...columns],
      columnsByTable,
      typesByTable,
      truncated,
    };
  }

  async getDDL(path: string[]): Promise<string> {
    const meta = await this.tableMetadata(path[0], path[1], path[2]);
    const cols = (meta.Columns ?? []).map((c) => `  ${c.Name} ${c.Type}`);
    const parts = (meta.PartitionKeys ?? []).map((c) => `  ${c.Name} ${c.Type}`);
    const lines = [`CREATE EXTERNAL TABLE ${path[1]}.${path[2]} (`, cols.join(",\n"), ")"];
    if (parts.length) {
      lines.push(`PARTITIONED BY (\n${parts.join(",\n")}\n)`);
    }
    const location = meta.Parameters?.location;
    if (location) {
      lines.push(`LOCATION '${location}'`);
    }
    return lines.join("\n");
  }

  /**
   * Deliberately NOT a COUNT(*). Counting means a full table scan; on a 2 TB
   * table that is roughly $10 for a number nobody asked for. `previewTable`
   * reports the rows it actually holds instead.
   */
  async countRows(): Promise<number> {
    return 0;
  }

  // ---- refusals -----------------------------------------------------------

  async updateCell(): Promise<void> {
    throw new Error(NOT_EDITABLE);
  }

  async deleteRow(): Promise<void> {
    throw new Error(NOT_EDITABLE);
  }

  async insertRow(): Promise<void> {
    throw new Error(NOT_EDITABLE);
  }
}

const NOT_EDITABLE =
  "Athena tables have no primary key, so rows cannot be addressed for editing. " +
  "Editing is only possible on Iceberg tables, which this version does not support.";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function q(ident: string): string {
  // Trino quotes identifiers with double quotes; embedded quotes double up.
  return `"${ident.replace(/"/g, '""')}"`;
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function isView(t: TableMetadata): boolean {
  return (t.Parameters?.table_type ?? "").toUpperCase().includes("VIRTUAL_VIEW");
}

function toColumnMeta(meta: TableMetadata): ColumnMeta[] {
  const partitions = new Set((meta.PartitionKeys ?? []).map((c) => c.Name));
  return [...(meta.Columns ?? []), ...(meta.PartitionKeys ?? [])].map((c) => ({
    name: c.Name ?? "",
    type: c.Type ?? "",
    nullable: true,
    // Partition columns are not primary keys, but they are the columns that
    // matter most here, so the grid marks them with the same affordance.
    pk: partitions.has(c.Name),
    fk: false,
  }));
}

function buildWhere(opts?: PreviewOptions): string {
  const clauses: string[] = [];
  if (opts?.filter) {
    clauses.push(`${q(opts.filter.column)} = ${lit(String(opts.filter.value))}`);
  }
  for (const f of opts?.columnFilters ?? []) {
    if (f.value) {
      clauses.push(`CAST(${q(f.column)} AS VARCHAR) LIKE ${lit(`%${f.value}%`)}`);
    }
  }
  return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
}

/**
 * How many rows to ask GetQueryResults for.
 *
 * Athena counts the repeated header row against MaxResults on page 1 only, so
 * asking for N there returns N-1 rows of data. We ask for one more to
 * compensate — except at the 1000 ceiling, where there is no room and the
 * caller has to walk into the next page instead.
 */
export function pageSize(want: number | undefined, isContinuation: boolean): number {
  const n = Math.min(want ?? RESULTS_PAGE_MAX, RESULTS_PAGE_MAX);
  return isContinuation ? n : Math.min(n + 1, RESULTS_PAGE_MAX);
}

/**
 * `GetQueryResults` repeats the column names as the first row of page 1 for
 * SELECT statements. This is real, widely observed, and undocumented by AWS —
 * so we DETECT it rather than assume it, by comparing row 1 to the column
 * names. Assuming would silently eat a genuine data row that happened to match.
 */
export function stripHeaderRow<T extends { Data?: Array<{ VarCharValue?: string }> }>(
  rows: T[],
  columns: string[],
): T[] {
  const first = rows[0];
  if (!first || !columns.length) {
    return rows;
  }
  const values = (first.Data ?? []).map((d) => d.VarCharValue);
  if (values.length !== columns.length) {
    return rows;
  }
  const isHeader = values.every((v, i) => v === columns[i]);
  return isHeader ? rows.slice(1) : rows;
}

/** DDL and DML return no rows; say what happened rather than showing nothing. */
export function describeDml(sql: string): string {
  const verb = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? "Statement";
  return `${verb} completed.`;
}

/**
 * Bytes scanned, for the results footer. Athena prices per terabyte, so the
 * unit the user is billed in is the one worth showing — deliberately without a
 * dollar estimate, which would need a per-region price table that goes stale
 * silently and is wrong for reserved capacity.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  // Bytes are whole; everything above gets one decimal so 1.4 GB ≠ 1 GB.
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}
