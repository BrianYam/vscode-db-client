# How AI pricing works in Open DB Client

Every dollar figure in the extension is an **estimate computed locally** from
two ingredients, both of which are real, fetched data:

1. **Exact token counts** — reported by the provider in each API response.
2. **A price per million tokens** — fetched into the price table, never
   shipped with or hardcoded into the extension.

No provider billing API is ever called (those need admin keys this extension
deliberately never asks for), so figures are estimates of list price, not
your invoice. Always verifiable against your provider dashboard.

## Where each surface gets its data

| Surface | Data shown | Source |
| --- | --- | --- |
| **Price table** (Settings → AI Assistant) | $/MTok per (provider, model) | Fetched: provider API or LiteLLM list |
| **Usage tables** (period / all-time) | requests, exact tokens, est. cost | Tokens: recorded per call. Cost: computed at render from the price table |
| **Model dropdown** during setup | `$… in / $… out /MTok` labels | Endpoint-reported (plain) or price-table annotation (`~` prefix) |
| **Assist bar** after Generate/Explain/Fix | `✓ 25.8s · 5263 tokens · ~$0.0021 · model` | Tokens: that call's response. Cost: price table at call time |

## The price table

Storage: `globalState` key `openDbClient.aiPriceTable` (size visible in
Settings → Uninstalling & your data). Rows are **read-only** — there is no way
to type a price into the extension. Each row records its **source**:

- **`provider API`** — the provider's own `/models` list carries pricing.
  OpenRouter-style endpoints do this (`pricing.prompt/completion`, per token,
  scaled to $/MTok in `src/ai/openaiCompat.ts`).
- **`LiteLLM`** — for providers whose APIs publish no pricing (verified: both
  OpenAI and Anthropic). Prices come from the [LiteLLM community price list]
  (https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
  a CI-auto-updated JSON the LiteLLM project itself fetches at runtime
  (~3 000 entries, exact dated ids like `gpt-5-mini-2025-08-07`). It is a
  labeled third-party source — accurate in practice, but not the provider's
  word. The download (~1.6 MB) is cached in memory for 1 hour
  (`src/ai/aiService.ts#litellmPrices`).

Rows enter the table only through **Add** (pick a provider → Load models →
pick a model; the provider-API price wins, LiteLLM is the fallback, and a
model neither source covers is refused with the reason). Providers that
require an API key contribute nothing until a key is stored — "Load models"
says so explicitly.

**↻ Refresh prices** re-fetches every row from its own source. Statuses:

- **up to date** — fetched successfully within 30 days.
- **stale** — older than 30 days, or its source was unreachable on refresh
  (the error is reported; the old number stays visible but aged).
- *(removed)* — the source no longer prices the model. The row is deleted and
  named in the refresh report; that model's costs revert to "—".

## The usage ledger

Every AI call (Generate / Explain / Fix / Test) appends one entry —
timestamp, provider preset, **server-reported** model id, verb, and the
response's exact `input/output` token counts (`src/ai/usageStore.ts`).
Entries are capped at 5 000 with the drop counted visibly; per-model running
totals survive the cap so "All time" stays exact.

**Costs are not stored.** They are computed at render time:
`exact tokens × current price table`. Two consequences, both deliberate:

- A model with no price row shows **"—", never a fake $0**; the total gains a
  `+?` marker so a partial sum can't masquerade as complete.
- History is costed at *today's* prices. If a provider changes its price and
  you Refresh, past rows re-cost accordingly. (Freezing cost per entry at
  call time is a known possible follow-up — see task M27.)

## Pricing in the model dropdown (setup)

When you ↻ fetch models for the active provider (`aiService.listModels`):

- A **plain** price (`$0.038 in / $0.14 out /MTok`) came from that endpoint's
  own response, this very fetch. OpenRouter shows these.
- A **`~` prefixed** price came from the price table (a prior fetch or a
  LiteLLM row) — the endpoint itself reported nothing. OpenAI/Anthropic
  models show these only after you've added their rows.
- **No price shown** = no row anywhere. The extension no longer invents
  family-based guesses (the old hardcoded seeds were provably wrong —
  e.g. gpt-5.4 is $2.50/$15, the seed claimed $1.25/$10).

## Per-call estimation (assist bar + ledger)

After each call, `aiService.run` computes
`estimateCost(inputTokens, outputTokens, findPrice(provider, model, table))`.
`findPrice` (`src/ai/priceTable.ts`) is provider-scoped:

1. exact `(provider, model)` row, else
2. the longest same-provider row whose model id is a substring of the
   server-reported id (servers often return a more-versioned id than the one
   listed), else
3. `undefined` → the assist bar simply omits the `~$…` segment.

The same lookup prices the usage tables, so the assist-bar figure and the
ledger row always agree.

## Code map

| Concern | File |
| --- | --- |
| Price row model, statuses, lookup, merges, LiteLLM parser | `src/ai/priceTable.ts` |
| Ledger arithmetic, storage keys, cost math | `src/ai/usageStore.ts` |
| Fetching (models, LiteLLM), add/refresh, per-call cost | `src/ai/aiService.ts` |
| Endpoint price parsing (OpenRouter-style) | `src/ai/openaiCompat.ts` |
| Settings UI (tables, add flow, refresh) | `src/webview/settingsPanel.ts` |
| Assist-bar cost line | `src/webview/queryPanel.ts` |
| Tests | `test/priceTable.test.js`, `test/aiUsage.test.js` |
