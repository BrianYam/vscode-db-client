/**
 * The three assist verbs as prompt builders — pure string functions so the
 * exact text sent to a provider is unit-testable and reviewable in one place.
 * Every prompt pins the engine dialect: "SQL" unqualified invites Postgres
 * idioms against SQLite and vice versa.
 */

export type AiVerb = "generate" | "explain" | "fix";

const DIALECT_LABEL: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL/MariaDB",
  sqlite: "SQLite",
};

export function dialectLabel(connType: string): string {
  return DIALECT_LABEL[connType] ?? "SQL";
}

/**
 * The statement lands in an interactive editor with no parameter binding —
 * a $1 in the output is a statement the user cannot run. A leading `params`
 * CTE gives them exactly one obvious place to paste their value instead.
 */
const RUNNABLE_RULES =
  "The statement must run as-is in an interactive SQL client: NEVER use bind " +
  "parameters ($1, ?, :name) or client variables. When the query depends on a " +
  "value the user must supply, define it once in a leading CTE named params " +
  "— e.g. WITH params AS (SELECT 'REPLACE_ME' AS saving_plan_id) — and " +
  "reference it, so there is a single obvious place to edit. ";

const STYLE_RULES =
  "Write concise, idiomatic SQL for the dialect: prefer one scan per table " +
  "using the dialect's idioms (e.g. CROSS JOIN LATERAL (VALUES ...) to unpivot " +
  "columns on PostgreSQL) instead of long chains of near-identical UNION ALL " +
  "branches; use short meaningful aliases; avoid DISTINCT unless duplicates " +
  "are actually possible; add ORDER BY or LIMIT only when they serve the " +
  "request; keep the result set's columns purposeful, not padded. ";

export function systemPrompt(verb: AiVerb, connType: string): string {
  const dialect = dialectLabel(connType);
  const base =
    `You are a ${dialect} expert assisting inside a database client. ` +
    `Use only tables and columns from the provided schema. `;
  switch (verb) {
    case "generate":
      return (
        base +
        RUNNABLE_RULES +
        STYLE_RULES +
        "A 'Current query' and earlier requests from this session may be " +
        "provided: when the new request asks to change, extend, or build on " +
        "them, edit the current query rather than starting from scratch; when " +
        "the request is about something new, ignore them and write fresh SQL. " +
        "Reply with exactly one SQL statement in a ```sql fenced block, " +
        "preceded by a single plain-language sentence saying what it does. " +
        "Never produce DROP, TRUNCATE, ALTER, or DELETE/UPDATE without a WHERE " +
        "clause unless the user explicitly asked for that operation."
      );
    case "explain":
      return (
        base +
        "Explain what the given SQL does in plain language, concisely — a short " +
        "paragraph at most. Do not rewrite or reformat the SQL."
      );
    case "fix":
      return (
        base +
        RUNNABLE_RULES +
        "The given SQL failed with the given database error. Reply with the " +
        "corrected statement in a ```sql fenced block, preceded by one sentence " +
        "naming what was wrong. Preserve the query's intent; change as little " +
        "as possible."
      );
  }
}

/** One earlier Generate exchange in this panel, oldest first. */
export interface AiExchange {
  prompt: string;
  sql: string;
}

export function generateUserPrompt(
  intent: string,
  schemaContext: string,
  currentSql?: string,
  history?: AiExchange[],
): string {
  let out = `Schema:\n${schemaContext}\n`;
  if (history?.length) {
    // Prompts only — the SQL each produced has been superseded by the editor's
    // current content, which is sent in full below.
    out += `\nEarlier requests in this session, oldest first:\n${history
      .map((h, i) => `${i + 1}. ${h.prompt}`)
      .join("\n")}\n`;
  }
  if (currentSql?.trim()) {
    out += `\nCurrent query in the editor:\n${currentSql.trim()}\n`;
  }
  return `${out}\nRequest: ${intent}`;
}

export function explainUserPrompt(sql: string, schemaContext: string): string {
  return `Schema:\n${schemaContext}\n\nExplain this SQL:\n${sql}`;
}

export function fixUserPrompt(sql: string, error: string, schemaContext: string): string {
  return `Schema:\n${schemaContext}\n\nThis SQL failed:\n${sql}\n\nError:\n${error}`;
}
