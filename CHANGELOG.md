# Changelog

All notable changes to the **Open DB Client** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] - 2026-07-22

### Internal

- **Dev tooling: Biome + Husky.** Added [Biome](https://biomejs.dev) for linting and
  formatting (`npm run lint`, `npm run format`, `npm run check`) configured to the repo
  style (2-space indent, double quotes). A Husky `pre-commit` hook runs `lint-staged`,
  which formats and lints only staged files. No change to the shipped extension.

## [0.3.2] - 2026-07-22

### Changed

- **Connection-string sample matches the selected engine.** The greyed-out
  placeholder in the *Use Connection String* field now updates as you switch server
  type — `postgresql://…`, `mysql://…`, `redis://…`, or a SQLite file path — instead
  of always showing the Postgres example.

## [0.3.1] - 2026-07-22

### Added

- **Edit Redis values in the grid.** Click a key, then double-click a cell to edit it,
  exactly like a SQL table. Each key type gets addressable columns — strings show
  `value`, lists `index`/`value`, hashes `field`/`value`, sets `member`, sorted sets
  `member`/`score` — and edits are written back with `SET`, `LSET`, `HSET`,
  `SADD`/`SREM`, or `ZADD`. Hash fields and sorted-set members can be renamed.
  `+ Row` appends an element to a list, set, sorted set, or hash.
- **A string key's TTL survives an edit.** The remaining expiry is read before the
  write and re-applied after it, so editing a rate-limit or session key does not turn
  it into a permanent one.
- **View and edit a key's TTL.** Volatile keys show their remaining life in the tree
  (e.g. `· 42s`) and in the grid toolbar. **Set TTL…** sets an expiry (in seconds),
  **Persist** removes it — from the grid or a key's right-click menu. Backed by
  `PTTL` / `PEXPIRE` / `PERSIST`.

### Changed

- Deleting rows in the grid now removes just those **elements** (`LREM`, `HDEL`,
  `SREM`, `ZREM`). Deleting the whole key remains the tree's **Delete Key** command.

## [0.2.0] - 2026-07-20

### Added

- **Redis key search.** Hover a Redis `db*` node and click 🔍 to search its keys. The
  tree filters as you type, matching server-side with `SCAN … MATCH` — plain text
  matches anywhere in the key, and glob syntax (`bull:erp-queue:*`) is used as-is. The
  active filter appears as a pinned row above the results; click it to clear.
- **Delete a Redis key.** Right-click a key → **Delete Key** (with confirmation), or use
  the inline 🗑. Right-click → **View Value** opens the same typed preview as clicking.

### Changed

- Redis keys are now listed alphabetically instead of in `SCAN` bucket order, and a
  database with more keys than the 500-key display cap says so instead of cutting the
  list off silently.

## [0.1.0] - 2026-07-09

Initial public release: a lightweight database client for VS Code with no cap on the
number of connections.

### Added

- **Database engines.** Connect to PostgreSQL, MySQL/MariaDB, SQLite (via WASM
  `sql.js`, so there is no native build step), and Redis. Add as many connections as
  you want.
- **Object browser.** An activity-bar tree walks each connection down through
  databases, schemas, tables/views, and typed columns with primary- and foreign-key
  markers. Redis connections show numbered databases and their keys. Connect and
  disconnect live with a status indicator, and refresh any node on its own.
- **SQL editor and results grid.** Run statements with Ctrl/Cmd+Enter. Results load
  with server-side pagination (100 rows per page), per-column sort and filter, and a
  global search box. Open any cell in a detail view as plain text or formatted JSON.
- **In-grid data editing.** Edit a cell inline to issue a parameterized `UPDATE` keyed
  by primary key, add rows with `INSERT`, and delete selected rows. Preview a table
  with "Select Top 200", inspect its DDL and structure, and export results to CSV or
  JSON.
- **Foreign-key navigation.** Foreign-key cells show a jump icon; "View Related
  Row" opens the referenced table filtered to the matching value.
- **Redis commands.** Run raw Redis commands and preview keys by type.
- **Connection form.** A guided webview with a server-type picker and fields that adapt
  per engine, a Test Connection action that reports timing, password show/hide, a file
  browser for SQLite, and a connection-string mode with a parser.
- **Saved queries.** Persist query files and folders in the extension's storage, with
  native-editor IntelliSense and inline Run / JSON CodeLens actions.
- **Tree organization.** Drag and drop to reorder connections.
- **Settings & Guides panel.** In-app guides (how to use, icon legend, uninstalling &
  your data), a version indicator, and a "Reset all data" action that removes every
  connection, stored secret, and saved query file.

### Security

- **Secure connections.** SSL/TLS with CA, client-certificate, and client-key options,
  plus SSH tunneling with password, key, or agent authentication.
- **Credential storage.** Passwords and SSH secrets are kept in VS Code
  SecretStorage, never in plain configuration. Non-sensitive connection metadata lives
  in globalState and carries a `schemaVersion` with a migration path for future
  upgrades.

