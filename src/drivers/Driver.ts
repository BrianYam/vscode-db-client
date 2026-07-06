import { ConnectionConfig } from "../connections/types";

/** A flat, grid-friendly result set. */
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** Free-form message for statements that return no rows (e.g. "UPDATE 3"). */
  message?: string;
}

/** One child in the connection tree (schema, table, key, etc.). */
export interface TreeItemData {
  label: string;
  /** Distinguishes context-menu behaviour: database | schema | table | key... */
  kind: "database" | "schema" | "table" | "view" | "key" | "info";
  /** Whether this node can be expanded further. */
  expandable: boolean;
  /** Opaque path the driver uses to resolve children of this node. */
  path: string[];
}

/**
 * Every database engine implements this interface. The tree, query panel, and
 * commands are written against Driver only — they never import pg/mysql2/etc.
 * directly. Add a new engine by adding one file that implements Driver.
 */
export interface Driver {
  readonly config: ConnectionConfig;

  /** Open the underlying connection/pool. Throws on failure. */
  connect(password?: string): Promise<void>;

  /** Close cleanly. Safe to call multiple times. */
  dispose(): Promise<void>;

  /** Children of the given tree path. Empty path = top level of the connection. */
  children(path: string[]): Promise<TreeItemData[]>;

  /** Run a raw statement (SQL, or a Redis command line). */
  query(sql: string): Promise<QueryResult>;

  /** Convenience preview used by the "Select Top 200" command. */
  previewTable(path: string[]): Promise<QueryResult>;
}
