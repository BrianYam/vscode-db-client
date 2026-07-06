import { ConnectionConfig } from "../connections/types";

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
  /** Column-only hints for icon selection. */
  pk?: boolean;
  fk?: boolean;
  dataType?: string;
}

/**
 * Every database engine implements this interface. The tree, query panel, and
 * commands are written against Driver only — they never import pg/mysql2/etc.
 * directly. Add a new engine by adding one file that implements Driver.
 */
export interface Driver {
  readonly config: ConnectionConfig;

  connect(password?: string): Promise<void>;
  dispose(): Promise<void>;

  /** Children of the given tree path. Empty path = top level of the connection. */
  children(path: string[]): Promise<TreeItemData[]>;

  /** Run a raw statement (SQL, or a Redis command line). `database` selects
   *  which database to run against on engines that support several per server. */
  query(sql: string, database?: string): Promise<QueryResult>;

  /**
   * Preview a table's rows (paginated). Sets `editable`, `columnsMeta`, `page`,
   * and `foreignKeys`. An optional equality `filter` powers "view related row".
   */
  previewTable(
    path: string[],
    offset?: number,
    limit?: number,
    filter?: PreviewFilter
  ): Promise<QueryResult>;

  /** Foreign-key relationships for a table. */
  foreignKeys(path: string[]): Promise<ForeignKey[]>;

  /** Total row count for a table (for pagination). */
  countRows(path: string[]): Promise<number>;

  /** Column metadata for a table. */
  tableColumns(path: string[]): Promise<ColumnMeta[]>;

  /** A CREATE-style definition string for a table. */
  getDDL(path: string[]): Promise<string>;

  /** Update a single cell, identified by the row's primary-key values. */
  updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void>;

  /** Delete a single row, identified by its primary-key values. */
  deleteRow(table: string[], pkValues: Record<string, unknown>): Promise<void>;

  /** Insert a row. Only the provided columns are set; the rest use defaults. */
  insertRow(table: string[], values: Record<string, unknown>): Promise<void>;
}
