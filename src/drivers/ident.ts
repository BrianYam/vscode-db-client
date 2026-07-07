/**
 * SQL identifier quoting. Values are always parameterized ($1 / ?), but
 * identifiers (schema/table/column names) are interpolated — these helpers
 * quote them safely by doubling the embedded quote character, closing the
 * identifier-injection class (SECURITY_THREAT_MODEL T1).
 */

/** Double-quote style: PostgreSQL, SQLite. */
export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Backtick style: MySQL / MariaDB. */
export function quoteBacktick(name: string): string {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

const SIMPLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Readable identifier for DISPLAY SQL — unquoted when simple (pg/sqlite). */
export function displayIdent(name: string): string {
  return SIMPLE.test(name) ? name : quoteIdent(name);
}

/** Readable identifier for DISPLAY SQL — unquoted when simple (mysql). */
export function displayBacktick(name: string): string {
  return SIMPLE.test(name) ? name : quoteBacktick(name);
}

/** A SQL literal for DISPLAY SQL (values are still parameterized on execution). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) {
    return "NULL";
  }
  if (typeof v === "number") {
    return String(v);
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}
