// Local LiteLLM mirror (M29): what survives the parse into storage, and the
// namespaced-id lookup that scopes every price to one provider.
const { test } = require("node:test");
const assert = require("node:assert");
const { litellmModelsFor, lookupLitellm, parseLitellmTable } = require("../out/ai/litellmTable.js");

// Mirrors the real file's shapes: bare ids for OpenAI/Anthropic direct,
// provider-prefixed ids for everyone else, plus the rows that must be dropped.
const JSON_FIXTURE = {
  "gpt-5-mini": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 2.5e-7,
    output_cost_per_token: 2e-6,
  },
  "o1-pro": {
    litellm_provider: "openai",
    mode: "responses",
    input_cost_per_token: 1.5e-4,
    output_cost_per_token: 6e-4,
  },
  "claude-sonnet-4-6": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
  },
  "openrouter/anthropic/claude-3.5-sonnet": {
    litellm_provider: "openrouter",
    mode: "chat",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
  },
  "ollama/llama3.1": {
    litellm_provider: "ollama",
    mode: "chat",
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
  // A different host's llama — the reason lookups are provider-scoped.
  "deepinfra/llama3.1": {
    litellm_provider: "deepinfra",
    mode: "chat",
    input_cost_per_token: 5e-8,
    output_cost_per_token: 9e-8,
  },
  "no-mode-still-counts": {
    litellm_provider: "mistral",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
  },
  // Dropped: not a chat model, no costs, unattributable, non-numeric.
  "dall-e-3": {
    litellm_provider: "openai",
    mode: "image_generation",
    input_cost_per_token: 1e-5,
    output_cost_per_token: 1e-5,
  },
  "text-embedding-3": {
    litellm_provider: "openai",
    mode: "embedding",
    input_cost_per_token: 2e-8,
    output_cost_per_token: 0,
  },
  orphan: { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  broken: { litellm_provider: "openai", mode: "chat", input_cost_per_token: "x" },
  sample_spec: {
    input_cost_per_token: "the cost per input token",
    mode: "one of: chat, embedding",
  },
};

const parsed = () => parseLitellmTable(JSON_FIXTURE);
const idsOf = (entries) => entries.map((e) => e[0]).sort();

test("parseLitellmTable: keeps every provider's priced chat models", () => {
  // Unlike M27's per-provider parse, one table spans all providers.
  assert.deepStrictEqual(idsOf(parsed()), [
    "claude-sonnet-4-6",
    "deepinfra/llama3.1",
    "gpt-5-mini",
    "no-mode-still-counts",
    "o1-pro",
    "ollama/llama3.1",
    "openrouter/anthropic/claude-3.5-sonnet",
  ]);
});

test("parseLitellmTable: drops non-chat, unpriced, unattributable and the doc stub", () => {
  const ids = idsOf(parsed());
  for (const gone of ["dall-e-3", "text-embedding-3", "orphan", "broken", "sample_spec"]) {
    assert.ok(!ids.includes(gone), `${gone} should not be stored`);
  }
});

test("parseLitellmTable: scales per-token to $/MTok without FP junk", () => {
  const gpt = parsed().find((e) => e[0] === "gpt-5-mini");
  assert.deepStrictEqual(gpt, ["gpt-5-mini", "openai", 0.25, 2]);
  // 3e-6 * 1e6 is 2.9999999999999996 before rounding.
  const claude = parsed().find((e) => e[0] === "claude-sonnet-4-6");
  assert.strictEqual(claude[2], 3);
  assert.strictEqual(claude[3], 15);
});

test("parseLitellmTable: a published 0 is a real price, not an unknown", () => {
  // Local models genuinely cost nothing — $0.00 is true here, unlike the
  // guessed $0 the price table forbids for models with no source at all.
  assert.deepStrictEqual(lookupLitellm(parsed(), "ollama", "llama3.1"), { input: 0, output: 0 });
});

test("parseLitellmTable: tolerates junk input", () => {
  assert.deepStrictEqual(parseLitellmTable(null), []);
  assert.deepStrictEqual(parseLitellmTable("nope"), []);
  assert.deepStrictEqual(parseLitellmTable({}), []);
});

test("lookupLitellm: bare ids (OpenAI/Anthropic direct)", () => {
  assert.deepStrictEqual(lookupLitellm(parsed(), "openai", "gpt-5-mini"), {
    input: 0.25,
    output: 2,
  });
  assert.deepStrictEqual(lookupLitellm(parsed(), "anthropic", "claude-sonnet-4-6"), {
    input: 3,
    output: 15,
  });
});

test("lookupLitellm: provider-prefixed ids matched from the unprefixed id", () => {
  // OpenRouter's own /models returns "anthropic/claude-3.5-sonnet"; the list
  // stores "openrouter/anthropic/claude-3.5-sonnet".
  assert.deepStrictEqual(lookupLitellm(parsed(), "openrouter", "anthropic/claude-3.5-sonnet"), {
    input: 3,
    output: 15,
  });
});

test("lookupLitellm: scoped to one provider — no cross-host borrowing", () => {
  const t = parsed();
  // Same model name, two hosts, different prices: each provider gets its own.
  assert.deepStrictEqual(lookupLitellm(t, "ollama", "llama3.1"), { input: 0, output: 0 });
  assert.deepStrictEqual(lookupLitellm(t, "deepinfra", "llama3.1"), { input: 0.05, output: 0.09 });
  // A provider the table doesn't price this model for gets nothing, never a
  // number lifted from another host.
  assert.strictEqual(lookupLitellm(t, "openai", "llama3.1"), undefined);
  assert.strictEqual(lookupLitellm(t, "anthropic", "gpt-5-mini"), undefined);
});

test("lookupLitellm: case-insensitive, and unknown models return undefined", () => {
  assert.ok(lookupLitellm(parsed(), "openai", "GPT-5-Mini"));
  assert.strictEqual(lookupLitellm(parsed(), "openai", "gpt-9-imaginary"), undefined);
  assert.strictEqual(lookupLitellm([], "openai", "gpt-5-mini"), undefined);
});

test("lookupLitellm: the more specific prefixed id wins over a bare collision", () => {
  const entries = [
    ["shared-id", "acme", 1, 2],
    ["acme/shared-id", "acme", 8, 9],
  ];
  assert.deepStrictEqual(lookupLitellm(entries, "acme", "shared-id"), { input: 8, output: 9 });
  // Order-independent: the prefixed row still wins when it comes first.
  assert.deepStrictEqual(lookupLitellm(entries.reverse(), "acme", "shared-id"), {
    input: 8,
    output: 9,
  });
});

test("litellmModelsFor: only that provider's ids", () => {
  assert.deepStrictEqual(litellmModelsFor(parsed(), "ollama"), ["ollama/llama3.1"]);
  assert.deepStrictEqual(litellmModelsFor(parsed(), "openai").sort(), ["gpt-5-mini", "o1-pro"]);
  assert.deepStrictEqual(litellmModelsFor(parsed(), "nobody"), []);
});
