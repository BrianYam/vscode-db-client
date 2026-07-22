// Redis key TTL (ms) → human-readable string (M9.4).
const { test } = require("node:test");
const assert = require("node:assert");
const { formatTtl } = require("../out/drivers/redis.js");

test("sub-minute TTLs show whole seconds", () => {
  assert.strictEqual(formatTtl(45000), "45s");
  assert.strictEqual(formatTtl(1000), "1s");
  assert.strictEqual(formatTtl(999), "1s"); // rounds to nearest second
});

test("larger TTLs show the two most-significant units", () => {
  assert.strictEqual(formatTtl(90000), "1m 30s");
  assert.strictEqual(formatTtl(3_723_000), "1h 2m");
  assert.strictEqual(formatTtl(90_061_000), "1d 1h");
});

test("trailing zero units are dropped", () => {
  assert.strictEqual(formatTtl(3_600_000), "1h");
  assert.strictEqual(formatTtl(60_000), "1m");
  assert.strictEqual(formatTtl(86_400_000), "1d");
});

test("zero and negative clamp to 0s", () => {
  assert.strictEqual(formatTtl(0), "0s");
  assert.strictEqual(formatTtl(-100), "0s");
});
