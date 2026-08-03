# Open DB Client

A lightweight database client for VS Code with **unlimited connections** — no
license, no paywall, no "premium" tier. Supports **PostgreSQL, MySQL/MariaDB,
SQLite, and Redis**.

It runs on mature, pure-JS drivers (`pg`, `mysql2`, `ioredis`) plus WASM
`sql.js`, so there is no native build step and nothing breaks after a VS Code
update.

## Install

Search **"Open DB Client"** in the Extensions view (`Ctrl/Cmd+Shift+X`), or:

```
ext install brianlab.open-database-client
```

## Features

- **Unlimited connections** across all four engines, side by side in one tree.
- **Browse** servers → databases → schemas → tables/views, with live
  **table search** on long lists (and server-side **key search** for Redis).
- **Query panel** with SQL formatting, line-comment toggle (`Ctrl/Cmd+/`),
  and **highlight-to-run** — select a statement and run just that.
- **Edit data in the results grid** — update cells, insert and delete rows
  (primary-key based), with SQLite changes written back to the `.db` file.
- **Export results** to file from the grid.
- **View DDL / structure** for any table or view.
- **Saved queries** — organize `.sql` files in folders right in the tree, and
  run them against any connection.
- **Redis tools** — browse and search keys, view values, delete keys, and
  set/clear TTLs.
- **SSH tunnels** — reach databases behind a bastion host, with key or
  password auth.
- **Import / export connections** — move your whole connection set between
  machines. Exports come in three flavors, safest first: without passwords,
  passphrase-encrypted (AES-256-GCM), or plain text behind an explicit
  warning that counts exactly what's about to be written.

### Getting started

1. Click **＋ Add Connection** in the panel title bar.
2. Pick an engine, fill host/port/user/password (or a file path for SQLite).
   Connection strings are supported too.
3. Expand the connection to browse schemas → tables (or keys, for Redis).
4. Click a table to preview the top 200 rows; right-click a connection →
   **New Query** to run arbitrary SQL (or Redis commands like `GET foo`).

The **Settings & Guides** panel (gear icon in the panel title bar) has
engine-specific walkthroughs.

## Security

- Passwords and SSH secrets are stored in **VS Code SecretStorage** (your OS
  keychain) — never in settings files or plain text.
- Connection exports that contain credentials are encrypted with a passphrase
  you choose (scrypt + AES-256-GCM), or clearly marked and confirmed when you
  explicitly choose plain text.

## Notes & limits

- Table previews are capped at 200 rows and Redis key listings at 500 per
  page — the UI always tells you when a list is truncated.
- Grid editing needs a primary key on the table; rows without one are
  read-only.

Found a bug or missing a feature? Issues and PRs are welcome on
[GitHub](https://github.com/BrianYam/vscode-db-client) — see
[DEVELOPMENT.md](https://github.com/BrianYam/vscode-db-client/blob/main/DEVELOPMENT.md)
for how to build and run from source. Release history is in the
[changelog](CHANGELOG.md).
