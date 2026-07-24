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
