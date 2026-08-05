# Discovery — Query Lock (manual + AI-mutation auto-lock)

Status: **LOCKED 2026-08-06** (§4). Raised 2026-08-06.
Requested: a per-panel lock that blocks query execution; engaged manually, and engaged
**automatically whenever the AI generates a mutation** (insert / update / delete / upsert
/ DDL), so an AI-written write can never be run by reflex.

Sized like M21: this document carries both discovery and design; no separate blueprint.

## 1. The 7-Question Foundation

**Why.** AI-generated SQL lands in the editor *selected*, one `Ctrl/Cmd+Enter` from
running. For SELECTs that immediacy is the feature; for a mutation it is the risk — the
muscle-memory keystroke that follows every Generate is exactly how an accidental UPDATE
happens. The existing destructive tag warns but does not stop.

**Success.** A 🔒 toggle in the query panel toolbar. Locked: Run button, Ctrl/Cmd+Enter,
highlight-to-run, cell edits, row insert/delete, and TTL changes all refuse with a clear
message. Any AI Generate/Fix whose SQL is a mutation flips the lock on by itself, visibly.
One click unlocks. Zero regression when the lock is never touched.

**Scope.** The query panel webview + the pure mutation detector + AI result plumbing.

**Boundaries (out of scope).** Tree-side commands (Run Query File, key delete — they have
their own confirms). Locking triggered by *hand-typed* mutations (the user wrote it on
purpose; only AI output auto-locks). Persistence of lock state across panel close. A
global always-locked mode per connection (future, if asked for).

**Stakeholders.** Single author; Marketplace users on production databases are the
beneficiaries.

**Constraints.** House rules: webview CSP unchanged; pure logic exported + unit-tested
(`node:test` tier); honesty-first UX (a blocked action says *why*, not nothing).

**Risks.** (a) Mutation detection is a token scan, not a grammar — CTE-wrapped writes
(`WITH … INSERT`) must be caught; a rare false positive (e.g. the word "insert" in a
string) locks a panel that one click unlocks — **fail-safe is the correct direction**.
(b) Grid-edit entry points are scattered; missing one silently weakens "read-only".

## 2. What already exists (verified)

- `isDestructive()` in `src/ai/context.ts` — same shape (comment-strip → per-statement
  verb scan), but narrower on purpose: it tags *dangerous* shapes. A syntactically fine
  `INSERT` is not destructive yet **is** a mutation. New sibling `isMutation()`, same file,
  same test tier.
- The AI result pipeline (`AiVerbResult` → `aiResult` message → note line) already carries
  per-result flags (`destructive`, `trimmedTo`) — `mutation` is one more field.
- Grid mutations all funnel through few webview chokepoints: `saveCell` (cell edits, incl.
  the Edit Data modal), `deleteSelected`, `openAddModal`, and the two TTL buttons.

## 3. Design

- **`isMutation(sql): string | null`** (context.ts): comment-strip, split on `;`, per
  statement match a leading verb in {INSERT, UPDATE, DELETE, MERGE, REPLACE, DROP,
  TRUNCATE, ALTER, CREATE}; a statement starting `WITH` that contains a top-level-ish
  write verb also counts. Returns the verb for the lock message. Over-triggering is
  acceptable by design (§1 Risks).
- **Webview state** `qlock` + 🔒/🔓 toolbar button beside Run. Guards at `run()` and the
  grid chokepoints; every refusal posts the same status: *"🔒 Query lock is on — click the
  lock to unlock."* Run button visually disabled while locked.
- **Auto-lock**: host computes `mutation` on Generate/Fix results; webview engages the
  lock and prefixes the note line with *"🔒 auto-locked (INSERT)"*. Explain never locks.
- **Unlock**: one click (locked decision — the deliberate click is the safety; a modal on
  top was rejected as friction without added safety).

## 4. Validation gate — LOCKED 2026-08-06

1. **Lock scope: full read-only panel** — query runs AND grid editing (cell edits, + Row,
   Delete, TTL changes) are blocked while locked.
2. **Unlock: one click** on the lock button, auto- or manually engaged alike.
3. **Mutation set: all writes including DDL** — INSERT, UPDATE, DELETE, MERGE, REPLACE,
   upserts, DROP, TRUNCATE, ALTER, CREATE.
4. Auto-lock fires only on **AI-generated** SQL (Generate / Fix), never on typed SQL.

Tasks: `task.md` M23.
