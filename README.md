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

## Scripts

Everyday commands and when to reach for each:

| Command | When to run it |
| --- | --- |
| `npm run compile` | One-off TypeScript build to `out/` (used by tests). |
| `npm run watch` | Leave running while developing — rebuilds `dist/` on save. |
| `npm run bundle` | Produce the shipped `dist/extension.js` (esbuild). |
| `npm run typecheck` | Type-check only (`tsc --noEmit`), no output — run before committing. |
| `npm run lint` | Report Biome lint problems in `src/` and `test/` (read-only). |
| `npm run format` | Auto-format `src/` and `test/` in place (whitespace, quotes, etc.). |
| `npm run check` | Biome lint **+** format **+** import-sort, applying every safe fix. Run this to clean a file up before committing. |
| `npm test` | Compile, then run the `node:test` suite in `test/`. |

**You rarely run the linters by hand.** A [Husky](https://typicode.github.io/husky)
`pre-commit` hook runs [`lint-staged`](https://github.com/lint-staged/lint-staged) on
every commit, which applies `biome check --write` to just the files you staged — so
formatting and safe lint fixes happen automatically. Use `npm run check`/`npm run lint`
when you want to sweep the whole project or see problems before staging. The hook is
installed automatically by the `prepare` script on `npm install`.

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
[`docs/task.md`](docs/task.md). Browse, query, and edit work for all four engines
today, including SQLite write-back (modifying statements persist to the `.db` file).

## Versioning

This project follows [Semantic Versioning](https://semver.org). Notable changes for each
release are recorded in [`CHANGELOG.md`](CHANGELOG.md), which VS Code also surfaces on the
extension's **Changelog** tab.

## Architecture

One `Driver` interface, one file per engine (`src/drivers/`). The tree, query panel,
and commands never import a DB library directly — add an engine by adding one driver.
