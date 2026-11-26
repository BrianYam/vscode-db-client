# `map.json` format

`docs/system-map/map.json` holds every fact the page shows. `scripts/build.mjs` enforces this format and fails on any violation, so its error messages are the final word.

## Basis and refs

Every item that makes a claim carries a `basis` and a `refs` array. `basis` says how we know; `refs` lets a reader check.

| `basis` | Meaning | Required refs |
|---|---|---|
| `code` | You read code this run that shows it | at least one `file` ref |
| `record` | A blueprint, a discovery doc, `docs/task.md`, `CLAUDE.md`, `CHANGELOG.md`, a PR, a commit or a comment states it | at least one `file`, `mr`, `commit` or `url` ref to that record |
| `human` | Brian answered it in `answers.md` | at least one `answer` ref to an answered question |
| `inferred` | Your best reading, unconfirmed | none; pair it with an open question when it matters |

Ref shapes:

```json
{ "file": "src/drivers/postgres.ts", "line": 120, "endLine": 180 }
{ "file": "docs/BLUEPRINT_DBCLIENT.md", "line": 38, "label": "Blueprint M4" }
{ "mr": 22 }
{ "commit": "9093828" }
{ "url": "https://github.com/BrianYam/vscode-db-client/issues/1", "label": "issue #1" }
{ "answer": "Q-004" }
```

`file` is relative to the repo root and must exist; it may be a folder. `line` and `endLine` are optional and must exist in the file. `label` is the short name the page shows for a record (the blueprint row). `note` adds a line of explanation under a file. `mr` is a pull request number.

## Plain text and `tech`

Prose fields (`summary`, `detail`, `rules`, `decision`, `why`, `risk`, `guidance`, a step's `title`) are the **plain layer**: everyday language, no identifiers. A journey step may carry `tech`: the functions, webview message types and settings keys behind the plain text, shown under *Under the hood*. The build warns when a journey that is in the guide has code in its plain layer. Two marks are allowed in prose: `` `code` `` (keep it to `tech` and component text) and `*emphasis*` for a label shown in the product, such as *Run Query*.

## Top level

```json
{
  "schemaVersion": 1,
  "meta": {
    "project": "Open DB Client",
    "client": "VS Code users who work with databases · open source by BrianLab",
    "tagline": "One line that says what it is for",
    "publisher": "BrianLab",
    "license": "MIT",
    "mark": "media/icon.svg",
    "codePaths": ["src", "package.json"],
    "repoUrl": "https://github.com/BrianYam/vscode-db-client",
    "forge": "github",
    "defaultBranch": "main",
    "commit": "<full sha of the main commit this map describes>",
    "generatedAt": "2026-11-26T09:00:00Z",
    "prsThrough": "2026-11-26T07:09:09Z",
    "securityContact": "Brian",
    "buildCommand": "npm run system-map"
  },
  "overview": {}, "areas": [], "components": [], "journeys": [], "glossary": [],
  "decisions": [], "dangerZones": [], "startHere": {}, "openQuestions": [], "changelog": []
}
```

`publisher` is the name on the guide's cover and footer (default BrianLab). `mark` is the SVG shown in the header, the favicon and the guide (default `media/icon.svg`). `codePaths` are the paths whose commits mark the map as behind (default `src`). `forge` is `github` (default) or `gitlab`, which decides the shape of file and commit links. `client` is who the guide is for; the part before ` · ` goes on the cover.

`commit` is what the page says it describes and what every file link opens. `prsThrough` is the merge time of the newest change already read, so the next run starts after it.

## Sections

**overview**

```json
{
  "summary": "2 to 4 plain sentences a new contributor could repeat to a friend.",
  "users": [{ "name": "Developer", "goal": "Browses tables and runs queries without leaving the editor" }],
  "loop": ["The handful of steps the whole product turns on, in order."]
}
```

**areas**: the areas a newcomer would name. They group the busy Business logic row, the feature picker and the guide's chapters.

```json
{ "id": "connections", "name": "Connections" }
```

**components**: the boxes on the board.

```json
{
  "id": "connection-manager",
  "name": "Connection manager",
  "kind": "module",
  "area": "connections",
  "summary": "One line for the card.",
  "detail": "A paragraph for the details panel. Engineering words are fine here.",
  "responsibilities": ["One short line each"],
  "paths": ["src/connections/manager.ts"],
  "dependsOn": [{ "id": "driver-contract", "why": "Creates one driver per live connection.", "basis": "code", "refs": [] }],
  "basis": "code",
  "refs": [{ "file": "src/connections/manager.ts", "note": "Optional note" }]
}
```

- `kind` decides the row: `app` Frontend; `service` API; `module`, `library` Business logic; `database`, `storage`, `queue` Data; `external` Outside services; `ops` Ops. `layer` overrides it.
- `paths` must exist. The update step uses them to find which components a change touches.
- `dependsOn` are the arrows on the connections diagram.

**journeys**: one real thing a person or the system does, in order.

```json
{
  "id": "preview-a-table",
  "title": "A developer previews a table",
  "actor": "Developer",
  "trigger": "Clicks a table in the sidebar",
  "area": "browse",
  "summary": "Plain. One to two sentences.",
  "rules": ["What is allowed, what is refused, what happens when something goes wrong."],
  "steps": [
    {
      "title": "The first rows appear in the grid",
      "detail": "A notice says when only part of the table is shown.",
      "tech": "Driver.previewTable(path, limit); QueryResult.truncated drives the notice.",
      "component": "query-panel",
      "basis": "code",
      "refs": [{ "file": "src/webview/queryPanel.ts" }]
    }
  ],
  "checks": [{ "question": "Answerable from the steps above.", "answer": "…" }],
  "related": { "glossary": [], "dangerZones": [], "decisions": [], "questions": ["Q-001"] }
}
```

- Each step names the `component` that does the work. The page draws the journey on the board, as a flow chart and as swimlanes.
- `audience: "team"` keeps the journey out of the *How it works* guide and the PDF.
- `rules` and the steps' plain text are the guide. Write them for someone who uses the extension.

**glossary**

```json
{ "id": "driver", "term": "Driver", "aliases": ["engine driver"], "definition": "…", "not": "What it is easily confused with.",
  "engineering": true, "components": ["driver-contract"], "basis": "code", "refs": [{ "file": "src/drivers/Driver.ts" }] }
```

The page underlines the first use of `term` or an alias in any text. `engineering: true` keeps a word out of the PDF's *Words used*.

**decisions**: a choice and its reason.

```json
{ "id": "driver-abstraction", "title": "…", "decision": "…", "why": "…", "date": "2026-07-06", "by": "Brian",
  "components": ["driver-contract"], "basis": "record", "refs": [{ "file": "docs/BLUEPRINT_DBCLIENT.md", "line": 21, "label": "Blueprint §1" }] }
```

When the choice is visible in code but the reason is not, give the reason its own provenance with `whyBasis` and `whyRefs`.

**dangerZones**: where a reasonable change causes an unreasonable outcome. Evidence required.

```json
{ "id": "identifier-quoting", "title": "…", "risk": "…", "guidance": "…", "components": ["driver-helpers"], "basis": "code", "refs": [{ "file": "src/drivers/ident.ts" }] }
```

**startHere**

```json
{
  "readingOrder": [{ "path": "CLAUDE.md", "why": "…" }],
  "firstJourneys": ["preview-a-table"],
  "runLocally": [{ "step": "What it does", "command": "npm run bundle" }],
  "rules": [{ "title": "Secrets live only in SecretStorage", "why": "…" }]
}
```

**openQuestions**: the gaps in what is written down. They mirror `answers.md`.

```json
{ "id": "Q-004", "question": "…", "context": "…", "owner": "Brian", "meanwhile": "What we do until it is answered.",
  "relatesTo": ["sqlite-driver"], "refs": [{ "file": "docs/task.md", "line": 26, "label": "task.md M4" }],
  "askedAt": "2026-11-26", "status": "open", "answer": null, "answeredBy": null }
```

- `id` is `Q-` and three or more digits, never reused.
- `status: "answered"` needs `answer`.
- An answer that does not settle the question yet ("to be confirmed") keeps it `open` and goes in `progress`: `{ "text": "…", "by": "Brian", "date": "2026-11-27" }`. The page shows it as *Where it stands*.
- A **sensitive** question carries `"sensitive": true` and a short, neutral `topic` instead of `question`, `context`, `refs` and `tech`, which the build rejects. Its answer is a pointer of at most 120 characters. See SKILL.md.

**changelog**: newest first, one entry per run that changed something.

```json
{ "date": "2026-11-26", "commit": "e1f6927", "summary": "Plain language: what changed in the extension and in the map.", "mrs": [22] }
```

## Database (optional)

This repo has no `database` key, so the page has no *Data* tab. For a repo with a schema export:

```json
"database": {
  "schemaDir": "src/database/schema",
  "groups": [
    { "name": "Connections", "component": "connection-store", "tables": ["connections", "folders"] }
  ]
}
```

The tables, columns and relations come from `docs/database/schema.json` (and `schema.dbml`), written by the repo's schema export; `groups` only arranges them on the *Data* tab and links each group to a component. Every table is in exactly one group. The build compares the JSON's `sourceHash` with the files in `schemaDir` and fails when they differ.

## Screens (optional)

Screenshots are not part of `map.json`. They live in `docs/screens/`; with no `screens.json` the page has no *All screens* tab.

- `screens.json`: every screen, and where it is shown.

  ```json
  { "id": "query-panel", "component": "query-panel", "platform": "web", "group": "Query panel",
    "caption": "Query panel: editor, Run, and the results grid", "role": "Developer",
    "shows": [{ "journey": "write-and-run-query", "step": 6 }],
    "source": ["src/webview/queryPanel.ts"] }
  ```

  `platform` is `web`, `phone`, `document` or `email`. `step` counts from 0. The build fails when a `shows` points at a journey or step that does not exist.
- `manifest.json`: one entry per captured screen with its `file` (relative to `docs/screens/`; this repo points at `../../media/…`), `width`, `height` and `capturedAt` (the commit). The page marks a screen *may be out of date* when any `source` changed between `capturedAt` and `HEAD`.
