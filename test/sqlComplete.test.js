// Completion reasoning: token scan, alias resolution, clause context, ranking.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  stripNoise,
  currentToken,
  currentStatement,
  aliasMap,
  tablesInScope,
  completionContext,
  rank,
  suggest,
} = require("../out/sqlComplete.js");

const SOURCES = {
  tables: ["saving_plans", "users", "erp_transactions"],
  columns: ["id", "top_up_min", "email", "name", "plan_id"],
  columnsByTable: {
    saving_plans: ["id", "top_up_min", "withdrawal_max"],
    users: ["id", "email", "name"],
    erp_transactions: ["id", "type", "plan_id"],
  },
  keywords: ["SELECT", "FROM", "WHERE", "ORDER BY", "OR", "ORDER", "ORDINALITY", "DESC"],
  functions: ["COUNT", "COALESCE", "DENSE_RANK"],
  dataTypes: ["INTEGER", "TEXT"],
};

// ---------- currentToken ----------

test("currentToken returns the partial word before the caret", () => {
  const sql = "select * from sav";
  const t = currentToken(sql, sql.length);
  assert.strictEqual(t.word, "sav");
  assert.strictEqual(t.start, 14);
});

test("currentToken is empty right after whitespace", () => {
  const sql = "select * from ";
  assert.strictEqual(currentToken(sql, sql.length).word, "");
});

test("currentToken handles a caret in the middle of a word", () => {
  const sql = "select name from users";
  // caret after "na"
  const t = currentToken(sql, 9);
  assert.strictEqual(t.word, "na");
  assert.strictEqual(t.end, 11, "end spans the whole word, not just to the caret");
});

// ---------- stripNoise ----------

test("stripNoise blanks line and block comments but keeps offsets", () => {
  const sql = "select 1 -- from users\nwhere";
  const out = stripNoise(sql);
  assert.strictEqual(out.length, sql.length);
  assert.ok(!/from/.test(out), "commented-out keyword must not survive");
  assert.ok(/where/.test(out), "real code survives");
});

test("stripNoise blanks string literals so their contents can't steer context", () => {
  const sql = "select * from t where x = 'from users'";
  const out = stripNoise(sql);
  assert.strictEqual(out.length, sql.length);
  assert.strictEqual((out.match(/from/g) || []).length, 1, "only the real FROM remains");
});

// ---------- statement isolation ----------

test("currentStatement ignores everything before the last semicolon", () => {
  const s = currentStatement("select * from users; select * from sav");
  assert.strictEqual(s.trim(), "select * from sav");
});

test("a previous statement's tables do not leak into scope", () => {
  assert.deepStrictEqual(tablesInScope("select * from users; select * from saving_plans "), [
    "saving_plans",
  ]);
});

// ---------- aliases ----------

test("aliasMap maps both the table name and its alias", () => {
  const m = aliasMap("select * from saving_plans sp ");
  assert.strictEqual(m.sp, "saving_plans");
  assert.strictEqual(m.saving_plans, "saving_plans");
});

test("aliasMap handles an explicit AS alias", () => {
  assert.strictEqual(aliasMap("select * from users as u ").u, "users");
});

test("aliasMap strips the schema qualifier", () => {
  const m = aliasMap("select * from public.erp_transactions t ");
  assert.strictEqual(m.t, "erp_transactions");
  assert.strictEqual(m.erp_transactions, "erp_transactions");
});

test("a following keyword is not mistaken for an alias", () => {
  const m = aliasMap("select * from users where ");
  assert.strictEqual(m.where, undefined);
  assert.strictEqual(m.users, "users");
});

test("joins contribute every table to scope", () => {
  const t = tablesInScope("select * from saving_plans sp join users u on u.id = sp.id ");
  assert.deepStrictEqual(t.sort(), ["saving_plans", "users"]);
});

// ---------- context ----------

test("after FROM the context is tables", () => {
  assert.strictEqual(completionContext("select * from ").kind, "table");
});

test("after JOIN the context is tables", () => {
  assert.strictEqual(completionContext("select * from a join ").kind, "table");
});

test("after WHERE the context is columns", () => {
  assert.strictEqual(completionContext("select * from users where ").kind, "column");
});

test("after SELECT the context is columns", () => {
  assert.strictEqual(completionContext("select ").kind, "column");
});

test("a qualifier pins one table", () => {
  const ctx = completionContext("select * from saving_plans sp where sp.");
  assert.strictEqual(ctx.kind, "column");
  assert.strictEqual(ctx.qualifier, "saving_plans");
});

test("a partial word after a qualifier still resolves the qualifier", () => {
  const ctx = completionContext("select * from users u where u.em");
  assert.strictEqual(ctx.qualifier, "users");
});

test("a partial word after FROM is still table context", () => {
  assert.strictEqual(completionContext("select * from sav").kind, "table");
});

// ---------- ranking ----------

test("ranking reproduces the reference order for 'or'", () => {
  const cands = ["ORDER BY", "OR", "ORDER", "ORDINALITY", "DESC"].map((label) => ({
    label,
    kind: "keyword",
  }));
  const got = rank("or", cands).map((c) => c.label);
  // exact match first, then the prefix matches alphabetically; DESC has no "or".
  assert.strictEqual(got[0], "OR");
  assert.deepStrictEqual(got, ["OR", "ORDER", "ORDER BY", "ORDINALITY"]);
});

test("shorter matches rank first, so real dialect phrases don't bury ORDER BY", () => {
  // Regression: Postgres genuinely has OR DELETE / OR INSERT / OR TRUNCATE, and
  // alphabetically they all precede ORDER — which pushed ORDER BY off the top.
  const cands = ["ORDER BY", "OR", "ORDER", "OR DELETE", "OR INSERT", "OR TRUNCATE"].map(
    (label) => ({ label, kind: "keyword" }),
  );
  const got = rank("or", cands).map((c) => c.label);
  assert.deepStrictEqual(got.slice(0, 3), ["OR", "ORDER", "ORDER BY"]);
});

test("prefix matches beat substring matches", () => {
  const got = rank("na", [
    { label: "original_name", kind: "column" },
    { label: "name", kind: "column" },
  ]).map((c) => c.label);
  assert.deepStrictEqual(got, ["name", "original_name"]);
});

test("schema names outrank vocabulary at the same tier", () => {
  const got = rank("co", [
    { label: "count", kind: "function" },
    { label: "country", kind: "column" },
  ]).map((c) => c.label);
  assert.deepStrictEqual(got, ["country", "count"]);
});

test("non-matching candidates are dropped", () => {
  assert.deepStrictEqual(rank("zzz", [{ label: "name", kind: "column" }]), []);
});

test("an empty prefix keeps everything", () => {
  assert.strictEqual(
    rank("", [
      { label: "a", kind: "column" },
      { label: "b", kind: "table" },
    ]).length,
    2,
  );
});

// ---------- suggest (the whole pipeline) ----------

test("'select * from sav' suggests the matching table", () => {
  const { items } = suggest("select * from sav", SOURCES);
  assert.strictEqual(items[0].label, "saving_plans");
  assert.strictEqual(items[0].kind, "table");
});

test("columns narrow to the table in scope, not the whole database", () => {
  const { items } = suggest("select * from saving_plans where ", SOURCES);
  const cols = items.filter((i) => i.kind === "column").map((i) => i.label);
  assert.ok(cols.includes("top_up_min"));
  assert.ok(!cols.includes("email"), "users.email is not in scope for saving_plans");
});

test("a qualifier restricts to exactly that table's columns", () => {
  const { items } = suggest("select * from saving_plans sp join users u on u.", SOURCES);
  assert.deepStrictEqual(
    items.map((i) => i.label),
    ["email", "id", "name"],
  );
  assert.ok(items.every((i) => i.kind === "column"));
});

test("with no table in scope, columns fall back to the flat list", () => {
  const { items } = suggest("select em", SOURCES);
  assert.ok(items.some((i) => i.label === "email" && i.kind === "column"));
});

test("an empty buffer offers vocabulary to start a statement, not table names", () => {
  const { items } = suggest("", SOURCES);
  const kinds = new Set(items.map((i) => i.kind));
  assert.ok(kinds.has("keyword"), "SELECT/INSERT/... are what start a statement");
  assert.ok(!kinds.has("table"), "a bare table name is not valid at the start");
});

test("suggest reports truncation rather than silently cutting the list", () => {
  const many = { ...SOURCES, keywords: Array.from({ length: 80 }, (_, i) => `KW${i}`) };
  const { items, truncated } = suggest("k", many, 10);
  assert.strictEqual(items.length, 10);
  assert.strictEqual(truncated, true);
});

test("column detail names the owning table", () => {
  const { items } = suggest("select * from users where em", SOURCES);
  const email = items.find((i) => i.label === "email");
  assert.strictEqual(email.detail, "users");
});

// ---------- regressions reported from live use ----------

test("ORDER BY does not offer DESC — that builds 'ORDER BY DESC', a syntax error", () => {
  // Reported: typing `d` after ORDER BY offered DO/DAY/DESC/DROP and accepting
  // produced `SELECT * FROM erp_transactions ORDER BY DESC`.
  const ctx = completionContext("select * from erp_transactions order by ");
  assert.strictEqual(ctx.expressionStart, true);
  const { items } = suggest("select * from erp_transactions order by d", SOURCES);
  assert.deepStrictEqual(
    items.filter((i) => i.kind === "keyword"),
    [],
    "no keywords may be offered where an expression must begin",
  );
});

test("ORDER BY still offers the table's columns and functions", () => {
  const { items } = suggest("select * from saving_plans order by ", SOURCES);
  const kinds = new Set(items.map((i) => i.kind));
  assert.ok(kinds.has("column"), "columns are the point of this position");
  assert.deepStrictEqual(
    [...kinds].filter((k) => k === "keyword"),
    [],
  );
  assert.ok(items.some((i) => i.label === "top_up_min"));
});

test("GROUP BY behaves the same as ORDER BY", () => {
  assert.strictEqual(completionContext("select * from users group by ").expressionStart, true);
});

test("once a sort column is typed, ASC/DESC become available again", () => {
  const { items } = suggest("select * from saving_plans order by top_up_min de", SOURCES);
  assert.ok(items.some((i) => i.label === "DESC" && i.kind === "keyword"));
});

test("tables are not suggested mid-statement", () => {
  // Reported alongside the above: `ORDER BY created_at ` listed every table.
  const { items } = suggest("select * from saving_plans order by top_up_min ", SOURCES);
  assert.deepStrictEqual(
    items.filter((i) => i.kind === "table"),
    [],
    "a bare table name is only valid after FROM/JOIN/INTO/UPDATE",
  );
});

test("FROM schema. suggests tables, not columns of a table called 'schema'", () => {
  // Reported: `SELECT * FROM public.er` suggested nothing, because `public` was
  // read as a table alias and no table by that name exists.
  const ctx = completionContext("select * from public.");
  assert.strictEqual(ctx.kind, "table");
  assert.strictEqual(ctx.qualifier, undefined);
  const { items } = suggest("select * from public.er", SOURCES);
  assert.ok(items.length > 0, "must suggest something");
  assert.strictEqual(items[0].label, "erp_transactions");
  assert.strictEqual(items[0].kind, "table");
});

test("a real alias qualifier still resolves to columns", () => {
  // The schema fix must not break `WHERE sp.` — different position, different meaning.
  const ctx = completionContext("select * from saving_plans sp where sp.");
  assert.strictEqual(ctx.kind, "column");
  assert.strictEqual(ctx.qualifier, "saving_plans");
});

test("a trailing comma continues a column list", () => {
  assert.strictEqual(completionContext("select id, ").kind, "column");
  const { items } = suggest("select * from users where id = 1 order by name, em", SOURCES);
  assert.ok(items.some((i) => i.label === "email"));
});

test("a commented-out FROM does not create table context", () => {
  // The live clause is WHERE; the FROM inside the comment must be ignored.
  const ctx = completionContext("select * from users where -- from \n");
  assert.notStrictEqual(ctx.kind, "table");
});
