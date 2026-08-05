# task.md — Open DB Client

Every task carries the `[SDD]` prefix and maps to a BLUEPRINT module (M0–M7).
Checked = implemented in this repo. Unchecked = remaining work.

## M0 — Skeleton & Connection CRUD
- [x] `[SDD][M0]` Extension manifest, activity-bar view, commands, launch/tasks config
- [x] `[SDD][M0]` `ConnectionStore` — configs in globalState, passwords in SecretStorage, **no count limit**
- [x] `[SDD][M0]` Add / Edit / Delete connection via native input flow (`connectionForm.ts`)
- [x] `[SDD][M0]` `ConnectionManager` — lazy connect, live-driver cache, dispose-all on shutdown

## M1 — PostgreSQL (reference slice)
- [x] `[SDD][M1]` `PostgresDriver` on pure-JS `pg`; fail-fast connect
- [x] `[SDD][M1]` Tree: schemas → tables/views
- [x] `[SDD][M1]` Query panel: SQL editor + Ctrl/Cmd+Enter run + results grid
- [x] `[SDD][M1]` "Select Top 200" table preview command

## M2 — MySQL / MariaDB
- [x] `[SDD][M2]` `MySqlDriver` on `mysql2/promise`; databases → tables; DML vs DDL result handling

## M3 — Redis
- [x] `[SDD][M3]` `RedisDriver` on `ioredis`; SCAN-based key listing; raw command execution; typed key preview

## M4 — SQLite
- [x] `[SDD][M4]` `SqliteDriver` on WASM `sql.js` (no native build); tables/views; SELECT
- [x] `[SDD][M4]` **Write-back**: modifying statements persist via `db.export()` → `fs.writeFileSync`
- [ ] `[SDD][M4]` File picker in the form instead of typing the path

## M5 — Editing & Export  ✅ DONE 2026-07-06
- [x] `[SDD][M5]` Inline cell edit in results grid → parameterized UPDATE (table previews with a PK)
- [x] `[SDD][M5]` Right-click table → View DDL / structure (SHOW CREATE / sqlite_master / reconstructed)
- [x] `[SDD][M5]` Export results to CSV / JSON (save dialog)
- [x] `[SDD][M5]` Column expansion in tree (table → columns with types, PK marker)

## M5.1 — Rich Data Grid (parity with reference client)  ✅ DONE 2026-07-06
- [x] `[SDD][M5.1]` Typed column headers with 🔑 PK / 🔗 FK / `*` not-null markers + data type
- [x] `[SDD][M5.1]` Per-column client-side sort (click header) and per-column filter inputs
- [x] `[SDD][M5.1]` Global "Search results" box
- [x] `[SDD][M5.1]` Row checkboxes + select-all; delete selected rows (by PK, with confirm)
- [x] `[SDD][M5.1]` Server-side pagination (100/page) with prev/next + "Total N"
- [x] `[SDD][M5.1]` Execution "Cost: Xs" timing + Refresh
- [x] `[SDD][M5.1]` Cell-detail modal (🔍) — Plain/JSON view, Copy, Save (no Premium wall)
- [x] `[SDD][M5.1]` **Add row** (INSERT) — form modal, blank = default/NULL
- [x] `[SDD][M5.1]` Fix: select-all header checkbox now reflects state (un-select-all works)
- [ ] `[SDD][M5.1]` Server-side sort/filter (currently sorts/filters the loaded page only)

## M5.2 — Foreign Keys & Related Rows  ✅ DONE 2026-07-06
- [x] `[SDD][M5.2]` FK target discovery per engine (column → referenced table/column)
- [x] `[SDD][M5.2]` FK cells marked (link colour + dotted underline) with a ↗ affordance
- [x] `[SDD][M5.2]` "View Related Row" opens the referenced table filtered by the FK value
- [x] `[SDD][M5.2]` Filtered preview is fully rich (typed headers, editable, paginated)

## M5.3 — Connection Form UI  ✅ DONE 2026-07-06
- [x] `[SDD][M5.3]` Webview form replaces native input-box chain
- [x] `[SDD][M5.3]` Server-type picker (chips), adaptive fields per engine
- [x] `[SDD][M5.3]` Test Connection button with success/error banner + "Cost: Nms"
- [x] `[SDD][M5.3]` Save / Save & Connect / Close; SSL toggle; SQLite file Browse dialog
- [x] `[SDD][M5.3]` Real SSL/TLS support wired into pg / mysql2 / ioredis
- [x] `[SDD][M5.3]` Password show/hide (eye) toggle
- [x] `[SDD][M5.3]` Connection-string mode: toggle + "Use" parser; drivers connect via string
- [x] `[SDD][M5.3]` SSL Config: CA / Client Cert / Client Key file paths (Browse) wired into TLS

## M5.4 — Tree UX  ✅ DONE 2026-07-06
- [x] `[SDD][M5.4]` Drag-and-drop to reorder connections (persisted to globalState order)

## M5.5 — Server-level browsing (all databases)  ✅ DONE 2026-07-06
- [x] `[SDD][M5.5]` Postgres tree = connection → databases → schemas → tables → columns
- [x] `[SDD][M5.5]` Database field now optional; enumerate all DBs via pg_database
- [x] `[SDD][M5.5]` Pool-per-database (lazy); previews/edits target the right DB pool
- [x] `[SDD][M5.5]` FK related-row carries the database; New Query runs against its DB
- [x] `[SDD][M5.5]` Connection-string mode ALSO lists all DBs (rewrites the db path segment per pool)
- [x] `[SDD][M5.5]` Composes with SSH tunnel (host rewrite + db rewrite together)
- [x] `[SDD][M5.5]` MySQL: already server-level (lists all databases) — confirmed
- [x] `[SDD][M5.5]` Redis: numbered DBs (db0..dbN) as a level, key counts via INFO keyspace
- [x] `[SDD][M5.5]` SQLite: single file = single database (N/A by design)

## M6 — SSH Tunnel  ✅ DONE 2026-07-06
- [x] `[SDD][M6]` `ssh2` local port-forward established before driver.connect()
- [x] `[SDD][M6]` SSH form section: enable, host/port, username, auth (Auto/Password/Key/Agent), timeout
- [x] `[SDD][M6]` Password / key + passphrase auth; `~` expansion; SSH agent support
- [x] `[SDD][M6]` SSH password + passphrase stored in SecretStorage (not globalState)
- [x] `[SDD][M6]` Tunnel lifecycle tied to connection (opened on connect, closed on disconnect)
- [x] `[SDD][M6]` Test Connection also opens the tunnel
- [x] `[SDD][M6]` SSH tunnel + connection string: parse host/port from URL, rewrite to local port

## M7 — Advanced (lowest priority)
- [ ] `[SDD][M7]` ER diagram generation from foreign keys
- [ ] `[SDD][M7]` Backup / restore (shell out to `pg_dump` / `mysqldump`)
- [ ] `[SDD][M7]` Remaining engines (SQL Server, Oracle, Mongo, ClickHouse, …)

## QA — Human Gate (Phase 4)  ✅ PASSED 2026-07-06
- [x] `[SDD][QA]` Live test: Postgres connect → browse → query → preview
- [x] `[SDD][QA]` Live test: MySQL connect → browse → query
- [x] `[SDD][QA]` Live test: Redis PING → SCAN keys → typed preview
- [x] `[SDD][QA]` Live test: SQLite open file → SELECT
- [x] `[SDD][QA]` Reload VS Code → connections persist, passwords intact, no cap

## Packaging / Adoption
- [x] `[SDD][PKG]` Build installable `.vsix` → `open-db-client-0.1.0.vsix`
- [ ] `[SDD][PKG]` Install into daily-driver VS Code (Extensions → Install from VSIX)

## M8 — Public Launch Readiness (pre-publish gap analysis 2026-07-09)
Lifecycle & listing surface a public user hits before/between/after use.
Priority: 🔴 must-fix before public · 🟡 nice-to-have. Ordered within each block.

### M8.0 — Distribution decision (drives M8.4/M8.5) 🔴
- [ ] `[SDD][M8.0]` Decide channel: **VS Code Marketplace / Open VSX** (auto-update, preferred) vs. **`.vsix` sideload** (no auto-update)
- [ ] `[SDD][M8.0]` Configure a git remote + confirm `open-db-client-0.1.0.vsix` is untracked (`.gitignore` already lists `*.vsix`; the root copy is a build artifact, not source)

### M8.1 — User guides 🟡 (in-app guide + icon legend already ship)
- [ ] `[SDD][M8.1]` Rewrite README for end-users: lead with install (not `npm`/F5), feature list, **screenshots/GIFs** in `media/`
- [ ] `[SDD][M8.1]` README + in-app "Data & Privacy" section: passwords → SecretStorage, config → globalState, query files → globalStorageUri
- [ ] `[SDD][M8.1]` New guide entry: "Uninstalling & removing your data" (pairs with M8.3)
- [ ] `[SDD][M8.1]` Promote SQLite write-back caveat / keyboard shortcuts into the in-app guide (not just README footer)
- [ ] `[SDD][M8.1]` Add `SECURITY.md` (handles DB credentials), `CONTRIBUTING.md`, issue templates

### M8.2 — Versioning 🔴 (data-schema versioning via `CURRENT_SCHEMA_VERSION` already solid)  ✅ CHANGELOG + SemVer DONE 2026-07-09 (e3afbd6, d96d060)
- [x] `[SDD][M8.2]` Add `CHANGELOG.md` (Keep-a-Changelog format; VS Code renders a changelog tab)
- [x] `[SDD][M8.2]` State a SemVer policy in README (CONTRIBUTING deferred); git tags + release process still to adopt
- [ ] `[SDD][M8.2]` "What's New" on upgrade — compare `lastSeenVersion` → current (depends on M8.4)

### M8.3 — Uninstalling 🔴 (highest-value gap for a credential-handling tool)  ✅ IMPLEMENTED 2026-07-09 (554fcfa; code-quality review pending)
- [x] `[SDD][M8.3]` `openDbClient.resetAllData` command: delete every SecretStorage key (password / sshPassword / sshPassphrase per connection), clear globalState `openDbClient.connections`, recursively remove `globalStorageUri` query files
- [x] `[SDD][M8.3]` Surface Reset command in the Settings & Guides panel (with confirm)
- [x] `[SDD][M8.3]` Document that data persists after uninstall + how to purge it

### M8.4 — Version check 🟡 (easy win)  ✅ DONE 2026-07-09 (c9326cf; spec + quality reviewed)
- [x] `[SDD][M8.4]` Read `ctx.extension.packageJSON.version`; show `v{version}` footer in Settings panel
- [x] `[SDD][M8.4]` Store/compare `lastSeenVersion` in globalState on activate (enables M8.2 What's-New + one-time upgrade migrations)

### M8.5 — Update check 🟡 (only if M8.0 = sideload; Marketplace auto-updates)
- [ ] `[SDD][M8.5]` If sideloading: lightweight GitHub-releases version check with an "update available" notice
- [ ] `[SDD][M8.5]` If Marketplace: no custom checker — rely on VS Code auto-update (close as N/A)

### M8.6 — Marketplace metadata 🔴 (required/strongly-recommended manifest fields)
- [ ] `[SDD][M8.6]` `package.json` top-level: `icon` (128×128 PNG), `repository`, `bugs`, `homepage`, `keywords`
- [ ] `[SDD][M8.6]` Optional listing polish: `galleryBanner`; drop `--allow-missing-repository` from the `package` script once `repository` is set

## M9 — Redis Key Explorer (requested 2026-07-20)
**Why**: a real Redis db holds hundreds of keys (observed: `db0 · 304 keys`). A flat,
unsorted, 500-key-capped list is unusable — the user cannot find a key, and cannot
remove one without dropping to a `DEL` command line.
**Copy-don't-innovate reference**: RedisInsight / Another Redis Desktop — key pattern box
above the key list (live filter), right-click key → Delete with confirm.

### M9.1 — Key search / auto-filter 🔴  ✅ DONE 2026-07-20
- [x] `[SDD][M9.1]` `Driver.children(path, filter?)` — optional filter passed down per tree node (other engines ignore it)
- [x] `[SDD][M9.1]` `RedisDriver.scanKeys` uses **server-side `SCAN … MATCH`** (bare text auto-wrapped to `*text*`; `*`/`?`/`[` used verbatim)
- [x] `[SDD][M9.1]` Live search box on a Redis `db*` node (inline 🔍) — debounced 300 ms, tree re-filters **as you type**
- [x] `[SDD][M9.1]` Active filter shown as a pinned first child (`Filter: … — N matches`); click it to clear
- [x] `[SDD][M9.1]` Truncation is honest: "Showing first 500 of more" info node instead of silently cutting
- [x] `[SDD][M9.1]` Keys sorted alphabetically (SCAN order is arbitrary and unreadable)

### M9.2 — Delete key 🔴  ✅ DONE 2026-07-20
- [x] `[SDD][M9.2]` Right-click key → **Delete Key** (modal confirm, names the key + db) → `DEL`
- [x] `[SDD][M9.2]` Right-click key → **View Value** (same typed preview as click)
- [x] `[SDD][M9.2]` Tree refreshes after delete; failures surface as an error toast, never a silent no-op

### M9.3 — Edit key values 🔴  ✅ DONE 2026-07-20
- [x] `[SDD][M9.3]` Type-aware preview shape so a single element is addressable:
      string → `value`, list → `index`/`value`, hash → `field`/`value`, set → `member`, zset → `member`/`score`
- [x] `[SDD][M9.3]` `RedisDriver.updateCell` — double-click a cell to edit:
      `SET` / `LSET` / `HSET` / `SADD`+`SREM` / `ZADD`; hash fields and zset members can be renamed
- [x] `[SDD][M9.3]` **TTL is preserved** on a string edit (`PTTL` → `SET` → `PEXPIRE`) — a rate-limit key must not become immortal because someone edited it
- [x] `[SDD][M9.3]` `deleteRow` deletes the **element** when the grid passes a pk, the **whole key** only when the tree command passes none (no accidental key wipe from the grid)
- [x] `[SDD][M9.3]` `insertRow` — `+ Row` appends to list/set/zset/hash; refused with a clear message on a string

### M9.4 — Follow-ups ▢
- [ ] `[SDD][M9.4]` Multi-select delete of keys from the tree
- [x] `[SDD][M9.4]` View/set a key's TTL explicitly (currently only preserved, never shown) ✅ DONE 2026-07-22
  - [x] `[SDD][M9.4]` `QueryResult.ttl` field carries a key's remaining TTL (ms) from driver to grid
  - [x] `[SDD][M9.4]` `RedisDriver.previewTable` attaches `PTTL`; `setTtl(table, ms|null)` runs `PEXPIRE` (or `PERSIST` when null)
  - [x] `[SDD][M9.4]` Tree: keys **with** an expiry show it in the node description (e.g. `· 42s`); non-volatile keys stay blank so the eye finds the volatile ones. One pipelined `PTTL` batch, no extra round-trips per key
  - [x] `[SDD][M9.4]` Grid: TTL shown in the toolbar with **Set TTL…** / **Persist** controls; edit routes through a native input box, refreshes on save
  - [x] `[SDD][M9.4]` `openDbClient.setTtl` right-click command on a key node (mirrors Delete Key)
  - [x] `[SDD][M9.4]` `formatTtl` unit tests (`test/formatTtl.test.js`)
- [ ] `[SDD][M9.4]` Create a new key from the tree (currently only via a command)
- [ ] `[SDD][M9.4]` Key-count-aware paging instead of the 500-key cap
- [ ] `[SDD][M9.4]` Streams: preview + edit (`XRANGE`) — today they fall back to a raw reply

## M10 — Connection resilience 🟢  ✅ DONE 2026-07-24
Goal: a stuck connection must never force a VS Code restart. Root cause — an in-flight
connect lived in no map (`ConnectionManager`), so `disposeAll()` could not reach it.
- [x] `[SDD][M10]` Track in-flight connects (`pending` map): the half-built driver/tunnel
      is registered *before* `connect()`, so `disposeAll()` tears down a mid-connect node
- [x] `[SDD][M10]` **Stop All Connections** command + view-title button (`$(stop-circle)`):
      `disposeAll()` → `markAllDisconnected()` (bump every generation, drop key filters, collapse)
- [x] `[SDD][M10]` `withTimeout` helper; hard caps on the previously-unbounded hang paths —
      SSH tunnel open (15s) and tree children/expansion queries (20s) → fail to an error node
- [x] `[SDD][M10]` `disposeAll()` (also the `deactivate()` path) now tears down pending
      connects and tunnels too, best-effort, guarded against double dispose/close

## M11 — Table search 🟢  ✅ DONE 2026-07-24
Goal: a schema with dozens of tables should be filterable, the way Redis keyspaces
already are. Reuse the existing per-node filter mechanism (`keyFilters` map +
`getKeyFilter`/`setKeyFilter`/`clearKeyFilter` + the `keyfilter` pinned row).
- [x] `[SDD][M11]` `openDbClient.searchTables` command: shared `liveFilterInput` helper
      (extracted from `searchKeys`) drives a debounced input box wired to the node's filter
- [x] `[SDD][M11]` `$(search)` inline + context action on `schema` (PostgreSQL) and
      `database` (MySQL) nodes; anchored `when` regex keeps it off `database-redis`
- [x] `[SDD][M11]` Tree narrows structural rows (table/view/schema/db) by label client-side
      and pins a `Filter: … · N matches` row (context value `keyfilter`, so the existing
      `clearKeyFilter` command + menu clear it) — no driver changes, works for every SQL engine

## M12 — SSH "Auto" default-key fallback 🟢  ✅ DONE 2026-07-28
Bug: a connection that works in another client / the terminal failed here with SSH
**Auth = Auto** and no key path. Root cause — `ssh2` never reads `~/.ssh/id_*` on its own
(the `ssh` CLI does), so "Auto" only tried the empty agent and gave up.
- [x] `[SDD][M12]` `SshTunnel.resolvePrivateKey()`: explicit path wins; otherwise fall back
      to the first default identity file that parses (`id_ed25519` → `id_rsa` → `id_ecdsa`)
- [x] `[SDD][M12]` Validate with `ssh2.utils.parseKey` before offering a default key, so an
      encrypted key with no passphrase is skipped instead of throwing before agent/password run

## M13 — Copy as JSON 🟢  ✅ DONE 2026-07-29
Goal: get rows out of the grid and into an editor/ticket/API payload without a round-trip
through a saved file. Export CSV/JSON both force a save dialog; the common case is "give me
*these two rows* as JSON". Cheap by construction — `raw.rows` is already in webview memory,
so this only allocates the output string (see the size gate below for the real ceiling).
- [x] `[SDD][M13]` **Copy as JSON** toolbar button next to Export CSV/JSON; builds the payload
      in the webview and reuses the existing `copy` message → `vscode.env.clipboard`
- [x] `[SDD][M13]` Shape: exactly 1 checked row → bare object; 2+ → array. Nothing checked
      (or a non-editable result, which renders no checkboxes) → every row **in view**, array-wrapped
- [x] `[SDD][M13]` Order/contents follow `computeView()` — current sort, per-column filters and
      search — so the clipboard matches what's on screen, not `raw.rows` order
- [x] `[SDD][M13]` Honest limits: payloads over 5 MB raise a modal "Copy anyway" confirm
      (`COPY_WARN_CHARS`) — the cost lands on the paste target, not on us; the toast reports
      the row count actually copied, and an empty view says so instead of copying `[]`

## M14 — Grid search & filter reliability 🟢  ✅ DONE 2026-07-30
Bugs: (a) focus jumped out of a column-filter box mid-typing, (b) the global search found
nothing for values that are demonstrably in the table.
- [x] `[SDD][M14]` **Focus loss, cause 1** — every re-render does `gridEl.innerHTML = h` and the
      filter inputs live *inside* the grid header, so the box being typed in is destroyed. On
      non-paginated results the client-side branch re-rendered on **every keystroke** with no
      focus repair at all (`restoreFilterFocus` only ran on a `result` message)
- [x] `[SDD][M14]` **Focus loss, cause 2** — `pendingFilterFocus` was a single slot consumed by
      the first response to land; two overlapping round-trips (350ms debounce vs. a ~0.4s query)
      left the second re-render with an empty slot and nothing restored focus
- [x] `[SDD][M14]` Fix: `renderGrid()` captures `document.activeElement` + `selectionStart/End`
      before the wipe and restores both after — covers keystroke, filter, sort, page and refresh
      re-renders on both the client-side and server-backed paths, and keeps the caret where it
      was instead of forcing it to end-of-text. `pendingFilterFocus`/`lastFilterCol`/
      `restoreFilterFocus` all deleted
- [x] `[SDD][M14]` **Stale responses**: filter/sort/page messages now carry `seq: ++reqSeq`,
      threaded through `runPreview` → `show` → the `result` message; the webview drops any
      response older than the newest it has rendered. Fixes the grid briefly showing rows that
      don't match what's in the filter boxes. Seq-less results (fresh runs, post-edit refreshes)
      always render
- [x] `[SDD][M14]` **Global search is page-local, and now says so.** It filters `raw.rows` —
      the loaded page — and is never sent to the DB, so on a 223-row table paged at 100 it
      silently missed ~55% of rows. Placeholder switches to "Search this page…" when a preview
      is paginated, and a new `#scope` line reports `N of 100 rows on this page match · page 1
      of 3 — Total 223 (search covers the loaded page only)`. Per-column filters are unaffected
      — those do hit the database and cover the whole table
- [x] `[SDD][M14]` **JSON/`jsonb` columns were unsearchable.** `pg` returns `jsonb` as a parsed
      object; `display()` stringified it for the grid but search/filter/sort used `String(v)`,
      i.e. `"[object Object]"` — so no term could ever match a JSON cell, and sorting by one
      compared every row as equal. Same class of bug on `Date` columns (grid showed quoted ISO,
      search compared `"Tue Jul 29 2026 …"`)
- [x] `[SDD][M14]` Fix: one `cellText()` helper is now the single place a cell becomes text —
      used by `display()`, the client-side column filter, the global search, the sort
      comparator and the inline double-click editor (which previously seeded the input with
      `[object Object]` for a `jsonb` cell)
- [ ] `[SDD][M14]` Known gap: on a **server-backed** preview a per-column filter on `jsonb`
      runs as `col::text ILIKE`, and Postgres renders `jsonb::text` with spaces
      (`{"a": 1}`) while the grid displays compact `JSON.stringify` (`{"a":1}`). Filtering on a
      pasted `"key":"value"` fragment therefore matches client-side but not server-side; plain
      values (`DGS-00374`) match in both
- [ ] `[SDD][M14]` Deferred: true server-side global search (OR across all columns per driver) —
      rejected for now on unindexed-`ILIKE` cost; revisit if page-local proves too limiting

## M15 — Per-connection Close Connection 🟢  ✅ DONE 2026-07-30
Gap: the only one-click way to drop a connection was the title-bar **Stop All Connections**
(`$(stop-circle)`), which is all-or-nothing. Closing a single connection meant knowing to
right-click the node. With many saved connections open at once, that's the common case.
- [x] `[SDD][M15]` Surface the existing `openDbClient.disconnect` command as an **inline**
      icon (`$(debug-disconnect)`, `inline@2`) on connection rows, next to Refresh and
      New Query. No new command or driver work — the per-connection teardown
      (`manager.disconnect` + `tree.markDisconnected`) already existed
- [x] `[SDD][M15]` Gated on `viewItem == connectionActive`, so the icon appears only on
      connections that are actually live and vanishes the moment one is closed. The
      right-click entry stays for discoverability; **Stop All** stays as the bulk action

## M16 — Sticky grid filter row 🟢  ✅ DONE 2026-07-30
Bug: scroll a long result set and the per-column filter boxes scroll away with the body, so
you lose the filters on any result taller than the grid.
- [x] `[SDD][M16]` Root cause: `.filterRow th { position: static }` — a single declaration
      that opted the second header row out of the sticky header entirely. It outranks the
      generic `th { position: sticky; top: 0 }` on specificity (0,1,1 vs 0,0,1), so the name
      row stuck and the filter row did not
- [x] `[SDD][M16]` Fix: `.filterRow th { position: sticky; top: var(--hdr-h, 0px);
      z-index: 2; padding: 2px }` — one rule now owns the filter row's stickiness, so there
      is no second place to override it from
- [x] `[SDD][M16]` `--hdr-h` is **measured** in `syncHeaderOffset()` after every render, not
      hard-coded: the name row's height varies with the optional type sub-label and the
      user's editor font. Re-run on `window.resize` (a wrapping column name changes it).
      A constant here would either overlap the names or leave a gap
- [x] `[SDD][M16]` Second bug fixed in the same pass: `th` had no `z-index`, while
      `td.editable` / `td.fkcell` are `position: relative`. Both at auto z-index → body
      cells painted *over* the sticky header as they scrolled under it. `th` is now
      `z-index: 3`, the filter row `2`
- [x] `[SDD][M16]` Verified against the **real** stylesheet extracted from `queryPanel.ts`
      (a hand-written repro missed the `position: static` rule and mis-diagnosed the cause
      first time round). At `scrollTop 800`: filter row `position=sticky`, `top=35px` =
      measured name-row height, `elementFromPoint` on the filter box returns that input
      (so it is clickable, not merely visible), focus + typing work, and the name row
      hit-tests to `div.cname` rather than a `td`
- [ ] `[SDD][M16]` Remaining human check: exercise in the Extension Development Host against
      a live table taller than the grid

## M17 — Clear all filters 🟢  ✅ DONE 2026-07-30
Goal: one control that drops every active filter. The grid has two independent filtering
mechanisms (page-local global search + per-column filters, the latter server-side on a
paginated preview), so clearing them one box at a time was tedious.
- [x] `[SDD][M17]` `Clear filters` button in the results bar, next to the search box it
      complements. Resets `filters = {}` and `search = ''` and empties the visible boxes
- [x] `[SDD][M17]` Both filtering paths reset, not just the inputs: a client-side result
      just redraws, while a **server-backed** preview also posts
      `{ type:'filter', filters: [] }` so the database returns the unfiltered page
- [x] `[SDD][M17]` `clearTimeout(filterTimer)` — clearing mid-debounce would otherwise let
      the pending 350ms round-trip fire and re-query with the terms just cleared
- [x] `[SDD][M17]` Disabled when nothing is filtered (`hasAnyFilter()`), so it never looks
      actionable when it would be a no-op. Synced from `renderGrid()`, plus explicitly in
      the server-backed filter-input branch — that path debounces instead of redrawing, so
      the button would otherwise stay stale until the response landed
- [x] `[SDD][M17]` Sort is deliberately **not** reset — the ask was filters, and losing
      column order on a "clear filters" click would be a surprise
- [x] `[SDD][M17]` Verified by running the panel's **real** script body in a browser harness
      with a stubbed `acquireVsCodeApi`. Client-side: 40 rows → 13 (column filter) → 5
      (+ search) → 40 after Clear, button re-disabled, all boxes and the scope line empty,
      zero messages posted. Server-backed: exactly one `filters: []` post, and no stale
      second round-trip 600ms later
- [ ] `[SDD][M17]` Remaining human check: exercise in the Extension Development Host

## M18 — SQL language suite: completion + formatting 🟡  SPEC LOCKED 2026-07-30
Spec: `docs/DISCOVERY_SQL_AUTOCOMPLETE.md` (locked) → `docs/BLUEPRINT_SQL_AUTOCOMPLETE.md`.
Locked: custom widget in the webview (not Monaco, not routed to `.sql`), table-aware columns,
dialect-aware vocabulary, **and dialect-aware formatting** — the "full suite".
Context: `sqlFeatures.ts` already gives **native** IntelliSense to saved `.sql` files, but it
is scoped `{ language:"sql", scheme:"file" }` — the panel's `<textarea>` gets nothing. That
gap is the whole feature.

**Dependency decision (measured, reversed from the first pass):** take `sql-formatter` 15.8.2
(MIT), imported per-dialect via `formatDialect` — **87 KB minified / 24 KB gzipped, +3.2 %**
on the bundle. The `format` barrel pulls all 21 dialects (313 KB) and must not be used. One
dependency serves both halves: it formats, *and* its dialect objects expose the completion
vocabulary — Postgres 653 functions / 116 keywords / 323 clauses, MySQL 411/228/245, SQLite
116/149/52, against today's 46 hardcoded dialect-blind keywords.

### M18.0 — Prerequisite (done ahead of the spec)
- [x] `[SDD][M18]` `src/drivers/postgres.ts` held a **raw NUL byte** in the `CS_KEY` literal
      (byte 418), which made `file` report "data" and made grep/ripgrep treat the file as
      binary and **silently return no matches**. That is how the Postgres driver first looked
      like it was missing `schemaHints` when it implements it at line 418. Replaced with an
      escaped `` — identical runtime value, source is ASCII again, grep works

### M18.1a — Dialect vocabulary from `sql-formatter` (static baseline) 🟢  ✅ DONE 2026-07-30
- [x] `[SDD][M18]` Add `sql-formatter@15` to `dependencies`. Import **only** via
      `formatDialect` + named dialect imports so esbuild tree-shakes the other 18 dialects;
      a stray `import { format }` silently costs 226 KB. Add a bundle-size check to QA
- [x] `[SDD][M18]` `src/sqlDialect.ts`: map connection `type` → dialect vocabulary
      (keywords + clauses + functions + data types) pulled from the dialect's
      `tokenizerOptions`. Redis has no dialect → returns a static command list
- [x] `[SDD][M18]` Retire the hardcoded 46-keyword `KEYWORDS` array in `sqlFeatures.ts` in
      favour of this — it is dialect-blind and an order of magnitude smaller

### M18.1b — Driver: table-aware columns 🟢  ✅ DONE 2026-07-30
- [x] `[SDD][M18]` Widen `schemaHints` to return `SchemaHints` (`columnsByTable?`, `keywords?`,
      `functions?`, `truncated?`), all **optional** so Redis and any failing catalog query
      degrade to today's behaviour. `tables`/`columns` unchanged → existing callers compile
- [x] `[SDD][M18]` Postgres: `columnsByTable` from one `information_schema.columns` pass.
      This is the part that matters — the static baseline cannot know your schema
- [x] `[SDD][M18]` MySQL + SQLite: same `columnsByTable` treatment
- [x] `[SDD][M18]` Redis: `keywords` = `COMMAND LIST`; tables/columns stay empty. The one
      engine with no static dialect, so this is its only vocabulary source. Verify live
- [x] `[SDD][M18]` **Optional** augmentation on top of the static baseline, each behind a
      try/catch that degrades silently — these are designed from docs and **unverified**:
      Postgres `pg_proc` (user-defined functions), MySQL `information_schema.KEYWORDS`
      (8.0.11+), SQLite `pragma_function_list` (**verified**: 155 functions on sql.js 3.49.1)
- [x] `[SDD][M18]` Set `truncated` when a LIMIT is hit (Postgres already caps at 2000/4000) so
      the UI can admit it instead of silently dropping suggestions

### M18.2 — Pure logic: `src/sqlComplete.ts` + unit tests 🟢  ✅ DONE 2026-07-30
- [x] `[SDD][M18]` Export `currentToken`, `aliasMap`, `tablesInScope`, `completionContext`,
      `rank` — pure functions, no VS Code API, so `test/sqlComplete.test.js` can cover them
      under the existing `node:test` + compiled-`out/` setup
- [x] `[SDD][M18]` Context rules: `FROM`/`JOIN`/`INTO`/`UPDATE` → tables;
      `SELECT`/`WHERE`/`ON`/`SET`/`GROUP BY`/`ORDER BY`/`HAVING` → in-scope columns + keywords;
      `alias.` / `table.` → that table's columns only; else keywords + functions + tables
- [x] `[SDD][M18]` Ranking must reproduce the reference: `or` → `ORDER BY, OR, ORDER,
      ORDINALITY`. Tiers exact → prefix → contains; then in-scope columns > tables > keywords
      > functions > alpha
- [x] `[SDD][M18]` Test the ugly cases: quoted identifiers, trailing comments, `--` and `/* */`,
      caret mid-word, aliases without `AS`, multi-statement buffers

### M18.3 — Webview widget 🟢  ✅ DONE 2026-07-30
- [x] `[SDD][M18]` Caret pixel position via a hidden mirror element (cloned font/padding/width),
      **minus `textarea.scrollTop`** — the known-fiddly part
- [x] `[SDD][M18]` Dropdown with per-kind icons (keyword / function / table / column) as in the
      reference screenshots; flip above the caret when it would clip the panel bottom
- [x] `[SDD][M18]` Cap the visible list and show an explicit "showing first N" row when cut —
      house rule is to admit truncation, and surface `truncated` from M18.1 here too
- [x] `[SDD][M18]` Keys ↑ ↓ Enter Tab Esc + click. **Must not swallow `Ctrl/Cmd+Enter` (run) or
      `Cmd+S` (save)** — both already bound on `sqlEl`/`window`; handler ordering is the
      regression risk. Esc must close the list, not the panel
- [x] `[SDD][M18]` Suppress during IME composition (`compositionstart`/`compositionend`)
- [x] `[SDD][M18]` Never block typing: a cache miss shows keywords only, no await on the DB

### M18.4 — Host ↔ webview wiring 🟢  ✅ DONE 2026-07-30
- [x] `[SDD][M18]` Host posts `{ type:"hints", … }` on panel open and after a connection or
      database change; webview caches in memory. Key `connId::database`, mirroring
      `sqlFeatures.ts`. Invalidate on `refresh`

### M18.5 — Feed the native `.sql` provider the same data 🟢  ✅ DONE 2026-07-30
- [x] `[SDD][M18]` `sqlFeatures.ts` currently serves a hardcoded 46-keyword list. Pass it
      `columnsByTable` + dialect `keywords`/`functions` so **saved query files** become
      table-aware and dialect-aware too. Same data, second surface, small change

### M18 — notes from the build (2026-07-30)
- [x] `[SDD][M18]` **Completion runs on the host, not in the webview.** The widget posts
      `{type:'complete', text, seq}` and renders the reply; all reasoning stays in the
      unit-tested `sqlComplete.ts` rather than being duplicated as untested webview JS.
      Stale replies are dropped by `seq`, the same guard the results grid uses
- [x] `[SDD][M18]` **Typing never triggers a connect.** Schema hints load only when the
      connection is already live (`manager.isConnected`); until then completion still works
      off the dialect vocabulary, which needs no connection. A password prompt must never be
      a side effect of typing
- [x] `[SDD][M18]` Ranking fix found in the live harness: Postgres really has `OR DELETE` /
      `OR INSERT` / `OR TRUNCATE`, and alphabetically they all precede `ORDER`, so `ORDER BY`
      was pushed off the top for "or". Added a shorter-label-first tiebreak — applied only
      when a prefix was typed, since with an empty prefix alphabetical is what reads
- [x] `[SDD][M18]` Insertion no longer doubles a space when accepting mid-statement
      (`from sav| LIMIT 10` → `from saving_plans LIMIT 10`, not two spaces)
- [ ] `[SDD][M18]` **Deferred (was M18.1b optional):** server-reported vocabulary
      augmentation — Postgres `pg_proc` user-defined functions, MySQL
      `information_schema.KEYWORDS`, SQLite `pragma_function_list`, Redis `COMMAND LIST`.
      The static dialect baseline made these unnecessary for the core experience; they only
      add user-defined names. Redis currently uses a small static command list
- [x] `[SDD][M18]` **Fix (reported from live use):** `ORDER BY` / `GROUP BY` / `PARTITION BY`
      now withhold the keyword vocabulary — only a column or function can begin an expression.
      Typing `d` after `ORDER BY` had offered `DO/DAY/DESC/DROP`, and accepting produced
      `ORDER BY DESC`, a syntax error. `ASC`/`DESC` become available again once a sort column
      is present
- [x] `[SDD][M18]` **Fix (reported from live use):** a trailing `name.` means a **schema** in a
      table position (`FROM public.` → tables) and a table/alias anywhere else (`WHERE sp.` →
      columns). Reading it always as an alias made `FROM public.er` suggest nothing, because
      no table is called `public`. Accepting keeps the `public.` prefix
- [x] `[SDD][M18]` Fix: the `any` context no longer offers table names. A bare table is only
      valid after `FROM`/`JOIN`/`INTO`/`UPDATE`, so listing every table after
      `ORDER BY created_at ` was noise. An earlier test asserted the old behaviour and was
      corrected rather than worked around
- [x] `[SDD][M18]` A trailing comma is treated as a column list continuation (`SELECT a, `,
      `ORDER BY a, `). Known limitation: `FROM a, b` comma-joins get column context too —
      acceptable, since explicit `JOIN` is the common form
- [ ] `[SDD][M18]` Known: with an **empty** prefix in a mid-statement position the keyword list
      is alphabetical, so `ABORT`/`ADD COLUMN` head the list where `ASC`/`DESC`/`LIMIT` would be
      more useful. Needs frequency or position weighting; typing one character already fixes it
- [ ] `[SDD][M18]` Deferred: CTE / subquery scope. The context scan handles `FROM`, `JOIN`,
      aliases and qualifiers, not `WITH x AS (…)`. Revisit only if it bites

### M18.6 — Formatting (`src/sqlFormat.ts`) 🟢  ✅ DONE 2026-07-30
**Measured on landing:** production (minified) bundle **1704 KB → 1792 KB = +88 KB**, inside
the 90 KB budget. Note the *dev* (unminified) build grows ~149 KB — that is whitespace, not
dialects; always judge the budget against `--production`, which is what `vsce package` ships.
An earlier worry that the CJS entry would defeat tree-shaking proved wrong: aliasing to the
ESM build produced a byte-identical 1792 KB, so no esbuild config change was needed.

- [x] `[SDD][M18]` `canFormat(type)` / `formatSql(sql, type)` — one thin module is the **only**
      importer of `sql-formatter`, so the dependency stays containable. Dialect is chosen from
      the connection `type`, the same discriminant `registry.ts` switches on
- [x] `[SDD][M18]` Redis → `canFormat() === false`, and the button/command is **hidden**, not a
      no-op — the house pattern for capabilities only some engines have (`if (driver.setTtl)`)
- [x] `[SDD][M18]` **Never destroy work**: on a parse error leave the buffer untouched and
      report it. Formatting must never replace a query with a mangled parse
- [x] `[SDD][M18]` Surfaces: `Format` button in the panel bar (plus `Shift+Alt+F` inside the
      panel), and a native `DocumentFormattingEditProvider` for `.sql` so VS Code's own
      Format Document works on saved query files
- [x] `[SDD][M18]` Dropped the planned standalone `openDbClient.formatSql` command as
      redundant — the provider already owns `Shift+Alt+F` / Format Document for files, and the
      panel has its own button. One less command in the palette for no lost capability
- [x] `[SDD][M18]` Options `keywordCase: "upper"` + `tabWidth`; expose in the settings panel
      later, not this milestone
- [x] `[SDD][M18]` Unit tests — pure string→string, fits the existing `node:test` tier.
      Verified samples to lock in: Postgres `->>` / `interval`, MySQL backtick identifiers,
      SQLite `json_extract`

### M18.8 — Multi-database binding + context badge 🟢  ✅ DONE 2026-07-30
Reported: on a server with several databases/schemas, Run on a previewed table failed with
`relation "drizzle.__drizzle_migrations" does not exist` and suggestions stopped working.
- [x] `[SDD][M18]` Root cause: a preview panel never bound `this.database` — `previewTable`
      resolves its own path, but the panel's Run (`driver.query(sql, database)`) and
      completion hints (`schemaHints(database)`) both fell back to the connection's **entry**
      database. Wrong DB → missing relation on Run, wrong/empty tables in suggestions
- [x] `[SDD][M18]` Fix: bind the panel to `previewPath[0]` on multi-database engines
      (postgres/mysql db name, redis db number — `RedisDriver.query` does `SELECT n`).
      SQLite excluded: its `path[0]` is a table name and it has one database anyway
- [x] `[SDD][M18]` Fix: schema hints are now cached **per database** (`hintsDb`) with an
      in-flight guard — a panel re-pointed via `rerun` refetches instead of serving the old
      database's tables forever
- [x] `[SDD][M18]` **Context badge**: the panel bar now shows which database queries actually
      run against (`aerobus`, `db0`, or the SQLite file name), with a tooltip naming the
      connection and how to target a different database. Updates live on `rerun`.
      **Schema deliberately not shown** — a session isn't pinned to one; unqualified names
      resolve via `search_path` and suggestions already span every schema
- [ ] `[SDD][M18]` F5 check: preview `drizzle.__drizzle_migrations` on a multi-DB server →
      Run succeeds; suggestions offer that database's tables; badge shows the right DB

### M18.7 — Phase 4 QA gate 🔴
- [ ] `[SDD][M18]` Unit tests green for every `sqlComplete.ts` and `sqlFormat.ts` export
- [ ] `[SDD][M18]` Manual matrix: 4 engines × {keyword prefix, table after `FROM`, column after
      `WHERE`, `alias.` qualified, Format}
- [ ] `[SDD][M18]` Regression: `Ctrl/Cmd+Enter` runs, `Cmd+S` saves, Esc closes only the list
- [ ] `[SDD][M18]` Degradation: catalog query denied → static baseline still serves, nothing
      surfaced to the user
- [ ] `[SDD][M18]` Confirm `truncated` reaches the UI on a wide schema
- [ ] `[SDD][M18]` **Bundle budget**: `dist/extension.js` grows by ≲ 90 KB. If it jumped ~300 KB
      someone imported the `format` barrel instead of `formatDialect`

## M19 — Editor ergonomics in the query panel (requested 2026-07-31)
Reported: the panel's editor is a bare textarea — no way to comment a line out, and Run
always fires the whole buffer even when one statement is highlighted.

### M19.1 — Toggle line comment (`Ctrl/Cmd+/`) 🟢  ✅ DONE 2026-07-31
- [x] `[SDD][M19]` VS Code's `editor.action.commentLine` is gated on `editorTextFocus`, so it
      never reaches a webview — the panel binds its own handler on the textarea
- [x] `[SDD][M19]` Whole-line semantics: acts on every line the selection touches; a selection
      ending exactly on a line break does **not** drag in the following line
- [x] `[SDD][M19]` Uncomments only when **every** non-blank line is already commented —
      on a mixed block, toggling would otherwise silently uncomment half the selection
- [x] `[SDD][M19]` Comments at the shallowest indent in the block so it keeps its shape;
      blank lines are left alone
- [x] `[SDD][M19]` Caret/selection is mapped through the edit (columns before the edit point
      stay put); the write goes through `execCommand('insertText')` so the native **undo**
      stack survives, with a `.value` assignment as fallback
- [x] `[SDD][M19]` Not bound on **Redis** — a buffer there is one command, and `--` would be
      sent as an argument rather than ignored. No binding beats a broken one
- [x] `[SDD][M19]` Suppresses the completion request the synthetic input event would fire,
      so commenting never pops the suggestion list

### M19.2 — Highlight-to-run (`Ctrl/Cmd+Enter`) 🟢  ✅ DONE 2026-07-31
- [x] `[SDD][M19]` With a non-blank selection, only the selected text is sent as the query;
      otherwise the whole buffer, as before
- [x] `[SDD][M19]` The **Run button** follows the same rule (a textarea keeps its selection
      after blur) — one rule to learn, not two
- [x] `[SDD][M19]` Honest UX: status reads "Running selection…" vs "Running…", the button
      tooltip says so, and the idle hint under the bar spells out both shortcuts
- [x] `[SDD][M19]` No host change — the existing `run` message carries whatever text was sent,
      so editable-table extraction operates on the statement that actually ran

### M19.3 — Phase 4 QA gate 🔴
- [ ] `[SDD][M19]` F5 matrix: caret-only toggle, multi-line toggle, re-toggle restores the
      original text, indented block keeps its shape, mixed block comments all
- [ ] `[SDD][M19]` Undo (`Cmd+Z`) after a toggle restores the previous buffer in one step
- [ ] `[SDD][M19]` Highlight one statement of several → Run and `Cmd+Enter` both run only it;
      clear the selection → whole buffer runs again
- [ ] `[SDD][M19]` Redis panel: `Cmd+/` does nothing, hint text omits it, highlight-to-run works
- [ ] `[SDD][M19]` Regression: `Cmd+S` saves, `Shift+Alt+F` formats, Esc closes only the
      completion list, suggestions still fire on ordinary typing

## M20 — Connection portability (import / export) 🟢  SPEC LOCKED 2026-08-02
Spec: `docs/BLUEPRINT_CONNECTION_PORTABILITY.md`. Requested 2026-08-02: move connections
between machines; on import, **append — never replace**.

### M20.0 — Discovery finding (drives the whole design)
- [x] `[SDD][M20]` `ConnectionConfig.connectionString` is persisted **whole** into globalState,
      so a pasted `postgres://user:pass@host/db` puts the password in cleartext in an
      unencrypted SQLite file. Verified: **5 of 11** connections on the author's install.
      Therefore an export that only omits SecretStorage values is still a credential dump —
      URL redaction is part of the export contract, not a nicety

### M20.1 — Core logic (`src/connections/portability.ts`) ✅ DONE 2026-08-02
- [x] `[SDD][M20]` Pure module (no vscode, no fs) so redaction / whitelist / crypto are unit-testable
- [x] `[SDD][M20]` `redactConnectionString` strips the password, keeps scheme/user/host/port/db/query.
      Username kept deliberately — not a secret, and already cleartext in the `username` field for
      every non-connection-string connection. Non-URL-parseable strings fall back to a textual
      strip rather than failing **open**
- [x] `[SDD][M20]` `buildExport` — omits `id` + `schemaVersion` (ids are local SecretStorage keys);
      `secrets: "omitted" | "included"`; flags redacted entries and returns their names to report
- [x] `[SDD][M20]` `parseImport` treats the file as untrusted: `kind`/`version` checked first,
      fields **whitelisted** by primitive type (several are paths the extension later reads —
      `sslCA`, `sslKey`, `sshPrivateKeyPath` — and `connectionString` is dialled), bad entries
      dropped individually with warnings so one malformed record doesn't cost the other ten
- [x] `[SDD][M20]` `identityKey` — `type + host + port + database + username`, `filePath` for SQLite,
      `redisDb` for Redis, resolved **through** the connection string so the same server saved two
      ways dedupes. Ignores display name and SSL/SSH options (how you reach it, not which it is)
- [x] `[SDD][M20]` `mergeConnections` — append-only; existing entries untouched; fresh ids; secrets
      returned keyed by new id so they land in SecretStorage; name clash on a *different* server
      gets ` (imported)` / ` (imported N)`
- [x] `[SDD][M20]` `encryptBundle`/`decryptBundle` — scrypt (N=16384, r=8, p=1) → AES-256-GCM,
      random salt + IV per file, auth tag verified. `node:crypto` only, no new dependency

### M20.2 — Commands & UX ✅ DONE 2026-08-02 (revised 2026-08-03, M20.5)
- [x] `[SDD][M20]` `exportConnections` / `importConnections`, on `view/title` group
      `1_portability` (the **…** overflow, not the 4 navigation icons) and in the palette under
      an **Open DB Client** category
- [x] `[SDD][M20]` Encrypted export asks for the passphrase **twice** (min 8 chars) — there is no
      recovery, so a typo has to be caught here, not on the other machine
- [x] `[SDD][M20]` Encrypted file written `0600`, best-effort `chmod` after (mode only applies on
      create, and the save dialog may be overwriting)
- [x] `[SDD][M20]` Honest reporting: export names the connections whose connection-string password
      was stripped; import shows added/skipped **before** writing, then reports counts, warns when
      the file carried no passwords, and logs each dropped entry to the output channel
- [x] `[SDD][M20]` Guides updated — new "Move your connections to another machine" section, and the
      uninstall page now states the connection-string cleartext caveat plainly
- [x] `[SDD][M20]` **Backup & transfer guide** (asked 2026-08-02: "how do I open the encrypted
      file?"). Answer in-app: you import it, the passphrase prompt fires on content sniffing not
      filename. Also covers which export to pick, the two failure messages, "lose the passphrase and
      it is gone", and a verified `node` decrypt snippet so an encrypted export is not lock-in —
      with the caveat that running it prints passwords to the terminal and leaves the passphrase in
      shell history

### M20.3 — Unit tests ✅ DONE 2026-08-02 (`test/portability.test.js`, 24 tests)
- [x] `[SDD][M20]` Redaction: password stripped / left alone / non-parseable fallback
- [x] `[SDD][M20]` Export: asserts the serialized file does **not** contain the password, SSH
      passphrase, or `:pw@` — the leak test, not just a shape test
- [x] `[SDD][M20]` Import: foreign `kind`, newer version, encrypted file, unknown fields,
      invalid `sshAuth`, wrong-typed fields, per-entry warnings
- [x] `[SDD][M20]` Merge: append-only, skip duplicates, twice-is-a-no-op, name-clash rename,
      secrets keyed by new id and removed from the config
- [x] `[SDD][M20]` Crypto: round-trip, no plaintext in the bundle, fresh salt/IV per export,
      wrong passphrase, tampered ciphertext

### M20.4 — Phase 4 QA gate 🔴
- [ ] `[SDD][M20]` F5: export plain → open the file and confirm no password appears anywhere,
      including for the 5 connection-string connections
- [ ] `[SDD][M20]` F5: export encrypted → import on a fresh profile → connections connect without
      re-entering passwords; wrong passphrase gives a clean error, not a stack trace
- [ ] `[SDD][M20]` F5: import the same file twice → second run reports 0 added / N skipped and the
      tree is unchanged
- [ ] `[SDD][M20]` F5: import a file with one connection you already have and one you don't →
      exactly one added, existing rows untouched and in the same order
- [ ] `[SDD][M20]` F5: hand-edit a file to add junk fields and a bogus entry → import succeeds,
      junk dropped, warning count shown, output channel names the reason
- [ ] `[SDD][M20]` Confirm imported secrets are in SecretStorage and **not** in globalState

## M21 — Connection-string passwords into SecretStorage 🔴 (from M20.0)
- [ ] `[SDD][M21]` Split `connectionString` on save: keep the URL minus the password in globalState,
      put the password in SecretStorage, re-assemble at connect time. Migrate existing records on
      upgrade (`schemaVersion` 2) so today's cleartext entries are cleaned up, not just new ones
- [ ] `[SDD][M21]` Until then the caveat is documented in the uninstall guide (M20.2)

### M20.5 — Third export mode: plaintext, behind a gate ✅ DONE 2026-08-03
Requested 2026-08-03: alongside encrypt and mask, an option that shows the passwords —
"but with extra dialog to get user to confirm the action".
- [x] `[SDD][M20]` **Consolidated to one `Export Connections…` command** with a QuickPick of three
      modes instead of adding a third command. Three export entries in a 2-item overflow menu
      would have buried the safe one; a picker lists them safest-first with the cost of each
      stated in the `detail` line, at the moment of choosing. `exportConnectionsEncrypted` is
      gone — never released, so no migration owed
- [x] `[SDD][M20]` Plaintext mode writes the same document as the encrypted one, unencrypted:
      SecretStorage secrets included, connection strings **not** redacted (readability is the
      whole point of the mode)
- [x] `[SDD][M20]` **The gate** is a modal that states facts, not a generic caution: it counts the
      database passwords, SSH secrets, *and* passwords embedded in connection strings that are
      about to be written. `countEmbeddedCredentials` exists because that last group is invisible
      to any SecretStorage lookup, yet is the majority of this install's credentials (M20.0)
- [x] `[SDD][M20]` The dialog offers **"Use the encrypted export instead"** as a button — the safer
      route is one click away at the point of risk, not advice buried in the message
- [x] `[SDD][M20]` Degenerate case: no stored secrets at all → say so and fall back to the redacted
      export rather than writing a "plaintext" file that is identical to the safe one
- [x] `[SDD][M20]` Defence in depth after the confirm: filename `…PLAINTEXT.json`, a `warning`
      field stamped **inside** the document (whoever opens it next may not be who exported it),
      `0600` where the filesystem allows, and a warning — not info — toast naming the file and
      saying to delete it
- [x] `[SDD][M20]` `warning` is ignored by `parseImport`; a plaintext file imports like any other
- [x] `[SDD][M20]` Guides + changelog rewritten for three modes; the Backup & transfer guide gains
      an "About the plain-text option" section spelling out what such a file means in practice
- [x] `[SDD][M20]` Tests: plaintext keeps secrets and skips redaction, `warning` present only when
      asked, `countSecrets` / `countEmbeddedCredentials`, and a plaintext round-trip through import

### M20.6 — Phase 4 QA gate for the plaintext mode 🔴
- [ ] `[SDD][M20]` F5: picker shows three modes, safest first, each with a readable detail line
- [ ] `[SDD][M20]` F5: plaintext → the modal's counts match reality (expect 5 embedded on this
      install per M20.0); Cancel and Escape both write nothing
- [ ] `[SDD][M20]` F5: "Use the encrypted export instead" hands off to the passphrase prompt
- [ ] `[SDD][M20]` F5: exported plaintext file is `0600`, named `…PLAINTEXT.json`, carries the
      `warning` field, and imports cleanly with passwords landing in SecretStorage
- [ ] `[SDD][M20]` F5: on a profile with no stored passwords, plaintext falls back to redacted
      with the explanation shown

## M21 — Connection form UX polish (requested 2026-08-05)

### M21.0 — Test-result placement + button affordance ✅ DONE 2026-08-05
- [x] `[SDD][M21]` Move the test-connection result banner from the top of the form (off-screen
      once the form is scrolled) into the fixed footer, beside the Test Connection button —
      the result appears where the user just clicked
- [x] `[SDD][M21]` Long error messages ellipsize in the footer row; full text available via
      hover tooltip (honest UX: nothing silently hidden)
- [x] `[SDD][M21]` Test Connection loses its `ghost` styling so it reads as a real button
      (secondary background) instead of blending into the footer

## M22 — AI Query Assistance (BYOK) + Usage Monitor (requested 2026-08-05)

Spec: `DISCOVERY_AI_ASSISTANT.md` (locked 2026-08-05) → `BLUEPRINT_AI_ASSISTANT.md`.
Locked: Anthropic + OpenAI + OpenAI-compatible custom base URL; inline assist bar
(never auto-run); Generate / Explain / Fix; Redis deferred; prompt field reuses the
completion widget; context = full schema + relations with honest trim.

### M22.1 — Provider layer (`src/ai/`) ✅ DONE 2026-08-05 (Blueprint §0, §1.1)
- [x] `[SDD][M22]` `AiProvider.ts`: `AiProviderConfig` / `AiRequest` / `AiResult` /
      `AiProvider` interface — exact token counts from response bodies, no SDKs
- [x] `[SDD][M22]` `openaiCompat.ts`: one `fetch` POST to `{base}/chat/completions`;
      covers OpenAI, Ollama, OpenRouter, Groq, Gemini-compat via base URL
- [x] `[SDD][M22]` `anthropic.ts`: `/v1/messages` with `x-api-key` + `anthropic-version`
- [x] `[SDD][M22]` `registry.ts#createAiProvider` — the only switch on `kind`
- [x] `[SDD][M22]` Error normalization: 401/429/network → human-readable; raw provider
      JSON never reaches the UI
- [x] `[SDD][M22]` Presets as data (Anthropic / OpenAI / Ollama / OpenRouter / Custom),
      model as free text seeded from preset default
- [x] `[SDD][M22]` Tests: both adapters against a mock `fetch` — parsing, usage
      extraction, error normalization

### M22.2 — Context builder (`src/ai/context.ts`, pure) ✅ DONE 2026-08-05 (Blueprint §1.3)
- [x] `[SDD][M22]` `buildSchemaContext(hints, fks, budget)` — full schema + FK relations,
      compact rendering
- [x] `[SDD][M22]` `trimToRelevant` — over budget → prompt-referenced tables + FK
      neighbours, returns `trimmed: true`
- [x] `[SDD][M22]` `estimateTokens`, `extractSql`, `isDestructive` (DROP/TRUNCATE/ALTER,
      DELETE/UPDATE without WHERE)
- [x] `[SDD][M22]` Tests: every export, node:test tier

### M22.3 — Keys, settings, consent ✅ DONE 2026-08-05 (Blueprint §1.2, §1.7)
- [x] `[SDD][M22]` Keys in SecretStorage (`ai:<providerId>`); AiSettings in globalState;
      keys excluded from connection exports
- [x] `[SDD][M22]` Settings panel "AI Assistant" section: preset picker, base URL, model,
      masked key input, Test button (minimal completion, reports latency or error)
- [x] `[SDD][M22]` First-use consent modal naming exactly what is sent; revocable;
      lighter localhost notice for Ollama
- [x] `[SDD][M22]` Per-connection "Disable AI" toggle
- [x] `[SDD][M22]` "AI & your data" guide in Settings & Guides

### M22.4 — Query panel assist bar ✅ DONE 2026-08-05 (Blueprint §1.4, §1.5)
- [x] `[SDD][M22]` Collapsible bar above the editor: prompt input + Generate / Explain /
      Fix (Fix armed only by a query error); hidden until a provider is configured
- [x] `[SDD][M22]` Prompt input reuses the completion widget for tables/columns
      (keywords/functions off)
- [x] `[SDD][M22]` `aiGenerate`/`aiExplain`/`aiFix` messages → `handleAi*` host methods →
      context builder → provider → post back (house webview pattern)
- [x] `[SDD][M22]` Generated SQL inserted **selected**, never auto-run; explanation line
      in the bar; destructive warning tag from `isDestructive`
- [x] `[SDD][M22]` Trim notice shown when schema context was trimmed
- [x] `[SDD][M22]` Busy state; new request cancels in-flight one

### M22.5 — Usage ledger + view ✅ DONE 2026-08-05 (Blueprint §1.6)
- [x] `[SDD][M22]` `usageStore.ts`: append per call (ts, provider, model, verb, tokens);
      capped with the drop surfaced
- [x] `[SDD][M22]` Cost = tokens × user-editable price table, labeled "estimated";
      no balance display — dashboard links instead
- [x] `[SDD][M22]` Settings view: month/all-time, per-model + per-verb, reset period

### M22.6 — Phase 4 QA gate 🔴 (Blueprint §4)
- [x] `[SDD][M22]` Unit tier green (adapters + context.ts) — 162 tests pass
- [ ] `[SDD][M22]` Manual matrix: 3 engines × 3 verbs × Anthropic / OpenAI / Ollama-local
- [ ] `[SDD][M22]` Security: key absent from logs/exports/webview HTML; consent once;
      per-connection disable respected; webview CSP unchanged
- [ ] `[SDD][M22]` Honesty checks: trim notice, destructive tag, ledger cap, cost label
- [ ] `[SDD][M22]` Regression: Ctrl/Cmd+Enter runs, editor completion intact, panel
      unchanged with no provider configured
