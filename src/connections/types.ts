export type DatabaseType = "postgres" | "mysql" | "sqlite" | "redis";

/**
 * A saved connection. Secrets (password) are NOT stored here — they live in
 * VS Code SecretStorage keyed by `id`. Everything else is safe to persist in
 * globalState. There is deliberately no cap on how many of these can exist.
 */
export interface ConnectionConfig {
  id: string;
  /** Config schema version; absent = legacy (pre-versioning) record. */
  schemaVersion?: number;
  type: DatabaseType;
  name: string;
  /**
   * Free-text notes about this connection (what it is for, what not to run
   * against it). Optional and capped at NOTES_MAX_CHARS.
   *
   * Unlike `password` / `sshPassword` / `sshPassphrase`, this is **not** a
   * secret field: it lives in globalState in the clear and it travels in export
   * files — including exports taken with secrets omitted, which cannot redact
   * free text. The connection form says so at the point of entry; do not treat
   * this as a place credentials may be kept.
   */
  notes?: string;
  // SQL / Redis network fields
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  // SQLite only
  filePath?: string;
  // Redis only
  redisDb?: number;
  // SQL / Redis: enable TLS/SSL
  ssl?: boolean;
  /** Skip certificate verification (accept self-signed). Default off = verify. */
  allowInvalidCert?: boolean;
  // Optional SSL certificate file paths
  sslCA?: string;
  sslCert?: string;
  sslKey?: string;
  // Connect via a raw connection string instead of individual fields
  useConnectionString?: boolean;
  connectionString?: string;
  // SSH tunnel (secrets — sshPassword / sshPassphrase — live in SecretStorage)
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  sshAuth?: SshAuth;
  sshPrivateKeyPath?: string;
  sshConnectTimeout?: number;
}

export type SshAuth = "auto" | "password" | "key" | "agent";

/**
 * Cap on `ConnectionConfig.notes`. globalState is a synced key-value store, not
 * a document store — and the note is rendered into a hover tooltip, where a
 * pasted runbook helps nobody. Enforced where the form builds a config, and
 * surfaced by a live counter rather than truncating behind the user's back.
 */
export const NOTES_MAX_CHARS = 2000;

export const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
  redis: 6379,
};
