import { formatDialect, mysql, postgresql, sqlite } from "sql-formatter";
import type { DatabaseType } from "./connections/types";

/**
 * The ONE place `sql-formatter` is imported. It backs both halves of the SQL
 * language suite: formatting (below) and the completion vocabulary
 * (`vocabularyFor`), which is why the dialect table lives here rather than in
 * either caller.
 *
 * Import named dialects + `formatDialect`, never the `format` barrel: the barrel
 * reaches every one of the 21 bundled dialects and defeats tree-shaking, costing
 * ~226 KB more in `dist/extension.js` (313 KB vs 87 KB, measured). Adding an
 * engine means one entry below — the same shape as `registry.ts`.
 */
type Dialect = typeof postgresql;

const DIALECTS: Partial<Record<DatabaseType, Dialect>> = {
  postgres: postgresql,
  mysql,
  sqlite,
};

/** Dialect vocabulary for completion. Every list is upper-case and de-duplicated. */
export interface Vocabulary {
  /** Clauses, joins, set operations and bare keywords, e.g. `ORDER BY`, `WHERE`. */
  keywords: string[];
  functions: string[];
  dataTypes: string[];
}

const EMPTY_VOCABULARY: Vocabulary = { keywords: [], functions: [], dataTypes: [] };

// Redis has no SQL dialect to borrow from. This is a deliberately small, static
// set of the commands the tree and query panel actually encourage; the driver can
// augment it from `COMMAND LIST` later without changing this shape.
const REDIS_COMMANDS = [
  "APPEND",
  "DECR",
  "DEL",
  "EXISTS",
  "EXPIRE",
  "GET",
  "GETRANGE",
  "HDEL",
  "HGET",
  "HGETALL",
  "HKEYS",
  "HLEN",
  "HSET",
  "INCR",
  "KEYS",
  "LLEN",
  "LPOP",
  "LPUSH",
  "LRANGE",
  "MGET",
  "MSET",
  "PERSIST",
  "PING",
  "RPOP",
  "RPUSH",
  "SADD",
  "SCAN",
  "SCARD",
  "SET",
  "SETEX",
  "SMEMBERS",
  "SREM",
  "TTL",
  "TYPE",
  "ZADD",
  "ZCARD",
  "ZRANGE",
  "ZREM",
  "ZSCORE",
];

const uniqueSorted = (words: string[]): string[] =>
  [...new Set(words.map((w) => w.toUpperCase()))].sort((a, b) => a.localeCompare(b));

/**
 * Keywords, functions and data types for an engine's dialect.
 *
 * Sourced from `sql-formatter`'s own tokenizer tables, so it is offline, instant,
 * needs no connection, and is correct per dialect — Postgres alone contributes
 * 653 function names against the 46 hand-maintained keywords this replaces.
 * Schema-specific names (tables, columns) are NOT here; those come from
 * `Driver.schemaHints`.
 */
export function vocabularyFor(type: DatabaseType): Vocabulary {
  if (type === "redis") {
    return { keywords: uniqueSorted(REDIS_COMMANDS), functions: [], dataTypes: [] };
  }
  const dialect = DIALECTS[type];
  if (!dialect) {
    return EMPTY_VOCABULARY;
  }
  const t = dialect.tokenizerOptions;
  return {
    keywords: uniqueSorted([
      ...t.reservedSelect,
      ...t.reservedClauses,
      ...t.reservedSetOperations,
      ...t.reservedJoins,
      ...(t.reservedKeywordPhrases ?? []),
      ...t.reservedKeywords,
    ]),
    functions: uniqueSorted(t.reservedFunctionNames),
    dataTypes: uniqueSorted([...t.reservedDataTypes, ...(t.reservedDataTypePhrases ?? [])]),
  };
}

/**
 * Redis has no SQL dialect, so formatting is meaningless there. Callers hide the
 * action rather than offering one that does nothing — the same convention the
 * optional `Driver` methods use (`if (driver.setTtl)`).
 */
export function canFormat(type: DatabaseType): boolean {
  return DIALECTS[type] !== undefined;
}

export interface FormatOptions {
  /** Spaces per indent level. Defaults to 2, matching this repo's own style. */
  tabWidth?: number;
}

/**
 * Format `sql` for the engine's dialect.
 *
 * Throws when the statement cannot be parsed. Callers MUST leave the user's
 * buffer untouched in that case — replacing a query with a half-parsed reformat
 * destroys work that cannot be recovered.
 */
export function formatSql(sql: string, type: DatabaseType, opts: FormatOptions = {}): string {
  const dialect = DIALECTS[type];
  if (!dialect) {
    throw new Error(`Formatting is not supported for ${type}.`);
  }
  // formatDialect turns whitespace-only input into "", which would silently
  // clear the editor. Give the original back instead.
  if (!sql.trim()) {
    return sql;
  }
  return formatDialect(sql, {
    dialect,
    // Only ever pass values the types allow: an unrecognised option value is not
    // rejected, it silently drops tokens from the output (a bad `keywordCase`
    // turned "select 1" into "1").
    keywordCase: "upper",
    tabWidth: opts.tabWidth ?? 2,
  });
}
