# Discovery — JSON viewer for JSONB columns

Status: **LOCKED 2026-09-08** (§5). Raised 2026-09-08.
Requested: a JSON viewer for JSONB columns.

Sized like M21 / M23 / M31: this document carries both discovery and design; no separate
blueprint.

## 1. The 7-Question Foundation

**Why.** A JSONB column today is a wall of minified text. `cellText()` runs
`JSON.stringify(v)` with no indentation and no truncation, and `td` is
`white-space: pre` (`queryPanel.ts:831`) — so a single 5 KB document stretches one column
far past the viewport and pushes every other column off screen. The row you were reading
becomes unreadable because of one cell. The only way to see inside is the 🔍 zoom, which
opens a plain `<textarea>`; its "JSON" dropdown option merely re-indents the text
(`queryPanel.ts:1869`). There is no structure, no collapsing, no key search — and on many
result sets there is no 🔍 at all (§2 Finding A).

**Success.**
- A JSONB cell reads as a compact summary in the grid (`{…} 12 keys`), never as a wall of
  text, and the column stops dominating the row.
- One click opens a real viewer: a collapsible tree with typed syntax colouring, expand /
  collapse, copy-value and copy-path, and a Raw toggle for the exact text.
- It works on **any** result containing JSON, not only editable table previews.
- Editing a JSONB value still works, and invalid JSON fails loudly rather than silently
  corrupting a column.

**Scope.** `src/webview/queryPanel.ts` only — cell rendering, the cell modal, and a new
pure JSON-shape helper. No driver changes: `pg` and `mysql2` already parse JSON/JSONB into
JS values before we see them.

**Boundaries (out of scope).** JSONPath / `jq`-style querying. Schema inference across
rows. Diffing two documents. Editing *inside* the tree (v1 edits raw text — §3.4). A
JSON column type in the Add Row form. Tree rendering of documents large enough to need
virtualization (capped instead — §3.5, the M32 lesson).

**Stakeholders.** Single author; users on Postgres/MySQL schemas that lean on JSONB
(event payloads, settings blobs, audit records) are the beneficiaries.

**Constraints.** House rules: **no CDN** — the webview is a self-contained HTML string
under a strict nonce CSP, so the tree is hand-rolled, not a library. `Driver` untouched.
Pure logic exported + `node:test` covered. Honesty-first UX.

**Risks.**
- (a) **Escaping.** `esc()` escapes only `&` and `<` (`queryPanel.ts:1605`). That is safe
  for text nodes but **not** for attribute values, and a JSON tree is exactly where
  attacker-controlled keys and values would meet HTML attributes. See §2 Finding B — this
  is the one genuinely security-relevant part of the change.
- (b) **Size.** A multi-megabyte document expanded to a full tree is the M32 hang again,
  one cell down. Mitigated by lazy expansion + a node cap (§3.5).
- (c) Detecting "this is JSON" by value shape can mis-fire on a plain string that happens
  to start with `{`. A false positive costs a Tree tab the user can ignore; a false
  negative costs nothing new. Fail toward *offering* the viewer.

## 2. What already exists (verified in-repo)

- `cellText()` stringifies objects for search/sort/filter so a jsonb cell is matchable —
  the comment there already anticipates this feature.
- `openModal(ri, col)` pretty-prints objects into `#mtext` with `JSON.stringify(v, null, 2)`
  (`queryPanel.ts:1862`), and `#mfmt` re-indents on demand. Half the plumbing exists.
- `saveCell` posts the textarea's **string**; `updateCell` binds it as a query parameter,
  so Postgres/MySQL cast text → jsonb themselves and reject malformed JSON with a real
  error. The write path needs no work.
- The M32 render cap and its honesty note set the precedent for §3.5.

### Finding A — the 🔍 zoom only exists on editable results (drives §5.2)

`renderGrid` emits the zoom affordance inside `if (editable)` (`queryPanel.ts:1720`), and
`editable` is set only when a single-table PK could be resolved. So a JOIN, an aggregate,
a view, or any multi-table query returning JSONB has **no way at all** to inspect a cell
today. Scoping the viewer to the existing 🔍 would inherit that gap and miss a large share
of the real cases. The JSON affordance must therefore be rendered on its own condition
(the cell holds JSON), independent of editability.

### Finding B — column types are unavailable on hand-typed queries (drives §5.1)

`attachEditable` (postgres.ts, mysql.ts) resolves a PK to enable editing but never sets
`columnsMeta` — that is populated only by `previewTable`. So on a hand-typed
`SELECT * FROM events`, `metaFor(col)` returns `undefined` and the declared type `jsonb`
is simply not known to the webview. **Detection must therefore be value-shaped, not
type-driven**, which happily also generalises:

| Engine | A JSON column arrives as | Detected by |
|---|---|---|
| **Postgres** `json`/`jsonb` | a parsed JS object/array (pg does this) | `typeof v === 'object'` |
| **MySQL** `JSON` | a parsed JS object/array (mysql2 does this) | `typeof v === 'object'` |
| **SQLite** | `TEXT` — a raw string | string that parses as JSON |
| **Redis** | a raw string | string that parses as JSON |

Declared type is used as a *hint* when `columnsMeta` happens to be present, never as the
gate.

### Competitive reference (Copy, Don't Innovate)

From general product knowledge of these tools, **not** live research this session — say
the word and I will verify against current builds before the lock.
- **DataGrip / DBeaver** — cell viewer panel with Tree / Text tabs, collapsible nodes,
  type colouring, copy-path.
- **TablePlus** — JSON cells open a formatted, foldable editor; raw text a toggle away.
- **pgAdmin** — pretty-printed JSON in an expanded cell view.

Convergent pattern: **collapsed summary in the grid, Tree + Raw tabs in a modal, copy both
value and path.** That is §3 — no invention required.

## 3. Design

### 3.1 Detection (pure, testable)
`jsonShape(v)` → `null | { kind: 'object'|'array', count, value }`. Returns non-null for a
real object/array, or for a string whose trimmed form starts `{`/`[` and `JSON.parse`s.
Exported and unit-tested (`node:test` tier) the way `isMutation`/`scanPattern` are.

### 3.2 Grid cell
A JSON cell renders as a summary chip — `{…} 12 keys`, `[…] 40 items`, `{}` / `[]` — plus
a `⤢` affordance, **rendered whenever the cell holds JSON, editable or not** (Finding A).
The full text stays available to search/sort/filter through the unchanged `cellText()`, so
filtering behaviour does not regress.

### 3.3 The viewer
The existing modal gains **Tree** / **Raw** tabs (replacing the `#mfmt` plain/json select,
whose only job was re-indenting):
- Collapsible nodes, arrays and objects collapsed past depth 2 on open.
- Type colouring via VS Code theme tokens (string / number / boolean / null / key).
- Per-node **copy value** and **copy path** (`$.items[3].sku`), routed through the
  existing host `copy` message so the size gate still applies.
- A key/value filter box that dims non-matching nodes.

### 3.4 Editing
**Raw tab only** in v1, which is the current behaviour and already round-trips (§2). The
Tree is read-only; Save is disabled on the Tree tab so there is no ambiguity about which
representation is being written. Invalid JSON is rejected by the database with its own
error, which is surfaced as-is.

### 3.5 Size ceiling (the M32 lesson, applied early)
Nodes expand lazily, and a single expansion paints at most `JSON_NODE_CAP` (1000) children,
with an honest inline note — *"Showing the first 1,000 of 8,412 items — use Raw to see
everything"*. A document over ~2 MB opens on the **Raw** tab with a one-line explanation
rather than building a tree at all. No silent truncation anywhere.

### 3.6 Escaping (Risk a / Finding B)
JSON keys and values are user data and must never reach an HTML attribute. Node identity
is held in a **JS-side array index**, not a `data-path` attribute carrying content, and all
rendered text goes through a text node. Where an attribute is unavoidable, a dedicated
`escAttr()` (adding `"` and `'` to `esc()`) is used. This is the part of the change to
review hardest.

## 4. Moat / indispensability note
JSONB is where modern Postgres schemas keep the interesting data, and a client that turns
it into an unreadable smear is one a developer will abandon for DataGrip the first time
they debug an event payload. This is a "do I keep this installed" feature rather than a
headline one — it removes a daily papercut on exactly the tables people inspect most.

## 5. Validation gate — LOCKED 2026-09-08

1. **Detection is value-shaped**, not type-driven — declared type is only a hint, because
   `columnsMeta` does not exist on hand-typed queries (Finding B). Covers all four engines.
2. **The viewer is reachable from any result**, not just editable table previews — the
   JSON affordance renders on its own condition, fixing the Finding A gap.
3. **Grid shows a collapsed summary chip**, never raw minified JSON; search/sort/filter
   keep working on the full text.
4. **Tree + Raw tabs**, hand-rolled (strict CSP — no CDN), with copy-value and copy-path.
5. **Editing stays on Raw** in v1; the Tree is read-only and Save is disabled there.
6. **Bounded by design**: lazy expansion, 1,000-child cap per expansion with an honest
   note, and documents over ~2 MB open on Raw instead of building a tree.
7. **Out of scope:** JSONPath querying, schema inference, diffing, tree editing.

Tasks: `task.md` M33.
