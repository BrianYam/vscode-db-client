# Open DB Client

A lightweight, self-built VS Code database client with **unlimited connections** —
no license, no paywall. Supports **PostgreSQL, MySQL/MariaDB, SQLite, and Redis**.

Built as a from-scratch replacement for paywalled database extensions. It stands on
mature, pure-JS drivers (`pg`, `mysql2`, `ioredis`) plus WASM `sql.js`, so there is
no native build step and nothing to rebuild after a VS Code update.

## Run it (development)

```bash
npm install
npm run compile
```

Then open this folder in VS Code and press **F5** ("Run Extension"). A second VS Code
window opens with the extension loaded. Click the **database icon** in the activity bar.

## Use it

1. Click **＋ Add Connection** in the panel title bar.
2. Pick an engine, fill host/port/user/password (or a file path for SQLite).
3. Expand the connection to browse schemas → tables (or keys, for Redis).
4. Click a table to preview the top 200 rows; right-click a connection → **New Query**
   to run arbitrary SQL (or Redis commands like `GET foo`).

Add as many connections as you want. Passwords are stored in VS Code SecretStorage;
connection metadata in globalState.

## Package as an installable `.vsix` (optional)

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension open-db-client-0.1.0.vsix
```

## Status & roadmap

See [`docs/BLUEPRINT_DBCLIENT.md`](docs/BLUEPRINT_DBCLIENT.md) and
[`docs/task.md`](docs/task.md). Browse + query works for all four engines today.
Known open item: SQLite writes are in-memory only (SELECT works; write-back is on the list).

## Architecture

One `Driver` interface, one file per engine (`src/drivers/`). The tree, query panel,
and commands never import a DB library directly — add an engine by adding one driver.
