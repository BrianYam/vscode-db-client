import type { ForeignKey, SchemaHints } from "../drivers/Driver";

/**
 * Pure schema-context reasoning for AI prompts. Everything here is exported and
 * side-effect free so it lands in the repo's node:test tier — the same rule
 * sqlComplete.ts follows. The host feeds it data the drivers already return
 * (schemaHints, foreignKeys); nothing here talks to a database or a network.
 */

export interface AiSchemaInput {
  tables: string[];
  columnsByTable: Record<string, string[]>;
  /** FK relations per table, best-effort — absent tables just render no arrows. */
  fksByTable?: Record<string, ForeignKey[]>;
}

export interface SchemaContext {
  text: string;
  /** True when the schema didn't fit the budget and was cut down — the UI must say so. */
  trimmed: boolean;
  /** The tables actually included, so the trim notice can count them. */
  tables: string[];
}

/**
 * chars/4 is the industry rule of thumb for English + SQL. This guards a
 * request-size budget; it is not an invoice — the ledger records exact counts
 * from the response.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Tables the user's prompt names, matched loosely: exact word, or off by a
 * trailing "s" in either direction ("saving_plan" ↔ "saving_plans"). Substring
 * matching is deliberately avoided — "user" must not drag in "user_sessions".
 */
export function referencedTables(prompt: string, tables: string[]): string[] {
  const words = new Set(
    (prompt.toLowerCase().match(/[a-z0-9_.]+/g) ?? []).map((w) => w.replace(/^.*\./, "")),
  );
  return tables.filter((t) => {
    const name = t.toLowerCase();
    return (
      words.has(name) ||
      words.has(`${name}s`) ||
      (name.endsWith("s") && words.has(name.slice(0, -1)))
    );
  });
}

/** One hop out along foreign keys — joins usually need the referenced table too. */
export function expandWithFkNeighbors(
  tables: string[],
  fksByTable: Record<string, ForeignKey[]> | undefined,
  allTables: string[],
): string[] {
  if (!fksByTable) {
    return tables;
  }
  const known = new Set(allTables);
  const out = new Set(tables);
  for (const t of tables) {
    for (const fk of fksByTable[t] ?? []) {
      const ref = fk.refTable[fk.refTable.length - 1];
      if (ref && known.has(ref)) {
        out.add(ref);
      }
    }
  }
  return [...out];
}

/** `table(col, col, …)` plus `table.col -> ref.col` arrow lines per FK. */
export function renderSchema(tables: string[], schema: AiSchemaInput): string {
  const lines: string[] = [];
  for (const t of tables) {
    const cols = schema.columnsByTable[t];
    lines.push(cols?.length ? `${t}(${cols.join(", ")})` : t);
  }
  for (const t of tables) {
    for (const fk of schema.fksByTable?.[t] ?? []) {
      const ref = fk.refTable[fk.refTable.length - 1];
      lines.push(`${t}.${fk.column} -> ${ref}.${fk.refColumn}`);
    }
  }
  return lines.join("\n");
}

/**
 * Full schema + relations when it fits the budget; otherwise trimmed to the
 * tables the prompt references plus their FK neighbours, then hard-cut from the
 * end if even that is too big. `trimmed` must reach the UI (house honesty rule):
 * a wrong answer caused by missing context has to be diagnosable by the user.
 */
export function buildSchemaContext(
  prompt: string,
  schema: AiSchemaInput,
  budgetTokens: number,
): SchemaContext {
  const full = renderSchema(schema.tables, schema);
  if (estimateTokens(full) <= budgetTokens) {
    return { text: full, trimmed: false, tables: [...schema.tables] };
  }

  let subset = expandWithFkNeighbors(
    referencedTables(prompt, schema.tables),
    schema.fksByTable,
    schema.tables,
  );
  if (subset.length === 0) {
    // Nothing recognizably named — better some schema than none.
    subset = [...schema.tables];
  }
  while (subset.length > 1 && estimateTokens(renderSchema(subset, schema)) > budgetTokens) {
    subset = subset.slice(0, -1);
  }
  return { text: renderSchema(subset, schema), trimmed: true, tables: subset };
}

/** Convenience: adapt a driver's SchemaHints into the builder's input shape. */
export function schemaInputFromHints(
  hints: SchemaHints,
  fksByTable?: Record<string, ForeignKey[]>,
): AiSchemaInput {
  return {
    tables: hints.tables,
    columnsByTable: hints.columnsByTable ?? {},
    fksByTable,
  };
}

export interface ExtractedReply {
  sql: string;
  /** Prose around the code fence, collapsed to one line for the assist bar. */
  explanation: string;
}

/**
 * Model replies are prompted to fence the SQL, but tolerance beats trust:
 * take the first fenced block if present, otherwise treat the whole reply as
 * the statement.
 */
export function extractSql(reply: string): ExtractedReply {
  const fence = reply.match(/```(?:sql|SQL)?\s*\n([\s\S]*?)```/);
  if (fence) {
    const prose = (reply.slice(0, fence.index) + reply.slice((fence.index ?? 0) + fence[0].length))
      .replace(/\s+/g, " ")
      .trim();
    return { sql: fence[1].trim(), explanation: prose };
  }
  return { sql: reply.trim(), explanation: "" };
}

/**
 * Any statement that writes data or structure — the query-lock trigger. Wider
 * than isDestructive on purpose: a syntactically fine INSERT is not
 * "destructive", but it IS a mutation the lock must catch. Returns the verb
 * (for the "auto-locked (INSERT)" message) or null for read-only statements.
 * Token scan, not a grammar; over-triggering is fail-safe by design — a rare
 * false positive costs one click on the lock.
 */
const MUTATION_VERB = /^(insert|update|delete|merge|replace|drop|truncate|alter|create)\b/i;
const EMBEDDED_WRITE = /\b(insert|update|delete|merge|replace)\b/i;

export function isMutation(sql: string): string | null {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const stmt of stripped.split(";")) {
    const s = stmt.trim();
    if (!s) {
      continue;
    }
    const lead = MUTATION_VERB.exec(s);
    if (lead) {
      return lead[1].toUpperCase();
    }
    // CTE-wrapped writes: `WITH x AS (…) INSERT INTO …`. A WITH that merely
    // *mentions* a write verb (in a string literal) also matches — acceptable.
    if (/^with\b/i.test(s)) {
      const inner = EMBEDDED_WRITE.exec(s);
      if (inner) {
        return inner[1].toUpperCase();
      }
    }
  }
  return null;
}

/**
 * Statement shapes that must carry a visible warning tag before the user runs
 * them. Returns a short reason, or null for safe statements. Deliberately
 * shallow — a token scan, not a grammar — matching the sqlComplete.ts approach.
 */
export function isDestructive(sql: string): string | null {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const stmt of stripped.split(";")) {
    const s = stmt.trim();
    if (!s) {
      continue;
    }
    if (/^drop\b/i.test(s)) {
      return "DROP statement";
    }
    if (/^truncate\b/i.test(s)) {
      return "TRUNCATE statement";
    }
    if (/^alter\b/i.test(s)) {
      return "ALTER statement";
    }
    if (/^delete\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      return "DELETE without WHERE";
    }
    if (/^update\b/i.test(s) && !/\bwhere\b/i.test(s)) {
      return "UPDATE without WHERE";
    }
  }
  return null;
}
