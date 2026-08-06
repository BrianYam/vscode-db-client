import type * as vscode from "vscode";
import type { AiVerb } from "./prompts";

export const USAGE_KEY = "openDbClient.aiUsage";
export const PRICES_KEY = "openDbClient.aiPrices";

/** One provider call, recorded with the exact counts the response reported. */
export interface UsageEntry {
  ts: number;
  providerId: string;
  model: string;
  verb: AiVerb | "test";
  inputTokens: number;
  outputTokens: number;
}

export interface UsageState {
  entries: UsageEntry[];
  /** Entries discarded by the cap — surfaced in the view, never silent. */
  dropped: number;
  /** Start of the current period ("reset period" moves this forward). */
  periodStart: number;
  /**
   * Running totals per provider/model/verb. Survive the entry cap, so
   * "all time" stays truthful even after old entries are discarded.
   */
  totals: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
}

/** USD per million tokens. User-editable in settings; these only seed it. */
export interface ModelPrice {
  input: number;
  output: number;
}

export const SEED_PRICES: Record<string, ModelPrice> = {
  "claude-opus": { input: 15, output: 75 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-haiku": { input: 1, output: 5 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

/** Cap keeps globalState bounded; totals above preserve the long-run truth. */
export const USAGE_CAP = 5000;

export function emptyUsageState(now: number): UsageState {
  return { entries: [], dropped: 0, periodStart: now, totals: {} };
}

/** NUL cannot appear in provider/model/verb strings — a collision-free separator. */
const SEP = "\u0000";

export function totalsKey(e: { providerId: string; model: string; verb: string }): string {
  return [e.providerId, e.model, e.verb].join(SEP);
}

/** Pure append-with-cap so the ledger arithmetic is unit-testable. */
export function applyRecord(state: UsageState, entry: UsageEntry, cap = USAGE_CAP): UsageState {
  const entries = [...state.entries, entry];
  const overflow = Math.max(0, entries.length - cap);
  const key = totalsKey(entry);
  const prev = state.totals[key] ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
  return {
    entries: entries.slice(overflow),
    dropped: state.dropped + overflow,
    periodStart: state.periodStart,
    totals: {
      ...state.totals,
      [key]: {
        inputTokens: prev.inputTokens + entry.inputTokens,
        outputTokens: prev.outputTokens + entry.outputTokens,
        requests: prev.requests + 1,
      },
    },
  };
}

/**
 * Longest matching price key wins, so "claude-sonnet-4-5" finds "claude-sonnet"
 * without a per-version table. Returns undefined for unknown models — the view
 * shows "—" rather than a fake $0 (estimates must not pretend to be exact).
 */
export function matchPrice(
  model: string,
  prices: Record<string, ModelPrice>,
): ModelPrice | undefined {
  const m = model.toLowerCase();
  let best: string | undefined;
  for (const key of Object.keys(prices)) {
    if (m.includes(key.toLowerCase()) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best ? prices[best] : undefined;
}

/** USD estimate for token counts, or undefined when the model has no price. */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice | undefined,
): number | undefined {
  if (!price) {
    return undefined;
  }
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export interface UsageRow {
  providerId: string;
  model: string;
  verb: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** Aggregate rows for the view — from capped entries (period) or totals (all time). */
export function summarizePeriod(state: UsageState, prices: Record<string, ModelPrice>): UsageRow[] {
  const acc: Record<string, UsageRow> = {};
  for (const e of state.entries) {
    if (e.ts < state.periodStart) {
      continue;
    }
    const key = totalsKey(e);
    acc[key] ??= {
      providerId: e.providerId,
      model: e.model,
      verb: e.verb,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const row = acc[key];
    row.requests += 1;
    row.inputTokens += e.inputTokens;
    row.outputTokens += e.outputTokens;
  }
  return priceRows(Object.values(acc), prices);
}

export function summarizeAllTime(
  state: UsageState,
  prices: Record<string, ModelPrice>,
): UsageRow[] {
  const rows = Object.entries(state.totals).map(([key, t]) => {
    const [providerId, model, verb] = key.split(SEP);
    return { providerId, model, verb, ...t };
  });
  return priceRows(rows, prices);
}

function priceRows(rows: UsageRow[], prices: Record<string, ModelPrice>): UsageRow[] {
  for (const r of rows) {
    r.costUsd = estimateCost(r.inputTokens, r.outputTokens, matchPrice(r.model, prices));
  }
  return rows.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

/** GlobalState wrapper around the pure ledger above. */
export class UsageStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  state(): UsageState {
    return this.ctx.globalState.get<UsageState>(USAGE_KEY) ?? emptyUsageState(Date.now());
  }

  async record(entry: UsageEntry): Promise<void> {
    await this.ctx.globalState.update(USAGE_KEY, applyRecord(this.state(), entry));
  }

  /** "Reset period" — all-time totals are deliberately untouched. */
  async resetPeriod(): Promise<void> {
    await this.ctx.globalState.update(USAGE_KEY, { ...this.state(), periodStart: Date.now() });
  }

  prices(): Record<string, ModelPrice> {
    return this.ctx.globalState.get<Record<string, ModelPrice>>(PRICES_KEY) ?? { ...SEED_PRICES };
  }

  async savePrices(prices: Record<string, ModelPrice>): Promise<void> {
    await this.ctx.globalState.update(PRICES_KEY, prices);
  }

  async deleteAll(): Promise<void> {
    await this.ctx.globalState.update(USAGE_KEY, undefined);
    await this.ctx.globalState.update(PRICES_KEY, undefined);
  }
}
