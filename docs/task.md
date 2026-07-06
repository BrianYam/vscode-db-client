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

## M6 — SSH Tunnel
- [ ] `[SDD][M6]` `ssh2` local port-forward established before driver.connect(); tunnel fields in form

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
