// Pure size helpers behind the settings panel's "Storage usage" readout.
const { test } = require("node:test");
const assert = require("node:assert");
const { byteSize, formatBytes } = require("../out/webview/storageUsage.js");

test("byteSize measures the JSON-serialized form in UTF-8 bytes", () => {
  assert.strictEqual(byteSize(undefined), 0); // key never written
  assert.strictEqual(byteSize([]), 2);
  assert.strictEqual(byteSize({ a: 1 }), 7);
  assert.strictEqual(byteSize("héllo"), 8); // 2 quotes + 4 ASCII + 2-byte é
});

test("formatBytes stays exact under 1 KB and rounds to one decimal above", () => {
  assert.strictEqual(formatBytes(0), "0 B");
  assert.strictEqual(formatBytes(1023), "1023 B");
  assert.strictEqual(formatBytes(1024), "1.0 KB");
  assert.strictEqual(formatBytes(9498), "9.3 KB");
  assert.strictEqual(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
