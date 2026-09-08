# Discovery — Optional description / notes per connection

Status: **LOCKED 2026-09-08** (§5). Raised 2026-09-08.
Requested: an optional description or notes field for each connection.

Sized like M21 / M23 / M31 / M33: this document carries both discovery and design; no
separate blueprint.

## 1. The 7-Question Foundation

**Why.** The product's whole pitch is *no cap on connections*, so the people who like it
most are the ones with twenty of them. At that point `name` alone stops carrying the
load: `tomei-staging` does not say *"read-replica, safe to query; writes go to primary"*,
and the connection you must not run an UPDATE against looks exactly like the one you may.
A note is where that knowledge lives — today it lives in the user's head or a separate
file. The tree node currently has **no tooltip at all** (`DatabaseTreeProvider.ts:155`
sets only `description`), so there is an empty, obvious surface waiting for it.

**Success.**
- An optional multi-line **Notes** field on the connection form; empty by default and
  never required.
- Visible where the decision is made: hovering a connection in the tree shows it, and it
  reaches the query panel's context tooltip so it is present while you type SQL.
- Survives export → import round-trip (§2 Finding A — it does not today, by default).
- Does not become an accidental credential store (§2 Finding B — the real risk here).

**Scope.** `ConnectionConfig.notes`, the connection form panel, the tree node tooltip, the
query panel's context tooltip, and the portability import allowlist + its tests.

**Boundaries (out of scope).** Markdown or rich text in notes. Per-database or per-table
notes (this is per *connection*). Tags/labels as a separate structured field, and any
filtering or grouping of the tree by them — a different feature that a notes field is not
a substitute for. Colour-coding connections. Making notes searchable.

**Stakeholders.** Single author; the beneficiaries are users running many connections,
especially anyone with production and staging side by side.

**Constraints.** House rules: secrets never in `globalState` — and this field lands in
`globalState`. Schema is versioned (`CURRENT_SCHEMA_VERSION = 1`), so the migration story
has to be explicit. Import files are untrusted input handled by an allowlist.

**Risks.**
- (a) **A free-text box is where people paste passwords.** This is not hypothetical; it is
  the single most predictable failure mode of this feature, and it is made worse by
  Finding B. Mitigation is design, not hope.
- (b) Unbounded length. `globalState` is a synced key-value store, not a document store;
  a pasted 2 MB runbook in a tooltip is bad for both.
- (c) Rendering. The note is user text going into a VS Code tooltip and a webview form.
  `MarkdownString` in a tooltip would interpret it — command links included.

## 2. What already exists (verified in-repo)

- `ConnectionConfig` (`types.ts`) is a flat optional-field interface; adding one more
  optional string is the established shape.
- `store.ts` stamps `schemaVersion: CURRENT_SCHEMA_VERSION` on save and migrates legacy
  records in one place (`migrate()`), so there is a precedent to follow — though this
  change needs **no** migration (§3.1).
- The connection form assembles config in one function, `toConfig()`
  (`connectionFormPanel.ts:106`), with a consistent `?.trim() || undefined` idiom.
- The tree's connection node sets `description` but never `tooltip` — the surface is free.

### Finding A — notes would export but silently fail to import (drives §5.3)

The two halves of portability are deliberately asymmetric, and a new field lands on the
wrong side of it:

| Direction | Mechanism | Effect on a new `notes` field |
|---|---|---|
| **Export** (`portability.ts:130`) | blind spread — `const { id, schemaVersion, ...rest } = config` | `notes` is included **automatically** |
| **Import** (`sanitize`, `portability.ts:281`) | explicit `STRING_FIELDS` allowlist | `notes` is **silently dropped** |

So without touching `STRING_FIELDS`, a user exports their connections, re-imports them,
and every note is gone with no warning. The allowlist is correct and deliberate — the
comment on it explains why an import file is untrusted — so the fix is to add `notes` to
it, and to cover the round-trip in `portability.test.js`, which already exists.

### Finding B — "export without secrets" would not redact a note (drives §5.4)

Export offers a secrets-omitted mode, and its redaction is field-specific: it strips the
password from `connectionString` and skips `SECRET_FIELDS` (`portability.ts:132-146`).
It has no notion of a free-text field. So a note reading *"login: admin / hunter2"* is
exported **in full** by the mode whose entire promise is that it carries no secrets — and
that is the file people feel safe emailing to a colleague.

This is the finding that shapes the design. The mitigation is not a scanner that pretends
to detect secrets; it is (1) telling the user plainly at the point of entry that notes are
stored and exported in the clear, and (2) making the export dialog say that notes are
included, so the promise the file makes is accurate.

### Competitive reference (Copy, Don't Innovate)

From general product knowledge of these tools, **not** live research this session — say
the word and I will verify before the lock.
- **DBeaver** — connection has a Description field, shown in the navigator tooltip.
- **DataGrip** — data source comment, surfaced on hover.
- **TablePlus** — connection notes, plus colour-coding for prod vs staging.
- **pgAdmin** — server "Comments" tab.

Convergent pattern: **a plain multi-line text field, surfaced on hover, never required.**
That is §3. (Colour-coding is the other half of how these tools separate prod from
staging; explicitly out of scope here, and worth its own discovery if the pain persists.)

## 3. Design

### 3.1 Data
`notes?: string` on `ConnectionConfig`. **No schema migration and no version bump**: the
field is optional, absent means absent, and `migrate()` exists for records that need a
*value changed* (the legacy `allowInvalidCert` case), which this does not. Saying so
explicitly here so the omission reads as a decision rather than an oversight.

Capped at **2,000 characters**, enforced in `toConfig()` (the one funnel) and surfaced in
the form as a live counter — not silently truncated.

### 3.2 Form
A `<textarea>` under Name, labelled `Notes (optional)`, with helper text stating the
security position in one line: *"Stored unencrypted with the connection, and included in
exports — don't put passwords here."* Honest at the point of entry, which is the only
place it can change behaviour.

### 3.3 Where it shows
- **Tree**: `node.tooltip` on the connection node — a plain `string`, deliberately **not**
  a `MarkdownString` (Risk c: markdown tooltips render links, including `command:` URIs).
- **Query panel**: appended to the existing `contextTooltip()`, so it is in reach while
  writing SQL against that connection.
- Not in `description` — that line is the engine name and stays short.

### 3.4 Portability
- Add `notes` to `STRING_FIELDS` so import keeps it (Finding A).
- The export-without-secrets confirmation names notes among what the file will contain
  (Finding B), so the dialog's promise stays true.
- Round-trip test added to the existing `portability.test.js`.

## 4. Moat / indispensability note
This is a retention feature, not an acquisition one. The user with twenty connections is
the one who has most invested in the tool and is least likely to leave — and the notes
they write are switching cost they create themselves. It is also the cheapest credible
answer to "how do I avoid running this against production", which is the anxiety that
makes people keep a heavyweight client installed alongside.

## 5. Validation gate — LOCKED 2026-09-08

1. **`notes?: string` on `ConnectionConfig`**, optional, capped at 2,000 characters with a
   live counter; no truncation without telling the user.
2. **No schema migration, no `CURRENT_SCHEMA_VERSION` bump** — an absent optional field
   needs neither; recorded as a decision, not an oversight.
3. **Added to the import allowlist** (`STRING_FIELDS`) so export → import round-trips,
   with a test — otherwise notes silently vanish on import (Finding A).
4. **Honest about secrecy**: the form says notes are stored unencrypted and travel in
   exports, and the secrets-omitted export dialog says notes are included. **No secret
   scanner** — a detector that misses one password is worse than a clear warning.
5. **Surfaced as a plain-string tooltip** on the tree node and appended to the query
   panel context tooltip. Never a `MarkdownString` (command-link injection).
6. **Out of scope:** tags, colour-coding, tree filtering/grouping by note, markdown,
   per-table notes.

Tasks: `task.md` M34.
