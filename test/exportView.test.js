// The export path. Extracted from queryPanel so it can be tested without a
// webview — the column picker (M35) made it conditional, and a file that
// silently drops columns is the failure mode this code exists to avoid.
const { test } = require("node:test");
const assert = require("node:assert");
const { projectResult, toCsv } = require("../out/webview/exportView.js");

const RESULT = {
  columns: ["id", "name", "email", "created_at"],
  rows: [
    { id: 1, name: "Ada", email: "ada@x", created_at: "2026-01-01" },
    { id: 2, name: "Grace", email: "grace@x", created_at: "2026-01-02" },
  ],
  rowCount: 2,
};

test("projectResult: no column list means everything (unchanged callers)", () => {
  assert.strictEqual(projectResult(RESULT, undefined), RESULT);
  assert.strictEqual(projectResult(RESULT, null), RESULT);
  assert.strictEqual(projectResult(RESULT, "id"), RESULT, "a non-array is not a selection");
});

test("projectResult: keeps only visible columns, in the result's own order", () => {
  // Deliberately passed out of order — the file must follow the result, not the click order.
  const out = projectResult(RESULT, ["created_at", "id"]);
  assert.deepStrictEqual(out.columns, ["id", "created_at"]);
  assert.deepStrictEqual(Object.keys(out.rows[0]), ["id", "created_at"]);
  assert.strictEqual(out.rows[0].email, undefined, "hidden values are gone, not blanked");
});

test("projectResult: unknown column names are ignored, never invented", () => {
  const out = projectResult(RESULT, ["id", "nope"]);
  assert.deepStrictEqual(out.columns, ["id"], "a forged name must not create a column");
});

test("projectResult: selecting everything returns the original untouched", () => {
  assert.strictEqual(projectResult(RESULT, ["id", "name", "email", "created_at"]), RESULT);
});

test("projectResult: rowCount and other metadata survive", () => {
  const out = projectResult({ ...RESULT, message: "OK", elapsedMs: 12 }, ["id"]);
  assert.strictEqual(out.rowCount, 2);
  assert.strictEqual(out.message, "OK");
  assert.strictEqual(out.elapsedMs, 12);
});

test("projectResult: every row keeps the same shape when a value is missing", () => {
  const ragged = { columns: ["a", "b"], rows: [{ a: 1, b: 2 }, { a: 3 }], rowCount: 2 };
  const out = projectResult(ragged, ["a", "b"]);
  assert.deepStrictEqual(out.columns, ["a", "b"]);
  const narrowed = projectResult({ ...ragged, columns: ["a", "b", "c"] }, ["b", "c"]);
  assert.deepStrictEqual(Object.keys(narrowed.rows[1]), ["b", "c"]);
});

test("toCsv: header and rows follow the projected columns", () => {
  const csv = toCsv(projectResult(RESULT, ["name", "id"]));
  const lines = csv.split("\n");
  assert.strictEqual(lines[0], "id,name", "header is the visible set");
  assert.strictEqual(lines[1], "1,Ada");
  assert.ok(!csv.includes("ada@x"), "a hidden column must not leak into the file");
});

test("toCsv: quotes, commas and newlines are escaped", () => {
  const csv = toCsv({
    columns: ["v"],
    rows: [{ v: 'say "hi"' }, { v: "a,b" }, { v: "line1\nline2" }],
    rowCount: 3,
  });
  const lines = csv.split("\n");
  assert.strictEqual(lines[0], "v");
  assert.strictEqual(lines[1], '"say ""hi"""', "double quotes are doubled and wrapped");
  assert.strictEqual(lines[2], '"a,b"', "a comma forces quoting");
  assert.ok(csv.includes('"line1\nline2"'), "an embedded newline stays inside quotes");
});

test("toCsv: null and undefined become empty, not the word 'null'", () => {
  const csv = toCsv({ columns: ["a", "b"], rows: [{ a: null, b: undefined }], rowCount: 1 });
  assert.strictEqual(csv.split("\n")[1], ",");
});

test("toCsv: objects are JSON-encoded, not [object Object]", () => {
  const csv = toCsv({ columns: ["j"], rows: [{ j: { a: 1 } }], rowCount: 1 });
  assert.ok(!csv.includes("[object"), csv);
  assert.strictEqual(csv.split("\n")[1], '"{""a"":1}"');
});

test("toCsv: a result with no rows still emits a header", () => {
  assert.strictEqual(toCsv({ columns: ["a", "b"], rows: [], rowCount: 0 }), "a,b");
});

test("JSON export carries only the visible columns", () => {
  // Mirrors handleExport's JSON branch: JSON.stringify(result.rows).
  const json = JSON.parse(JSON.stringify(projectResult(RESULT, ["id", "name"]).rows));
  assert.deepStrictEqual(json, [
    { id: 1, name: "Ada" },
    { id: 2, name: "Grace" },
  ]);
});
