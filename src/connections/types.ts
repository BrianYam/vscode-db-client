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

export const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
  redis: 6379,
};
