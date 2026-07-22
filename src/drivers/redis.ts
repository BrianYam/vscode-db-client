import Redis from "ioredis";
import { type ConnectionConfig, DEFAULT_PORTS } from "../connections/types";
import type { ColumnMeta, Driver, QueryResult, TreeItemData } from "./Driver";
import { buildTls } from "./ssl";

/** Max keys listed under one db node before the list is marked truncated. */
const KEY_LIMIT = 500;

/** Path segment identifying the synthetic "active filter" tree node. */
export const KEY_FILTER_NODE = "@keyfilter";

/** Max elements shown when previewing a list/zset. */
const PREVIEW_LIMIT = 200;

/**
 * The column that addresses a single element, per key type. A type listed here
 * is editable in the grid; anything else is read-only.
 */
const PK_COLUMN: Record<string, string | undefined> = {
  string: "value",
  list: "index",
  hash: "field",
  set: "member",
  zset: "member",
};

function requireColumn(column: string, editable: string, type: string): void {
  if (column !== editable) {
    throw new Error(`Only the "${editable}" column is editable on a ${type} key`);
  }
}

/** The list position a grid row addresses. */
function listIndex(pkValues: Record<string, unknown>): number {
  const idx = Number(pkValues.index);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error("Could not locate this list element — refresh and try again");
  }
  return idx;
}

/**
 * Turn a user's search term into a Redis glob. A term that already contains
 * glob syntax is passed through untouched; anything else becomes a substring
 * match, which is what a search box is expected to do.
 */
export function scanPattern(filter?: string): string | undefined {
  const term = filter?.trim();
  if (!term) {
    return undefined;
  }
  return /[*?[\]]/.test(term) ? term : `*${term}*`;
}

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

  async children(path: string[], filter?: string): Promise<TreeItemData[]> {
    // Top level -> numbered databases (db0..dbN). Deeper -> keys in that db.
    if (path.length === 0) {
      return this.databaseNodes();
    }
    if (path.length === 1) {
      const db = Number(path[0]);
      const pattern = scanPattern(filter);
      const { keys, truncated } = await this.scanKeys(db, KEY_LIMIT, pattern);
      // SCAN returns keys in arbitrary (bucket) order — sort so the list reads.
      keys.sort();
      // One pipelined PTTL round-trip for the whole (already-capped) list, so
      // volatile keys can show their remaining life without N extra calls.
      const ttls = await this.keyTtls(keys);
      const nodes: TreeItemData[] = keys.map((k, i) => {
        const ms = ttls[i];
        // Only annotate keys that actually expire — a "no expiry" on every key
        // is noise; a bare description draws the eye to the volatile ones.
        const ttl = ms > 0 ? formatTtl(ms) : undefined;
        return {
          label: k,
          kind: "key" as const,
          expandable: false,
          path: [path[0], k],
          description: ttl,
          tooltip: ttl ? `Expires in ${ttl}` : undefined,
        };
      });
      if (pattern) {
        // Pinned first child: shows the live filter and doubles as "clear".
        nodes.unshift({
          label: `Filter: ${filter}`,
          description: `${keys.length}${truncated ? "+" : ""} ${
            keys.length === 1 ? "match" : "matches"
          }`,
          kind: "info",
          icon: "filter",
          expandable: false,
          path: [path[0], KEY_FILTER_NODE],
          tooltip: `Matching ${pattern} — click to clear the filter`,
        });
      } else if (truncated) {
        // Never silently cut the list off: say so, and point at the fix.
        nodes.unshift({
          label: `Showing first ${KEY_LIMIT} keys`,
          description: "search to narrow",
          kind: "info",
          icon: "info",
          expandable: false,
          path: [path[0], "@keytruncated"],
          tooltip: `This database has more than ${KEY_LIMIT} keys. Use Search Keys to filter them server-side.`,
        });
      }
      return nodes;
    }
    return [];
  }

  private async databaseNodes(): Promise<TreeItemData[]> {
    // How many DBs the server exposes (default 16 if CONFIG is disabled).
    let count = 16;
    try {
      const cfg = (await this.c.call("CONFIG", "GET", "databases")) as string[];
      count = Number(cfg?.[1]) || 16;
    } catch {
      /* CONFIG may be restricted on managed Redis; fall back to 16 */
    }
    // Key counts per db from INFO keyspace (only non-empty dbs are listed).
    const counts: Record<string, string> = {};
    try {
      const info = String(await this.c.info("keyspace"));
      for (const line of info.split("\n")) {
        const m = /^db(\d+):keys=(\d+)/.exec(line.trim());
        if (m) {
          counts[m[1]] = m[2];
        }
      }
    } catch {
      /* ignore */
    }
    const current = this.config.redisDb ?? 0;
    const nodes: TreeItemData[] = [];
    for (let i = 0; i < count; i++) {
      const keyCount = counts[i];
      // Show dbs that have keys, plus the configured one (so it's always visible).
      if (keyCount || i === current) {
        nodes.push({
          label: `db${i}`,
          kind: "database",
          expandable: true,
          path: [String(i)],
          description: keyCount ? `${keyCount} keys` : "empty",
        });
      }
    }
    return nodes;
  }

  /**
   * SCAN the keyspace, optionally narrowing server-side with MATCH. A filtered
   * scan may walk many buckets before it fills `limit`, so it gets a larger
   * round-trip budget; `truncated` reports whether we stopped early.
   */
  private async scanKeys(
    db: number,
    limit: number,
    pattern?: string,
  ): Promise<{ keys: string[]; truncated: boolean }> {
    await this.c.select(db);
    const maxRoundTrips = pattern ? 200 : 20;
    const found: string[] = [];
    let cursor = "0";
    let trips = 0;
    do {
      const [next, batch] = pattern
        ? await this.c.scan(cursor, "MATCH", pattern, "COUNT", 500)
        : await this.c.scan(cursor, "COUNT", 500);
      found.push(...batch);
      cursor = next;
      trips++;
    } while (cursor !== "0" && found.length < limit && trips < maxRoundTrips);
    return { keys: found.slice(0, limit), truncated: found.length > limit || cursor !== "0" };
  }

  /**
   * Remaining TTL (ms) for each key, in one pipelined round-trip. Assumes the
   * right db is already selected (the caller SCANned it). A failed reply for a
   * key degrades to `-1` (treated as "no expiry") rather than breaking the list.
   */
  private async keyTtls(keys: string[]): Promise<number[]> {
    if (keys.length === 0) {
      return [];
    }
    const pipe = this.c.pipeline();
    for (const k of keys) {
      pipe.pttl(k);
    }
    const replies = await pipe.exec();
    return keys.map((_, i) => {
      const [err, value] = replies?.[i] ?? [];
      return err ? -1 : Number(value);
    });
  }

  async query(sql: string, database?: string): Promise<QueryResult> {
    const parts = tokenize(sql.trim());
    if (parts.length === 0) {
      return { columns: [], rows: [], rowCount: 0, message: "Empty command" };
    }
    if (database !== undefined) {
      await this.c.select(Number(database));
    }
    const [cmd, ...args] = parts;
    const raw = await this.c.call(cmd, ...args);
    return formatReply(raw);
  }

  async previewTable(path: string[]): Promise<QueryResult> {
    // path is [dbIndex, key]
    const db = Number(path[0]);
    const key = path[1];
    await this.c.select(db);
    const type = await this.c.type(key);
    const result = await this.readValue(type, key);
    result.sql = previewCommandFor(type, key);
    // Surface the remaining TTL so the grid can show/edit it (-1 = no expiry).
    result.ttl = await this.c.pttl(key);
    // Editable shapes get a pk column so the grid can address one element.
    const pk = PK_COLUMN[type];
    if (pk) {
      result.editable = { table: [path[0], key], pkColumns: [pk] };
    }
    return result;
  }

  /**
   * Read a key into a grid shape whose columns can be addressed for editing:
   * list → index/value, hash → field/value, zset → member/score, set → member,
   * string → value. Anything else falls back to the raw reply.
   */
  private async readValue(type: string, key: string): Promise<QueryResult> {
    switch (type) {
      case "list": {
        const items = await this.c.lrange(key, 0, PREVIEW_LIMIT - 1);
        const rows = items.map((value, index) => ({ index, value }));
        return { columns: ["index", "value"], rows, rowCount: rows.length };
      }
      case "hash": {
        const map = await this.c.hgetall(key);
        const rows = Object.entries(map).map(([field, value]) => ({ field, value }));
        return { columns: ["field", "value"], rows, rowCount: rows.length };
      }
      case "set": {
        const members = await this.c.smembers(key);
        const rows = members.map((member) => ({ member }));
        return { columns: ["member"], rows, rowCount: rows.length };
      }
      case "zset": {
        const flat = await this.c.zrange(key, 0, PREVIEW_LIMIT - 1, "WITHSCORES");
        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < flat.length; i += 2) {
          rows.push({ member: flat[i], score: flat[i + 1] });
        }
        return { columns: ["member", "score"], rows, rowCount: rows.length };
      }
      case "string": {
        const value = await this.c.get(key);
        return {
          columns: ["value"],
          rows: value === null ? [] : [{ value }],
          rowCount: value === null ? 0 : 1,
        };
      }
      default:
        return this.query(previewCommandFor(type, key));
    }
  }

  // The following are table-oriented operations that don't apply to Redis.
  async countRows(): Promise<number> {
    return 0;
  }

  async foreignKeys(): Promise<[]> {
    return [];
  }

  async schemaHints(): Promise<{ tables: string[]; columns: string[] }> {
    return { tables: [], columns: [] };
  }

  async tableColumns(): Promise<ColumnMeta[]> {
    return [];
  }

  async getDDL(): Promise<string> {
    throw new Error("DDL is not applicable to Redis");
  }

  /**
   * Edit one element of a key in place. `table` is [dbIndex, key]; `pkValues`
   * addresses the element (list index, hash field, set/zset member).
   */
  async updateCell(
    table: string[],
    pkValues: Record<string, unknown>,
    column: string,
    value: unknown,
  ): Promise<void> {
    const key = table[1];
    await this.c.select(Number(table[0]));
    const type = await this.c.type(key);
    const next = value === null || value === undefined ? "" : String(value);

    switch (type) {
      case "string": {
        requireColumn(column, "value", type);
        // SET clears any expiry, so carry the remaining TTL across explicitly
        // (works on every server version, unlike SET … KEEPTTL).
        const pttl = await this.c.pttl(key);
        await this.c.set(key, next);
        if (pttl > 0) {
          await this.c.pexpire(key, pttl);
        }
        return;
      }
      case "list": {
        requireColumn(column, "value", type);
        await this.c.lset(key, listIndex(pkValues), next);
        return;
      }
      case "hash": {
        const field = String(pkValues.field);
        if (column === "value") {
          await this.c.hset(key, field, next);
        } else if (column === "field") {
          // Rename the field, keeping its value.
          if (next === field) {
            return;
          }
          const current = await this.c.hget(key, field);
          await this.c.hset(key, next, current ?? "");
          await this.c.hdel(key, field);
        } else {
          requireColumn(column, "value", type);
        }
        return;
      }
      case "set": {
        requireColumn(column, "member", type);
        const old = String(pkValues.member);
        if (old === next) {
          return;
        }
        // A set has no in-place edit: add the new member, drop the old one.
        await this.c.sadd(key, next);
        await this.c.srem(key, old);
        return;
      }
      case "zset": {
        const member = String(pkValues.member);
        if (column === "score") {
          const score = Number(next);
          if (!Number.isFinite(score)) {
            throw new Error(`"${next}" is not a valid score — enter a number`);
          }
          await this.c.zadd(key, score, member);
        } else if (column === "member") {
          if (next === member) {
            return;
          }
          const score = await this.c.zscore(key, member);
          await this.c.zadd(key, Number(score ?? 0), next);
          await this.c.zrem(key, member);
        } else {
          requireColumn(column, "score", type);
        }
        return;
      }
      default:
        throw new Error(`Editing a "${type}" key is not supported`);
    }
  }

  /**
   * Delete one element of a key — or, when `pkValues` is empty, the whole key.
   * The tree's "Delete Key" command passes no pk values; the results grid
   * always passes the element's pk, so a grid delete never drops the key.
   */
  async deleteRow(table: string[], pkValues?: Record<string, unknown>): Promise<void> {
    const key = table[1];
    await this.c.select(Number(table[0]));
    if (!pkValues || Object.keys(pkValues).length === 0) {
      await this.c.del(key);
      return;
    }
    const type = await this.c.type(key);
    switch (type) {
      case "list": {
        // Redis cannot delete by index: tombstone the slot, then remove it.
        const tombstone = `__odbc_deleted__${Date.now()}`;
        await this.c.lset(key, listIndex(pkValues), tombstone);
        await this.c.lrem(key, 1, tombstone);
        return;
      }
      case "hash":
        await this.c.hdel(key, String(pkValues.field));
        return;
      case "set":
        await this.c.srem(key, String(pkValues.member));
        return;
      case "zset":
        await this.c.zrem(key, String(pkValues.member));
        return;
      default:
        // A string holds a single value: deleting it means deleting the key.
        await this.c.del(key);
    }
  }

  /**
   * Set or clear a key's expiry. `table` is [dbIndex, key]; `ms` is the new TTL
   * in milliseconds, or `null` to make the key permanent (`PERSIST`).
   */
  async setTtl(table: string[], ms: number | null): Promise<void> {
    const key = table[1];
    await this.c.select(Number(table[0]));
    if ((await this.c.exists(key)) === 0) {
      throw new Error(`Key "${key}" no longer exists`);
    }
    if (ms === null) {
      await this.c.persist(key);
      return;
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error("TTL must be a positive number of seconds");
    }
    await this.c.pexpire(key, Math.round(ms));
  }

  /** Append an element to a collection key. `values` comes from the grid's
   *  Add-Row form, keyed by column name. */
  async insertRow(table: string[], values: Record<string, unknown>): Promise<void> {
    const key = table[1];
    await this.c.select(Number(table[0]));
    const type = await this.c.type(key);
    const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    switch (type) {
      case "list":
        // Lists are ordered by position, so a new element is appended.
        await this.c.rpush(key, str(values.value));
        return;
      case "hash": {
        const field = str(values.field);
        if (!field) {
          throw new Error("A hash entry needs a field name");
        }
        await this.c.hset(key, field, str(values.value));
        return;
      }
      case "set":
        await this.c.sadd(key, str(values.member));
        return;
      case "zset": {
        const score = Number(str(values.score) || 0);
        if (!Number.isFinite(score)) {
          throw new Error(`"${values.score}" is not a valid score — enter a number`);
        }
        await this.c.zadd(key, score, str(values.member));
        return;
      }
      default:
        throw new Error(
          `A "${type}" key holds a single value — edit it in place instead of adding a row`,
        );
    }
  }
}

/**
 * Human-readable remaining TTL from milliseconds, e.g. 45000 → "45s",
 * 3_723_000 → "1h 2m". Shows at most the two most-significant units.
 */
export function formatTtl(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [
    ["d", d],
    ["h", h],
    ["m", m],
    ["s", s],
  ] as const;
  const first = parts.findIndex(([, v]) => v > 0);
  return parts
    .slice(first, first + 2)
    .filter(([, v]) => v > 0)
    .map(([u, v]) => `${v}${u}`)
    .join(" ");
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
  let m = re.exec(line);
  while (m !== null) {
    out.push(m[1] ?? m[2]);
    m = re.exec(line);
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
