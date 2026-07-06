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
- [ ] `[SDD][M4]` **Write-back**: persist INSERT/UPDATE/DELETE to the `.db` file (export `db.export()` → `fs.writeFileSync`). _Open item._
- [ ] `[SDD][M4]` File picker in the form instead of typing the path

## M5 — Editing & Export (next up)
- [ ] `[SDD][M5]` Inline cell edit in results grid → generate UPDATE
- [ ] `[SDD][M5]` Right-click table → view DDL / column structure
- [ ] `[SDD][M5]` Export results to CSV / JSON
- [ ] `[SDD][M5]` Column expansion in tree (table → columns with types)

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
