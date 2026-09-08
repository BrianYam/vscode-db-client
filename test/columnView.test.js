// Column picker helpers. These ship as a source string injected into the query
// panel's webview (see columnView.ts for why), so the test evaluates that exact
// text — what is tested is what ships.
const { test } = require("node:test");
const assert = require("node:assert");
const { COLUMN_VIEW_HELPERS } = require("../out/webview/columnView.js");

const { visibleColumns, projectRows, columnsKey } = new Function(
  `${COLUMN_VIEW_HELPERS}\nreturn { visibleColumns, projectRows, columnsKey };`,
)();

const ALL = ["id", "name", "email", "created_at"];

test("visibleColumns: nothing hidden returns everything, in order", () => {
  assert.deepStrictEqual(visibleColumns(ALL, new Set()), ALL);
  assert.deepStrictEqual(visibleColumns(ALL, null), ALL);
});

test("visibleColumns: returns a copy, never the caller's array", () => {
  const out = visibleColumns(ALL, new Set());
  out.push("mutated");
  assert.strictEqual(ALL.length, 4, "the result's column list must not be aliased");
});

test("visibleColumns: hiding preserves the original order", () => {
  assert.deepStrictEqual(visibleColumns(ALL, new Set(["email"])), ["id", "name", "created_at"]);
  // Hidden in a different order than the columns — output still follows the result.
  assert.deepStrictEqual(visibleColumns(ALL, new Set(["created_at", "id"])), ["name", "email"]);
});

test("visibleColumns: stale names in the hidden set are ignored", () => {
  // A previous query's columns can linger in the set; they must not throw or
  // accidentally hide something else.
  assert.deepStrictEqual(visibleColumns(ALL, new Set(["gone", "email"])), [
    "id",
    "name",
    "created_at",
  ]);
});

test("visibleColumns: everything hidden yields an empty list", () => {
  // The UI refuses to hide the last column; the helper stays honest regardless.
  assert.deepStrictEqual(visibleColumns(ALL, new Set(ALL)), []);
});

test("visibleColumns: no columns at all", () => {
  assert.deepStrictEqual(visibleColumns([], new Set(["x"])), []);
  assert.deepStrictEqual(visibleColumns(null, new Set()), []);
});

test("projectRows: keeps only the given columns, in the given order", () => {
  const rows = [{ id: 1, name: "A", email: "a@x", created_at: "2026" }];
  assert.deepStrictEqual(projectRows(rows, ["name", "id"]), [{ name: "A", id: 1 }]);
  assert.deepStrictEqual(Object.keys(projectRows(rows, ["name", "id"])[0]), ["name", "id"]);
});

test("projectRows: every row keeps the same shape even when a value is missing", () => {
  // A ragged CSV/JSON is worse than an explicit empty cell.
  const rows = [{ id: 1, name: "A" }, { id: 2 }];
  const out = projectRows(rows, ["id", "name"]);
  assert.deepStrictEqual(Object.keys(out[1]), ["id", "name"]);
  assert.strictEqual(out[1].name, undefined);
});

test("projectRows: falsy and structured values survive projection", () => {
  const rows = [{ a: 0, b: null, c: false, d: "", e: { j: 1 } }];
  const out = projectRows(rows, ["a", "b", "c", "d", "e"]);
  assert.deepStrictEqual(out[0], { a: 0, b: null, c: false, d: "", e: { j: 1 } });
});

test("projectRows: empty inputs", () => {
  assert.deepStrictEqual(projectRows([], ["a"]), []);
  assert.deepStrictEqual(projectRows(null, ["a"]), []);
  assert.deepStrictEqual(projectRows([{ a: 1 }], []), [{}]);
});

test("columnsKey: identifies a column set so visibility can reset on change", () => {
  assert.strictEqual(columnsKey(["a", "b"]), columnsKey(["a", "b"]), "same set, same key");
  assert.notStrictEqual(columnsKey(["a", "b"]), columnsKey(["b", "a"]), "order matters");
  assert.notStrictEqual(columnsKey(["a"]), columnsKey(["a", "b"]));
  assert.strictEqual(columnsKey([]), columnsKey(null));
});

test("columnsKey: separator cannot be forged by a column name", () => {
  // Joined on a newline precisely because a column name cannot contain one;
  // names with commas or spaces must still produce distinct keys.
  assert.notStrictEqual(columnsKey(["a,b"]), columnsKey(["a", "b"]));
});
