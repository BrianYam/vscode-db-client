// Redis key-search term → SCAN MATCH glob (M9.1).
const { test } = require("node:test");
const assert = require("node:assert");
const { scanPattern } = require("../out/drivers/redis.js");

test("plain text becomes a substring match", () => {
  assert.strictEqual(scanPattern("erp-queue"), "*erp-queue*");
});

test("a term with glob syntax is passed through untouched", () => {
  assert.strictEqual(scanPattern("bull:erp-queue:*"), "bull:erp-queue:*");
  assert.strictEqual(scanPattern("bull:erp-queue:?"), "bull:erp-queue:?");
  assert.strictEqual(scanPattern("key[0-9]"), "key[0-9]");
});

test("empty, blank, and missing terms mean no filter", () => {
  assert.strictEqual(scanPattern(""), undefined);
  assert.strictEqual(scanPattern("   "), undefined);
  assert.strictEqual(scanPattern(undefined), undefined);
});

test("surrounding whitespace is trimmed", () => {
  assert.strictEqual(scanPattern("  gift  "), "*gift*");
});
