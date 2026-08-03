# Developing Open DB Client

Contributor guide: building, running, and shipping the extension. If you just
want to *use* it, see the [README](README.md) — this file is not part of the
published package.

## Run it (development)

```bash
npm install
```

Then open this folder in VS Code and press **F5** ("Run Extension") — it
bundles automatically first (via `.vscode/tasks.json`). A second VS Code window
opens with the extension loaded. Click the **database icon** in the activity bar.

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
| `npm run marketplace:verify` | Compare the live Marketplace version against local `package.json`. |

**You rarely run the linters by hand.** A [Husky](https://typicode.github.io/husky)
`pre-commit` hook runs [`lint-staged`](https://github.com/lint-staged/lint-staged) on
every commit, which applies `biome check --write` to just the files you staged — so
formatting and safe lint fixes happen automatically. Use `npm run check`/`npm run lint`
when you want to sweep the whole project or see problems before staging. The hook is
installed automatically by the `prepare` script on `npm install`.

## Install the built extension into your VS Code

You don't need to uninstall the old version first — `--force` overwrites it in place.

```bash
npm run package             # builds open-database-client-<version>.vsix in the repo root
./scripts/install-local.sh  # installs that .vsix with --force
```

Then reload the window: **Cmd/Ctrl+Shift+P → "Developer: Reload Window"**.

`install-local.sh` targets the VSIX matching the current `package.json` version
automatically, so after a `npm run release:*` (which bumps the version and builds the
`.vsix`) you can go straight to `./scripts/install-local.sh`. It needs the **`code` CLI on
your PATH** — if it's missing, run **"Shell Command: Install 'code' command in PATH"** from
the Command Palette once (the script prints this hint if `code` isn't found).

> **Tip:** for day-to-day development you don't need a `.vsix` at all — just press **F5**
> to launch the Extension Development Host against your live `dist/`. Build and install a
> VSIX only when you want to dogfood the actual shipped package.

## Architecture

One `Driver` interface, one file per engine (`src/drivers/`). The tree, query panel,
and commands never import a DB library directly — add an engine by adding one driver.
The full rules live in [`CLAUDE.md`](CLAUDE.md); strategy and task tracking in
[`docs/BLUEPRINT_DBCLIENT.md`](docs/BLUEPRINT_DBCLIENT.md) and
[`docs/task.md`](docs/task.md).

## Versioning & releasing

[Semantic Versioning](https://semver.org), [Keep a Changelog](https://keepachangelog.com)
format, lock-step between `package.json` and `CHANGELOG.md`:

```bash
npm run release:patch        # bump + stamp CHANGELOG + tag + build .vsix (all local)
npm run publish:marketplace  # guarded Marketplace publish, then git push + tags
npm run marketplace:verify   # confirm the Marketplace picked it up
```

The full publishing guide — one-time Azure DevOps/publisher setup, flags,
Open VSX, troubleshooting — is in [`docs/PUBLISHING.md`](docs/PUBLISHING.md).

## Testing

Tests are plain `.js` files using `node:test`, importing pure logic from the
compiled `out/` tree — no VS Code API involved. See [`docs/TESTING.md`](docs/TESTING.md)
for the manual QA checklists.
