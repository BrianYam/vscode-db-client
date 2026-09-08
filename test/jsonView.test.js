// The JSON viewer's detection/formatting helpers. These ship as a source string
// injected into the query panel's webview (see jsonView.ts for why), so the test
// evaluates that exact text — what is tested is what ships.
const { test } = require("node:test");
const assert = require("node:assert");
const { JSON_VIEW_HELPERS } = require("../out/webview/jsonView.js");

const { jsonShape, jsonSummary, escAttr, jsonPathSeg, jsonPeek } = new Function(
  `${JSON_VIEW_HELPERS}\nreturn { jsonShape, jsonSummary, escAttr, jsonPathSeg, jsonPeek };`,
)();

test("jsonShape: parsed objects and arrays (Postgres/MySQL shape)", () => {
  assert.deepStrictEqual(jsonShape({ a: 1, b: 2 }), {
    kind: "object",
    count: 2,
    value: { a: 1, b: 2 },
  });
  assert.strictEqual(jsonShape([1, 2, 3]).kind, "array");
  assert.strictEqual(jsonShape([1, 2, 3]).count, 3);
});

test("jsonShape: empty object and array still count as JSON", () => {
  assert.strictEqual(jsonShape({}).count, 0);
  assert.strictEqual(jsonShape([]).count, 0);
});

test("jsonShape: JSON held as text (SQLite/Redis shape)", () => {
  assert.strictEqual(jsonShape('{"a":1}').kind, "object");
  assert.strictEqual(jsonShape("  [1,2]  ").kind, "array", "leading whitespace is tolerated");
  assert.deepStrictEqual(jsonShape('{"a":1}').value, { a: 1 });
});

test("jsonShape: not JSON", () => {
  assert.strictEqual(jsonShape(null), null);
  assert.strictEqual(jsonShape(undefined), null);
  assert.strictEqual(jsonShape(42), null);
  assert.strictEqual(jsonShape(true), null);
  assert.strictEqual(jsonShape(""), null);
  assert.strictEqual(jsonShape("plain text"), null);
  assert.strictEqual(jsonShape("{not json"), null, "starts like JSON but does not parse");
  assert.strictEqual(jsonShape('"a string"'), null, "a bare JSON scalar is not a document");
  assert.strictEqual(jsonShape("123"), null);
});

test("jsonShape: dates and byte arrays are not JSON documents", () => {
  // Regression guard: both are typeof 'object' and survive structuredClone, so a
  // naive check renders every timestamp in the grid as "{}".
  assert.strictEqual(jsonShape(new Date("2026-01-01T00:00:00Z")), null);
  assert.strictEqual(jsonShape(new Uint8Array([1, 2, 3])), null);
});

test("jsonShape: nesting is preserved, depth is not flattened", () => {
  const deep = { a: { b: { c: [1, { d: 2 }] } } };
  const s = jsonShape(deep);
  assert.strictEqual(s.count, 1);
  assert.deepStrictEqual(s.value, deep);
});

test("jsonSummary: singular/plural and empty forms", () => {
  assert.strictEqual(jsonSummary(jsonShape({ a: 1 })), "{…} 1 key");
  assert.strictEqual(jsonSummary(jsonShape({ a: 1, b: 2 })), "{…} 2 keys");
  assert.strictEqual(jsonSummary(jsonShape([1])), "[…] 1 item");
  assert.strictEqual(jsonSummary(jsonShape([1, 2])), "[…] 2 items");
  assert.strictEqual(jsonSummary(jsonShape({})), "{}");
  assert.strictEqual(jsonSummary(jsonShape([])), "[]");
  assert.strictEqual(jsonSummary(null), "");
});

test("escAttr: closes the quote holes esc() leaves open", () => {
  assert.strictEqual(escAttr('a"b'), "a&quot;b");
  assert.strictEqual(escAttr("a'b"), "a&#39;b");
  assert.strictEqual(escAttr("<script>"), "&lt;script>");
  assert.strictEqual(escAttr("a&b"), "a&amp;b");
  // Ampersand must be escaped first or the others double-encode.
  assert.strictEqual(escAttr('&"'), "&amp;&quot;");
});

test("jsonPathSeg: identifiers dotted, everything else bracketed", () => {
  assert.strictEqual(jsonPathSeg("sku", false), ".sku");
  assert.strictEqual(jsonPathSeg("_id", false), "._id");
  assert.strictEqual(jsonPathSeg("odd key", false), '["odd key"]');
  assert.strictEqual(jsonPathSeg("2fa", false), '["2fa"]', "cannot start with a digit");
  assert.strictEqual(jsonPathSeg('quote"key', false), '["quote\\"key"]');
  assert.strictEqual(jsonPathSeg(3, true), "[3]");
});

test("jsonPeek: one-line preview of a collapsed value", () => {
  assert.strictEqual(jsonPeek(null), "null");
  assert.strictEqual(jsonPeek(7), "7");
  assert.strictEqual(jsonPeek(false), "false");
  assert.strictEqual(jsonPeek("hi"), '"hi"');
  assert.strictEqual(jsonPeek({ a: 1 }), "{…} 1 key");
  assert.strictEqual(jsonPeek([1, 2]), "[…] 2 items");
  const long = jsonPeek("x".repeat(100));
  assert.ok(long.length < 70 && long.endsWith('…"'), `long strings are elided: ${long}`);
});
