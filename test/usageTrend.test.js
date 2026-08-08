// Daily trend buckets: windowing, grouping, unpriced honesty, the "other" fold.
const { test } = require("node:test");
const assert = require("node:assert");
const { usageTrend } = require("../out/ai/usageTrend.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 8, 12); // 2026-08-08 noon UTC
const entry = (over = {}) => ({
  ts: NOW,
  providerId: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  verb: "generate",
  inputTokens: 1000,
  outputTokens: 500,
  ...over,
});
const state = (entries) => ({ entries, dropped: 0, periodStart: 0, totals: {} });
const flashPrice = (providerId, model) =>
  providerId === "openrouter" && model.startsWith("deepseek") ? { input: 1, output: 2 } : undefined;

test("buckets by UTC day inside the window; outside entries excluded", () => {
  const t = usageTrend(
    state([
      entry(),
      entry({ ts: NOW - 2 * DAY, inputTokens: 100, outputTokens: 0 }),
      entry({ ts: NOW - 31 * DAY }), // before the 30-day window
      entry({ ts: NOW + 2 * DAY }), // clock skew — never charted
    ]),
    flashPrice,
    "provider",
    NOW,
  );
  assert.strictEqual(t.days.length, 30);
  assert.strictEqual(t.days[29], "2026-08-08");
  assert.strictEqual(t.charted, 2);
  const s = t.series[0];
  assert.strictEqual(s.key, "openrouter");
  assert.strictEqual(s.tokens[29], 1500);
  assert.strictEqual(s.tokens[27], 100);
  // cost: 1000×$1/M + 500×$2/M = 0.002
  assert.ok(Math.abs(s.cost[29] - 0.002) < 1e-9);
});

test("groupBy model splits series; unpriced calls counted, not cost-summed", () => {
  const t = usageTrend(
    state([entry(), entry({ model: "x-ai/grok-4.5" })]),
    flashPrice,
    "model",
    NOW,
  );
  assert.strictEqual(t.series.length, 2);
  const grok = t.series.find((s) => s.key === "x-ai/grok-4.5");
  assert.strictEqual(grok.unpriced, 1);
  assert.strictEqual(grok.cost[29], 0); // never a guessed cost
  assert.strictEqual(grok.tokens[29], 1500); // tokens always charted
});

test("more than 6 keys fold into 'other', totals preserved", () => {
  const entries = [];
  for (let i = 0; i < 9; i++) {
    entries.push(entry({ model: "m" + i, inputTokens: 1000 - i, outputTokens: 0 }));
  }
  const t = usageTrend(state(entries), () => undefined, "model", NOW);
  assert.strictEqual(t.series.length, 6);
  assert.strictEqual(t.series[5].key, "other");
  const chartedTokens = t.series.reduce((sum, s) => sum + s.tokens[29], 0);
  assert.strictEqual(
    chartedTokens,
    entries.reduce((sum, e) => sum + e.inputTokens, 0),
  );
});
