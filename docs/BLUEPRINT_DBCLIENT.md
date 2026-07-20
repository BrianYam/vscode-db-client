# BLUEPRINT — Open DB Client

_Spec-Driven Development artifact. Version-controlled. Do not delete prior notes; version them._

## 0. Understanding Lock (Discovery Summary)

| Question | Answer |
|---|---|
| **Why** | The `cweijan/vscode-database-client` extension paywalls >3 connections behind a Premium license. Objective: a self-built, no-cost replacement — writing new code, not cracking the paid product. |
| **Success (KPI)** | Unlimited connections working in VS Code for the user's real databases, with the daily 80% workflow (browse + query) intact. |
| **Scope** | PostgreSQL, MySQL/MariaDB, SQLite, Redis. Tree browse, SQL/command editor, results grid, full connection CRUD. |
| **Boundaries (out for now)** | SSH/Socks tunnel, backup/restore, ER diagrams, cloud sync, the 11 other DB engines. Tracked as later phases, not MVP. |
| **Stakeholders** | Single developer (self-hosted, local use). |
| **Constraints** | Minimum ongoing effort; must survive VS Code updates (→ avoid native modules where possible). |
| **Risks** | Native-module ABI mismatch (mitigated: pure-JS `pg`/`mysql2`/`ioredis` + WASM `sql.js`); scope creep from "full clone" ambition. |

**Design principle: Copy, don't innovate.** UX mirrors the original — activity-bar tree, expand to schemas/tables, click table → grid preview, per-connection query editor.

## 1. Pillar I — Execution (what we build)

Driver-abstraction architecture so every engine is one file behind a single `Driver` interface. The tree, query panel, and commands never import a DB library directly.

```
Activity Bar (tree)  ─┐
Query Panel (webview)─┼─→ ConnectionManager ─→ Driver ─→ pg / mysql2 / sql.js / ioredis
Connection Form      ─┘         │
                        ConnectionStore (globalState + SecretStorage, NO count limit)
```

### Module roadmap (App Intelligence 30-day cycle framing)

| Module | Status | Notes |
|---|---|---|
| M0 Skeleton + unlimited connection CRUD | ✅ Done | Solves the core paywall pain today |
| M1 PostgreSQL vertical slice (tree → query → grid) | ✅ Done | Reference implementation |
| M2 MySQL / MariaDB driver | ✅ Done | Pure-JS, parity with M1 |
| M3 Redis driver | ✅ Done | Command-line queries + key preview |
| M4 SQLite driver | ⚠ Read-only | WASM in-memory; write-back is the one open item |
| M5 Editing (inline row edit, DDL view, export CSV/JSON) | ▢ Next | Depth features |
| M6 SSH tunnel | ▢ Later | `ssh2` port-forward before driver connect |
| M7 ER diagrams / backup / restore | ▢ Later | Highest effort, lowest daily value |
| M8 Public launch readiness | ⚠ Partial | Changelog/versioning/reset done; marketplace metadata open |
| M9 Redis key explorer (search + delete) | ✅ Done | Server-side `SCAN MATCH` live filter; delete key with confirm |

## 2. Pillar II — Capacity

Lean solo build. No team. Effort concentrated in M5 (editing) since browse+query already covers the daily workflow. Native-module avoidance is the key capacity decision — it removes the recurring "rebuild after VS Code update" tax.

## 3. Pillar III — Growth (future)

- Connection import from the original extension's settings (one-time migration → zero switching cost).
- Query history + saved snippets.
- Optional: AI-assisted SQL (schema-aware completion) as the differentiator over the original.

## 4. Human QA Gate (Phase 4 checklist)

- [ ] Each driver tested against a live instance (see `task.md` QA tasks).
- [ ] Passwords confirmed stored only in SecretStorage, never globalState.
- [ ] No connection-count cap anywhere in the code path.
- [ ] Survives a VS Code reload with connections persisted.
