# Discovery — Query run indication & abort

Status: **LOCKED 2026-09-08** (§5). Raised 2026-09-08.
Requested:
1. Make the *query running* indication feel like the AI-generation running animation.
2. Long queries need to be abortable — the control sits **beside Run** and must be obvious.

Sized like M21 / M23: this document carries both discovery and design; no separate
blueprint.

## 1. The 7-Question Foundation

**Why.** Two gaps, one root cause: a running query is currently invisible work.
`run()` sets `statusEl.textContent = 'Running…'` (`queryPanel.ts:959`) and then nothing
moves — no motion, no elapsed time — so a 40-second query and a hung one look identical.
And there is **no abort path at all**: `grep -rn "abort\|cancel" src/` returns only the AI
cancel and an unrelated comment. A user who fires `SELECT *` at a 40M-row table has
exactly two options today: wait, or kill the window. Meanwhile the AI assist bar three
rows above already solves the first half well (braille spinner + live seconds,
`queryPanel.ts:1214-1233`) — the query path just never got the same treatment.

**Success.**
- A running query animates: braille spinner + live elapsed seconds, same visual language
  as the AI bar, so "working" and "stuck" are distinguishable within a second.
- An **Abort** control sits immediately right of Run, appears the moment a query starts,
  is styled as a danger action, and actually cancels **server-side** on Postgres and MySQL.
- A query that cannot truly be cancelled says so instead of pretending (§2 Finding A).
- Zero regression when a query returns in 50ms — the spinner must not flash-flicker.

**Scope.** `src/webview/queryPanel.ts` (toolbar, run/abort state machine, spinner),
`src/drivers/Driver.ts` (an optional `cancel?()` on the interface),
`postgres.ts` / `mysql.ts` (dedicated-connection execution + cancel), `redis.ts` (abandon).

**Boundaries (out of scope).** Aborting tree-driven table previews, exports, schema-hint
loads, or AI calls (the AI bar has its own path). Query timeouts / auto-abort after N
seconds. A query history or "recently aborted" list. Progress *percentage* — no engine
here reports one, and a fake progress bar is the opposite of honest UX. Abort for SQLite
(§2 Finding A). Killing the connection as a fallback abort.

**Stakeholders.** Single author; Marketplace users running ad-hoc SQL against production.

**Constraints.** House rules: webview CSP unchanged (nonce'd inline script only);
`Driver`-only abstraction — the panel must not learn what engine it is talking to;
optional-method pattern for partial support (`setTtl?` precedent); pure logic exported +
`node:test` covered; honesty-first UX.

**Risks.**
- (a) **Postgres/MySQL cancel requires a dedicated connection.** Both drivers currently
  run `pool.query(sql)`, which hands back an arbitrary pooled client and never exposes
  its backend id — there is nothing to cancel. Reworking `query()` to check a connection
  out explicitly is the real work here, and it touches the hot path of every hand-typed
  query. Mitigation: `try/finally` release, and the change is confined to `query()` —
  previews and metadata calls keep using `pool.query`.
- (b) **A late result after an abort must not paint the grid.** Cancellation is a race;
  the statement may complete before the cancel lands. Mitigation: a monotonic run
  sequence, host-side; results from a superseded run are dropped, not rendered.
- (c) **Spinner flicker** on fast queries. Mitigation: the animation is armed on a ~150ms
  delay — a query that returns first never shows it.
- (d) Over-promising abort. Mitigated by Finding A being a *locked* honesty decision,
  not a bug to paper over.

## 2. What already exists (verified in-repo)

- **The animation to copy** — `AI_FRAMES = ['⠋','⠙',…]`, `aiSpinStart()`/`aiSpinStop()`,
  `setInterval` at 120ms, elapsed seconds appended, `aiSpinStop()` returns the total for
  the note line (`queryPanel.ts:1214-1233`). This is the reference implementation; the
  query path should **share** it, not clone it.
- **Toolbar** — `#runBtn` then `#lockBtn` in `.bar` (`queryPanel.ts:851-852`). Abort's
  natural home is between them.
- **Lock precedent** — M23 already owns "Run is unavailable right now" (`setLock` disables
  `#runBtn`). The abort state machine must compose with it, not fight it: unlocking must
  not re-enable Run mid-flight.
- **Message plumbing** — webview→host `switch` at `queryPanel.ts:180`; `run()` host method
  at `:410`. Adding an `abort` message type is the established pattern.
- **No `seq` on run** — `filter` and `complete` already carry a `seq` (the out-of-order
  guard exists as a pattern); `run`/`result` do not. Risk (b) needs it extended.

### Finding A — abort is not uniformly possible (drives §5.4)

| Engine | Execution today | Can it be cancelled? |
|---|---|---|
| **PostgreSQL** | `pool.query(sql)` (`postgres.ts:291`) | **Yes, truly.** Check out a client, keep `client.processID`, and on abort run `SELECT pg_cancel_backend($1)` on a second connection. Server stops the query. |
| **MySQL / MariaDB** | `this.p.query(sql)` (`mysql.ts:181`) | **Yes, truly.** Check out a connection, keep `conn.threadId`, and on abort issue `KILL QUERY <threadId>` on a second connection. |
| **SQLite (sql.js)** | `this.d.exec(sql)` (`sqlite.ts:176`) | **No — and cannot be.** `exec()` is *synchronous* WASM running on the extension host thread. While it runs the host is blocked, so the Abort click cannot even be delivered, let alone honoured. |
| **Redis (ioredis)** | `client.call(...)` (`redis.ts:243`) | **Not per-command.** ioredis has no cancel. Only *abandon* (stop waiting, discard the reply) is available without killing the connection. |

This is why abort is an **optional** `Driver` capability, not a required one — the same
call the codebase already makes for `setTtl?`.

### Finding B — one driver instance serves every panel (found during build)

`ConnectionManager.getDriver(id)` returns a **shared** driver per connection, so two query
panels open on the same connection run through the same object. A single "the query in
flight" field on the driver is therefore wrong: panel B's run overwrites panel A's, and
aborting A cancels B. `query()` and `cancel()` are token-scoped for this reason —
`query(sql, database, token)` registers under the caller's token and `cancel(token)`
targets exactly that run. Tokens are `p<panel>r<seq>`, minted by the panel.

### Competitive reference (Copy, Don't Innovate)

Drawn from general product knowledge of these tools, **not** from live research this
session — say the word and I'll verify against current builds before the lock.
- **DataGrip / DBeaver** — a red stop control in the query toolbar, live elapsed timer in
  the status strip; DBeaver's cancel maps onto the same `pg_cancel_backend` / `KILL QUERY`
  mechanics proposed here.
- **pgAdmin** — Run and Stop are adjacent toolbar buttons; Stop is enabled only in flight.
- **TablePlus** — spinner in place, keyboard accelerator to cancel.

The convergent pattern is: **Stop lives next to Run, only exists while running, is red.**
That is exactly what §3 specifies — no invention required.

## 3. Design

### 3.1 Shared spinner (webview)
Extract the AI bar's spinner into one `makeSpinner(el, label)` helper returning
`{ start, stop }` — identical frames, interval, and elapsed-seconds format. The AI bar is
refactored onto it (behaviour unchanged, verified by eye); the query path becomes its
second caller. One animation, one definition.

While running, the **Run button itself** becomes the indicator: label swaps to
`⠋ Running… 4s`, disabled, so the motion is where the user's eyes already are. The status
line keeps its text role (`Running selection…`) and stops being the only signal.
Armed on a 150ms delay (Risk c).

### 3.2 Abort control (webview)
New `#abortBtn` **immediately right of `#runBtn`**, `display:none` when idle. In flight:
visible, danger-styled (`--vscode-inputValidation-errorBackground` / error border — a
red that survives every theme), label `■ Abort`. Obvious by position, colour, and by
being the only enabled control in the pair.

Accelerator: **Esc aborts while a query is running** — the autocomplete's Esc handler
already `stopPropagation()`s when the dropdown is open, so the two never collide.

Engines that cannot cancel (§2 Finding A) do not get a fake button: the host advertises
capability at panel open (`canAbort` on the existing init/`aiEnabled`-style message), and
where it is false the button never renders. Redis renders it with the honest label
`■ Stop waiting` and a status line that says the server may still be working.

### 3.3 Driver contract
```ts
/** Cancel the in-flight statement started by `query()`, if the engine can.
 *  Optional: engines with no cancellation (sql.js) omit it and callers guard. */
cancel?(): Promise<void>;
/** True when `cancel()` stops work server-side rather than merely abandoning it. */
readonly canCancel?: boolean;
```
- **postgres.ts** — `query()` switches to `pool.connect()` → record `client.processID` →
  `client.query(sql)` → `finally client.release()`. `cancel()` opens a short-lived
  connection on the same pool and runs `SELECT pg_cancel_backend($1)`.
- **mysql.ts** — `query()` switches to `pool.getConnection()` → record `conn.threadId` →
  `conn.query(sql)` → `finally conn.release()`. `cancel()` runs `KILL QUERY <threadId>`
  on a separate pooled connection.
- **redis.ts** — `cancel()` marks the in-flight call abandoned; `canCancel = false`.
- **sqlite.ts** — no `cancel()`. Deliberate.

### 3.4 Host state machine (`queryPanel.ts`)
`run()` gains a monotonic `runSeq`; the `result`/`error` posts echo it and the webview
drops anything stale (Risk b). New `abort` message → `driver.cancel?.()`. An aborted run
resolves to a status line of `Aborted after 12.4s.` — a plain fact, no error styling,
because the user asked for it.

## 4. Moat / indispensability note
Abort is table stakes for every paid client in §2's reference list and absent from most
lightweight VS Code alternatives. Shipping *true* server-side cancellation — rather than
a button that only stops the spinner — is a credible "this one is actually a database
client" signal on the Marketplace listing, and it directly protects the shared production
databases our users point this at.

## 5. Validation gate — LOCKED 2026-09-08

1. **Spinner:** the AI bar's braille + elapsed-seconds animation is **extracted and
   shared**, and plays **on the Run button itself**; 150ms arming delay against flicker.
2. **Abort placement:** a dedicated button **immediately right of Run**, hidden when idle,
   danger-red in flight, plus **Esc** while running.
3. **Cancellation is real, not cosmetic:** Postgres `pg_cancel_backend`, MySQL
   `KILL QUERY` — which requires reworking both `query()` methods onto a dedicated
   connection.
4. **Honesty over uniformity:** **SQLite shows no Abort button at all** (synchronous WASM
   blocks the host thread — it is unimplementable, not merely unimplemented); **Redis**
   shows `■ Stop waiting` and says the server may still be working.
5. **One query in flight per panel** — Run is disabled while running; late results from a
   superseded run are dropped.
6. **Out of scope this milestone:** query timeouts, aborting previews/exports, progress
   percentages.

Tasks: `task.md` M31.
