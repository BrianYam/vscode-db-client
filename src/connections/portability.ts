import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { type ConnectionConfig, type DatabaseType, DEFAULT_PORTS } from "./types";

/**
 * Import / export of connection configs. Pure logic — no vscode, no filesystem —
 * so it is unit-testable and so the security-critical parts (redaction, whitelist,
 * crypto) can be tested without a live editor.
 *
 * See docs/BLUEPRINT_CONNECTION_PORTABILITY.md for the locked decisions. The one
 * to keep in mind while reading: a connection string can embed a password, and
 * those are stored in cleartext globalState today, so "don't export secrets" is
 * not achieved by omitting SecretStorage values alone.
 */

export const EXPORT_KIND = "open-db-client/connections";
export const ENCRYPTED_KIND = "open-db-client/connections-encrypted";
export const EXPORT_VERSION = 1;

/** Secrets that live in SecretStorage; only ever written to an encrypted bundle. */
export interface ConnectionSecrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

/**
 * A connection as it appears in an export file. `id` is deliberately absent —
 * it is a local key into SecretStorage, and reusing one across machines could
 * marry a config to the wrong stored password.
 */
export type ExportedConnection = Omit<ConnectionConfig, "id" | "schemaVersion"> &
  ConnectionSecrets & {
    /** Set when a password was stripped out of `connectionString` on export. */
    redactedCredentials?: boolean;
  };

export interface ExportFile {
  kind: typeof EXPORT_KIND;
  version: number;
  exportedAt: string;
  exportedBy: string;
  secrets: "omitted" | "included";
  connections: ExportedConnection[];
}

const TYPES: DatabaseType[] = ["postgres", "mysql", "sqlite", "redis"];

/**
 * Fields an import is allowed to set. Anything else in the file is dropped:
 * an import file is untrusted input, and several of these values are paths the
 * extension will later read (sslCA/sslKey/sshPrivateKeyPath) or a string it will
 * dial (connectionString), so a blind spread is not acceptable.
 */
const STRING_FIELDS = [
  "name",
  "host",
  "username",
  "database",
  "filePath",
  "sslCA",
  "sslCert",
  "sslKey",
  "connectionString",
  "sshHost",
  "sshUsername",
  "sshPrivateKeyPath",
] as const;
const NUMBER_FIELDS = ["port", "redisDb", "sshPort", "sshConnectTimeout"] as const;
const BOOL_FIELDS = ["ssl", "allowInvalidCert", "useConnectionString", "sshEnabled"] as const;
const SECRET_FIELDS = ["password", "sshPassword", "sshPassphrase"] as const;
const SSH_AUTH = ["auto", "password", "key", "agent"];

// ---------------------------------------------------------------- redaction

/**
 * Strip the password out of a connection string, keeping everything else —
 * scheme, username, host, port, database, query params — so the entry is still
 * useful after import and only the secret is gone.
 *
 * The username is intentionally kept: it is not a secret, and it is already
 * stored in the clear in the `username` field for every non-connection-string
 * connection, so removing it here would be inconsistent and lossy.
 */
export function redactConnectionString(cs: string): { value: string; redacted: boolean } {
  try {
    const u = new URL(cs);
    if (!u.password) {
      return { value: cs, redacted: false };
    }
    u.password = "";
    return { value: u.toString(), redacted: true };
  } catch {
    // Not URL-shaped (a DSN-style string, say). Fall back to the textual form
    // rather than exporting it untouched — failing open would leak the password.
    const m = /^([a-zA-Z][\w+.-]*:\/\/)([^/@]*?):([^/@]*)@/.exec(cs);
    if (m) {
      return { value: cs.replace(m[0], `${m[1]}${m[2]}@`), redacted: true };
    }
    // Some other shape that still smells of credentials — say so rather than
    // guessing at a rewrite that might corrupt it.
    return { value: cs, redacted: false };
  }
}

// ------------------------------------------------------------------- export

/**
 * Build an export document. With `includeSecrets` false (the default path) every
 * SecretStorage value is dropped and connection strings are redacted; the result
 * is safe to hand to someone else.
 */
export function buildExport(
  entries: Array<{ config: ConnectionConfig; secrets?: ConnectionSecrets }>,
  opts: { includeSecrets: boolean; exportedBy: string; exportedAt: string },
): { file: ExportFile; redactedNames: string[] } {
  const redactedNames: string[] = [];
  const connections = entries.map(({ config, secrets }) => {
    const { id: _id, schemaVersion: _sv, ...rest } = config;
    const out: ExportedConnection = { ...rest };
    if (out.connectionString && !opts.includeSecrets) {
      const r = redactConnectionString(out.connectionString);
      out.connectionString = r.value;
      if (r.redacted) {
        out.redactedCredentials = true;
        redactedNames.push(config.name);
      }
    }
    if (opts.includeSecrets && secrets) {
      for (const f of SECRET_FIELDS) {
        if (secrets[f]) {
          out[f] = secrets[f];
        }
      }
    }
    return out;
  });
  return {
    file: {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: opts.exportedAt,
      exportedBy: opts.exportedBy,
      secrets: opts.includeSecrets ? "included" : "omitted",
      connections,
    },
    redactedNames,
  };
}

// ------------------------------------------------------------------- import

export interface ParsedImport {
  connections: ExportedConnection[];
  /** Entries that were rejected, and why — reported, never silently dropped. */
  warnings: string[];
  hasSecrets: boolean;
}

/** True when the text is (or claims to be) an encrypted bundle. */
export function isEncryptedBundle(text: string): boolean {
  try {
    return (JSON.parse(text) as { kind?: string }).kind === ENCRYPTED_KIND;
  } catch {
    return false;
  }
}

/**
 * Parse and sanitize an export file. Throws on a document that is not ours;
 * individual bad entries are dropped with a warning so one malformed connection
 * does not cost the user the other ten.
 */
export function parseImport(text: string): ParsedImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  // Typed loosely on purpose: this is untrusted input, so `kind` is whatever the
  // file says it is, not what our own union permits.
  const d = doc as Partial<Omit<ExportFile, "kind">> & { kind?: string };
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    throw new Error("Not an Open DB Client connections file.");
  }
  if (d.kind === ENCRYPTED_KIND) {
    throw new Error("This file is encrypted — it needs its passphrase to be imported.");
  }
  if (d.kind !== EXPORT_KIND) {
    throw new Error(
      `Not an Open DB Client connections file (kind: ${d.kind ? String(d.kind) : "missing"}).`,
    );
  }
  if (typeof d.version !== "number" || d.version > EXPORT_VERSION) {
    throw new Error(
      `This file was written by a newer version of Open DB Client (format v${String(d.version)}). Update the extension to import it.`,
    );
  }
  if (!Array.isArray(d.connections)) {
    throw new Error("The file has no connections array.");
  }

  const warnings: string[] = [];
  const connections: ExportedConnection[] = [];
  d.connections.forEach((raw, i) => {
    const sane = sanitize(raw, i, warnings);
    if (sane) {
      connections.push(sane);
    }
  });
  const hasSecrets = connections.some((c) => SECRET_FIELDS.some((f) => c[f]));
  return { connections, warnings, hasSecrets };
}

/** Whitelist one entry down to known fields with the right primitive types. */
function sanitize(raw: unknown, index: number, warnings: string[]): ExportedConnection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`Entry ${index + 1}: not an object — skipped.`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== "string" || !TYPES.includes(type as DatabaseType)) {
    warnings.push(`Entry ${index + 1}: unknown database type "${String(type)}" — skipped.`);
    return null;
  }
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) {
    warnings.push(`Entry ${index + 1}: missing name — skipped.`);
    return null;
  }

  const out = { type: type as DatabaseType, name } as ExportedConnection;
  for (const f of STRING_FIELDS) {
    const v = r[f];
    if (f !== "name" && typeof v === "string" && v !== "") {
      out[f] = v;
    }
  }
  for (const f of NUMBER_FIELDS) {
    const v = r[f];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[f] = v;
    }
  }
  for (const f of BOOL_FIELDS) {
    if (typeof r[f] === "boolean") {
      out[f] = r[f] as boolean;
    }
  }
  for (const f of SECRET_FIELDS) {
    if (typeof r[f] === "string" && r[f] !== "") {
      out[f] = r[f] as string;
    }
  }
  if (typeof r.sshAuth === "string" && SSH_AUTH.includes(r.sshAuth)) {
    out.sshAuth = r.sshAuth as ExportedConnection["sshAuth"];
  }
  if (r.redactedCredentials === true) {
    out.redactedCredentials = true;
  }
  return out;
}

// -------------------------------------------------------------------- merge

/**
 * The server an entry actually points at, resolving a connection string when one
 * is used, so the same server saved two different ways compares equal.
 */
function resolveTarget(c: ExportedConnection): {
  host: string;
  port: number;
  database: string;
  username: string;
} {
  const fallbackPort = DEFAULT_PORTS[c.type];
  if (c.useConnectionString && c.connectionString) {
    try {
      const u = new URL(c.connectionString);
      return {
        host: (u.hostname || "").toLowerCase(),
        port: u.port ? Number(u.port) : fallbackPort,
        database: decodeURIComponent(u.pathname.replace(/^\//, "")),
        username: decodeURIComponent(u.username),
      };
    } catch {
      // Unparseable: compare the raw string instead of collapsing every broken
      // connection string into one identity.
      return { host: c.connectionString, port: 0, database: "", username: "" };
    }
  }
  return {
    host: (c.host ?? "").toLowerCase(),
    port: c.port ?? fallbackPort,
    database: c.database ?? "",
    username: c.username ?? "",
  };
}

/**
 * Identity used to recognise "I already have this connection". Deliberately
 * ignores the display name — the same server saved under two names is the same
 * server — and ignores SSL/SSH options, which are how you reach it, not which it is.
 */
export function identityKey(c: ExportedConnection): string {
  if (c.type === "sqlite") {
    return `sqlite|${(c.filePath ?? "").trim()}`;
  }
  const t = resolveTarget(c);
  const db = c.type === "redis" ? String(c.redisDb ?? 0) : t.database;
  return [c.type, t.host, t.port, db, t.username].join("|");
}

export interface MergeResult {
  merged: ConnectionConfig[];
  added: ConnectionConfig[];
  skipped: ExportedConnection[];
  secrets: Map<string, ConnectionSecrets>;
}

/**
 * Append imported connections to the existing list. Existing entries are never
 * modified, reordered, or removed — an import can only ever grow the list.
 * Returns the secrets keyed by the NEW id so the caller can put them in
 * SecretStorage rather than leaving them in globalState.
 */
export function mergeConnections(
  existing: ConnectionConfig[],
  incoming: ExportedConnection[],
  mkId: () => string,
): MergeResult {
  const seen = new Set(existing.map((c) => identityKey(c as ExportedConnection)));
  const names = new Set(existing.map((c) => c.name));
  const merged = [...existing];
  const added: ConnectionConfig[] = [];
  const skipped: ExportedConnection[] = [];
  const secrets = new Map<string, ConnectionSecrets>();

  for (const inc of incoming) {
    const key = identityKey(inc);
    if (seen.has(key)) {
      skipped.push(inc);
      continue;
    }
    seen.add(key);

    const { password, sshPassword, sshPassphrase, redactedCredentials: _rc, ...config } = inc;
    const id = mkId();
    const entry: ConnectionConfig = { ...config, id, name: uniqueName(inc.name, names) };
    names.add(entry.name);
    merged.push(entry);
    added.push(entry);
    if (password || sshPassword || sshPassphrase) {
      secrets.set(id, { password, sshPassword, sshPassphrase });
    }
  }
  return { merged, added, skipped, secrets };
}

/** Two different servers must stay tellable apart in the tree. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  let n = `${name} (imported)`;
  let i = 2;
  while (taken.has(n)) {
    n = `${name} (imported ${i++})`;
  }
  return n;
}

// ------------------------------------------------------------------- crypto

/** scrypt params. N=16384 keeps memory at 16 MB — under node's 32 MB default. */
const KDF = { name: "scrypt", N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 32;

export interface EncryptedBundle {
  kind: typeof ENCRYPTED_KIND;
  version: number;
  kdf: typeof KDF & { salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEYLEN, { N: KDF.N, r: KDF.r, p: KDF.p });
}

export function encryptBundle(plaintext: string, passphrase: string): EncryptedBundle {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    kind: ENCRYPTED_KIND,
    version: EXPORT_VERSION,
    kdf: { ...KDF, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/**
 * Open an encrypted bundle. GCM authentication means a wrong passphrase and a
 * tampered file are both hard failures rather than silent garbage — the two are
 * indistinguishable by design, so the message covers both.
 */
export function decryptBundle(text: string, passphrase: string): string {
  let b: Partial<EncryptedBundle>;
  try {
    b = JSON.parse(text) as Partial<EncryptedBundle>;
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  if (b?.kind !== ENCRYPTED_KIND) {
    throw new Error("Not an encrypted Open DB Client connections file.");
  }
  if (typeof b.version !== "number" || b.version > EXPORT_VERSION) {
    throw new Error("This encrypted file was written by a newer version of Open DB Client.");
  }
  if (b.cipher !== "aes-256-gcm" || b.kdf?.name !== "scrypt") {
    throw new Error("Unsupported encryption in this file.");
  }
  for (const f of ["salt"] as const) {
    if (typeof b.kdf[f] !== "string") {
      throw new Error("The encrypted file is missing its key-derivation parameters.");
    }
  }
  if (typeof b.iv !== "string" || typeof b.tag !== "string" || typeof b.data !== "string") {
    throw new Error("The encrypted file is incomplete.");
  }
  const kdf = b.kdf;
  const key = scryptSync(passphrase, Buffer.from(kdf.salt, "base64"), KEYLEN, {
    N: kdf.N ?? KDF.N,
    r: kdf.r ?? KDF.r,
    p: kdf.p ?? KDF.p,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "base64"));
  decipher.setAuthTag(Buffer.from(b.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(b.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Wrong passphrase, or the file has been modified.");
  }
}
