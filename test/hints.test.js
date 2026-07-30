// Grouping catalog rows into table-aware column hints (shared by all SQL drivers).
const { test } = require("node:test");
const assert = require("node:assert");
const { groupColumns } = require("../out/drivers/hints.js");

test("groups columns under their table, preserving catalog order", () => {
  const g = groupColumns([
    { table: "saving_plans", column: "id" },
    { table: "saving_plans", column: "top_up_min" },
    { table: "users", column: "id" },
    { table: "users", column: "email" },
  ]);
  assert.deepStrictEqual(g.columnsByTable.saving_plans, ["id", "top_up_min"]);
  assert.deepStrictEqual(g.columnsByTable.users, ["id", "email"]);
});

test("flat list is de-duplicated across tables", () => {
  const g = groupColumns([
    { table: "a", column: "id" },
    { table: "b", column: "id" },
    { table: "b", column: "name" },
  ]);
  // "id" exists in both tables but appears once in the fallback list.
  assert.deepStrictEqual(g.columns.sort(), ["id", "name"]);
});

test("a repeated (table, column) pair does not duplicate within the table", () => {
  const g = groupColumns([
    { table: "a", column: "id" },
    { table: "a", column: "id" },
  ]);
  assert.deepStrictEqual(g.columnsByTable.a, ["id"]);
});

test("blank table or column names are skipped", () => {
  const g = groupColumns([
    { table: "", column: "id" },
    { table: "a", column: "" },
    { table: "a", column: "ok" },
  ]);
  assert.deepStrictEqual(Object.keys(g.columnsByTable), ["a"]);
  assert.deepStrictEqual(g.columnsByTable.a, ["ok"]);
});

test("empty input yields empty structures, not undefined", () => {
  const g = groupColumns([]);
  assert.deepStrictEqual(g.columns, []);
  assert.deepStrictEqual(g.columnsByTable, {});
});
