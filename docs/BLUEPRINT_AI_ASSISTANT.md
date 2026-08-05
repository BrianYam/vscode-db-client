# BLUEPRINT — AI Query Assistance (BYOK) + Usage Monitor

Derived from `DISCOVERY_AI_ASSISTANT.md` (locked 2026-08-05).
Locked decisions: **Anthropic + OpenAI + OpenAI-compatible custom base URL**, **inline
assist bar** (never auto-run), verbs **Generate / Explain / Fix**, **Redis deferred**
(amended 2026-08-06: **descoped — not planned**; see Discovery §9).
Added at the lock: the prompt field reuses the **existing completion widget**, and schema
context is **full schema + relations** with an honest token-budget trim.

## 0. Protocol decision — two `fetch` adapters, zero dependencies

Everything any "modern AI model" speaks reduces to two wire protocols. We implement both
by hand — each is one HTTPS POST with a JSON body:

| Adapter | Covers | Wire specifics |
|---|---|---|
| `openaiCompat` | OpenAI, Groq, DeepSeek, Mistral, Gemini (compat endpoint), OpenRouter, **Ollama / LM Studio locally** — anything with a base URL | `POST {base}/chat/completions`, `Authorization: Bearer`, `choices[0].message.content`, `usage.prompt_tokens` / `completion_tokens` |
| `anthropic` | Claude models | `POST /v1/messages`, `x-api-key` + `anthropic-version` headers, `content[0].text`, `usage.input_tokens` / `output_tokens` |

**No provider SDKs** (each is hundreds of KB against a 2.9 MB "lightweight" bundle for two
POSTs' worth of value). **Non-streaming in v1** — generated SQL is short; the interface
below returns a complete result but nothing in it precludes adding SSE later.

Presets ship as data, not adapters: `{ id, label, kind, baseUrl, defaultModel }` entries
for Anthropic / OpenAI / Ollama / OpenRouter / Custom. Model is a **free-text field**
seeded with the preset's default — no hardcoded model list to go stale.

## 1. Pillar I — Execution

### 1.1 Provider layer — `src/ai/` (mirrors `src/drivers/`)

The registry pattern is the house architecture rule; this is its second instance:

```ts
// src/ai/AiProvider.ts
export interface AiProviderConfig {
  kind: "anthropic" | "openai-compat";
  baseUrl: string;          // preset-filled; editable for the long tail
  model: string;
  providerId: string;       // stable id — SecretStorage + ledger key
}

export interface AiRequest  { system: string; user: string; maxTokens?: number }
export interface AiResult   {
  text: string;
  inputTokens: number;      // exact, from the response body
  outputTokens: number;
  model: string;            // as reported, not as requested
}

export interface AiProvider {
  readonly config: AiProviderConfig;
  complete(req: AiRequest, apiKey: string): Promise<AiResult>;
}
```

- `src/ai/registry.ts#createAiProvider(config)` — the one place `kind` is switched on.
- Errors are normalized to human-readable messages (401 → "key rejected", 429 → "rate
  limited", network → "could not reach {host}") — raw provider JSON never hits the UI.
- **All calls run in the host.** Webview CSP already forbids external fetch; that stays.

### 1.2 Keys & settings

- API keys → **SecretStorage**, key `ai:<providerId>` — the `store.ts` split (config in
  globalState, secret in SecretStorage) copied verbatim. Never logged, never exported:
  the connection-export formats do **not** gain an AI section.
- `AiSettings` in globalState: provider configs, active provider id, consent flag,
  per-connection disable list, user-editable price table (§1.6).
- Settings panel gains an **AI Assistant** section: preset picker, base URL, model,
  masked key input (`pwwrap`/eye pattern), and a **Test** button that fires a minimal
  `complete()` and reports success/latency or the normalized error — the Test Connection
  pattern, applied to providers.

### 1.3 Context builder — `src/ai/context.ts` (pure, unit-tested)

The prompt's schema context, from data the drivers already return —
`schemaHints()` (tables + `columnsByTable`), `foreignKeys()`, `getDDL()`:

| Function | Responsibility |
|---|---|
| `buildSchemaContext(hints, fks, budget)` | full schema + relations rendered compactly (`table(col type, …)` + `a.x → b.y` FK lines) when it fits the budget |
| `trimToRelevant(prompt, hints, fks)` | over budget → tables named in the prompt + their FK neighbours; returns `{ context, trimmed: true }` |
| `estimateTokens(text)` | chars/4 heuristic — a guard, not an invoice |
| `isDestructive(sql)` | `DROP` / `TRUNCATE` / `ALTER`, `DELETE`/`UPDATE` without `WHERE` → tag for §1.5 |
| `extractSql(text)` | model reply → statement (fenced block or bare), tolerant of prose around it |

**Honesty rule:** when `trimmed`, the assist bar says "schema was trimmed to N tables" —
a wrong answer caused by missing context must be diagnosable by the user.

### 1.4 Verbs — three system prompts, one plumbing

All three flow through the same path; only the system prompt and user payload differ.
Every prompt pins the **dialect from the connection's `type`** (the `registry.ts`
discriminant) and instructs: return one statement, in a fenced block, no destructive
statements unless explicitly asked.

| Verb | Input | Output surface |
|---|---|---|
| **Generate** | NL intent + schema context | SQL inserted into the editor + one-line explanation in the bar |
| **Explain** | selection (or whole buffer) | prose in the bar — the editor is not touched |
| **Fix** | failed statement + the actual error message | corrected SQL inserted, replacing the failed statement |

### 1.5 Query panel assist bar — `queryPanel.ts`

- A collapsible bar above the editor: prompt input, **✨ Generate**, **Explain**, **Fix**
  (Fix enabled only after a query error, carrying that error). Hidden entirely until an
  AI provider is configured — no dead UI for non-AI users.
- **Locked addition:** the prompt input reuses the **existing completion widget**
  (`sqlComplete.ts` + the panel's dropdown) serving tables/columns from the already-cached
  hints — real identifiers while typing intent. Keyword/function suggestions are off here;
  they are noise in natural language.
- Result handling: SQL goes **into the editor, selected**, with the explanation line in
  the bar. **Never auto-run** — Run stays a human click. `isDestructive` hits render a
  visible warning tag on the bar before the user runs it.
- Wire-up follows the house pattern exactly: `aiGenerate` / `aiExplain` / `aiFix` message
  types → `handleAi*` host methods → context builder → provider → `post` back. Busy state
  in the bar; a second request cancels the first.

### 1.6 Usage ledger — `src/ai/usageStore.ts` + settings view

- Every `complete()` resolution appends `{ ts, providerId, model, verb, inputTokens,
  outputTokens }` — the `queryStore.ts` globalState pattern, capped (e.g. 5 000 entries,
  oldest dropped, drop surfaced in the view per house honesty rules).
- **Cost is an estimate**: tokens × the user-editable price table (seeded with current
  per-model prices), labeled *"estimated — verify in your provider dashboard"*.
- **No balance/credits display** — provider billing APIs need separate admin keys
  (Discovery §5). The view links out to each provider's dashboard instead of pretending.
- View (settings panel): this month / all time, per-model and per-verb breakdown,
  reset-period action.

### 1.7 Consent gate & guide

- **First-use modal** (native dialog via the host, per house rule): names the provider,
  and exactly what will be sent — prompt text, table/column names & types, FK relations,
  dialect; never row data, never credentials, never hosts. Accept once, revocable in
  settings. Localhost base URLs (Ollama) get a lighter notice — nothing leaves the machine.
- Per-connection **"Disable AI for this connection"** toggle for regulated databases.
- New **"AI & your data"** guide in Settings & Guides: what is sent, what is stored where
  (key → SecretStorage, ledger → local), that costs are estimates, and that generated SQL
  is the user's to review before running.

## 2. Pillar II — Capacity

Single author; Lean AI Cell of one. Sequence so the pure, unit-testable core lands before
any UI: **M22.1 provider layer → M22.2 context builder** (both fully testable offline,
adapters verifiable with a mock `fetch`) → **M22.3 settings/keys/consent** → **M22.4
assist bar** → **M22.5 ledger + view** → **M22.6 QA gate**. M22.1 and M22.2 are
independent and can interleave.

## 3. Pillar III — Growth

Cheap follow-ons once the provider layer exists: SSE streaming; a chat sidebar with
history; results-aware follow-ups ("now group it by month"); schema embeddings for very
large databases; "explain this error" on any failed query even with AI otherwise idle.

Explicitly **not** planned: Redis command generation — descoped 2026-08-06 (Discovery §9
amendment); the assist bar stays SQL-only unless real user demand appears.

## 4. Phase 4 — QA gate

- Unit tests green for every `context.ts` export and both adapters (mocked `fetch`:
  response parsing, usage extraction, error normalization) — the repo's automated tier.
- Manual matrix: 3 SQL engines × 3 verbs × {Anthropic, OpenAI, Ollama-local}.
- Security: key absent from logs, exports, and webview HTML; consent fires exactly once;
  per-connection disable respected; webview CSP unchanged (no external fetch).
- Honesty: trim notice on a huge schema; destructive tag on `DELETE` without `WHERE`;
  ledger cap surfaced; cost labeled as estimate.
- Regression: `Ctrl/Cmd+Enter` runs, completion widget still works in the SQL editor,
  panel unaffected when no provider is configured.
