# Discovery — API-sourced Price Table (M27)

Date: 2026-08-08 · Status: **LOCKED 2026-08-08** · Source: user spec (chat, 10 points)

Lock notes: D1 initially = built-in fallback rows. **Superseded 2026-08-08**
by user directive "do not hardcode any value, all values must be true":
research confirmed neither OpenAI nor Anthropic offers a pricing API
(community thread + docs), so their prices now come from the **LiteLLM
community price list** (raw.githubusercontent.com/BerriAI/litellm/main/
model_prices_and_context_window.json — CI-updated, ~3 000 entries, exact
dated ids verified incl. gpt-5-mini-2025-08-07). Rows are labeled
`LiteLLM` vs `provider API`; SEED_PRICES deleted from the codebase. The
fetch is cached in-memory for 1 h (file is ~1.6 MB). D2 = 30 days. D3 =
legacy `aiPrices` values discarded; key purged by Reset All Data.

## Why

Cost estimates today come from a hand-editable price table seeded with 8
hardcoded model families. The models actually being used (deepseek, grok via
OpenRouter) can't even be added through the UI, so their costs show "—".
Hand-maintained prices drift; the provider API is the source of truth.

## Requirements (user spec, verbatim intent)

1. Usage table shows models actually used — **confirmed already true** (each
   call records providerId + server-reported model + exact tokens).
2. Prices are **not user-editable** (replaces the current editable table).
3. Price table rows are **(provider, model, input $/MTok, output $/MTok)**
   fetched from the provider API.
4. Only API-sourced entries exist. Providers that need a key to list models
   can only contribute prices once the user has stored a key.
5. Cost estimation (usage ledger + per-call assist bar) reads from this table.
6. New rows are added by choosing a provider, then a model from its list.
7. A **Refresh** button re-fetches all rows' prices from their providers.
8. Each row shows a **status**: `up to date` / `stale` / `not available`;
   NA rows are removed.
9. Models without pricing (provider doesn't publish it) → no estimate shown
   ("—" / omitted), never a fake $0. Already the codebase's honesty rule.
10. Usage table gains a **Provider** column (data already recorded).

## Technical findings (verified in code)

- `openaiCompat.listModels` already parses OpenRouter-style
  `pricing.prompt/completion` (per-token, scaled to $/MTok). **Plain OpenAI's
  `/models` has no pricing field; Anthropic's API likewise none.** Ollama/local:
  free, no pricing concept.
- Consequence of a strict "API-only" rule: **direct OpenAI / Anthropic
  connections lose cost estimates entirely** (their models become
  "not available" → removed → "—" everywhere). Decision D1 below.
- Keys are stored per provider in SecretStorage (`aiStore.getKey(providerId)`),
  so multi-provider fetching is possible without new secret plumbing.
- Usage rows already carry `providerId` (`totalsKey` = provider␀model␀verb);
  displaying it is UI-only.
- Matching must become **(provider, model) exact-id** lookup (API ids are
  canonical), replacing today's longest-substring model matching. Server may
  report a versioned id differing from the requested one; fall back to
  substring match within the same provider.

## Decisions to lock

- **D1 — providers whose API publishes no prices (OpenAI, Anthropic direct):**
  (a) strict: no prices, estimates disappear; or (b) keep a read-only built-in
  fallback table for these, rows clearly labeled `built-in` instead of a
  fetched timestamp. → USER
- **D2 — staleness threshold:** a row is `stale` when its last successful
  fetch is older than N days or the last refresh attempt failed. Proposed
  default N = 7. → USER
- **D3 — migration:** existing user-edited `openDbClient.aiPrices` values are
  discarded (table is no longer user-authored). Seed rows die with them.

## Out of scope

- Live account balances / billing APIs (deliberately excluded — admin keys).
- Auto-refresh on a timer (Refresh is manual; staleness makes age visible).
