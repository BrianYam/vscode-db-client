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
