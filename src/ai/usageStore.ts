import type * as vscode from "vscode";
import type { PriceRow } from "./priceTable";
import type { AiVerb } from "./prompts";

export const USAGE_KEY = "openDbClient.aiUsage";
/** Legacy hand-edited table — purged on delete, no longer written. */
export const PRICES_KEY = "openDbClient.aiPrices";
/** API-sourced price rows (see priceTable.ts). */
export const PRICE_TABLE_KEY = "openDbClient.aiPriceTable";

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

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

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
/** Resolves a call's price; undefined means "no estimate" (shown as —). */
export type PriceLookup = (providerId: string, model: string) => ModelPrice | undefined;

export function summarizePeriod(state: UsageState, lookup: PriceLookup): UsageRow[] {
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
  return priceRows(Object.values(acc), lookup);
}

export function summarizeAllTime(state: UsageState, lookup: PriceLookup): UsageRow[] {
  const rows = Object.entries(state.totals).map(([key, t]) => {
    const [providerId, model, verb] = key.split(SEP);
    return { providerId, model, verb, ...t };
  });
  return priceRows(rows, lookup);
}

function priceRows(rows: UsageRow[], lookup: PriceLookup): UsageRow[] {
  for (const r of rows) {
    r.costUsd = estimateCost(r.inputTokens, r.outputTokens, lookup(r.providerId, r.model));
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

  /** Stored API-sourced price rows (built-in fallback rows are composed by callers). */
  apiPriceRows(): PriceRow[] {
    return this.ctx.globalState.get<PriceRow[]>(PRICE_TABLE_KEY) ?? [];
  }

  async savePriceRows(rows: PriceRow[]): Promise<void> {
    await this.ctx.globalState.update(PRICE_TABLE_KEY, rows);
  }

  async deleteAll(): Promise<void> {
    await this.ctx.globalState.update(USAGE_KEY, undefined);
    await this.ctx.globalState.update(PRICES_KEY, undefined);
    await this.ctx.globalState.update(PRICE_TABLE_KEY, undefined);
  }
}
