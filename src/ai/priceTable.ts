import type { AiModelInfo } from "./AiProvider";

/**
 * API-sourced price table (Discovery: docs/DISCOVERY_PRICE_TABLE.md).
 *
 * No price in this extension is hardcoded. Every row records where its
 * numbers came from:
 *  - `api`      — the provider's own model list (OpenRouter-style endpoints
 *                 publish real prices; OpenAI and Anthropic do not).
 *  - `litellm`  — the LiteLLM community price list, an auto-updated JSON the
 *                 LiteLLM project maintains on GitHub. It's the only
 *                 machine-readable source for providers whose APIs publish
 *                 no pricing; rows are labeled so nobody mistakes it for the
 *                 provider's word.
 */
export interface PriceRow {
  providerId: string;
  model: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  source: "api" | "litellm";
  /** Last successful fetch. */
  fetchedAt?: number;
}

export type PriceStatus = "up to date" | "stale";

/** D2: a fetched price older than this is shown as stale. */
export const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function rowStatus(row: PriceRow, now: number): PriceStatus {
  return row.fetchedAt !== undefined && now - row.fetchedAt < STALE_MS ? "up to date" : "stale";
}

/**
 * Price lookup for one call. Precedence: exact (provider, model) row →
 * longest same-provider substring (server-reported ids can be more versioned
 * than the listed one). Undefined when nothing matches — callers show
 * "—"/omit, never a fake $0.
 */
export function findPrice(
  providerId: string,
  model: string,
  rows: PriceRow[],
): PriceRow | undefined {
  const m = model.toLowerCase();
  const mine = rows.filter((r) => r.providerId === providerId);
  const exact = mine.find((r) => r.model.toLowerCase() === m);
  if (exact) {
    return exact;
  }
  let best: PriceRow | undefined;
  for (const r of mine) {
    const key = r.model.toLowerCase();
    if (m.includes(key) && (!best || key.length > best.model.length)) {
      best = r;
    }
  }
  return best;
}

/** $/MTok price pairs by lowercased model id. */
export type PriceMap = Map<string, { input: number; output: number }>;

export interface MergeResult {
  rows: PriceRow[];
  /** Models the source no longer prices — removed, reported by the caller. */
  removed: string[];
}

/**
 * Fold one provider's freshly fetched model list into its `api` rows.
 * Rows of other providers/sources pass through. A row survives only if the
 * provider still lists the model WITH a price (req 8: "not available" rows
 * are removed, never silently).
 */
export function mergeFetched(
  rows: PriceRow[],
  providerId: string,
  models: AiModelInfo[],
  now: number,
): MergeResult {
  const priced: PriceMap = new Map();
  for (const mo of models) {
    if (!mo.est && mo.inputPerMTok != null && mo.outputPerMTok != null) {
      priced.set(mo.id.toLowerCase(), { input: mo.inputPerMTok, output: mo.outputPerMTok });
    }
  }
  return mergeMap(rows, "api", providerId, priced, now);
}

/** Same fold, for a provider's `litellm` rows against a fetched PriceMap. */
export function mergeLitellm(
  rows: PriceRow[],
  providerId: string,
  prices: PriceMap,
  now: number,
): MergeResult {
  return mergeMap(rows, "litellm", providerId, prices, now);
}

function mergeMap(
  rows: PriceRow[],
  source: PriceRow["source"],
  providerId: string,
  priced: PriceMap,
  now: number,
): MergeResult {
  const removed: string[] = [];
  const next: PriceRow[] = [];
  for (const r of rows) {
    if (r.source !== source || r.providerId !== providerId) {
      next.push(r);
      continue;
    }
    const p = priced.get(r.model.toLowerCase());
    if (!p) {
      removed.push(r.model);
      continue;
    }
    next.push({ ...r, input: p.input, output: p.output, fetchedAt: now });
  }
  return { rows: next, removed };
}
