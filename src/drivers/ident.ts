/**
 * SQL identifier quoting. Values are always parameterized ($1 / ?), but
 * identifiers (schema/table/column names) are interpolated — these helpers
 * quote them safely by doubling the embedded quote character, closing the
 * identifier-injection class (SECURITY_THREAT_MODEL T1).
 */

/** Double-quote style: PostgreSQL, SQLite. */
export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Backtick style: MySQL / MariaDB. */
export function quoteBacktick(name: string): string {
  return `\`${String(name).replace(/`/g, "``")}\``;
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
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Matches one identifier segment in any of the three quoting styles, or bare.
const IDENT_SRC = '"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*';
const CHAIN_RE = new RegExp(String.raw`^\s*((?:${IDENT_SRC})(?:\s*\.\s*(?:${IDENT_SRC})){0,2})`);
const IDENT_PART_RE = new RegExp(IDENT_SRC, "g");

function unquote(part: string): string {
  if (part.startsWith('"') && part.endsWith('"')) {
    return part.slice(1, -1).replaceAll('""', '"');
  }
  if (part.startsWith("`") && part.endsWith("`")) {
    return part.slice(1, -1).replaceAll("``", "`");
  }
  return part;
}

/**
 * Best-effort extraction of the table a plain, single-table
 * `SELECT ... FROM <table> [WHERE ...] [...]` statement targets — used to
 * offer row editing/multi-select on hand-typed queries (not just tree-driven
 * table previews). Returns unquoted identifier parts (e.g. ["public","users"])
 * or undefined when the statement isn't one we can safely resolve (joins,
 * unions, subqueries/functions in FROM, multiple statements, etc.) — callers
 * should fall back to a read-only grid rather than guess.
 */
export function parseFromTable(sql: string): string[] | undefined {
  let s = sql.trim();
  if (s.endsWith(";")) {
    s = s.slice(0, -1).trimEnd();
  }
  if (s.includes(";") || !/^select\b/i.test(s) || /\b(join|union)\b/i.test(s)) {
    return undefined;
  }
  const fromMatch = /\bfrom\b/i.exec(s);
  if (!fromMatch) {
    return undefined;
  }
  const after = s.slice(fromMatch.index + fromMatch[0].length);
  const m = CHAIN_RE.exec(after);
  if (!m) {
    return undefined;
  }
  const rest = after.slice(m[0].length).trimStart();
  if (rest.startsWith(",") || rest.startsWith("(")) {
    return undefined; // multiple tables, or a function/subquery as the source
  }
  const parts = (m[1].match(IDENT_PART_RE) ?? []).map(unquote);
  return parts.length ? parts : undefined;
}
