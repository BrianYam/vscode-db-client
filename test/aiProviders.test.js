// Provider adapters against a mock fetch: parsing, usage extraction, and the
// error normalization that keeps raw provider JSON out of the UI.
const { test } = require("node:test");
const assert = require("node:assert");
const { createAiProvider, AI_PRESETS, presetById } = require("../out/ai/registry.js");
const { isLocalBaseUrl, normalizeHttpError } = require("../out/ai/AiProvider.js");

function mockFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const OPENAI_CFG = {
  providerId: "openai",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-mini",
};
const ANTHROPIC_CFG = {
  providerId: "anthropic",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
};

test("openai-compat: parses text and exact usage", async () => {
  const fetch = mockFetch(200, {
    model: "gpt-5-mini-2026",
    choices: [{ message: { content: "SELECT 1" } }],
    usage: { prompt_tokens: 42, completion_tokens: 7 },
  });
  const p = createAiProvider(OPENAI_CFG, fetch);
  const r = await p.complete({ system: "s", user: "u" }, "sk-test");
  assert.strictEqual(r.text, "SELECT 1");
  assert.strictEqual(r.inputTokens, 42);
  assert.strictEqual(r.outputTokens, 7);
  // Model as reported by the server, not as requested.
  assert.strictEqual(r.model, "gpt-5-mini-2026");
});

test("openai-compat: hits {base}/chat/completions with Bearer auth", async () => {
  const fetch = mockFetch(200, {
    choices: [{ message: { content: "x" } }],
    usage: {},
  });
  await createAiProvider(OPENAI_CFG, fetch).complete({ system: "s", user: "u" }, "sk-abc");
  assert.strictEqual(fetch.calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.strictEqual(fetch.calls[0].init.headers.authorization, "Bearer sk-abc");
});

test("openai-compat: empty key sends no Authorization header (Ollama)", async () => {
  const fetch = mockFetch(200, { choices: [{ message: { content: "x" } }] });
  const cfg = { ...OPENAI_CFG, baseUrl: "http://localhost:11434/v1" };
  await createAiProvider(cfg, fetch).complete({ system: "s", user: "u" }, "");
  assert.strictEqual(fetch.calls[0].init.headers.authorization, undefined);
});

test("anthropic: parses content block and usage, sends required headers", async () => {
  const fetch = mockFetch(200, {
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "SELECT 2" }],
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  const p = createAiProvider(ANTHROPIC_CFG, fetch);
  const r = await p.complete({ system: "s", user: "u" }, "sk-ant");
  assert.strictEqual(r.text, "SELECT 2");
  assert.strictEqual(r.inputTokens, 10);
  assert.strictEqual(r.outputTokens, 3);
  assert.strictEqual(fetch.calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(fetch.calls[0].init.headers["x-api-key"], "sk-ant");
  assert.ok(fetch.calls[0].init.headers["anthropic-version"]);
  // max_tokens is mandatory on this API — must be present even when unset.
  assert.ok(JSON.parse(fetch.calls[0].init.body).max_tokens > 0);
});

test("openai-compat: retries once with max_completion_tokens on the rename 400", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            },
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
    };
  };
  const r = await createAiProvider(OPENAI_CFG, fetch).complete(
    { system: "s", user: "u", maxTokens: 512 },
    "sk",
  );
  assert.strictEqual(r.text, "OK");
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].max_tokens, 512);
  assert.strictEqual(calls[0].max_completion_tokens, undefined);
  assert.strictEqual(calls[1].max_tokens, undefined);
  assert.strictEqual(calls[1].max_completion_tokens, 512);
});

test("openai-compat: an unrelated 400 is not retried", async () => {
  let n = 0;
  const fetch = async () => {
    n++;
    return {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "invalid model" } }),
    };
  };
  await assert.rejects(
    () =>
      createAiProvider(OPENAI_CFG, fetch).complete(
        { system: "s", user: "u", maxTokens: 512 },
        "sk",
      ),
    /HTTP 400.*invalid model/s,
  );
  assert.strictEqual(n, 1);
});

test("401 normalizes to a key-rejected message, with vendor detail mined", async () => {
  const fetch = mockFetch(401, { error: { message: "invalid x-api-key" } });
  await assert.rejects(
    () => createAiProvider(ANTHROPIC_CFG, fetch).complete({ system: "s", user: "u" }, "bad"),
    (err) => {
      assert.match(err.message, /rejected by api\.anthropic\.com/);
      assert.match(err.message, /invalid x-api-key/);
      return true;
    },
  );
});

test("429 and 500 normalize to readable messages", () => {
  assert.match(normalizeHttpError(429, "h", "").message, /Rate limited/);
  assert.match(normalizeHttpError(500, "h", "not json <html>").message, /server error/);
});

test("network failure names the host, not a stack trace", async () => {
  const fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => createAiProvider(OPENAI_CFG, fetch).complete({ system: "s", user: "u" }, "k"),
    /Could not reach api\.openai\.com/,
  );
});

test("malformed success body is a readable error, not a crash", async () => {
  const fetch = mockFetch(200, { unexpected: true });
  await assert.rejects(
    () => createAiProvider(OPENAI_CFG, fetch).complete({ system: "s", user: "u" }, "k"),
    /no completion text/,
  );
});

test("presets: every preset creates a provider; Ollama is local and keyless", () => {
  for (const preset of AI_PRESETS.filter((p) => p.baseUrl)) {
    const provider = createAiProvider({
      providerId: preset.id,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
    });
    assert.ok(provider.config.providerId === preset.id);
  }
  assert.strictEqual(presetById("ollama").needsKey, false);
  assert.strictEqual(isLocalBaseUrl(presetById("ollama").baseUrl), true);
  assert.strictEqual(isLocalBaseUrl("https://api.openai.com/v1"), false);
});
