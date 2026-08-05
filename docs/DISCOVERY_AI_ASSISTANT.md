# Discovery — AI Query Assistance (BYOK) + Usage Monitor

Status: **LOCKED 2026-08-05** (see §9). Raised 2026-08-05.
Requested: (1) a settings surface to store the user's own API key for Anthropic, OpenAI,
"or any of the other modern AI models"; (2) AI assistance in the query box — describe the
intent in natural language, the AI uses connection context to build the query; (3) a place
to monitor AI usage by credits / usage / cost.

## 1. The 7-Question Foundation

**Why.** The query panel now has autocomplete and formatting, but the user still has to
*know SQL* and *know the schema's shape* to get anywhere. "Show me savings plans that
charged a fee last month" is a 30-second thought and a 5-minute query for someone who
doesn't live in this database. Every serious competitor (§3) has shipped this; for a
Marketplace extension it is fast becoming table stakes. The BYOK model means the feature
costs us nothing to run — the user pays their own provider directly.

**Success.**
- A key pasted once into settings enables an "Ask AI" affordance in the query panel.
- Typing intent in plain language yields runnable SQL for the *connected engine's dialect*,
  aware of the *actual tables and columns*, inserted into the editor — **never auto-run**.
- A usage view shows requests, input/output tokens, and estimated cost, per provider/model,
  accumulated locally.
- Zero regression to the extension's pitch: lightweight, no native deps, no account with us.

**Scope.** Settings panel (key entry + provider/model pick), query panel (the assist UX),
a small provider-adapter layer in the host, a local usage ledger + view. PostgreSQL, MySQL,
SQLite dialects; Redis gets command-generation from the same plumbing if cheap, else it is
deferred (different language, same argument as autocomplete).

**Boundaries (out of scope, v1).**
- No agentic multi-step execution (AI running queries by itself, iterating on results).
- No chat sidebar with long conversation history — v1 is prompt → SQL (+ short explanation),
  with one-shot "fix this error" as the only follow-up.
- No hosted proxy, no billing of our own, no telemetry of anyone's prompts. BYOK only.
- No fine-tuning / embeddings / schema indexing beyond what `schemaHints` already returns.
- No sending of **row data** to providers (see §6 — this is a privacy line, not a cut).

**Stakeholders.** Single author; the user is the operator. Marketplace users are the
audience — which now matters: this is a published extension, so defaults must be safe for
strangers' production databases, not just our own.

**Constraints.**
- CSP-locked webviews; all network calls happen in the **host**, never the webview.
- Bundle is 2.9 MB and "lightweight" is the pitch: **no provider SDKs**. Both target APIs
  are a single `fetch` POST; adapters are ~50 lines each.
- Secrets live in SecretStorage — same rule as DB passwords, no exceptions.
- Single author: v1 must be shippable in one module cycle.

**Risks.**
(a) *Wrong SQL that looks right* — mitigated by never auto-running, showing the SQL for
review, and the existing grid making results inspectable.
(b) *Destructive SQL* (`DROP`, `DELETE` without `WHERE`) — needs a visible warning tag on
generated statements, reusing the honesty-first UX convention.
(c) *Price-table drift* — cost figures are estimates from a local table; must be labeled
as such and user-editable (§5).
(d) *Provider API drift* — minimized by supporting exactly two wire protocols (§4), both
of which are the industry's stable standards.
(e) *Schema leaves the machine* — table/column names go to a third party; requires explicit
opt-in at first use, per-connection opt-out (§6). PDPA/data-sovereignty concern for users
querying regulated databases.

## 2. What already exists (verified, not assumed)

The context-gathering half of this feature is **already built**:

- **`Driver.schemaHints(database?)`** returns tables, columns, and a **per-table column
  map** (`Driver.ts:44` — made table-aware during the autocomplete work). This is exactly
  the schema context an LLM prompt needs, and it is already cached per `connId::database`.
- **`Driver.getDDL(path)`** returns CREATE-style definitions — richer context (types,
  keys) for the specific tables the user names, when the flat map isn't enough.
- **`connections/store.ts`** already splits configs (globalState) from secrets
  (SecretStorage) — the API-key storage pattern is a copy, not an invention.
- **`settingsPanel.ts`** is a guides-style webview with per-section navigation — a natural
  home for "AI Assistant" settings + the usage view.
- **`queryPanel.ts`** message-passing pattern (`type` switch → `handle*` → driver) extends
  directly: `aiGenerate` → host builds prompt → provider adapter → post SQL back.
- **`queryStore.ts`** persists per-connection query history in globalState — the same
  mechanism works for a usage ledger.
- The **registry pattern** (`drivers/registry.ts`) is the architectural template: an
  `AiProvider` interface + one adapter file per protocol + a registry keyed by provider id.

What does **not** exist: any outbound HTTP from the extension (drivers speak database wire
protocols; `marketplace-status.mjs` is a build script). AI calls will be the first
network-to-the-internet feature — one more reason consent must be explicit.

## 3. Prior art — copy, don't innovate

| Product | Model | What they ship | What we copy |
|---|---|---|---|
| **TablePlus** | **BYOK** (OpenAI, Anthropic, Ollama) | Text-to-SQL + chat assist in a paid-license client | **The whole shape.** Closest analogue: lightweight client, user's own key, no vendor billing. Their provider list (incl. local Ollama) is the right v1 list. |
| **DataGrip AI Assistant** | JetBrains subscription ($10/mo add-on) | NL→SQL with deep schema context, explain, fix | The *context discipline*: suggestions grounded in the real schema, not generic SQL. Their attach-schema consent prompt. |
| **DBeaver AI** | Pro/Enterprise editions | Query generation from the live connection's metadata | Per-connection AI enable/disable toggle; scope of schema shared is visible to the user. |
| **Outerbase** | Hosted (acquired by Cloudflare, effectively gone) | AI-first DB UI | A cautionary tale for hosted/proxied models — BYOK is also the *durable* choice. |
| **GitHub Copilot / VS Code** | Subscription; **BYOK added for individuals** | Inline AI everywhere | The UX grammar users already know: ghost-text/inline suggestion, explicit accept. |

Gold standard consensus: **BYOK, schema-grounded, never auto-run, local-first metering.**
Nobody exposes provider *billing balances* in-client (§5 explains why we can't either).

## 4. Provider protocol reality & options

There is no single protocol, but there are exactly **two that matter**:

1. **OpenAI-compatible Chat Completions** — the de-facto standard. OpenAI itself, plus
   Groq, DeepSeek, Mistral, Google Gemini (compat endpoint), OpenRouter, **Ollama and
   LM Studio locally** — all speak it. One adapter + a configurable base URL covers the
   entire long tail, including "any of the other modern AI models" and fully-local models.
2. **Anthropic Messages API** — different endpoint, headers (`x-api-key`,
   `anthropic-version`), and response shape. Worth its own small adapter (Claude is
   explicitly requested and is the strongest SQL model family).

Both return **token usage in every response** — the fact that makes §5 free.

| | Approach | Cost | Verdict |
|---|---|---|---|
| **A** | Two hand-rolled `fetch` adapters (OpenAI-compat with custom base URL, Anthropic) behind an `AiProvider` interface + registry, mirroring `Driver` | ~2 small files; 0 KB of dependencies | **Recommended.** Covers named providers + Ollama/OpenRouter/anything via base URL. Same architecture rule that already governs the codebase. |
| **B** | Bundle an SDK (`openai`, `@anthropic-ai/sdk`) or a gateway lib (LiteLLM-style) | Hundreds of KB, transitive deps, version churn | Rejected — contradicts the lightweight constraint for two POST requests' worth of value. |
| **C** | Route through a hosted gateway (OpenRouter-only, or our own proxy) | Simplest single protocol | Rejected as the *only* path (third party between user and their key), but OpenRouter works automatically under A via base URL. |

**Streaming**: both protocols support SSE streaming. v1 can ship non-streaming (SQL answers
are short); the adapter interface should not preclude adding it.

## 5. Usage monitoring — what is actually possible

The honest version, stated up front because the request says "credits, usage, or cost":

- **Token usage**: every API response carries exact input/output token counts. We record
  `{ts, provider, model, inputTokens, outputTokens, feature}` in a local ledger
  (globalState, `queryStore.ts` pattern). **Exact, free, offline.**
- **Cost**: computed as tokens × a **local, user-editable price table** seeded with current
  per-model prices. Labeled *"estimated — verify in your provider dashboard"*. Prices
  drift; honesty over false precision.
- **Credits / balance**: **not feasible with a plain API key.** OpenAI's usage/costs API
  and Anthropic's usage & cost API both require separate *admin/organization* keys that
  most users don't have and that we should not encourage pasting into an editor extension.
  No competitor shows live balances either. The usage view links out to each provider's
  dashboard instead.

Usage view (in the settings panel): totals + per-model breakdown, this month / all time,
per-feature split (generate vs explain vs fix), and a "reset period" action.

## 6. Security & privacy requirements (Phase-1, non-negotiable)

- API keys → **SecretStorage only**; masked in the form (`pwwrap`/eye pattern); never
  logged, never in exports (the connection-export formats do not gain an AI-keys section
  in v1 — a key is one paste to restore; an exported key is a liability).
- **What is sent** to a provider: the user's prompt + schema *names/types* (tables,
  columns, optionally DDL of referenced tables) + engine dialect. **Never row data, never
  query results, never credentials, never connection hosts.**
- **First-use consent gate** naming exactly what will be shared and with whom, with a
  linkable "What the AI can see" guide page. Per-connection "no AI on this connection"
  toggle for regulated databases (PDPA / data-sovereignty).
- Generated SQL is **inserted, highlighted, and left for the user to run**. Statements
  matching destructive shapes (`DROP|TRUNCATE|DELETE/UPDATE` without `WHERE`, `ALTER`) get
  a visible warning tag before the user runs them.
- All provider calls from the **host** (webview CSP already forbids external fetch — keep
  it that way).
- Local providers (Ollama base URL) work with no key and no consent gate beyond localhost
  notice — the fully-private option, and cheap to support since it is protocol A.

## 7. Moat / indispensability

Autocomplete made the panel *where you write queries*; NL→SQL makes it *where you start
them*. For the Marketplace audience it removes the last reason to pay for DataGrip AI or
DBeaver Pro next to a free extension — BYOK + local-model support is a genuine
differentiator in the VS Code extension space, where the incumbent DB extensions gate AI
behind their own subscriptions. The usage ledger compounds the trust story: your key, your
data, your meter, on your machine.

## 8. Open decisions for the lock — RESOLVED 2026-08-05 (see §9)

1. **v1 provider list** — recommend: **Anthropic, OpenAI, OpenAI-compatible custom
   base URL** (labeled presets for Ollama/OpenRouter). Is that the right cut, or must any
   named provider (e.g. Gemini native) be first-class in v1?
2. **Assist UX shape** — recommend an **inline assist bar** in the query panel (prompt
   field above the editor; result inserted into the editor with an explanation line), not
   a chat sidebar. Matches "help us build the query", smallest surface, copies TablePlus.
3. **v1 verbs** — recommend three: **Generate** (NL→SQL), **Explain** (selection → prose),
   **Fix** (last error + statement → corrected SQL). Anything else is scope creep.
4. **Redis in v1?** — recommend defer (same reasoning as autocomplete: different language).
5. **Default model per provider** — recommend a sensible default (e.g. current Claude
   Sonnet / GPT-4-class mini) with a free-text model override, not a hardcoded list that
   goes stale.

## 9. Validation gate — LOCKED 2026-08-05

All §8 recommendations approved:

1. **Providers**: Anthropic + OpenAI + OpenAI-compatible custom base URL (with labeled
   presets for Ollama / OpenRouter).
2. **UX**: inline assist bar in the query panel; SQL inserted for review, never auto-run.
3. **Verbs**: all three — Generate, Explain, Fix.
4. **Redis**: deferred to a later milestone.
5. **Models**: sensible per-provider default + free-text override.

**Added at the lock:**

- The assist bar's **prompt field gets the existing completion widget** (tables/columns
  from `schemaHints`), so real identifiers are easy to reference while typing intent.
- Schema context sent to the AI is the **full schema plus relations** (foreign keys), not
  just names — with a token-budget guard that trims to referenced tables + FK neighbours
  on very large schemas, and *says so* when it trims (house honesty rule).

Proceeds to `BLUEPRINT_AI_ASSISTANT.md`, then task scaffolding under milestone **M22**.
