# Changelog

All notable changes to the **Open DB Client** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Query lock.** A 🔒 toggle in the query panel toolbar makes the panel
  read-only: running queries (button, Ctrl/Cmd+Enter, highlight-to-run), cell
  edits, row insert/delete, and TTL changes are all blocked with a clear
  message until unlocked. The lock also **engages by itself whenever the AI
  generates a mutation** — INSERT, UPDATE, DELETE, MERGE/REPLACE, upserts, or
  DDL (CREATE/DROP/ALTER/TRUNCATE) — so the reflex Ctrl+Enter after a Generate
  can never run a write unreviewed. One click unlocks; the assist bar notes
  "🔒 auto-locked (UPDATE)" so it's always clear why. Detection errs on the
  side of locking (a rare false positive costs one click).

## [1.1.0] - 2026-08-05

### Added
- **AI query assistance (bring your own key).** Configure Anthropic, OpenAI, or
  any OpenAI-compatible endpoint (Ollama locally, OpenRouter, Groq, …) in
  Settings & Guides → AI Assistant — the ↻ button fetches the models your
  endpoint actually serves right now (no stale hardcoded list; the field still
  accepts any id typed by hand) — and the query panel gains an assist bar:
  - **Generate** — describe the query in plain language and get dialect-correct
    SQL, grounded in the connected database's real tables, columns and
    foreign-key relations. Table/column names autocomplete inside the prompt.
  - **Explain** — plain-language explanation of the selected SQL.
  - **Fix** — after a failed query, one click sends the statement plus its
    exact error and returns a corrected version.
  - Generated SQL is **never auto-run**: it lands in the editor selected, and
    destructive shapes (DROP, TRUNCATE, ALTER, DELETE/UPDATE without WHERE) are
    tagged with a visible warning first.
  - **Privacy**: only schema *names* are sent — never row data, results,
    passwords or hosts. A one-time consent dialog spells this out (local Ollama
    endpoints skip it — nothing leaves the machine), any connection can be
    excluded from AI entirely, and the new "AI & your data" guide documents
    exactly what is shared. On huge schemas the context is trimmed to relevant
    tables and the bar says so. API keys live in SecretStorage only and are
    never included in connection exports.
- **AI usage monitor.** Every call is metered locally from the response's exact
  token counts: requests, tokens and estimated cost per model and per action,
  for the current period and all time, with a user-editable price table.
  Costs are labeled as estimates; live account balances aren't shown because
  provider billing APIs require admin keys this extension deliberately never
  asks for — the view links to your provider dashboard instead. Ledger capped
  at 5 000 entries with the drop counted visibly; all-time totals stay exact.
- **Reset All Data** now also purges stored AI keys, settings and the usage
  ledger.

## [1.0.1] - 2026-08-05

### Changed
- **Connection form: test result shown next to the button.** The "Connection
  successful / failed" banner moved from the top of the form — where it was
  invisible once you scrolled down — into the fixed footer beside Test
  Connection, so the result appears right where you clicked. Long error
  messages ellipsize with the full text on hover. Test Connection also gains
  a solid secondary-button background so it no longer blends into the footer.
- **README rewritten for the Marketplace page.** It now leads with what the
  extension does — features, install, getting started, security notes — instead
  of contributor workflow. All development content (build/run, scripts, local
  VSIX install, release process, architecture pointers) moved to a new
  `DEVELOPMENT.md`.

## [1.0.0] - 2026-08-03

### Added
- **Marketplace publishing workflow.** `docs/PUBLISHING.md` documents the full
  one-time setup (Azure DevOps PAT, `brianlab` publisher, vsce login) and the
  per-release flow; `npm run publish:marketplace` (`scripts/publish.mjs`) publishes
  the current version after verifying a clean tree and a stamped CHANGELOG section,
  with `--dry-run` and an optional `--ovsx` pass to Open VSX. `package.json` now
  declares the GitHub `repository` so Marketplace links resolve correctly.
- **Marketplace status check.** `npm run marketplace:verify`
  (`scripts/marketplace-status.mjs`) compares the live Marketplace version against
  the local `package.json` via the public gallery API (no login), reports install
  count and last-update time, and exits non-zero on drift — usable as a
  post-publish/CI gate. `-- --ovsx` also checks Open VSX; `npm run
  marketplace:show` proxies the full `vsce show` listing.
- `publish:marketplace` now runs `git push` + `git push --tags` after a
  successful publish (skippable with `--no-push`); `release:*` still leaves the
  release local so a bad bump can be undone before anything goes public.

### Changed
- **Extension ID renamed to `open-database-client`** (Marketplace ID
  `brianlab.open-database-client`). The old name `open-db-client` is already
  reserved on the Marketplace by another party — extension names are unique
  globally, not per publisher. The display name is still "Open DB Client", and
  the export-file format tags (`open-db-client/connections*`) are unchanged so
  existing exports keep importing.
- `.vscodeignore` now excludes dev-only files (`CLAUDE.md`, `biome.json`,
  `.husky/`, `package-lock.json`) from the shipped VSIX.

## [0.4.3] - 2026-08-03

### Added
- **Import & export connections.** Move a whole connection set to another machine, hand a
  team a starting set, or back one up before a reset. Two commands, on the panel's **…**
  menu and in the Command Palette:
  - **Export Connections…** asks how much to include, safest first, with the trade-off
    spelled out on each choice:
    - **Without passwords** — safe to share. No stored passwords, and any password embedded
      in a connection string is stripped out (the username is kept). Entries that lost one
      are flagged in the file, and the export names them so nothing is lost silently.
    - **With passwords — encrypted** — passwords and SSH secrets sealed with a passphrase
      you choose (scrypt + AES-256-GCM, random salt/IV per file, authenticated so a tampered
      file fails loudly). No recovery if the passphrase is lost.
    - **With passwords — plain text** — the same credentials, readable, for when you need to
      see or reuse the values. Gated behind a confirmation that counts exactly what is about
      to be written (including passwords hidden inside connection strings, which no keychain
      lookup would report) and offers the encrypted export as an alternative. Saved as
      `…PLAINTEXT.json` and stamped with a warning inside the file itself.
    - Either credential-bearing file is written `0600` where the filesystem allows it.
  - **Import Connections…** only ever **appends**: existing connections are never
    overwritten, renamed, or reordered. A connection you already have — matched on
    server, port, database and user, resolved through the connection string when one is
    used — is skipped, so importing the same file twice does nothing the second time. A
    name clash between two *different* servers is renamed rather than merged. Imported
    entries get fresh ids, and any secrets in an encrypted file go into SecretStorage, not
    globalState. You are shown what will be added and skipped before anything is written,
    and told afterwards if the file carried no passwords.
  - Import reads all three formats without being told which it has, and treats the file as
    untrusted: only known fields are read (several are paths the
    extension later opens), and malformed entries are dropped with a count and a reason in
    the output channel rather than skipped in silence.
- **"What's new" guide** in Settings & Guides, rendered from the changelog that ships with
  the extension — so the in-app notes can never drift from the released ones.
- **"Backup & transfer" guide** in Settings & Guides: which export to pick, how to open an
  encrypted file (import it — the passphrase prompt appears on its own), what the errors
  mean, and a copy-paste `node` snippet that decrypts a bundle without the extension, so an
  encrypted export is never a lock-in.

### Changed
- Settings & Guides: the *Uninstalling & your data* page now spells out that a connection
  saved via **Use Connection String** keeps its whole URL — including any embedded
  password — in unencrypted globalState, unlike the separate-fields path which uses
  SecretStorage. Storing those in SecretStorage instead is tracked as follow-up work.

## [0.4.2] - 2026-07-31

### Added
- Query panel editor: **`Ctrl/Cmd+/`** toggles `--` line comments over every line the
  selection touches (comments at the shallowest indent, uncomments only when the whole
  block is already commented). Not bound on Redis, where a buffer is a single command
  and `--` would be sent as an argument rather than ignored.
- Query panel editor: **highlight-to-run** — with text selected, `Ctrl/Cmd+Enter` (and
  the Run button) executes only the selection instead of the whole buffer. The status
  line says "Running selection…" so it is never ambiguous which one ran.

## [0.4.1] - 2026-07-31

### Fixed

- **Row multi-select/checkboxes were lost after running hand-typed SQL.** Only tree-driven
  table previews resolved a table's primary key and offered row checkboxes/editing; running
  any manually typed or edited query — even a trivial `SELECT * FROM t WHERE ...` — went
  through the generic query path, which never attached that metadata, so the checkbox column
  silently disappeared. `query()` on Postgres, MySQL, and SQLite now best-effort detects a
  simple single-table `SELECT` (no joins/unions/subqueries) and resolves its primary key the
  same way a preview does, so multi-select and delete keep working after editing the query.

## [0.4.0] - 2026-07-30

### Added

- **Autocomplete in the query editor.** Typing now suggests tables, columns, keywords,
  functions and data types, with ↑/↓ to move, Enter or Tab to accept, Esc to dismiss and
  Ctrl/Cmd+Space to ask on demand. Suggestions understand where you are in the statement:
  after `FROM` you get tables, after `WHERE` you get columns, and — the part that matters —
  **only the columns of the tables actually in your statement**, resolved through aliases, so
  `FROM saving_plans sp WHERE sp.` offers that table's columns rather than every column in the
  database. Schema-qualified names work too — `FROM public.` lists tables. Suggestions are
  withheld where they would produce invalid SQL: straight after `ORDER BY` you get columns and
  functions, not `DESC`. Keywords and functions come from the real dialect for your connection
  (PostgreSQL contributes 653 function names where the old list had 46 shared entries), and
  Redis gets its command set instead. Everything works offline from cached schema, so typing
  never waits on the database — and never triggers a connection or password prompt on its own.
  Saved `.sql` query files get the same suggestions through VS Code's own IntelliSense.

- **The query panel now shows — and respects — which database it runs against.** On servers
  with several databases, a panel opened from a table preview silently ran its SQL (and looked
  up autocomplete tables) against the connection's default database, producing "relation does
  not exist" errors and empty suggestions for tables you could see in the tree. Preview panels
  are now bound to the database they came from, autocomplete refreshes when a panel is
  re-pointed at another database, and a badge in the toolbar shows the target (`aerobus`,
  `db0`, or the SQLite file name) with a tooltip explaining how to aim at a different one.
  Schema is intentionally not shown: queries aren't pinned to a schema — unqualified names
  resolve through `search_path`, and suggestions already cover every schema's tables.

- **Format SQL.** A new **Format** button in the query panel pretty-prints your statement using
  the right dialect for the connection — PostgreSQL, MySQL/MariaDB or SQLite — so engine-specific
  syntax (Postgres `->>` and `interval`, MySQL backtick identifiers, SQLite functions) survives
  intact. `Shift+Alt+F` does the same, and saved `.sql` query files now work with VS Code's own
  Format Document. If a statement can't be parsed your query is left exactly as you typed it and
  the error is reported — formatting never overwrites work it couldn't understand. Redis
  connections don't show the button, since Redis commands aren't SQL.

- **Close a single connection from the tree.** Connected connections now show a
  disconnect icon inline on the row, next to Refresh and New Query. Previously the only
  one-click option was **Stop All Connections** in the view's title bar, which closed
  everything; closing just one meant right-clicking the node. Stop All is unchanged for
  when you do want the bulk action.

- **Clear filters.** A new results-bar button drops every active filter at once — the search
  box and all per-column filters — instead of emptying each box by hand. On a paginated
  preview, where column filters run in the database, it also re-fetches the unfiltered page.
  It stays disabled while nothing is filtered, so it never looks actionable when it would do
  nothing. Sort order is left alone.

- **Copy as JSON.** A new results-grid button copies rows straight to the clipboard, no save
  dialog. Check one row and you get a bare object; check several and you get an array. With
  nothing checked — including results that aren't editable and so have no checkboxes — it
  copies every row currently in view. What you copy respects the grid's sort, column filters
  and search, so it matches what you're looking at. Payloads over ~5 MB ask for confirmation
  first, since a clipboard that large is a problem for whatever you paste into.

### Fixed

- **The results-grid filter row now stays pinned while you scroll.** The grid has two header
  rows — the column names and the per-column filter boxes — but only the names row was
  actually pinned; the filter row scrolled away with the rows, so on any result taller than
  the grid you lost the filters until you scrolled back to the top. The filter row now stays
  put directly below the column names. Body rows also no longer paint over the header as they
  scroll past it.
- **Typing in a column filter no longer loses focus.** The filter boxes live inside the
  results grid, so every redraw destroyed the one you were typing in. The old repair only
  covered a single case and used one slot that the first arriving response consumed — so
  on plain queries focus died after *every* character, and on table previews it died
  whenever two filter round-trips overlapped. Focus and caret position are now saved and
  restored across every redraw, whatever triggered it.
- **The grid no longer flashes rows that don't match the filters.** A slow response
  arriving after a newer one would repaint with stale rows; requests are now sequenced and
  overtaken responses are discarded.
- **Search and filter now work on JSON columns.** A `jsonb` column arrives as a parsed
  object, and while the grid rendered it as JSON, search compared against the useless
  `[object Object]` — so nothing inside a JSON payload was ever findable, and sorting by
  such a column did nothing. Date columns had the same mismatch. Search, per-column
  filters, sorting and the inline editor now all read a cell exactly as the grid shows it.

### Changed

- **"Search results…" is now labelled "Search this page…" on paginated previews.** It only
  ever filtered the rows already loaded, so on a table paged at 100 rows it quietly ignored
  everything past the first page — which looked like a broken search. The box now says what
  it covers, and while a search is active a line under the toolbar reports how many of the
  loaded rows matched, which page you're on and the true total. Per-column filters are
  unchanged: those run in the database and cover the whole table.

## [0.3.6] - 2026-07-28

### Fixed

- **SSH tunnel "Auto" auth now reads your default key.** `ssh2` (unlike the `ssh` CLI)
  never loads `~/.ssh/id_*` on its own, so with **Auth = Auto** and an empty key path we
  only ever tried the SSH agent — a connection that works in a terminal (or another
  client) failed here whenever the key wasn't `ssh-add`-ed into the agent. "Auto" and
  "Key" now fall back to the first default identity file that parses
  (`id_ed25519` → `id_rsa` → `id_ecdsa`); an encrypted key with no passphrase is skipped
  so the agent/password paths still get their turn.

## [0.3.5] - 2026-07-24

### Added

- **Search tables.** Schemas (PostgreSQL) and databases (MySQL) now carry a
  `$(search)` action (also `Open DB Client: Search Tables` via right-click) that opens a
  live, debounced filter box — the table/view list narrows as you type, with a pinned
  `Filter: …` row on top that clears the filter when clicked. Mirrors the existing Redis
  key search; filtering is client-side (table lists are small) so it stays instant.

## [0.3.4] - 2026-07-24

### Added

- **Stop All Connections.** A new stop-circle button in the CONNECTIONS view title
  (and `Open DB Client: Stop All Connections` in the palette) force-tears-down every
  connection and collapses the tree to a clean state — the escape hatch for a stuck
  connection so you never have to restart VS Code.

### Fixed

- **A wedged spinner is now recoverable.** In-flight connects are tracked, so
  `disposeAll()` / Stop All can tear down a connection that hangs *mid-connect* (it
  previously lived in no map and was unreachable). The SSH-tunnel open (15s) and tree
  node-expansion / children queries (20s) also gained hard timeouts, so a dead SSH host
  or slow metadata read fails to a visible error node instead of spinning forever.

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

