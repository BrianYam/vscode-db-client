# Discovery — SQL Autocomplete (columns + keywords) in the Query Panel

Status: **Discovery, awaiting lock.** Raised 2026-07-30.
Requested: column suggestions and query (keyword) suggestions while typing, per the
DataGrip-style reference screenshots.

## 1. The 7-Question Foundation

**Why.** The query panel's editor is a bare `<textarea>`. Typing
`SELECT * FROM saving_plans or` offers nothing — no `ORDER BY`, no column names. Every
identifier has to be recalled exactly or copied out of the tree. For a client whose whole
value is "fewer round-trips to get at your data", the editor is the weakest surface.

**Success.** Typing a prefix in the panel's editor shows a filtered list of keywords, tables
and columns; ↑/↓ + Enter/Tab inserts; Esc dismisses. Suggestions never block typing and
never fire a query per keystroke.

**Scope.** The **query panel's editor** (`queryPanel.ts`, `<textarea id="sql">`) — that is
where the user was typing in the report.

**Boundaries (out of scope).** Full SQL parsing / a grammar. Syntax highlighting.
Multi-statement scope analysis. Cross-database qualified name resolution. Signature help.
Redis command completion (different language; separate item if wanted).

**Stakeholders.** Single author; the user is the operator. No external decision-maker.

**Constraints.** The panel is a CSP-locked webview with a nonce'd inline script and no
external loads. The extension markets itself as *lightweight* — bundle is already 2.7 MB.
Whatever ships must not need a native build step or a multi-MB editor payload.

**Risks.** (a) Re-implementing editor UX in a `<textarea>` is fiddly — caret pixel position
needs a mirror element; (b) schema hints on a large database are big and must be cached;
(c) a custom widget owns every keyboard edge case (IME, wrapping, scroll) that a real editor
gets for free.

## 2. What already exists (verified, not assumed)

This feature is **half-built already**, which changes the shape of the work.

- **`src/sqlFeatures.ts` already registers native VS Code IntelliSense** — a real
  `CompletionItemProvider` serving tables (`Struct`), columns (`Field`) and 46 keywords
  (`Keyword`), plus Run / JSON CodeLens.
- It is scoped to **`{ language: "sql", scheme: "file" }`** — i.e. **saved `.sql` files only**.
  The webview panel is not a text document, so none of it applies there. **That is the entire
  gap.**
- **`Driver.schemaHints(database?)` exists and all four drivers implement it**
  (`postgres.ts:418`, `mysql.ts:302`, `sqlite.ts:300`, `redis.ts:326`). Results are cached
  per `connId::database` in `sqlFeatures.ts`.

### The one real data limitation

`schemaHints` returns **flat** lists:

```ts
schemaHints(database?: string): Promise<{ tables: string[]; columns: string[] }>
```

Postgres implements columns as `SELECT DISTINCT column_name ... LIMIT 4000` across every
schema. So columns are **not table-aware**: after `FROM saving_plans WHERE `, the suggestions
are every column in the database, not `saving_plans`'. Fixing that means changing the
`Driver` contract (a `Record<table, column[]>`, or a new optional method) and touching all
four drivers — a materially bigger change than the widget itself, and worth deciding
separately.

## 3. Prior art — copy, don't innovate

The reference screenshots (DataGrip / DBeaver-class) establish the bar we copy:

| Behaviour | Detail to copy |
|---|---|
| Prefix filter | `or` → `ORDER BY`, `OR`, `ORDER`, `ORDERING`, `ORDINALITY` |
| Kind icons | keyword vs function vs table vs column are visually distinct |
| Case | keywords upper-case, identifiers as stored |
| Ranking | exact/prefix match first, then contains |
| Non-blocking | list follows typing; Esc dismisses; typing never waits on the DB |

Note the second screenshot mixes keywords (`DESC`, `DELETE`) with **functions** (`decode`,
`dense_rank`) under separate icons. Our current keyword list has no function entries.

## 4. Options considered

| | Approach | Cost | Verdict |
|---|---|---|---|
| **A** | Custom completion widget in the webview: caret mirror, token scan, dropdown, keyboard nav; host supplies cached `schemaHints` over a message | ~300–500 lines of new webview JS/CSS | Matches the screenshots and keeps the panel's UX intact. We own every edge case. |
| **B** | Route SQL editing to a real `.sql` document and lean on the **existing** `sqlFeatures.ts` provider | Small — mostly wiring | Free IntelliSense, syntax highlighting, and zero new UI to maintain. But it changes the panel's core UX: the inline editor stops being where you type. |
| **C** | Bundle Monaco into the webview | Multi-MB payload, CSP + web-worker work | **Rejected** — contradicts the "lightweight, no native build" constraint. |

A hybrid is also open: ship **B**'s wiring (cheap, immediate, already works) and add **A**
afterwards for in-panel typing.

## 5. Moat / indispensability

Autocomplete is the difference between "a grid that shows tables" and "somewhere I actually
write queries". It is the main switching cost versus a plain `psql` shell, and it compounds
with the features already shipped (preview → edit → Copy as JSON). Low strategic risk, high
daily-use value.

## 6. Validation gate — LOCKED 2026-07-30

- **Approach A** — custom completion widget in the webview panel.
- **Table-aware columns: yes** — `schemaHints` gains a per-table map; all four drivers change.
- **Added after the lock:** suggestions must be **dialect-aware** per engine (postgres, mysql,
  sqlite, redis).
- **Scope widened to the "full suite" (2026-07-30):** dialect-aware **formatting** as well as
  suggestions. This reversed the initial "no new dependency" call — measurement showed
  `sql-formatter` costs 87 KB minified (+3.2 %) when imported per-dialect, and its dialect
  objects supply the completion vocabulary too (653 Postgres functions vs our 46 hardcoded
  keywords). One dependency, both halves. See `BLUEPRINT_SQL_AUTOCOMPLETE.md` §0.

Superseded: option B (route to `.sql` files) and option C (bundle Monaco) are not being built.
The `.sql` native provider still benefits — §1.5 feeds it the same data for free.
