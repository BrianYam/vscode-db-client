import { ConnectionConfig } from "../connections/types";

/** Identifies a table that a result set can be edited against. */
export interface EditTarget {
  /** Driver-specific path to the table, e.g. ["public","users"]. */
  table: string[];
  /** Primary-key column names. Editing is only offered when this is non-empty. */
  pkColumns: string[];
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
}

/** Column metadata for tree expansion and DDL/structure views. */
export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

/** One child in the connection tree (schema, table, column, key, etc.). */
export interface TreeItemData {
  label: string;
  kind: "database" | "schema" | "table" | "view" | "column" | "key" | "info";
  expandable: boolean;
  /** Opaque path the driver uses to resolve children of this node. */
  path: string[];
  /** Optional right-hand text (e.g. a column's type). */
  description?: string;
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

  /** Run a raw statement (SQL, or a Redis command line). */
  query(sql: string): Promise<QueryResult>;

  /** Preview a table's rows; sets `editable` when a primary key exists. */
  previewTable(path: string[]): Promise<QueryResult>;

  /** Column metadata for a table (used by tree expansion and DDL view). */
  tableColumns(path: string[]): Promise<ColumnMeta[]>;

  /** A CREATE-style definition string for a table. */
  getDDL(path: string[]): Promise<string>;

  /**
   * Update a single cell, identified by the row's primary-key values.
   * Implementations MUST parameterize values to avoid injection.
   */
  updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown
  ): Promise<void>;
}
