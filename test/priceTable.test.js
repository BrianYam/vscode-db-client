// API-sourced price table: status thresholds, lookup precedence, and the
// refresh merges (NA rows removed and reported, never silently). The LiteLLM
// list itself is litellmTable.test.js.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  findPrice,
  mergeFetched,
  mergeLitellm,
  rowStatus,
  STALE_MS,
} = require("../out/ai/priceTable.js");

const apiRow = (over = {}) => ({
  providerId: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  input: 0.038,
  output: 0.14,
  source: "api",
  fetchedAt: 1_000_000,
  ...over,
});

test("rowStatus: fresh under 30 days, stale at/after or never fetched", () => {
  const r = apiRow();
  assert.strictEqual(rowStatus(r, r.fetchedAt + STALE_MS - 1), "up to date");
  assert.strictEqual(rowStatus(r, r.fetchedAt + STALE_MS), "stale");
  assert.strictEqual(rowStatus(apiRow({ fetchedAt: undefined }), 0), "stale");
});

test("findPrice: exact provider+model beats substring; wrong provider misses", () => {
  const rows = [
    apiRow(),
    apiRow({ model: "deepseek/deepseek-v4", input: 1, output: 2 }),
    apiRow({
      providerId: "openai",
      model: "gpt-5-mini",
      source: "litellm",
      input: 0.25,
      output: 2,
    }),
  ];
  assert.strictEqual(findPrice("openrouter", "deepseek/deepseek-v4-flash", rows).input, 0.038);
  // Server-reported id more versioned than the listed one → same-provider substring.
  assert.strictEqual(findPrice("openrouter", "deepseek/deepseek-v4-flash-0731", rows).input, 0.038);
  // Substring match applies within the provider, across sources.
  assert.strictEqual(findPrice("openai", "gpt-5-mini-2025-08-07", rows).input, 0.25);
  // No cross-provider fallback and no invented prices.
  assert.strictEqual(findPrice("anthropic", "gpt-5-mini", rows), undefined);
  assert.strictEqual(findPrice("openai", "o1-pro", rows), undefined);
});

test("mergeFetched: updates api rows, removes NA models, reports them", () => {
  const rows = [
    apiRow(),
    apiRow({ model: "x-ai/grok-4.5", input: 3, output: 15 }),
    apiRow({ providerId: "other", model: "kept-untouched" }),
    apiRow({ providerId: "openrouter", model: "litellm-kept", source: "litellm" }),
  ];
  const models = [
    { id: "deepseek/deepseek-v4-flash", inputPerMTok: 0.05, outputPerMTok: 0.2 },
    // grok listed but price gone → NA → removed.
    { id: "x-ai/grok-4.5" },
  ];
  const { rows: next, removed } = mergeFetched(rows, "openrouter", models, 9_999);
  assert.deepStrictEqual(removed, ["x-ai/grok-4.5"]);
  const ds = next.find((r) => r.model === "deepseek/deepseek-v4-flash");
  assert.strictEqual(ds.input, 0.05);
  assert.strictEqual(ds.fetchedAt, 9_999);
  // Other providers and other sources pass through untouched.
  assert.ok(next.find((r) => r.providerId === "other"));
  assert.ok(next.find((r) => r.model === "litellm-kept"));
});

test("mergeLitellm: updates litellm rows from a PriceMap, leaves api rows alone", () => {
  const rows = [
    apiRow({ providerId: "openai", model: "gpt-5-mini", source: "litellm", input: 9, output: 9 }),
    apiRow({ providerId: "openai", model: "gone-model", source: "litellm" }),
    apiRow(), // openrouter api row untouched
  ];
  const prices = new Map([["gpt-5-mini", { input: 0.25, output: 2 }]]);
  const { rows: next, removed } = mergeLitellm(rows, "openai", prices, 7);
  assert.deepStrictEqual(removed, ["gone-model"]);
  const g = next.find((r) => r.model === "gpt-5-mini");
  assert.strictEqual(g.input, 0.25);
  assert.strictEqual(g.fetchedAt, 7);
  assert.ok(next.find((r) => r.providerId === "openrouter"));
});
