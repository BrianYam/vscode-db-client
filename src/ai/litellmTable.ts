/**
 * Local mirror of the LiteLLM community price list (Discovery:
 * docs/DISCOVERY_LITELLM_TABLE.md, M29).
 *
 * M27 fetched this list per-provider into a 1 h in-memory cache, filtered
 * through a two-entry provider map — so it vanished with the window, was
 * useless offline, and priced only OpenAI and Anthropic. This module keeps
 * the whole list instead: every provider LiteLLM prices, persisted, with a
 * fetch timestamp so age is visible.
 *
 * It is a cache of an external source: rebuilt wholesale on refresh, never
 * user-edited, safe to delete. It is NOT the price table — estimates read
 * `PriceRow`s (priceTable.ts), which this feeds. Keeping one visible table
 * as the estimate path is what makes "which number produced this cost?"
 * answerable.
 */

/** Trimmed to a tuple: 2 237 priced chat models cost ~129 KB this way, ~1.6 MB raw. */
export type LitellmEntry = [
  /** Lowercased LiteLLM id, e.g. "gpt-5-mini" or "openrouter/anthropic/claude-3.5-sonnet". */
  id: string,
  /** The list's own `litellm_provider` field, e.g. "openai", "openrouter". */
  provider: string,
  /** USD per million input tokens. */
  input: number,
  /** USD per million output tokens. */
  output: number,
];

export interface LitellmTable {
  entries: LitellmEntry[];
  /** Last successful fetch — drives the up-to-date/stale badge. */
  fetchedAt: number;
}

/** The price list LiteLLM itself fetches at runtime — CI-updated on GitHub. */
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Parse the raw LiteLLM JSON into storable tuples.
 *
 * Keeps every provider (unlike M27's per-provider filter) but only entries
 * that can price a chat call: a chat/responses mode and both token costs
 * present. Image/audio/embedding rows would produce meaningless SQL-assist
 * estimates. The list's `sample_spec` documentation stub carries neither
 * cost field, so it fails this filter without a special case.
 *
 * Costs are per-token there; scaled to per-million and rounded to 6
 * significant digits — 1e-6-scale floats otherwise store as FP junk like
 * 0.30000000000000004.
 */
export function parseLitellmTable(json: unknown): LitellmEntry[] {
  const out: LitellmEntry[] = [];
  if (!json || typeof json !== "object") {
    return out;
  }
  for (const [id, entry] of Object.entries(json as Record<string, unknown>)) {
    const e = entry as {
      litellm_provider?: unknown;
      mode?: unknown;
      input_cost_per_token?: unknown;
      output_cost_per_token?: unknown;
    };
    if (typeof e?.litellm_provider !== "string") {
      continue; // unscopeable — a price we couldn't attribute to a provider
    }
    if (e.mode !== undefined && e.mode !== "chat" && e.mode !== "responses") {
      continue;
    }
    const inTok = e.input_cost_per_token;
    const outTok = e.output_cost_per_token;
    if (typeof inTok !== "number" || typeof outTok !== "number") {
      continue;
    }
    // A published 0 (local/free models) is a real price, not an unknown one —
    // it estimates as $0.00, which is true. "Never a fake $0" is about models
    // with NO source; those stay absent from this table entirely.
    out.push([
      id.toLowerCase(),
      e.litellm_provider,
      Number((inTok * 1_000_000).toPrecision(6)),
      Number((outTok * 1_000_000).toPrecision(6)),
    ]);
  }
  return out;
}

/**
 * Find one model's price, scoped to a LiteLLM provider.
 *
 * The list namespaces ids inconsistently: OpenAI and Anthropic direct entries
 * are bare (`gpt-5-mini-2025-08-07`, `claude-sonnet-4-5`) while everyone else
 * is prefixed (`openrouter/anthropic/claude-3.5-sonnet`, `deepseek/deepseek-chat`).
 * Providers report the *unprefixed* id — OpenRouter's own /models returns
 * `anthropic/claude-3.5-sonnet` — so both shapes must be tried. The provider
 * scope is what stops a local `llama-3.1-8b` matching an unrelated cloud host.
 */
export function lookupLitellm(
  entries: LitellmEntry[],
  litellmProvider: string,
  modelId: string,
): { input: number; output: number } | undefined {
  const bare = modelId.toLowerCase();
  const prefixed = `${litellmProvider}/${bare}`;
  let fallback: LitellmEntry | undefined;
  for (const e of entries) {
    if (e[1] !== litellmProvider) {
      continue;
    }
    if (e[0] === prefixed) {
      return { input: e[2], output: e[3] }; // most specific — done
    }
    if (e[0] === bare) {
      fallback = e;
    }
  }
  return fallback ? { input: fallback[2], output: fallback[3] } : undefined;
}

/** Distinct model ids this provider is priced for — feeds the dropdown. */
export function litellmModelsFor(entries: LitellmEntry[], litellmProvider: string): string[] {
  return entries.filter((e) => e[1] === litellmProvider).map((e) => e[0]);
}
