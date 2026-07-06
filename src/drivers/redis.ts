import Redis from "ioredis";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import { ColumnMeta, Driver, QueryResult, TreeItemData } from "./Driver";
import { buildTls } from "./ssl";

/** Redis driver backed by ioredis. Queries are raw command lines, e.g. "GET foo". */
export class RedisDriver implements Driver {
  private client?: Redis;

  constructor(public readonly config: ConnectionConfig) {}

  async connect(password?: string): Promise<void> {
    const tls = buildTls(this.config);
    const options = {
      lazyConnect: true,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 1,
      tls: tls
        ? { ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: tls.rejectUnauthorized }
        : undefined,
    };
    if (this.config.useConnectionString && this.config.connectionString) {
      this.client = new Redis(this.config.connectionString, options);
    } else {
      this.client = new Redis({
        host: this.config.host,
        port: this.config.port ?? DEFAULT_PORTS.redis,
        username: this.config.username || undefined,
        password: password || undefined,
        db: this.config.redisDb ?? 0,
        ...options,
      });
    }
    await this.client.connect();
    await this.client.ping();
  }

  async dispose(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
  }

  private get c(): Redis {
    if (!this.client) {
      throw new Error("Not connected");
    }
    return this.client;
  }

  async children(path: string[]): Promise<TreeItemData[]> {
    // Top level -> first 500 keys (SCAN, non-blocking).
    if (path.length === 0) {
      const keys = await this.scanKeys(500);
      return keys.map((k) => ({
        label: k,
        kind: "key" as const,
        expandable: false,
        path: [k],
      }));
    }
    return [];
  }

  private async scanKeys(limit: number): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.c.scan(cursor, "COUNT", 200);
      found.push(...batch);
      cursor = next;
    } while (cursor !== "0" && found.length < limit);
    return found.slice(0, limit);
  }

  async query(sql: string): Promise<QueryResult> {
    const parts = tokenize(sql.trim());
    if (parts.length === 0) {
      return { columns: [], rows: [], rowCount: 0, message: "Empty command" };
    }
    const [cmd, ...args] = parts;
    const raw = await this.c.call(cmd, ...args);
    return formatReply(raw);
  }

  async previewTable(path: string[]): Promise<QueryResult> {
    const key = path[0];
    const type = await this.c.type(key);
    return this.query(previewCommandFor(type, key));
  }

  // The following are table-oriented operations that don't apply to Redis.
  async countRows(): Promise<number> {
    return 0;
  }

  async foreignKeys(): Promise<[]> {
    return [];
  }

  async tableColumns(): Promise<ColumnMeta[]> {
    return [];
  }

  async getDDL(): Promise<string> {
    throw new Error("DDL is not applicable to Redis");
  }

  async updateCell(): Promise<void> {
    throw new Error("Inline editing is not supported for Redis keys");
  }

  async deleteRow(table: string[]): Promise<void> {
    // For Redis, "delete row" = delete the key.
    await this.c.del(table[0]);
  }

  async insertRow(): Promise<void> {
    throw new Error("Add row is not supported for Redis keys");
  }
}

function previewCommandFor(type: string, key: string): string {
  switch (type) {
    case "list":
      return `LRANGE ${key} 0 199`;
    case "set":
      return `SMEMBERS ${key}`;
    case "hash":
      return `HGETALL ${key}`;
    case "zset":
      return `ZRANGE ${key} 0 199 WITHSCORES`;
    default:
      return `GET ${key}`;
  }
}

/** Split a command line, honouring double quotes. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/** Coerce any Redis reply shape into the grid format. */
function formatReply(raw: unknown): QueryResult {
  if (raw === null || raw === undefined) {
    return { columns: ["value"], rows: [], rowCount: 0, message: "(nil)" };
  }
  if (Array.isArray(raw)) {
    const rows = raw.map((v, i) => ({ index: i, value: stringify(v) }));
    return { columns: ["index", "value"], rows, rowCount: rows.length };
  }
  return {
    columns: ["value"],
    rows: [{ value: stringify(raw) }],
    rowCount: 1,
  };
}

function stringify(v: unknown): string {
  if (Buffer.isBuffer(v)) {
    return v.toString();
  }
  if (typeof v === "object") {
    return JSON.stringify(v);
  }
  return String(v);
}
