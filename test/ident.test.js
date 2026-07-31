// Pure-logic unit tests (R0 safety net). Runs on Node's built-in test runner
// against the compiled output — no test framework dependency.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  quoteIdent,
  quoteBacktick,
  displayIdent,
  displayBacktick,
  sqlLiteral,
  parseFromTable,
} = require("../out/drivers/ident.js");

test("quoteIdent wraps in double quotes", () => {
  assert.strictEqual(quoteIdent("users"), '"users"');
});

test("quoteIdent doubles embedded double quotes (injection guard)", () => {
  assert.strictEqual(quoteIdent('a"b'), '"a""b"');
  assert.strictEqual(quoteIdent('x"; DROP TABLE t; --'), '"x""; DROP TABLE t; --"');
});

test("quoteBacktick wraps in backticks and doubles embedded backticks", () => {
  assert.strictEqual(quoteBacktick("users"), "`users`");
  assert.strictEqual(quoteBacktick("a`b"), "`a``b`");
});

test("displayIdent leaves simple names unquoted, quotes odd ones", () => {
  assert.strictEqual(displayIdent("users"), "users");
  assert.strictEqual(displayIdent("user_id"), "user_id");
  assert.strictEqual(displayIdent("weird name"), '"weird name"');
  assert.strictEqual(displayIdent("2col"), '"2col"');
});

test("displayBacktick leaves simple names unquoted, backticks odd ones", () => {
  assert.strictEqual(displayBacktick("users"), "users");
  assert.strictEqual(displayBacktick("weird name"), "`weird name`");
});

test("sqlLiteral quotes strings, passes numbers, handles null", () => {
  assert.strictEqual(sqlLiteral("hi"), "'hi'");
  assert.strictEqual(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.strictEqual(sqlLiteral(42), "42");
  assert.strictEqual(sqlLiteral(null), "NULL");
  assert.strictEqual(sqlLiteral(undefined), "NULL");
});

test("parseFromTable extracts a bare table name", () => {
  assert.deepStrictEqual(parseFromTable("SELECT * FROM users"), ["users"]);
});

test("parseFromTable extracts a schema-qualified table with a WHERE clause", () => {
  assert.deepStrictEqual(
    parseFromTable(
      "SELECT * FROM public.saving_plans_transactions where saving_plan_id='x' LIMIT 100",
    ),
    ["public", "saving_plans_transactions"],
  );
});

test("parseFromTable unquotes double-quoted and backtick identifiers", () => {
  assert.deepStrictEqual(parseFromTable('SELECT * FROM "public"."Users"'), ["public", "Users"]);
  assert.deepStrictEqual(parseFromTable("SELECT * FROM `db`.`t`"), ["db", "t"]);
});

test("parseFromTable strips a trailing semicolon", () => {
  assert.deepStrictEqual(parseFromTable("SELECT * FROM users;"), ["users"]);
});

test("parseFromTable bails on joins, unions, and multiple statements", () => {
  assert.strictEqual(parseFromTable("SELECT * FROM a JOIN b ON a.id = b.id"), undefined);
  assert.strictEqual(parseFromTable("SELECT * FROM a UNION SELECT * FROM b"), undefined);
  assert.strictEqual(parseFromTable("SELECT * FROM a; SELECT * FROM b"), undefined);
});

test("parseFromTable bails on multiple tables or a function/subquery source", () => {
  assert.strictEqual(parseFromTable("SELECT * FROM a, b"), undefined);
  assert.strictEqual(parseFromTable("SELECT * FROM generate_series(1, 10)"), undefined);
  assert.strictEqual(parseFromTable("SELECT * FROM (SELECT 1) t"), undefined);
});

test("parseFromTable bails on non-SELECT statements and missing FROM", () => {
  assert.strictEqual(parseFromTable("UPDATE users SET x = 1"), undefined);
  assert.strictEqual(parseFromTable("SELECT 1"), undefined);
});
