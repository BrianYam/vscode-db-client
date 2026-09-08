# Discovery — Column picker (show / hide result columns)

Status: **LOCKED 2026-09-08** (§5). Raised 2026-09-08.
Requested: a column picker so the user can choose which columns to show or hide.
Everything selected by default; hiding is for readability.
Reference supplied: a **View ▾** dropdown with a *Search columns…* box and a checkmark per
column (the shadcn/ui data-table visibility pattern).

Sized like M23 / M31 / M33 / M34: this document carries both discovery and design; no
separate blueprint.

## 1. The 7-Question Foundation

**Why.** `SELECT *` on a real table hands back everything, and `td` is `white-space: pre`
with no truncation — so the three columns you actually care about get pushed off screen by
`created_at`, `updated_at`, `deleted_at`, and half a dozen ids. The current answer is to
stop using `SELECT *` and hand-write a column list, which is exactly the friction a GUI
client is supposed to remove. M33 fixed this for one *cell* being too wide; this is the
same complaint one axis over.

**Success.**
- A **Columns ▾** control in the results toolbar: every column listed, all checked by
  default, with a filter box for wide tables and a one-click *Show all*.
- Hiding is instant and purely presentational — no re-query, no data lost.
- The button states the situation at a glance (`Columns 5/9`) so a hidden column is never
  invisible *state*.
- No new way to be quietly wrong: the things that read columns — search, filters, copy,
  export, Add Row — all behave predictably (§3.3, and they do not all behave the same way,
  on purpose).

**Scope.** `src/webview/queryPanel.ts` (toolbar control, dropdown, render loop, search /
filter / copy interactions) plus the host `export` handler, which needs to be told which
columns are visible.

**Boundaries (out of scope).** Column **reordering** and drag-to-resize (a different
feature; the picker is not a substitute and should not pretend to be). Persisting the
choice across panel reopens or per table (§4 — deliberate, revisit if asked). Pinning /
freezing columns. Hiding columns in the tree or the Add Row form. Any change to what the
*query* selects — this never rewrites SQL.

**Stakeholders.** Single author; anyone running `SELECT *` against a wide table.

**Constraints.** House rules: self-contained webview under a strict nonce CSP, so the
dropdown is hand-rolled. Must compose with the M32 render cap and the M33 JSON chips.
Pure logic exported + `node:test` covered.

**Risks.**
- (a) **Invisible state.** A hidden column that still filters or still matches a search is
  the classic "why is my grid empty" bug. This is the main design risk and §3.3 answers it
  case by case rather than with one blanket rule.
- (b) **Silent data loss on export.** If Export quietly drops hidden columns, a user
  produces an incomplete file without noticing. If it quietly keeps them, the file does not
  match what they were looking at. Either choice must be *stated*, not assumed.
- (c) Hiding a primary-key column while editing. Verified safe (§2), but worth a test.
- (d) A stale visibility set when a new query returns different columns.

## 2. What already exists (verified in-repo)

- **Eight places read `raw.columns`** (`queryPanel.ts`): the grid header, the filter row,
  the body loop, global search, `copyAsJson`, the Add Row form, plus `metaFor` and the
  empty-result guard. Every one is a decision point, which is why §3.3 is a table.
- **Export runs host-side.** `handleExport` builds from `this.lastResult` and `toCsv`
  iterates `result.columns` (`queryPanel.ts:2292`) — the host has **no idea** what the
  webview is hiding. Respecting visibility means sending it explicitly.
- **The clipboard already promises to match the view.** The comment above `copyAsJson`
  states it outright: *"Order follows the grid (sort/filter/search applied), not raw.rows,
  so what lands on the clipboard is what you were looking at."* A picker that left Copy
  exporting hidden columns would break a promise the code already makes.
- **Editing does not depend on a column being rendered.** `saveCell` reads pk values from
  `raw.rows[ri]`, not the DOM, and hiding never removes data from `raw`. So a hidden PK is
  safe — Risk (c) is already handled by the architecture, and only needs pinning with a test.
- **`#ac` sits at z-index 50 and modals at 100** (after M33), so a new dropdown has a free
  lane between the sticky header (3) and the completion list.

### Competitive reference (Copy, Don't Innovate)

The supplied screenshot *is* the reference — shadcn/ui's data-table column toggle: a
right-aligned **View** button, a search box, and a checkmark per column. Beyond it, from
general product knowledge rather than live research this session:
- **DataGrip / DBeaver** — a column-visibility submenu on the grid header's context menu.
- **TablePlus** — per-column show/hide, remembered per table.

Two things worth copying that the screenshot shows and we should not drop: the **search
box** (a 40-column table is unusable as a flat checklist) and **hiding being visibly
counted**, so the user knows the view is filtered.

## 3. Design

### 3.1 The control
A `Columns ▾` button in the results toolbar, left of Export. Label carries the count when
anything is hidden: `Columns 5/9` — hidden columns must never be silent state (Risk a).
The dropdown is hand-rolled (CSP), anchored under the button at **z-index 60**, and holds:
a filter box, one checkbox row per column, and **Show all** (disabled when nothing is
hidden). Row order follows result order — this is not a reordering tool.

### 3.2 State
`hidden: Set<string>` per panel, empty by default (everything shown, as requested).
**Reset whenever the result's column set changes** (Risk d) — compared as a joined key, so
re-running the same query keeps your choice while a different query starts clean.

The last visible column cannot be unchecked: a zero-column grid is a blank rectangle with
no way back except *Show all*. The final checkbox simply disables.

### 3.3 What "hidden" means, per consumer
Deliberately not one blanket rule — these have genuinely different jobs:

| Consumer | Behaviour | Why |
|---|---|---|
| Grid header / body / filter row | hidden | the whole point |
| **Global search** | **visible only** | matching a row on invisible text is Risk (a) in its purest form |
| **Column filters** | **hiding clears that column's filter** | a filter you cannot see or clear is invisible state; clearing is honest and the status line says so |
| **Copy as JSON** | **visible only** | keeps the promise the code already makes (§2) |
| **Export CSV / JSON** | **visible only, and says so** | consistency beats a second mental model — the confirmation names the count, and *Show all* is one click away |
| **Add Row** | **always all columns** | a data-entry form, not a view; omitting a NOT NULL column would produce a failing insert for an invisible reason |
| Cell editing / Delete | unaffected | reads `raw.rows`, never the DOM (§2) |

### 3.4 Host changes
`export` carries `columns: string[]` (the visible list, in result order). `handleExport`
projects `lastResult` onto it before `toCsv` / `JSON.stringify`, and the success message
reports `12 row(s), 5 of 9 columns` when anything is hidden. An absent `columns` means all
— so nothing else that posts `export` has to change.

### 3.5 Pure logic
`visibleColumns(all, hidden)` and `projectRows(rows, columns)` live in a small exported
module (the `jsonView.ts` source-string precedent applies: this runs in the webview, and
the shipped build minifies). Unit-tested: hiding, the all-hidden guard, unknown names in
the hidden set, and projection preserving column order.

## 4. Deliberate omission — persistence
The choice does **not** survive closing the panel, and is not remembered per table. Doing
it properly means deciding the key (connection + database + table? the SQL text?), where it
lives (`globalState`, growing forever), and when it is invalidated by a schema change —
that is its own discovery, not a footnote to this one. Recorded here so the omission reads
as a decision. Re-running the same query in an open panel *does* keep the choice (§3.2).

## 5. Validation gate — LOCKED 2026-09-08

1. **`Columns ▾` toolbar dropdown**, hand-rolled, with a search box and *Show all*; every
   column checked by default, exactly as requested.
2. **Hidden state is never silent**: the button reads `Columns 5/9` whenever anything is
   hidden, and the last visible column cannot be unchecked.
3. **Per-consumer behaviour is explicit, not uniform** (§3.3): search and Copy follow the
   visible set; a hidden column's filter is **cleared**; **Add Row always shows every
   column**; editing and Delete are untouched.
4. **Export respects visibility and reports it** — `5 of 9 columns` in the confirmation,
   rather than silently producing a narrower file.
5. **Visibility resets when the result's column set changes**; re-running the same query
   keeps it.
6. **No persistence across panel reopens, and none per table** — deliberate, §4.
7. **Out of scope:** column reordering, resizing, pinning, and any rewriting of the SQL.

Tasks: `task.md` M35.
