# Discovery — Local LiteLLM price table + auto-pricing (M29)

Date: 2026-08-08 · Status: **LOCKED 2026-08-08** · Source: user spec (chat,
5 points) · Extends: `DISCOVERY_PRICE_TABLE.md` (M27, LOCKED)

Lock notes: D1–D5 were put to the user as open decisions; the user elected to
proceed rather than adjudicate each, so they are locked at the **recommended
default** with the rationale recorded below. Each is reversible before its
task lands — they are defaults, not findings.

## Why

M27 made every price fetched and labeled, but LiteLLM — the only
machine-readable source for providers whose APIs publish no pricing — is
still a **transient, per-provider, in-memory** fetch (`aiService.ts:193`,
1 h TTL, filtered through `LITELLM_PROVIDER_IDS`, which maps exactly two
providers). Four consequences the user hit:

1. **Offline or first-run → no LiteLLM fallback at all.** The cache dies with
   the window.
2. **79 of the 81 providers LiteLLM prices are invisible to us.** deepseek,
   grok/openrouter, groq, mistral, gemini, bedrock, fireworks — the exact
   models M27's Discovery named as unpriceable ("their costs show —").
3. **The model dropdown can't show a price** before you commit to a model: a
   price costs a 1.6 MB download scoped to one provider.
4. **Selecting a new model leaves its usage at "—"** until the user
   remembers to open the price table and add a row by hand.

## Requirements (user spec, verbatim intent)

1. Fetch and keep **all** LiteLLM pricing in a persisted **LiteLLM table** —
   not per-provider, not in-memory-only.
2. That table shows a **status**: up to date / stale.
3. **Query cost estimates read the price table** (unchanged contract).
4. **In the model dropdown**: show the provider API's price when it publishes
   one; otherwise the price from the LiteLLM table.
5. **Using a new model automatically stores its price into the price list.**

## Verified findings (measured against the live file, 2026-08-08)

- **2 987 entries; 2 237 are chat/responses *and* carry both token costs;
  81 distinct `litellm_provider` values.** Top by count: fireworks_ai 276,
  bedrock 188, azure 157, openai 112, openrouter 96, deepinfra 67,
  mistral 51, gemini 48.
- **Size is a non-issue if trimmed.** Raw file 1.6 MB; the 2 237 priced chat
  rows as `[id, provider, $in/MTok, $out/MTok]` tuples rounded via
  `toPrecision(6)` = **129 KB** (166 KB as objects). 12× smaller than raw,
  and comparable to the existing 5 000-entry usage ledger. It **must** be
  registered in the storage-usage panel (`settingsPanel.ts:249`) and purged
  by Reset All Data — an unlisted 129 KB key would violate the "measure
  everything this install persists" promise.
- **LiteLLM ids are provider-namespaced, but inconsistently.** OpenAI and
  Anthropic direct entries are bare (`gpt-5-mini-2025-08-07`,
  `claude-sonnet-4-5`); everyone else is prefixed
  (`openrouter/anthropic/claude-3.5-sonnet`, `groq/llama-3.1-8b-instant`,
  `deepseek/deepseek-chat`). **OpenRouter's own `/models` API returns the
  unprefixed `anthropic/claude-3.5-sonnet`.** So lookup must try
  `<litellm_provider>/<id>` *then* bare `<id>`, scoped by the provider field.
  Today's `parseLitellmPrices` returns a bare-key map for one provider and
  cannot express this — it is replaced, not extended.
- `PriceRow.source` (`"api" | "litellm"`) already encodes the tier split, and
  `findPrice` is already the single estimate path (usage ledger + per-call
  assist bar). Req 3 therefore needs **no** change to the estimate lookup.
- `refreshPrices` currently deletes rows their source no longer prices. With
  a local table that check becomes cheap and works offline.

## Proposed architecture — two tables, one lookup

- **LiteLLM table** — new `openDbClient.aiLitellmPrices`: the trimmed mirror
  (all providers) + `fetchedAt`. Status reuses M27's `STALE_MS` (30 days).
  It is a **cache of an external source**: rebuilt wholesale on refresh,
  never user-edited, safe to delete.
- **Price table** — existing `openDbClient.aiPriceTable`: unchanged meaning.
  These are the rows estimates read, each a **dated snapshot** of whichever
  source priced it. Auto-add writes here.
- `findPrice` stays the only estimate path. The LiteLLM table is a *source*,
  not a second lookup tier for cost estimates — otherwise "which number did
  this estimate use" stops being answerable from one visible table.

Why keep the copy at all, when the LiteLLM table is local and complete?
Because req 5 asks for it, and it buys three things a pass-through wouldn't:
the row stays visible and removable (✕), it records *when* that price was
true, and estimates don't silently change under the user when LiteLLM
re-publishes a number.

## Decisions (locked at the recommended default)

- **D1 — "using a new model" = a call recorded in the usage ledger.**
  Auto-add fires where usage is already recorded, keyed on the
  **server-reported** model id. Saving a model in Settings does *not* by
  itself add a row. Rationale: the server routinely reports a more versioned
  id than the one requested — that mismatch is precisely why M27 needed
  substring matching — so pricing the *requested* id would file the price
  under a name the ledger never uses. Pricing on first real call is also
  self-limiting: only models that cost money get rows.
- **D2 — auto-add re-adds a row the user ✕'d.** No dismissed-pairs state.
  Rationale: actually calling a model is a stronger signal than an earlier
  ✕, and a visible removable row beats a silently missing estimate. Accepted
  cost: ✕ means "hide until next use", which the UI must not imply is
  permanent.
- **D3 — custom / unmapped endpoints map to a LiteLLM provider the user
  picks.** Optional; unset = no LiteLLM fallback (today's behaviour, "—").
  Rationale: bare-id matching across all 81 providers would happily price a
  local `llama-3.1-8b` off an unrelated cloud host's row — a fabricated
  number presented as real, which the codebase's honesty rule forbids
  outright.
- **D4 — manual ↻ refresh, plus one automatic fetch when the table is
  empty.** No timers, no refetch-on-open. Rationale: M27 put auto-refresh
  explicitly out of scope and made staleness visible instead; a stale row
  still prices, it just says so. A 1.6 MB download on opening Settings is
  not something the user asked for.
- **D5 — the dropdown shows a price column with "—" for unpriced models.**
  Rationale: consistent with the rest of the UI, and "—" is information
  (it tells you that model's usage will never be costed). Revisit only if
  it measurably hurts on an 800-model OpenRouter list.

## Out of scope

- Live account balances / billing APIs (inherited from M27).
- Shipping any price with the extension — the LiteLLM table starts **empty**
  and is fetched, so "no price is hardcoded" still holds literally.
- Vendoring the LiteLLM file into the VSIX (would be a shipped price, and
  stale on day one).
