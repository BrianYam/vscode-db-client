// Pure schema-context reasoning: budget trim honesty, FK expansion, reply
// parsing, and the destructive-statement tagger.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  estimateTokens,
  referencedTables,
  expandWithFkNeighbors,
  renderSchema,
  buildSchemaContext,
  extractSql,
  isDestructive,
} = require("../out/ai/context.js");
const { systemPrompt, dialectLabel, generateUserPrompt } = require("../out/ai/prompts.js");

const SCHEMA = {
  tables: ["users", "orders", "saving_plans"],
  columnsByTable: {
    users: ["id", "email"],
    orders: ["id", "user_id", "total"],
    saving_plans: ["id", "user_id", "fee"],
  },
  fksByTable: {
    orders: [{ column: "user_id", refTable: ["public", "users"], refColumn: "id" }],
    saving_plans: [{ column: "user_id", refTable: ["public", "users"], refColumn: "id" }],
  },
};

test("referencedTables matches whole words and singular/plural, not substrings", () => {
  assert.deepStrictEqual(referencedTables("show me all orders by user", SCHEMA.tables), [
    "users",
    "orders",
  ]);
  // "user" must not substring-match into saving_plans' columns or similar names.
  assert.deepStrictEqual(referencedTables("saving_plan fees this month", SCHEMA.tables), [
    "saving_plans",
  ]);
  assert.deepStrictEqual(referencedTables("nothing relevant here", SCHEMA.tables), []);
});

test("expandWithFkNeighbors pulls in referenced tables one hop out", () => {
  const out = expandWithFkNeighbors(["orders"], SCHEMA.fksByTable, SCHEMA.tables);
  assert.deepStrictEqual(out.sort(), ["orders", "users"]);
});

test("renderSchema emits table(cols) lines plus FK arrows", () => {
  const text = renderSchema(["orders"], SCHEMA);
  assert.match(text, /orders\(id, user_id, total\)/);
  assert.match(text, /orders\.user_id -> users\.id/);
});

test("buildSchemaContext: full schema when it fits, untrimmed", () => {
  const ctx = buildSchemaContext("anything", SCHEMA, 10_000);
  assert.strictEqual(ctx.trimmed, false);
  assert.strictEqual(ctx.tables.length, 3);
});

test("buildSchemaContext: over budget trims to referenced + FK neighbours and says so", () => {
  const full = renderSchema(SCHEMA.tables, SCHEMA);
  const budget = estimateTokens(full) - 1;
  const ctx = buildSchemaContext("total per order", SCHEMA, budget);
  assert.strictEqual(ctx.trimmed, true);
  assert.ok(ctx.tables.includes("orders"));
  assert.ok(ctx.tables.includes("users")); // FK neighbour came along
  assert.ok(!ctx.text.includes("saving_plans("));
});

test("extractSql takes the fenced block and collapses prose to one line", () => {
  const reply =
    "Counts users per plan.\n```sql\nSELECT plan, COUNT(*) FROM users GROUP BY plan\n```\n";
  const { sql, explanation } = extractSql(reply);
  assert.strictEqual(sql, "SELECT plan, COUNT(*) FROM users GROUP BY plan");
  assert.strictEqual(explanation, "Counts users per plan.");
});

test("extractSql tolerates a bare, unfenced reply", () => {
  const { sql, explanation } = extractSql("  SELECT 1  ");
  assert.strictEqual(sql, "SELECT 1");
  assert.strictEqual(explanation, "");
});

test("isDestructive tags the dangerous shapes and clears the safe ones", () => {
  assert.strictEqual(isDestructive("SELECT * FROM users"), null);
  assert.strictEqual(isDestructive("DELETE FROM users WHERE id = 1"), null);
  assert.match(isDestructive("DELETE FROM users"), /DELETE without WHERE/);
  assert.match(isDestructive("UPDATE users SET x = 1"), /UPDATE without WHERE/);
  assert.match(isDestructive("DROP TABLE users"), /DROP/);
  assert.match(isDestructive("TRUNCATE users"), /TRUNCATE/);
  assert.match(isDestructive("ALTER TABLE users ADD c int"), /ALTER/);
  // Comments must not hide a verb, and multi-statement scans every statement.
  assert.match(isDestructive("SELECT 1; -- ok\nDELETE FROM users"), /DELETE without WHERE/);
  // A WHERE inside a comment doesn't count as a guard.
  assert.match(isDestructive("DELETE FROM users -- where id=1"), /DELETE without WHERE/);
});

test("prompts pin the dialect and forbid destructive output on generate", () => {
  assert.strictEqual(dialectLabel("postgres"), "PostgreSQL");
  const sys = systemPrompt("generate", "sqlite");
  assert.match(sys, /SQLite/);
  assert.match(sys, /Never produce DROP/);
  assert.match(systemPrompt("fix", "mysql"), /corrected statement/);
});

test("generate and fix demand runnable SQL — no bind parameters, params CTE instead", () => {
  for (const verb of ["generate", "fix"]) {
    const sys = systemPrompt(verb, "postgres");
    assert.match(sys, /NEVER use bind parameters/);
    assert.match(sys, /CTE named params/);
  }
  // Best-practice style rules apply to generation.
  const gen = systemPrompt("generate", "postgres");
  assert.match(gen, /UNION ALL/);
  assert.match(gen, /avoid DISTINCT/);
  // Explain doesn't write SQL, so it carries no authoring rules.
  assert.doesNotMatch(systemPrompt("explain", "postgres"), /bind parameters/);
});

test("generateUserPrompt carries editor SQL and session history for follow-ups", () => {
  const plain = generateUserPrompt("count users", "users(id)");
  assert.doesNotMatch(plain, /Current query/);
  assert.doesNotMatch(plain, /Earlier requests/);
  assert.match(plain, /Request: count users/);

  const followUp = generateUserPrompt(
    "now also show the name",
    "users(id, name)",
    "SELECT id FROM users",
    [{ prompt: "count users", sql: "SELECT id FROM users" }],
  );
  assert.match(followUp, /Earlier requests in this session[\s\S]*1\. count users/);
  assert.match(followUp, /Current query in the editor:\nSELECT id FROM users/);
  assert.match(followUp, /Request: now also show the name/);
  // System prompt tells the model what those sections mean.
  assert.match(systemPrompt("generate", "postgres"), /edit the current query/);
});
