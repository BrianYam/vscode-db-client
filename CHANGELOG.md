# Changelog

All notable changes to the **Open DB Client** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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
- **Foreign-key navigation.** Foreign-key cells show a jump affordance; "View Related
  Row" opens the referenced table filtered to the matching value.
- **Redis support.** Run raw Redis commands and preview keys by type.
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

