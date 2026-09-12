# Open DB Client

**A free, lightweight database client for VS Code — with unlimited connections.**
No license, no account, no paywall, no "premium" tier. One tree for
**PostgreSQL, MySQL/MariaDB, SQLite, Redis, and AWS Athena**, side by side.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/brianlab.open-database-client?label=Marketplace&color=2f6feb)](https://marketplace.visualstudio.com/items?itemName=brianlab.open-database-client)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/brianlab.open-database-client?color=22c55e)](https://marketplace.visualstudio.com/items?itemName=brianlab.open-database-client)
[![Rating](https://img.shields.io/visual-studio-marketplace/stars/brianlab.open-database-client?color=f59e0b)](https://marketplace.visualstudio.com/items?itemName=brianlab.open-database-client&ssr=false#review-details)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/BrianYam/vscode-db-client/blob/main/LICENSE)

![Connect, browse, query, and edit — in one panel](media/demo.gif)

Built on mature, pure-JS drivers (`pg`, `mysql2`, `ioredis`, AWS SDK) plus WASM
`sql.js` — **no native build step**, so nothing breaks after a VS Code update.

## Why this one?

- **Unlimited connections, forever free.** Most popular DB extensions cap you at
  2–3 connections unless you pay. This one never will.
- **Edit data where you see it.** The results grid is writable — update cells,
  insert and delete rows — not just a read-only viewer.
- **Five engines, one workflow.** The same tree, query panel, and shortcuts
  cover Postgres, MySQL/MariaDB, SQLite, Redis, and AWS Athena — with Athena
  deliberately more cautious, because it bills per byte scanned.
- **Your secrets stay secret.** Passwords live in your OS keychain via VS Code
  SecretStorage — never in settings files or plain text.
- **AI on your terms.** Generate, explain, and fix SQL with your own API key —
  Anthropic, OpenAI, OpenRouter, a local Ollama, or any OpenAI-compatible
  endpoint. No subscription, no data middleman, and a local ledger showing
  exactly what each request cost.

## Supported engines

| Engine | Browse | Query | Edit grid | Notes |
| --- | --- | --- | --- | --- |
| **PostgreSQL** | ✅ | ✅ | ✅ | SSH tunnel, SSL, connection strings |
| **MySQL / MariaDB** | ✅ | ✅ | ✅ | SSH tunnel, SSL, connection strings |
| **SQLite** | ✅ | ✅ | ✅ | WASM `sql.js`; edits written back to the `.db` file |
| **Redis** | ✅ | ✅ | ✅ | Server-side key search, TTLs, raw commands, SSH tunnel |
| **AWS Athena** | ✅ | ✅ | — | SSO / profile / assume-role; reports bytes scanned |

SSH tunnelling works for every engine except SQLite, which is a local file.

## Features

### Query & edit

- **Query panel** with **autocomplete** for tables, columns and keywords, SQL
  formatting, line-comment toggle (`Ctrl/Cmd+/`), and **highlight-to-run** —
  select a statement and run just that.
- **Abort a long query.** An **■ Abort** button (or `Esc`) stops it — a *real*
  server-side cancellation on PostgreSQL and MySQL (`pg_cancel_backend` /
  `KILL QUERY`), not an abandoned promise. The Run button shows a live
  elapsed-seconds counter while it works.
- **Editable results grid** — update cells, insert and delete rows
  (primary-key based), with SQLite changes written back to the `.db` file.
- **Column picker** — `Columns ▾` hides the noise in a wide `SELECT *`; the
  button reads `Columns 5/9` so a narrowed view is never a mystery, and Export
  follows what you can see.
- **A proper JSON/JSONB viewer** — cells show a summary (`{…} 12 keys`) and `⤢`
  opens a collapsible, filterable tree with copy-for-value and copy-for-path
  (`$.items[3].sku`). Works on any result, not just table previews.
- **Search, sort, per-column filters** and a row-number gutter that follows the
  current sort.
- **Export** to CSV or JSON, or **Copy as JSON** straight to the clipboard.
- **Query lock.** A 🔒 toggle makes the panel read-only — and it engages by
  itself whenever a generated statement is a mutation, so the reflex
  `Ctrl+Enter` after an AI **Generate** can never run a write unreviewed.
- **Saved queries** — organize `.sql` files in folders right in the tree, and
  run them against any connection.

![Query panel with editable results grid](media/query-panel.png)

### AI assistant — bring your own key

- Describe what you want in plain language and **Generate** the SQL, ask it to
  **Explain** a statement, or **Fix** a failed one — right in the query panel.
- Presets for **Anthropic (Claude)**, **OpenAI**, **OpenRouter** and **Ollama**
  (local), plus a custom option for any other OpenAI-compatible endpoint — your
  key, your model, your choice.
- The model is given your real **schema, column types and relations**, so it
  writes SQL against the tables you actually have.
- Your key stays in your OS keychain; requests go straight from your machine to
  your provider. **No middleman, nothing to subscribe to.**
- A **local usage ledger** counts every request's exact tokens and estimated
  cost — priced from a locally stored copy of the LiteLLM price list covering
  81 providers, with every row labelled by source and flagged when stale.
- **Per-connection opt-out.** Untick a connection and the assist bar disappears
  from its query panels entirely — so a regulated database can be kept out of
  reach of the AI while the rest of your connections keep it.

![AI assist bar generating SQL from a plain-language prompt](media/ai-query-generation.gif)

![AI assistant setup — pick a provider, paste a key, test](media/ai-assistance-setup.png)

### Browse & inspect

- Browse servers → databases → schemas → tables/views, with live **table
  search** on long lists.
- **View DDL / structure** for any table or view.
- **Preview Rows** pages through a table 100 rows at a time — `‹ ›` walks the
  whole table server-side, with sort and filters applied at the source.
- **Connection notes** — an optional free-text field on each connection, shown
  when you hover it in the tree *and* in the query panel, so "read replica —
  don't write here" is in front of you while you type.

### Redis, first-class

- Browse and **search keys server-side**, view values, delete keys, and
  set/clear TTLs — plus run raw commands (`GET foo`) in the query panel.
- Values are **editable in the grid** like any other engine: a string, a list
  element by index, a hash field or its name, a set member. Editing a string
  carries its remaining TTL across rather than silently clearing it.

### AWS Athena, priced honestly

- Connect with an AWS profile (SSO, `credential_process` and assume-role chains
  all resolve through the SDK), static access keys, or the machine's own role.
- **Browsing costs nothing.** The tree, autocomplete and DDL come from Athena's
  metadata APIs, which scan no data; `information_schema` is never touched
  because querying it is billed. Clicking a table does *not* preview it — on a
  billed engine a stray click should never start a scan.
- The results footer reports **bytes scanned** next to elapsed time, including
  for a query you aborted — AWS bills those either way.

### Connect from anywhere

- **SSH tunnels** — reach databases behind a bastion host, with key or password
  auth.
- **Connection strings** supported alongside the form.
- **Import / export connections** — move your whole setup between machines.
  Three flavors, safest first: without passwords, passphrase-encrypted
  (AES-256-GCM), or plain text behind an explicit warning that counts exactly
  what's about to be written.

## Getting started

1. Install: search **"Open DB Client"** in the Extensions view
   (`Ctrl/Cmd+Shift+X`), or `ext install brianlab.open-database-client`.
2. Click **＋ Add Connection** in the panel title bar.
3. Pick an engine, fill host/port/user/password (or a file path for SQLite, or
   an AWS profile for Athena) — or paste a connection string.
4. Expand the connection to browse schemas → tables (or keys, for Redis).
5. Right-click a connection → **New Query** to run arbitrary SQL or Redis
   commands.

The **Settings & Guides** panel (gear icon in the panel title bar) has
engine-specific walkthroughs, a "what's new" view, and a readout of exactly what
the extension has stored on your machine.

## Security & privacy

- Passwords, SSH secrets and AI API keys are stored in **VS Code SecretStorage**
  (your OS keychain) — never in settings files or plain text.
- Nothing is sent anywhere by default. AI requests go directly from your machine
  to the provider you configured; there is no telemetry and no server of ours in
  the path.
- Connection exports that contain credentials are encrypted with a passphrase
  you choose (scrypt + AES-256-GCM), or clearly marked and confirmed when you
  explicitly choose plain text. Connection **notes are stored unencrypted** and
  travel with every export flavor, so don't keep credentials in them.
- **Reset All Data** removes every connection, secret, saved query, AI key and
  usage record in one action.

## Notes & limits

- Table previews page 100 rows at a time (Redis lists 500 keys per page and
  shows the first 200 elements of a list or sorted set; Athena previews up to
  500 rows and does not page). The UI always says when a list is truncated.
- A very large result renders the first 2,000 rows — search, sort, Export and
  Copy still cover the whole result, and the grid says so.
- Grid editing on a SQL table needs a primary key; rows without one are
  read-only. Redis values are editable by key, field or index instead. Athena
  has no primary keys, so its results are read-only and say so.
- SQLite cannot be interrupted mid-statement, so it shows no Abort button rather
  than a button that would do nothing.
- Requires VS Code **1.90** or newer.

Found a bug or missing a feature? Issues and PRs are welcome on
[GitHub](https://github.com/BrianYam/vscode-db-client) — see
[DEVELOPMENT.md](https://github.com/BrianYam/vscode-db-client/blob/main/DEVELOPMENT.md)
for how to build and run from source. Release history is in the
[changelog](CHANGELOG.md).
