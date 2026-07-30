# BLUEPRINT — SQL Language Suite (completion + formatting)

Derived from `DISCOVERY_SQL_AUTOCOMPLETE.md` (locked 2026-07-30).
Locked decisions: **custom completion widget in the webview panel**, **table-aware columns**,
**dialect-aware vocabulary per engine**, and — added 2026-07-30 — **dialect-aware formatting**
as part of the same suite, sharing one dependency (§0).

## 0. Library decision — adopt `sql-formatter`, one dependency for both halves

Scope is the **full suite**: dialect-aware *suggestions* **and** dialect-aware *formatting*.

**Decision: take `sql-formatter` (15.8.2, MIT) as the single new dependency**, and import it
**per-dialect via `formatDialect`** — never the `format` barrel. It powers both halves.

### Why this reverses the earlier "no dependency" call

The first pass argued against a library on weight, and for reading vocabulary out of each
server's catalogs. Measured numbers changed that:

| Import style | minified | gzipped | vs current 2751 KB bundle |
|---|---|---|---|
| `format` (pulls all 21 dialects) | 313 KB | 79 KB | +11 % — avoid |
| `formatDialect` + only pg/mysql/sqlite | **87 KB** | **24 KB** | **+3.2 %** |

87 KB for a correct multi-dialect formatter *plus* the vocabulary below is a good trade. A
formatter is a real tokenizer + parser; hand-rolling one is not proportionate work.

**The decisive find:** the dialect objects already expose exactly the vocabulary completion
needs, so one dependency serves both features (measured, not assumed):

| Dialect | keywords | clauses | functions | data types |
|---|---|---|---|---|
| `postgresql` | 116 | 323 | **653** | 32 |
| `mysql` | 228 | 245 | **411** | 49 |
| `sqlite` | 149 | 52 | **116** | 15 |

Against today's **46 hardcoded, shared, dialect-blind** keywords in `sqlFeatures.ts`. This is
offline, instant, needs no connection, and is correct per dialect — which is precisely what
was asked for.

### Server catalogs become augmentation, not foundation

Reading vocabulary from the server is now an *optional enhancement* layered on the static
baseline, which de-risks M18.1 considerably (those catalog queries are still unverified):

| Engine | Static baseline | Server augmentation (optional) |
|---|---|---|
| Postgres | `sql-formatter` postgresql | `pg_proc` → **user-defined** functions |
| MySQL | `sql-formatter` mysql | `information_schema.KEYWORDS` (8.0.11+) |
| SQLite | `sql-formatter` sqlite | `pragma_function_list` — **verified**, 155 functions on the bundled sql.js 3.49.1 |
| Redis | **none** — not SQL, no dialect exists | `COMMAND LIST` (the only real source) |

Redis is the one engine `sql-formatter` cannot help: no dialect, and Format is N/A. Its
completion stays server-reported via `COMMAND LIST`, with a small static command fallback.

**Still rejected:** `dt-sql-parser` / `node-sql-parser` for real grammar-level parsing. The
context detection in §1.2 is a backward token scan, which is enough for the reference
behaviour. Revisit only if the heuristic measurably fails.

### Verified locally, not assumed

`sql-formatter` 15.8.2 correctly formatted Postgres (`->>` JSON operator, `interval`), MySQL
(backtick identifiers) and SQLite (`json_extract`) samples. Deps are `nearley` (parser
runtime) + `argparse` (its CLI only).

## 1. Pillar I — Execution

### 1.1 Data contract (additive)

Widen `schemaHints`' return type rather than adding a parallel channel, per the
`QueryResult` convention in `CLAUDE.md`:

```ts
export interface SchemaHints {
  tables: string[];
  columns: string[];                          // flat fallback for unqualified context
  columnsByTable?: Record<string, string[]>;  // table-aware; SQL engines only
  keywords?: string[];                        // dialect vocabulary, server-reported
  functions?: string[];                       // dialect functions, server-reported
  truncated?: boolean;                        // a LIMIT was hit — surface it, per house style
}

schemaHints(database?: string): Promise<SchemaHints>
```

`columnsByTable` / `keywords` / `functions` are **optional**, so Redis (no tables, no columns)
and any engine whose catalog query fails degrade to exactly today's behaviour instead of
erroring. Existing callers keep compiling — `tables` and `columns` are unchanged.

`truncated` matters: Postgres already caps at `LIMIT 2000` / `LIMIT 4000`. A wide schema
silently loses suggestions today; the widget must be able to say so.

### 1.2 Pure logic — `src/sqlComplete.ts`

All completion reasoning lives here as exported pure functions, so it is unit-testable under
the repo's `node:test` + compiled-`out/` setup (the pattern `scanPattern` / `formatTtl` set):

| Function | Responsibility |
|---|---|
| `currentToken(text, caret)` | `{ word, start, end }` of the identifier being typed |
| `aliasMap(textBeforeCaret)` | `FROM saving_plans sp JOIN users u` → `{ sp: saving_plans, u: users }` |
| `tablesInScope(textBeforeCaret)` | tables named after `FROM` / `JOIN` / `UPDATE` / `INTO` |
| `completionContext(textBeforeCaret)` | `{ kind: "table" \| "column" \| "any", qualifier?: string }` |
| `rank(prefix, candidates)` | prefix-match tier, then contains; stable, case-insensitive |

Context rules (deliberately shallow — no grammar):

- after `FROM` / `JOIN` / `INTO` / `UPDATE` → **tables**
- after `SELECT` / `WHERE` / `ON` / `SET` / `GROUP BY` / `ORDER BY` / `HAVING` → **columns in
  scope** + keywords
- `alias.` or `table.` (trigger on `.`) → **only that table's columns**
- otherwise → keywords + functions + tables

Ranking tiers, so `or` yields `ORDER BY, OR, ORDER, ORDINALITY` like the reference: exact →
prefix → contains; within a tier, in-scope columns > tables > keywords > functions > alpha.

### 1.3 Webview widget — `queryPanel.ts`

- **Caret position** via a hidden **mirror element** cloning the textarea's font, padding and
  width; text up to the caret plus a marker span, then read the span's offset. Must subtract
  `textarea.scrollTop` — the known-fiddly part.
- **Dropdown**: absolutely positioned; per-kind icon (keyword / function / table / column) as
  in the screenshots; capped visible list with an explicit "showing first N" row when cut, per
  house honesty rules; flips above the caret when it would clip the panel bottom.
- **Keys**: ↑ ↓ Enter Tab Esc, click to accept. Registered so it **cannot** swallow the
  existing `Ctrl/Cmd+Enter` (run) or `Cmd+S` (save) — those handlers already exist on `sqlEl`
  and `window`, and ordering is a real regression risk.
- **IME**: suppress on `compositionstart`, resume on `compositionend`.
- **Never blocks typing**: hints are cached client-side; a cache miss shows keywords only.

### 1.4 Host wiring

Host pushes `{ type: "hints", ... }` on panel open and after a connection/database change;
webview caches in memory. Cache key `connId::database`, mirroring `sqlFeatures.ts`.
Invalidate on `refresh`.

### 1.5 Formatting — `src/sqlFormat.ts`

The second half of the suite. One thin module owns the dependency so nothing else imports it:

```ts
import { formatDialect, postgresql, mysql, sqlite } from "sql-formatter";

const DIALECT = { postgres: postgresql, mysql: mysql, sqlite: sqlite } as const;

export function canFormat(type: string): boolean;          // false for redis
export function formatSql(sql: string, type: string): string;
```

- **Dialect comes from the connection's `type`** — the same discriminant `registry.ts` already
  switches on. Adding an engine means one entry here, mirroring the house rule for `Driver`.
- **Redis returns `canFormat() === false`** and the command/button is hidden rather than
  no-opping — the established pattern for capabilities only some engines have
  (`if (driver.setTtl)`).
- **Never destroys work.** A syntax error must leave the buffer untouched and report the
  failure, not replace the query with a mangled parse.
- **Surfaces:** a `Format` button in the panel bar (host-side, alongside `Run`), plus a
  `openDbClient.formatSql` command wired to VS Code's native
  `DocumentFormattingEditProvider` for `.sql` files — so `Shift+Alt+F` works on saved query
  files for free, matching §1.6's "same data, two surfaces" principle.
- **Options:** `keywordCase: "upper"`, `tabWidth` from the editor config. Worth exposing in
  the settings panel later; not in this milestone.

Unit-testable as pure string→string, so it lands in the repo's `node:test` tier.

### 1.6 Free win — the native provider gets the same data

`sqlFeatures.ts` already serves `.sql` files with a hardcoded 46-keyword list. Feeding it the
same `columnsByTable` + dialect `keywords` makes **saved query files** table-aware and
dialect-aware for one small change. Same data, two surfaces.

## 2. Pillar II — Capacity

Single author; a Lean AI Cell of one. Sequence M18.1 → M18.2 (both independently verifiable)
before the widget, so the fiddly DOM work lands on a foundation already proven by unit tests.
M18.1 and M18.2 have no dependency on each other and can interleave.

## 3. Pillar III — Growth

Once vocabulary is server-reported and context is structured, these become cheap:
snippet completion (`SELECT … FROM …`), hover type info from `columnsByTable`, "insert all
columns" on `SELECT *`, and dialect-aware SQL formatting if that turns out to be what was
wanted.

## 4. Phase 4 — QA gate

- Unit tests green for every `sqlComplete.ts` export (the repo's only automated tier).
- Manual matrix: each of the four engines × {keyword prefix, table after `FROM`, column after
  `WHERE`, `alias.` qualified}.
- Regression: `Ctrl/Cmd+Enter` still runs, `Cmd+S` still saves, Esc doesn't close the panel.
- Degradation: catalog query denied → static fallback, no error surfaced to the user.
- Confirm `truncated` reaches the UI on a wide schema.
