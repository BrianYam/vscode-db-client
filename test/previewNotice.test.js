// Redis list/zset value previews: truncation must be visible (M-HONESTY).
const { test } = require("node:test");
const assert = require("node:assert");
const { previewNotice } = require("../out/drivers/redis.js");

test("nothing held back means no notice at all", () => {
  assert.strictEqual(previewNotice(200, 200, "elements"), undefined);
  assert.strictEqual(previewNotice(12, 12, "elements"), undefined);
  assert.strictEqual(previewNotice(0, 0, "members"), undefined);
});

test("a total below what was shown is still silent", () => {
  // Guards the race where the key shrinks between the range read and the count:
  // claiming "the first 200 of 3" would be worse than saying nothing.
  assert.strictEqual(previewNotice(200, 3, "elements"), undefined);
});

test("truncation names both numbers, not just the fact of it", () => {
  const msg = previewNotice(200, 5000, "elements");
  assert.match(msg, /first 200 of 5,000 elements/);
});

test("the unit is the caller's word, so zsets read correctly", () => {
  assert.match(previewNotice(200, 900, "members"), /of 900 members/);
});

test("says the cap is the preview's, not the key's", () => {
  // A user who reads "truncated" assumes the data is gone, not merely unshown.
  assert.match(previewNotice(200, 5000, "elements"), /preview's limit, not the key's/);
});

test("large totals are grouped for legibility", () => {
  assert.match(previewNotice(200, 1234567, "elements"), /1,234,567/);
});
