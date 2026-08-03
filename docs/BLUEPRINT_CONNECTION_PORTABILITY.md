# BLUEPRINT — Connection portability (import / export)

Status: **SPEC LOCKED 2026-08-02** · Milestone `M20` · Supersedes nothing

## 1. Why

Connections live in one VS Code profile on one machine (`globalState` key
`openDbClient.connections`, secrets in SecretStorage). There is no way to move them to a
second machine, hand a team a starting set, or back them up before a `Reset all data`.
Re-typing 11 connections by hand is the current answer.

**Primary KPI:** moving a full connection set to a second machine takes one export, one
import, and zero hand-retyping of non-secret fields.

## 2. Discovery findings

### 2.1 The finding that shapes the whole feature

`ConnectionConfig.connectionString` (`src/connections/types.ts:33`) is persisted **whole**
into `globalState`. When the user pastes `postgresql://user:pass@host/db`, the password goes
to disk in cleartext — `globalState` is an unencrypted SQLite file
(`~/Library/Application Support/Code/User/globalStorage/state.vscdb`). Only the
separate-fields path routes the password to SecretStorage.

Verified on the author's own install: **5 of 11 connections** currently hold a cleartext
password this way.

Consequence for this milestone: an export that merely "omits SecretStorage secrets" would
still be a credential dump for every connection-string connection. Redaction of the URL is
therefore **part of the export contract, not a nicety**.

(The underlying storage issue is out of scope here and tracked separately as M21.)

### 2.2 Threat model for an export file

A `.json` sitting in `~/Downloads` is assumed to be: synced to cloud backup, attached to
Slack, and eventually `git add`-ed by accident. The default export must survive all three
without leaking a credential. Anything that *does* carry credentials must be
unreadable without a passphrase the user typed.

Anchors: PDPA / Act 854 — credentials to production data stores are access-control
material; the default path must not create an uncontrolled copy.

### 2.3 Untrusted input

An import file is attacker-controllable content. Fields like `sslCA` / `sslKey` /
`sshPrivateKeyPath` are **filesystem paths the extension will later read**, and
`connectionString` drives an outbound connection. Import therefore whitelists known fields
and drops unknown ones rather than spreading a parsed object into a config.

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Two export commands.** Default = redacted, shareable. Opt-in = passphrase-encrypted, full fidelity. | One file people can safely pass around; one file for genuinely moving machines. Neither pretends to be the other. |
| D2 | Default export **omits** SecretStorage secrets **and strips the password out of `connectionString`**, flagging each affected entry with `redactedCredentials: true`. | §2.1 — omission alone is not enough. The flag makes the loss visible on import instead of surfacing as a mystery auth failure. |
| D3 | The connection-string **username is kept**; only the password is stripped. | A username is not a secret — it is already stored in the clear in the `username` field for every non-connection-string connection, so stripping it would be inconsistent and would cost the importer real information. Called out in the export summary. |
| D4 | Encrypted bundle = **scrypt (N=16384, r=8, p=1) → AES-256-GCM**, random salt + IV per file, auth tag verified on open. | `node:crypto` only, no new dependency. GCM means a tampered file fails loudly rather than decrypting to garbage. |
| D5 | Import **appends**, never replaces. Existing connections are not touched, reordered, or renumbered. | Explicit user requirement. |
| D6 | Duplicate rule: **skip on identity match**, where identity = `type + host + port + database + username` (`type + filePath` for SQLite, plus `redisDb` for Redis), resolved through the connection string when one is used. | Re-importing the same file twice is then a no-op. A blind append doubles the list every time. Comparing resolved targets means a connection-string entry dedupes correctly against the same server saved as separate fields. |
| D7 | Imported entries always get a **fresh `id`**; `id` is not written to the export file at all. | Ids are local primary keys for SecretStorage lookups. Carrying them across machines would risk one connection's config being married to another's stored password. |
| D8 | Name collisions (same name, different server — not a duplicate) get a ` (imported)` / ` (imported 2)` suffix. | Two different servers must stay distinguishable in the tree. |
| D9 | Import reports **added / skipped / dropped** counts and warns when credentials were redacted. | House rule: surface what actually happened rather than a green tick. |
| D10 | A **"What's new"** guide is added to Settings & Guides, rendered from the shipped `CHANGELOG.md` at runtime. | See §5. |

## 4. File formats

`kind` + `version` are checked before anything else is read; an unknown `kind` is rejected
with a message naming what the file actually is.

```jsonc
// Default export — safe to share
{
  "kind": "open-db-client/connections",
  "version": 1,
  "exportedAt": "2026-08-02T…Z",
  "exportedBy": "open-db-client 0.5.0",
  "secrets": "omitted",
  "connections": [
    { "name": "Tomei Staging", "type": "postgres",
      "useConnectionString": true,
      "connectionString": "postgresql://user@host:5432/tomei",
      "redactedCredentials": true }
  ]
}
```

```jsonc
// Encrypted export — carries passwords, SSH passwords, SSH passphrases
{
  "kind": "open-db-client/connections-encrypted",
  "version": 1,
  "kdf": { "name": "scrypt", "N": 16384, "r": 8, "p": 1, "salt": "<b64>" },
  "cipher": "aes-256-gcm",
  "iv": "<b64>", "tag": "<b64>",
  "data": "<b64 ciphertext of the default-format document, secrets included>"
}
```

## 5. Changelog in Settings & Guides

**Question asked:** is shipping a changelog in-product standard practice?

**Answer: yes, and it is the norm for VS Code extensions.** The Marketplace renders
`CHANGELOG.md` as a first-class tab, and VS Code itself, GitLens, Docker, and Python all
surface release notes in-product. A changelog is a compatibility and trust document —
"is the bug I hit fixed in the version I have?" is unanswerable without it. Nothing in
`CHANGELOG.md` is sensitive: it describes shipped behaviour, not infrastructure.

The one real risk is **drift** — an in-app copy that stops matching the released notes.
Mitigated by rendering the shipped `CHANGELOG.md` itself at runtime (it is already inside
the `.vsix`; `.vscodeignore` excludes `docs/**` but not the root file), so there is exactly
one source of truth and no build step to forget.

## 6. Out of scope (this milestone)

- Migrating `connectionString` passwords into SecretStorage — real, separate, tracked as M21.
- Sync via Settings Sync / a cloud account.
- Exporting saved `.sql` query files (they are already plain files the user can copy).
- Import from other clients' formats (DBeaver, TablePlus). Revisit if asked for.
