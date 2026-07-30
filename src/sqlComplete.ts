/**
 * Completion reasoning for the SQL editor — deliberately a backward token scan,
 * not a grammar. Everything here is pure so it can be unit-tested without a
 * VS Code host (the DOM widget in queryPanel.ts cannot be).
 *
 * The trade-off is explicit: this understands `FROM t alias`, qualified
 * `alias.column`, and clause position. It does NOT resolve CTEs or subquery
 * scope. A real parser would, at the cost of a dependency; revisit only if the
 * heuristic proves insufficient in practice.
 */

/** What kind of name belongs at the caret. */
export type CompletionKind = "table" | "column" | "any";

export interface CompletionContext {
  kind: CompletionKind;
  /** Set when the caret follows `alias.` / `table.` — restricts to that table. */
  qualifier?: string;
  /** Tables named in the statement, already resolved through aliases. */
  tables: string[];
  /**
   * The caret sits where an expression must *begin* (straight after `ORDER BY`,
   * `GROUP BY`, `PARTITION BY`). Only a column or a function can go here, so the
   * keyword vocabulary is withheld — offering `DESC` in this position is how
   * `ORDER BY DESC` gets built, which is a syntax error.
   */
  expressionStart?: boolean;
}

export interface Candidate {
  label: string;
  /** Drives the icon and the ranking tier. */
  kind: "column" | "table" | "keyword" | "function" | "dataType";
  /** Shown to the right, e.g. the owning table for a column. */
  detail?: string;
}

/** An identifier character. Covers `$` and `#`, which several engines allow. */
const IDENT = /[A-Za-z0-9_$#]/;

/**
 * Strip comments and string literals, replacing each with equivalent-length
 * blanks so offsets are preserved. Without this, a keyword inside a comment or
 * a quoted string steers the context detection.
 */
export function stripNoise(text: string): string {
  const out = text.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") {
        out[k] = " ";
      }
    }
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "--") {
      const end = text.indexOf("\n", i);
      const to = end === -1 ? text.length : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const to = end === -1 ? text.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        j++;
      }
      // Quoted identifiers ("my col", `my col`) are names, not noise — keep the
      // inner text so they can still be completed against; only kill quotes.
      if (ch === "'") {
        blank(i, Math.min(j + 1, text.length));
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

export interface Token {
  word: string;
  start: number;
  end: number;
}

/** The identifier being typed at `caret`, or an empty word at the caret. */
export function currentToken(text: string, caret: number): Token {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = pos;
  while (start > 0 && IDENT.test(text[start - 1])) {
    start--;
  }
  let end = pos;
  while (end < text.length && IDENT.test(text[end])) {
    end++;
  }
  return { word: text.slice(start, pos), start, end };
}

/**
 * Only the current statement matters. Splitting on `;` keeps a previous
 * statement's tables from leaking into this one's suggestions.
 */
export function currentStatement(textBeforeCaret: string): string {
  const semi = textBeforeCaret.lastIndexOf(";");
  return semi === -1 ? textBeforeCaret : textBeforeCaret.slice(semi + 1);
}

// Clauses that introduce a table name, and so make the next identifier a table.
const TABLE_CLAUSES = /\b(from|join|into|update|table)\s*$/i;

// Positions where an expression must *begin*. Only a column or function is valid
// here — notably NOT `ASC`/`DESC`, which need something to sort first.
const EXPRESSION_START = /\b(?:order|group|partition)\s+by\s*$/i;

// Clauses after which an identifier is most likely a column.
const COLUMN_CLAUSES =
  /\b(select|where|on|set|by|having|and|or|not|as|distinct|returning|using|values)\s*$/i;

// Words that follow a table name but are not an alias.
const NOT_ALIASES = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "full",
  "cross",
  "on",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "set",
  "values",
  "using",
  "union",
  "select",
  "as",
  "and",
  "or",
  "returning",
  "into",
  "from",
]);

/**
 * Tables referenced in the statement, mapped from every name they can be reached
 * by — the table's own name and any alias. `FROM saving_plans sp` yields both
 * `saving_plans` and `sp`.
 */
export function aliasMap(textBeforeCaret: string): Record<string, string> {
  const text = stripNoise(currentStatement(textBeforeCaret));
  const map: Record<string, string> = {};
  const re =
    /\b(?:from|join|into|update)\s+([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*)\s*(?:(?:as)\s+)?([A-Za-z_][\w$#]*)?/gi;
  let m = re.exec(text);
  while (m !== null) {
    const qualified = m[1];
    // `public.users` is addressed as `users` by its columns.
    const bare = qualified.split(".").pop() ?? qualified;
    map[bare.toLowerCase()] = bare;
    const alias = m[2];
    if (alias && !NOT_ALIASES.has(alias.toLowerCase())) {
      map[alias.toLowerCase()] = bare;
    }
    m = re.exec(text);
  }
  return map;
}

/** Distinct tables in scope, in the order they appear. */
export function tablesInScope(textBeforeCaret: string): string[] {
  return [...new Set(Object.values(aliasMap(textBeforeCaret)))];
}

/** What to offer at the caret, given everything typed before it. */
export function completionContext(textBeforeCaret: string): CompletionContext {
  const aliases = aliasMap(textBeforeCaret);
  const tables = [...new Set(Object.values(aliases))];
  const stmt = stripNoise(currentStatement(textBeforeCaret));
  // Drop the partial word being typed so the clause before it is visible.
  const head = stmt.slice(0, currentToken(stmt, stmt.length).start);

  // A trailing `name.` is the strongest signal available, but it means two
  // different things depending on where it sits: in a table position it is a
  // SCHEMA (`FROM public.` → tables), anywhere else a table or alias
  // (`WHERE sp.` → that table's columns). Reading it always as an alias made
  // `FROM public.er` suggest nothing at all.
  const qualified = /([A-Za-z_][\w$#]*)\s*\.\s*$/.exec(head);
  if (qualified) {
    if (TABLE_CLAUSES.test(head.slice(0, qualified.index))) {
      return { kind: "table", tables };
    }
    const name = qualified[1].toLowerCase();
    return { kind: "column", qualifier: aliases[name] ?? qualified[1], tables };
  }
  if (EXPRESSION_START.test(head)) {
    return { kind: "column", tables, expressionStart: true };
  }
  if (TABLE_CLAUSES.test(head)) {
    return { kind: "table", tables };
  }
  // A trailing comma continues a list — `SELECT a, `, `ORDER BY a, `. Far more
  // often a column list than a `FROM a, b` join, so treat it as column position.
  if (COLUMN_CLAUSES.test(head) || /,\s*$/.test(head)) {
    return { kind: "column", tables };
  }
  return { kind: "any", tables };
}

/**
 * Order candidates for a typed prefix: exact, then prefix, then substring
 * matches; ties broken by kind (schema names before vocabulary, since a column
 * you actually have beats a keyword you might want) and finally alphabetically.
 *
 * With an empty prefix nothing is filtered out — that is the "just show me
 * what's here" case, e.g. straight after `FROM `.
 */
const KIND_RANK: Record<Candidate["kind"], number> = {
  column: 0,
  table: 1,
  keyword: 2,
  function: 3,
  dataType: 4,
};

export function rank(prefix: string, candidates: Candidate[]): Candidate[] {
  const needle = prefix.toLowerCase();
  const scored: Array<{ c: Candidate; tier: number }> = [];
  for (const c of candidates) {
    const label = c.label.toLowerCase();
    let tier: number;
    if (!needle) {
      tier = 1;
    } else if (label === needle) {
      tier = 0;
    } else if (label.startsWith(needle)) {
      tier = 1;
    } else if (label.includes(needle)) {
      tier = 2;
    } else {
      continue;
    }
    scored.push({ c, tier });
  }
  // Shorter label = the prefix covers more of it = closer match. Without this,
  // Postgres' real `OR DELETE` / `OR INSERT` / `OR TRUNCATE` phrases sort ahead
  // of `ORDER BY` for "or", the opposite of what anyone wants. Only meaningful
  // when something was typed — with no prefix, plain alphabetical is what reads.
  const byLength = needle
    ? (a: Candidate, b: Candidate) => a.label.length - b.label.length
    : () => 0;
  return scored
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        KIND_RANK[a.c.kind] - KIND_RANK[b.c.kind] ||
        byLength(a.c, b.c) ||
        a.c.label.localeCompare(b.c.label),
    )
    .map((s) => s.c);
}

export interface SuggestSources {
  tables: string[];
  columns: string[];
  columnsByTable?: Record<string, string[]>;
  keywords: string[];
  functions: string[];
  dataTypes: string[];
}

/**
 * The whole pipeline: context → candidate set → ranked list. Kept here rather
 * than in the webview so the interesting half is testable.
 */
export function suggest(
  textBeforeCaret: string,
  sources: SuggestSources,
  limit = 50,
): { items: Candidate[]; truncated: boolean } {
  const ctx = completionContext(textBeforeCaret);
  const token = currentToken(textBeforeCaret, textBeforeCaret.length);
  const byTable = sources.columnsByTable ?? {};

  // Column candidates narrow as far as the context allows: a qualifier pins one
  // table, otherwise the tables in scope, otherwise every column we know.
  const columnsFor = (): Candidate[] => {
    const pick = (table: string): Candidate[] =>
      (byTable[table] ?? []).map((c) => ({ label: c, kind: "column" as const, detail: table }));
    if (ctx.qualifier) {
      return pick(ctx.qualifier);
    }
    const scoped = ctx.tables.flatMap(pick);
    if (scoped.length) {
      return scoped;
    }
    return sources.columns.map((c) => ({ label: c, kind: "column" as const, detail: "column" }));
  };

  const tableItems = (): Candidate[] =>
    sources.tables.map((t) => ({ label: t, kind: "table" as const, detail: "table" }));
  const vocabulary = (): Candidate[] => [
    ...sources.keywords.map((k) => ({ label: k, kind: "keyword" as const })),
    ...sources.functions.map((f) => ({ label: f, kind: "function" as const })),
    ...sources.dataTypes.map((d) => ({ label: d, kind: "dataType" as const })),
  ];

  let pool: Candidate[];
  if (ctx.qualifier) {
    // Nothing but that table's columns makes sense after `alias.`.
    pool = columnsFor();
  } else if (ctx.kind === "table") {
    pool = tableItems();
  } else if (ctx.expressionStart) {
    // Withhold keywords: straight after `ORDER BY` only a column or a function
    // is valid, and offering `DESC` here is exactly how `ORDER BY DESC` — a
    // syntax error — gets built by accepting the first suggestion.
    pool = [
      ...columnsFor(),
      ...sources.functions.map((f) => ({ label: f, kind: "function" as const })),
    ];
  } else if (ctx.kind === "column") {
    pool = [...columnsFor(), ...vocabulary()];
  } else {
    // No tables here: a bare table name is only valid after FROM/JOIN/INTO/UPDATE,
    // so suggesting one mid-statement (e.g. after `ORDER BY created_at `) is noise.
    pool = vocabulary();
  }

  const ranked = rank(token.word, pool);
  return { items: ranked.slice(0, limit), truncated: ranked.length > limit };
}
