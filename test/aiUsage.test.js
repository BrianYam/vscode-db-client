// Usage-ledger arithmetic: cap honesty, all-time totals surviving the cap,
// price matching, and the "unknown model → no fake $0" rule.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  applyRecord,
  totalsKey,
  emptyUsageState,
  estimateCost,
  summarizeAllTime,
  summarizePeriod,
  usedModels,
} = require("../out/ai/usageStore.js");
const { findPrice } = require("../out/ai/priceTable.js");

const entry = (over = {}) => ({
  ts: 1000,
  providerId: "anthropic",
  model: "claude-sonnet-4-5",
  verb: "generate",
  inputTokens: 100,
  outputTokens: 50,
  ...over,
});

test("applyRecord appends and accumulates totals", () => {
  let s = emptyUsageState(0);
  s = applyRecord(s, entry());
  s = applyRecord(s, entry({ inputTokens: 10, outputTokens: 5 }));
  assert.strictEqual(s.entries.length, 2);
  const t = s.totals[totalsKey(entry())];
  assert.deepStrictEqual(t, { inputTokens: 110, outputTokens: 55, requests: 2 });
});

test("cap drops oldest entries, counts the drop, and totals stay exact", () => {
  let s = emptyUsageState(0);
  for (let i = 0; i < 5; i++) {
    s = applyRecord(s, entry({ ts: i }), 3);
  }
  assert.strictEqual(s.entries.length, 3);
  assert.strictEqual(s.dropped, 2);
  assert.strictEqual(s.entries[0].ts, 2); // oldest two gone
  // All-time truth is untouched by the cap.
  assert.strictEqual(s.totals[totalsKey(entry())].requests, 5);
});

// A fetched-style table standing in for real rows; summaries only need a lookup.
const TEST_ROWS = [
  { providerId: "anthropic", model: "claude-sonnet", input: 3, output: 15, source: "litellm" },
];
const seedLookup = (providerId, model) => findPrice(providerId, model, TEST_ROWS);

test("lookup: provider-scoped substring match; unknown model returns undefined", () => {
  assert.strictEqual(seedLookup("anthropic", "claude-sonnet-4-5").input, 3);
  assert.strictEqual(seedLookup("openai", "claude-sonnet-4-5"), undefined);
  assert.strictEqual(seedLookup("anthropic", "llama3.1"), undefined);
});

test("estimateCost computes per-MTok, and stays undefined without a price", () => {
  assert.strictEqual(estimateCost(1_000_000, 0, { input: 3, output: 15 }), 3);
  assert.strictEqual(estimateCost(0, 2_000_000, { input: 3, output: 15 }), 30);
  assert.strictEqual(estimateCost(1000, 1000, undefined), undefined);
});

test("summarizePeriod respects periodStart; summarizeAllTime reads totals", () => {
  let s = emptyUsageState(0);
  s = applyRecord(s, entry({ ts: 10 }));
  s = applyRecord(s, entry({ ts: 100 }));
  s = { ...s, periodStart: 50 };
  const period = summarizePeriod(s, seedLookup);
  assert.strictEqual(period.length, 1);
  assert.strictEqual(period[0].requests, 1);
  const all = summarizeAllTime(s, seedLookup);
  assert.strictEqual(all[0].requests, 2);
  assert.ok(all[0].costUsd > 0);
});

test("unknown model rows carry costUsd undefined, not zero", () => {
  let s = emptyUsageState(0);
  s = applyRecord(s, entry({ model: "llama3.1", ts: 10 }));
  const rows = summarizeAllTime(s, seedLookup);
  assert.strictEqual(rows[0].costUsd, undefined);
});

test("usedModels: distinct provider+model pairs, verbs collapsed, cap-proof", () => {
  let s = emptyUsageState(0);
  s = applyRecord(s, entry({ ts: 1 }));
  s = applyRecord(s, entry({ ts: 2, verb: "test" })); // same pair, other verb
  s = applyRecord(
    s,
    entry({ ts: 3, providerId: "openrouter", model: "deepseek/deepseek-v4-flash" }),
  );
  // Totals survive the cap, so usedModels must too.
  s = applyRecord(s, entry({ ts: 4, model: "capped-out" }), 1);
  const pairs = usedModels(s)
    .map((u) => u.providerId + "/" + u.model)
    .sort();
  assert.deepStrictEqual(pairs, [
    "anthropic/capped-out",
    "anthropic/claude-sonnet-4-5",
    "openrouter/deepseek/deepseek-v4-flash",
  ]);
});
