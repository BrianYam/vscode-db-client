// Per-provider endpoint memory: switching preset must restore what that
// provider was saved with, not reset to the preset's default model.
const { test } = require("node:test");
const assert = require("node:assert");
const { withProviderMemory } = require("../out/ai/aiStore.js");

const settings = (over = {}) => ({
  providerId: "openai",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-nano",
  litellmProvider: "",
  perProvider: {},
  consentGiven: false,
  disabledConnections: [],
  ...over,
});

test("seeds the active provider from the flat settings when it has no entry", () => {
  // The pre-M30 shape: one endpoint triple, no memory. Without this seed the
  // first switch away and back would drop gpt-5-nano for the preset default.
  const s = withProviderMemory(settings());
  assert.deepStrictEqual(s.perProvider.openai, {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-nano",
    litellmProvider: "",
  });
});

test("never overwrites an entry the user already saved", () => {
  const s = withProviderMemory(
    settings({ model: "gpt-5-mini", perProvider: { openai: { model: "gpt-5-nano" } } }),
  );
  assert.deepStrictEqual(s.perProvider.openai, { model: "gpt-5-nano" });
});

test("leaves other providers' memory untouched", () => {
  const s = withProviderMemory(
    settings({ perProvider: { anthropic: { model: "claude-opus-4" } } }),
  );
  assert.strictEqual(s.perProvider.anthropic.model, "claude-opus-4");
  assert.strictEqual(s.perProvider.openai.model, "gpt-5-nano");
});

test("no provider chosen yet — nothing to seed", () => {
  const s = settings({ providerId: "", model: "" });
  assert.strictEqual(withProviderMemory(s), s);
  assert.deepStrictEqual(s.perProvider, {});
});

test("custom endpoints remember their base URL and LiteLLM mapping too", () => {
  const s = withProviderMemory(
    settings({
      providerId: "custom",
      baseUrl: "http://192.168.1.9:8000/v1",
      model: "qwen2.5-coder",
      litellmProvider: "groq",
    }),
  );
  assert.deepStrictEqual(s.perProvider.custom, {
    baseUrl: "http://192.168.1.9:8000/v1",
    model: "qwen2.5-coder",
    litellmProvider: "groq",
  });
});
