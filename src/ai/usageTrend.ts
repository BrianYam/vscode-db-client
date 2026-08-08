import { estimateCost, type PriceLookup, type UsageState } from "./usageStore";

/**
 * Daily usage buckets for the settings trend chart. Pure and host-side: the
 * webview receives a few KB of aggregates, never the raw (≤5 000) entries.
 * Days are bucketed in UTC so the arithmetic is deterministic and testable;
 * at day granularity the off-by-timezone risk is cosmetic only.
 */
export interface TrendSeries {
  key: string;
  /** input+output tokens per day, aligned with UsageTrend.days. */
  tokens: number[];
  /** Estimated USD per day — only entries the price table covers. */
  cost: number[];
  /** Calls whose model has no price row — their cost is NOT in `cost`. */
  unpriced: number;
}

export interface UsageTrend {
  /** UTC YYYY-MM-DD, oldest → newest, contiguous. */
  days: string[];
  /** Largest first; everything past the top slots is folded into "other". */
  series: TrendSeries[];
  /** Entries inside the window (the honesty line reports this). */
  charted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Legibility cap: stacked bars stop reading past a handful of colors. */
const MAX_SERIES = 6;

export function usageTrend(
  state: UsageState,
  lookup: PriceLookup,
  groupBy: "provider" | "model",
  now: number,
  days = 30,
): UsageTrend {
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const fromStart = todayStart - (days - 1) * DAY_MS;
  const dayLabels: string[] = [];
  for (let i = 0; i < days; i++) {
    dayLabels.push(new Date(fromStart + i * DAY_MS).toISOString().slice(0, 10));
  }

  const acc = new Map<string, TrendSeries>();
  let charted = 0;
  for (const e of state.entries) {
    if (e.ts < fromStart || e.ts >= todayStart + DAY_MS) {
      continue;
    }
    const idx = Math.floor((e.ts - fromStart) / DAY_MS);
    const key = groupBy === "provider" ? e.providerId : e.model;
    let s = acc.get(key);
    if (!s) {
      s = { key, tokens: new Array(days).fill(0), cost: new Array(days).fill(0), unpriced: 0 };
      acc.set(key, s);
    }
    s.tokens[idx] += e.inputTokens + e.outputTokens;
    const c = estimateCost(e.inputTokens, e.outputTokens, lookup(e.providerId, e.model));
    if (c === undefined) {
      s.unpriced += 1;
    } else {
      s.cost[idx] += c;
    }
    charted += 1;
  }

  const sorted = [...acc.values()].sort(
    (a, b) => b.tokens.reduce((x, y) => x + y, 0) - a.tokens.reduce((x, y) => x + y, 0),
  );
  if (sorted.length > MAX_SERIES) {
    const other: TrendSeries = {
      key: "other",
      tokens: new Array(days).fill(0),
      cost: new Array(days).fill(0),
      unpriced: 0,
    };
    for (const s of sorted.splice(MAX_SERIES - 1)) {
      for (let i = 0; i < days; i++) {
        other.tokens[i] += s.tokens[i];
        other.cost[i] += s.cost[i];
      }
      other.unpriced += s.unpriced;
    }
    sorted.push(other);
  }
  return { days: dayLabels, series: sorted, charted };
}
