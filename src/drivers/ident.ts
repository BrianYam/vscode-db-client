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
