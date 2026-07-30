// Dialect-aware SQL formatting. The rule that matters: never destroy the user's
// buffer — unparseable input must throw so callers can leave it alone.
const { test } = require("node:test");
const assert = require("node:assert");
const { canFormat, formatSql, vocabularyFor } = require("../out/sqlDialect.js");

// ---------- dialect vocabulary (drives completion) ----------

test("each SQL dialect supplies a substantial, upper-case vocabulary", () => {
  for (const type of ["postgres", "mysql", "sqlite"]) {
    const v = vocabularyFor(type);
    // The 46 hand-maintained keywords this replaced were dialect-blind; every
    // real dialect should comfortably beat that.
    assert.ok(v.keywords.length > 100, `${type} keywords: ${v.keywords.length}`);
    assert.ok(v.functions.length > 100, `${type} functions: ${v.functions.length}`);
    assert.ok(v.dataTypes.length > 10, `${type} dataTypes: ${v.dataTypes.length}`);
    for (const list of [v.keywords, v.functions, v.dataTypes]) {
      assert.deepStrictEqual(
        list.filter((w) => w !== w.toUpperCase()),
        [],
        `${type} must be upper-cased`,
      );
      assert.strictEqual(new Set(list).size, list.length, `${type} must be de-duplicated`);
    }
  }
});

test("vocabulary includes the multi-word clauses the reference UI shows", () => {
  const { keywords } = vocabularyFor("postgres");
  for (const kw of ["SELECT", "WHERE", "ORDER BY", "GROUP BY", "LEFT JOIN"]) {
    assert.ok(keywords.includes(kw), `missing ${kw}`);
  }
});

test("dialects genuinely differ from one another", () => {
  const pg = new Set(vocabularyFor("postgres").functions);
  const my = new Set(vocabularyFor("mysql").functions);
  // A Postgres-only function must not show up for MySQL.
  assert.ok(pg.has("DENSE_RANK"));
  assert.ok(!my.has("ACOSD"), "MySQL should not inherit Postgres-only functions");
});

test("Redis gets its command set, not SQL", () => {
  const v = vocabularyFor("redis");
  assert.ok(v.keywords.includes("HGETALL"));
  assert.ok(v.keywords.includes("SCAN"));
  assert.ok(!v.keywords.includes("SELECT ALL"));
  assert.deepStrictEqual(v.functions, [], "Redis has no SQL functions");
});

test("canFormat covers the SQL engines and excludes Redis", () => {
  assert.strictEqual(canFormat("postgres"), true);
  assert.strictEqual(canFormat("mysql"), true);
  assert.strictEqual(canFormat("sqlite"), true);
  // Redis is not SQL — the UI hides the action rather than offering a no-op.
  assert.strictEqual(canFormat("redis"), false);
});

test("formats and upper-cases keywords, leaving identifiers alone", () => {
  const out = formatSql("select id, name from Users where id = 1", "postgres");
  assert.match(out, /^SELECT/);
  assert.match(out, /\bFROM\b/);
  assert.match(out, /\bWHERE\b/);
  // Identifier case is the user's business, not ours.
  assert.match(out, /Users/);
});

test("keeps Postgres-specific syntax intact", () => {
  const out = formatSql(
    "select request_body->>'city' as city from t where created_at > now() - interval '7 days'",
    "postgres",
  );
  assert.match(out, /->>/);
  assert.match(out, /'city'/);
  assert.match(out, /interval '7 days'/);
});

test("keeps MySQL backtick identifiers intact", () => {
  const out = formatSql("select `id`,`name` from `users`", "mysql");
  assert.match(out, /`id`/);
  assert.match(out, /`users`/);
});

test("keeps SQLite function calls intact", () => {
  const out = formatSql("select json_extract(body,'$.city') from app_configs", "sqlite");
  assert.match(out, /json_extract/);
  assert.match(out, /'\$\.city'/);
});

test("throws on unparseable SQL so the caller can keep the original", () => {
  assert.throws(() => formatSql("SELECT ((( FROM", "postgres"));
  assert.throws(() => formatSql("SELECT 'unterminated", "postgres"));
});

test("throws for an engine with no dialect", () => {
  assert.throws(() => formatSql("GET mykey", "redis"), /not supported/i);
});

test("whitespace-only input is returned unchanged, not blanked", () => {
  // formatDialect() maps whitespace to "", which would silently clear the editor.
  assert.strictEqual(formatSql("   \n  ", "postgres"), "   \n  ");
  assert.strictEqual(formatSql("", "postgres"), "");
});

test("tabWidth is honoured and defaults to 2", () => {
  const two = formatSql("select a from t", "postgres");
  const four = formatSql("select a from t", "postgres", { tabWidth: 4 });
  assert.match(two, /\n {2}a/);
  assert.match(four, /\n {4}a/);
});

test("formatting is idempotent", () => {
  const once = formatSql("select a,b from t where x=1 order by a desc", "postgres");
  assert.strictEqual(formatSql(once, "postgres"), once);
});

test("multiple statements are preserved", () => {
  const out = formatSql("select 1; select 2;", "postgres");
  assert.match(out, /SELECT\s+1;/);
  assert.match(out, /SELECT\s+2;/);
});
