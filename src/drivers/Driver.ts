import type { ConnectionConfig } from "../connections/types";

/** Identifies a table that a result set can be edited against. */
export interface EditTarget {
  /** Driver-specific path to the table, e.g. ["public","users"]. */
  table: string[];
  /** Primary-key column names. Editing is only offered when this is non-empty. */
  pkColumns: string[];
}

/** Column metadata for rich grid headers, tree expansion, and DDL views. */
export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: boolean;
}

/** Pagination state for a table preview. */
export interface PageInfo {
  offset: number;
  limit: number;
  total: number;
}

/** A foreign-key relationship from one column to a referenced table column. */
export interface ForeignKey {
  column: string;
  refTable: string[];
  refColumn: string;
}

/** Optional equality filter applied to a table preview (used for related rows). */
export interface PreviewFilter {
  column: string;
  value: unknown;
}

/**
 * Schema names for editor autocomplete. Dialect keywords/functions are NOT here —
 * those come from `sqlDialect.ts` and need no connection.
 */
export interface SchemaHints {
  tables: string[];
  /**
   * Every column name in the database, de-duplicated. The fallback for when we
   * cannot tell which table is in scope.
   */
  columns: string[];
  /**
   * Columns grouped by table name, so `FROM saving_plans WHERE …` can suggest
   * only that table's columns. Optional: engines without tables (Redis) omit it,
   * and callers fall back to `columns`.
   */
  columnsByTable?: Record<string, string[]>;
  /**
   * A row limit was hit, so the lists above are incomplete. Surfaced to the user
   * rather than silently dropping suggestions.
   */
  truncated?: boolean;
}

/** A substring filter on one column (from the grid's per-column filter box). */
export interface ColumnFilter {
  column: string;
  value: string;
}

/** Sort applied server-side to a table preview. */
export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

/** Everything that shapes a paginated table preview. */
export interface PreviewOptions {
  offset?: number;
  limit?: number;
  /** Exact-match filter (used by "view related row"). */
  filter?: PreviewFilter;
  /** Per-column substring filters. */
  columnFilters?: ColumnFilter[];
  sort?: SortSpec;
}

/** A flat, grid-friendly result set. */
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** Free-form message for statements that return no rows (e.g. "UPDATE 3"). */
  message?: string;
  /** Present when the grid may be edited in place (table previews only). */
  editable?: EditTarget;
  /** Rich per-column metadata; present for table previews. */
  columnsMeta?: ColumnMeta[];
  /** Pagination info; present for table previews. */
  page?: PageInfo;
  /** Foreign keys of the previewed table (for "view related row"). */
  foreignKeys?: ForeignKey[];
  /** Server round-trip time in milliseconds. */
  elapsedMs?: number;
  /**
   * Bytes the engine scanned to answer this. Athena bills per terabyte
   * scanned, so on that engine this is what the statement cost — the grid
   * shows it rather than leaving the user to find out on the invoice. Absent
   * on engines where a query has no per-run price.
   */
  bytesScanned?: number;
  /** The equivalent SQL for a table preview (shown, editable, in the editor). */
  sql?: string;
  /**
   * Remaining time-to-live in milliseconds for a previewed key (Redis).
   * `-1` = the key exists but has no expiry; `-2` = the key is gone. Absent for
   * engines/results that have no notion of TTL.
   */
  ttl?: number;
}

/** One child in the connection tree (schema, table, column, key, etc.). */
export interface TreeItemData {
  label: string;
  kind:
    | "database"
    | "schema"
    | "table"
    | "view"
    | "column"
    | "key"
    | "folder"
    | "user"
    | "role"
    | "info";
  expandable: boolean;
  /** Optional codicon id override for this node's icon. */
  icon?: string;
  /** Opaque path the driver uses to resolve children of this node. */
  path: string[];
  /** Optional right-hand text (e.g. a column's type). */
  description?: string;
  /** Optional hover tooltip (e.g. an index definition). */
  tooltip?: string;
  /** Column-only hints for icon selection. */
  pk?: boolean;
  fk?: boolean;
  dataType?: string;
}

/**
 * Secrets for `connect()`, fetched by the host from SecretStorage. An object
 * rather than a bare password because Athena's `keys` mode needs two of them,
 * and a driver must never reach for SecretStorage (or any VS Code API) itself.
 */
export interface ConnectSecrets {
  password?: string;
  /** Athena `keys` mode. The access key ID is not secret and lives in config. */
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
}

/**
 * Every database engine implements this interface. The tree, query panel, and
 * commands are written against Driver only — they never import pg/mysql2/etc.
 * directly. Add a new engine by adding one file that implements Driver.
 */
export interface Driver {
  readonly config: ConnectionConfig;

  connect(secrets?: ConnectSecrets): Promise<void>;
  dispose(): Promise<void>;

  /**
   * Children of the given tree path. Empty path = top level of the connection.
   * `filter` is a user-typed narrowing term for engines that can filter
   * server-side (Redis `SCAN MATCH`); engines that don't support it ignore it.
   */
  children(path: string[], filter?: string): Promise<TreeItemData[]>;

  /**
   * Run a raw statement (SQL, or a Redis command line). `database` selects
   * which database to run against on engines that support several per server.
   * `token` opaquely identifies this run so `cancel(token)` can target it: a
   * driver instance is shared by every panel on the connection, so "the query
   * in flight" is ambiguous without one.
   */
  query(sql: string, database?: string, token?: string): Promise<QueryResult>;

  /**
   * True when `cancel()` stops the statement server-side rather than merely
   * abandoning the reply. Drives the query panel's Abort button: absent/false
   * engines either hide it (no `cancel()` at all) or label it honestly as
   * "stop waiting". Never claim `true` unless the server really stops working.
   */
  readonly canCancel?: boolean;

  /**
   * Cancel the run started with this `token`, if this engine can. A token with
   * nothing in flight is a no-op — cancelling is inherently racy and the
   * statement may simply have finished first.
   *
   * Optional, like `setTtl?`: sql.js runs synchronously on the extension host
   * thread, so there is no moment at which a cancel could even be delivered —
   * it omits this rather than implementing a no-op that lies to the caller.
   */
  cancel?(token: string): Promise<void>;

  /**
   * Preview a table's rows (paginated). Sets `editable`, `columnsMeta`, `page`,
   * and `foreignKeys`. An optional equality `filter` powers "view related row".
   */
  previewTable(path: string[], opts?: PreviewOptions): Promise<QueryResult>;

  /** Foreign-key relationships for a table. */
  foreignKeys(path: string[]): Promise<ForeignKey[]>;

  /** Table and column names for editor autocomplete. */
  schemaHints(database?: string): Promise<SchemaHints>;

  /** Total row count for a table (for pagination), honoring preview filters. */
  countRows(path: string[], opts?: PreviewOptions): Promise<number>;

  /** Column metadata for a table. */
  tableColumns(path: string[]): Promise<ColumnMeta[]>;

  /** A CREATE-style definition string for a table. */
  getDDL(path: string[]): Promise<string>;

  /** Update a single cell, identified by the row's primary-key values. */
  updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void>;

  /** Delete a single row, identified by its primary-key values. */
  deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void>;

  /** Insert a row. Only the provided columns are set; the rest use defaults. */
  insertRow(table: string[], values: Record<string, unknown>): Promise<void>;

  /**
   * Set (or clear) a key's expiry. `table` is the key's path; `ms` is the new
   * TTL in milliseconds, or `null` to remove the expiry (make the key permanent).
   * Only engines with a notion of TTL (Redis) implement this.
   */
  setTtl?(table: string[], ms: number | null): Promise<void>;
}
