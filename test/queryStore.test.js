// Query-storage scope key parsing (maps a saved .sql file back to its connection).
const { test } = require("node:test");
const assert = require("node:assert");
const { parseKey, encodeKey } = require("../out/connections/queryKey.js");

test("encodeKey + parseKey round-trip", () => {
  const key = encodeKey("c_x", ["shortcut", "public"]);
  assert.strictEqual(key, "c_x@@shortcut@public");
  assert.deepStrictEqual(parseKey(key).scope, ["shortcut", "public"]);
});

test("parseKey splits connId and scope (db + schema)", () => {
  const r = parseKey("c_abc123@@shortcut@public");
  assert.strictEqual(r.connId, "c_abc123");
  assert.deepStrictEqual(r.scope, ["shortcut", "public"]);
});

test("parseKey handles db-only scope", () => {
  const r = parseKey("c_abc123@@shortcut");
  assert.strictEqual(r.connId, "c_abc123");
  assert.deepStrictEqual(r.scope, ["shortcut"]);
});

test("parseKey handles empty scope", () => {
  const r = parseKey("c_abc123@@");
  assert.strictEqual(r.connId, "c_abc123");
  assert.deepStrictEqual(r.scope, []);
});

test("parseKey tolerates a legacy key with no @@", () => {
  const r = parseKey("c_abc123");
  assert.strictEqual(r.connId, "c_abc123");
  assert.deepStrictEqual(r.scope, []);
});
