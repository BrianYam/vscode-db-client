import Redis from "ioredis";
import { ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import { Driver, QueryResult, TreeItemData } from "./Driver";

/** Redis driver backed by ioredis. Queries are raw command lines, e.g. "GET foo". */
export class RedisDriver implements Driver {
  private client?: Redis;

  constructor(public readonly config: ConnectionConfig) {}

  async connect(password?: string): Promise<void> {
    this.client = new Redis({
      host: this.config.host,
      port: this.config.port ?? DEFAULT_PORTS.redis,
      username: this.config.username || undefined,
      password: password || undefined,
      db: this.config.redisDb ?? 0,
      lazyConnect: true,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 1,
    });
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
