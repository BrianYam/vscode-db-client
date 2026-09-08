# BLUEPRINT — AWS Athena (Lite)

Supersedes the v1 blueprint on `feat/athena-fat`. That branch shipped a correct but
oversized feature (4,524 lines across 40 files). This one targets the same user job
with roughly a tenth of the surface.

## The job

Connect to Athena, browse the catalog, run a query, read the rows. Nothing else.

## Hard constraint: two live connections must survive

Two Athena connections already exist in this machine's VS Code state and **must keep
working without being re-entered**. They live in
`globalStorage/state.vscdb` under `brianlab.open-database-client` plus the macOS
Keychain — entirely outside git, so no branch operation can lose them. What *can*
lose them is renaming a persisted field. Verified shapes:

| id (suffix) | name | mode | fields present |
|---|---|---|---|
| `…mt3rxr1v` | aerobus-athena-ak | `keys` | region, accessKeyId, workgroup, outputLocation |
| `…mt3s7dpv` | aerobus-athena-profile | `profile` | region, profile, workgroup |

**Frozen contract — do not rename, retype, or drop:**

- `DatabaseType` must keep the literal `"athena"`.
- `ConnectionConfig` must keep `awsAuthMode`, `awsRegion`, `awsProfile`,
  `awsAccessKeyId`, `athenaWorkgroup`, `athenaCatalog`, `athenaOutputLocation`.
- SecretStorage keys `openDbClient.awsSecret.<id>` and
  `openDbClient.awsSessionToken.<id>` keep those exact names.
- `schemaVersion: 1` records must load unmigrated.

A field may disappear from the *form* while staying readable by the *driver*.
`athenaOutputLocation` is exactly that case — one saved connection sets it.

## Rebase vs. reset: neither

`main` moved five commits past the fork point and now ships its own query
cancellation, with a different contract than the fat branch invented:

- `main`: `cancel?(token: string)` — optional method on `Driver`.
- `feat/athena-fat`: a separate `Cancellable` interface with `cancelQuery(executionId)`
  plus a `capabilities.ts` gating layer threaded through all four existing drivers.

Sixteen files overlap, including `Driver.ts`, all four drivers, `queryPanel.ts` and
`connectionFormPanel.ts`. Rebasing means hand-reconciling two competing designs for a
subsystem across the whole driver layer — to keep code we have already decided to
delete. Fresh branch from `main`, port the ~200 lines that carry the feature.

## Scope

**In** — one driver file, one registry case, one form section, the frozen fields above,
`bytesScanned` shown in the results footer, tests for the pure helpers.

**Out, and why:**

| Cut | Lines | Reason |
|---|---|---|
| `capabilities.ts` + its edits to pg/mysql/redis/sqlite | ~330 | `main` solved cancellation its own way. An abstraction built for one engine is not yet an abstraction. |
| `athenaPricing.ts` + cost estimation UI | ~345 | A per-region price table is a maintenance liability that goes stale silently. Athena returns `DataScannedInBytes` for free; print it. |
| `ai/redact.ts` + the five `ai/*` edits | ~180 | Unrelated to connecting to Athena. Port separately if wanted. |
| `.idea/*` | 32 | Editor config, should never have been committed. |
| Catalog / endpoint override / FIPS form inputs | — | Unset on both live connections. Fields stay readable; the inputs go. |

## Honesty (non-negotiable, per CLAUDE.md)

Athena bills per terabyte scanned and a cancelled query is still billed for what it
scanned. Cutting the pricing estimator does not mean going quiet about cost:

- Results footer shows bytes scanned, from the response we already have.
- Clicking a table in the tree must **not** auto-preview — a preview is a billed query.
  Preview stays an explicit context-menu action. One line in the tree, not a framework.
- Row cap surfaces as "showing first N", never a silent truncation.
