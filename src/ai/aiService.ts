import * as vscode from "vscode";
import type { Driver, ForeignKey } from "../drivers/Driver";
import { AiError, type AiModelInfo, hostOf, isLocalBaseUrl } from "./AiProvider";
import type { AiStore } from "./aiStore";
import {
  buildSchemaContext,
  extractSql,
  isDestructive,
  isMutation,
  referencedTables,
  schemaInputFromHints,
} from "./context";
import {
  LITELLM_PRICES_URL,
  type LitellmEntry,
  type LitellmTable,
  lookupLitellm,
  parseLitellmTable,
} from "./litellmTable";
import { findPrice, mergeFetched, mergeLitellm, type PriceMap, type PriceRow } from "./priceTable";
import {
  type AiExchange,
  type AiVerb,
  explainUserPrompt,
  fixUserPrompt,
  generateUserPrompt,
  systemPrompt,
} from "./prompts";
import { createAiProvider, presetById } from "./registry";
import { estimateCost, type UsageStore, usedModels } from "./usageStore";

/** Keep prompts well under any provider's context floor; schema is the bulk. */
const SCHEMA_TOKEN_BUDGET = 6000;
/** FK lookups are one query per table — bound the best-effort enrichment. */
const MAX_FK_LOOKUPS = 20;

export interface AiVerbRequest {
  verb: AiVerb;
  connId: string;
  connType: string;
  database?: string;
  /** Generate: the natural-language intent. */
  prompt?: string;
  /** Explain/Fix: the SQL in question. Generate: the editor's current query,
   *  so follow-up requests edit it instead of starting over. */
  sql?: string;
  /** Fix: the database error message. */
  error?: string;
  /** Generate: earlier exchanges in this panel, oldest first (bounded). */
  history?: AiExchange[];
}

export interface AiVerbResult {
  /** Generate/Fix: the statement to insert. Explain: empty. */
  sql: string;
  /** Prose for the assist bar (explanation line, or the whole Explain answer). */
  text: string;
  /** Schema didn't fit the budget and was cut to N tables — the UI must say so. */
  trimmedTo?: number;
  /** Reason string when the generated SQL matches a destructive shape. */
  destructive?: string;
  /** Write verb (INSERT/UPDATE/…) when the SQL mutates — engages the query lock. */
  mutation?: string;
  /** Wall-clock provider round-trip, for the "answered in Xs" line. */
  ms: number;
  /** input + output token total, so the cost of the call is visible in place. */
  tokens: number;
  /** USD estimate from the local price table — absent when the model has no price. */
  costUsd?: number;
  /** Which preset answered (providerId) — shown with the result. */
  provider: string;
  /** Model as the server reported it, which may differ from the one requested. */
  model: string;
}

/** One row of the settings model dropdown: the price shown next to a model. */
export interface PriceCandidate {
  id: string;
  /** USD per MTok. Both absent when no source prices this model — shown "—". */
  input?: number;
  output?: number;
  source?: PriceRow["source"];
}

/**
 * Host-side orchestration for the assist verbs: consent → schema context →
 * provider call → usage ledger. Lives outside queryPanel.ts so the panel only
 * does message plumbing, per the house webview pattern.
 */
export class AiService {
  constructor(
    private readonly store: AiStore,
    private readonly usage: UsageStore,
  ) {}

  isConfigured(): Promise<boolean> {
    return this.store.isConfigured();
  }

  enabledFor(connId: string): boolean {
    return this.store.aiEnabledFor(connId);
  }

  /**
   * First-use consent, revocable in settings. Local endpoints (Ollama) skip
   * the gate — nothing leaves the machine.
   */
  private async ensureConsent(): Promise<boolean> {
    const s = this.store.get();
    if (s.consentGiven || isLocalBaseUrl(s.baseUrl)) {
      return true;
    }
    const host = hostOf(s.baseUrl);
    const pick = await vscode.window.showInformationMessage(
      `Send schema names to ${host}?`,
      {
        modal: true,
        detail:
          `AI assistance sends your typed request, the SQL in the query editor, ` +
          `and table/column names, data types, and foreign-key relations for the ` +
          `connected database to ${host}. ` +
          `It never sends row data, query results, passwords, or connection hosts. ` +
          `You can revoke this any time in Settings & Guides → AI Assistant.`,
      },
      "Allow",
    );
    if (pick !== "Allow") {
      return false;
    }
    await this.store.update({ consentGiven: true });
    return true;
  }

  /** A minimal round-trip for the settings Test button. Records usage like any call. */
  async test(): Promise<{ ms: number; model: string }> {
    // Fail with guidance, not a mangled URL, when the form is incomplete.
    const s = this.store.get();
    if (!s.providerId || !s.baseUrl || !s.model) {
      throw new AiError("Pick a preset and fill in base URL and model first.");
    }
    if (!(await this.store.isConfigured())) {
      throw new AiError(
        "No API key stored for this provider — paste your key and press Test again.",
      );
    }
    const config = this.store.providerConfig();
    const key = (await this.store.getKey(config.providerId)) ?? "";
    const provider = createAiProvider(config);
    const started = Date.now();
    // Generous cap: reasoning models (GPT-5 family) spend output tokens on
    // thinking before any text — a tiny cap yields an empty, "failed" reply.
    const res = await provider.complete(
      { system: "Reply with the single word OK.", user: "ping", maxTokens: 512 },
      key,
    );
    // Measured before the bookkeeping below, which may hit the network.
    const ms = Date.now() - started;
    await this.usage.record({
      ts: Date.now(),
      providerId: config.providerId,
      model: res.model,
      verb: "test",
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });
    await this.autoPrice(config.providerId, res.model);
    return { ms, model: res.model };
  }

  /**
   * Live model list from the configured endpoint, for the settings dropdown.
   * Needs only base URL + key — deliberately NOT the model, since choosing
   * the model is exactly what this call exists to help with.
   */
  async listModels(): Promise<AiModelInfo[]> {
    const s = this.store.get();
    if (!s.providerId || !s.baseUrl) {
      throw new AiError("Pick a preset and fill in the base URL first.");
    }
    const key = (await this.store.getKey(s.providerId)) ?? "";
    const models = await createAiProvider(this.store.providerConfig()).listModels(key);
    // Endpoint-reported prices win (OpenRouter). Where the list has none
    // (OpenAI, Anthropic), annotate from the price table — the "~" marks
    // built-in fallback numbers, the only non-API source that exists.
    const table = this.priceTable();
    const litellmId = this.litellmProviderFor(s.providerId);
    const entries = litellmId ? await this.ensureLitellmTable().catch(() => []) : [];
    return models.map((m) => {
      if (m.inputPerMTok != null || m.outputPerMTok != null) {
        return m;
      }
      // Price table first — those are the numbers the usage ledger actually
      // charges against — then the LiteLLM mirror, so every model LiteLLM
      // knows shows a price in the dropdown, not just ones already added (req 4).
      const p =
        findPrice(s.providerId, m.id, table) ??
        (litellmId ? lookupLitellm(entries, litellmId, m.id) : undefined);
      // est → rendered with "~": the number is from the price table (a prior
      // fetch or LiteLLM), not from this endpoint's own response.
      return p ? { ...m, inputPerMTok: p.input, outputPerMTok: p.output, est: true } : m;
    });
  }

  /** The full price table. Every row was fetched from a real source — nothing shipped. */
  priceTable(): PriceRow[] {
    return this.usage.apiPriceRows();
  }

  /** The stored LiteLLM mirror with its age, for the settings badge. */
  litellmTable(): LitellmTable | undefined {
    return this.usage.litellmTable();
  }

  /**
   * Which LiteLLM provider prices this preset's models. Presets carry their
   * own mapping (registry.ts); "custom" uses whatever the user named, since a
   * user-supplied base URL could be anything. Unmapped → no LiteLLM fallback,
   * which shows "—" rather than a price borrowed from an unrelated host.
   */
  private litellmProviderFor(providerId: string): string | undefined {
    if (providerId === "custom") {
      return this.store.get().litellmProvider || undefined;
    }
    return presetById(providerId)?.litellmProvider;
  }

  /**
   * The local mirror, downloading once if it has never been populated.
   * D4: no timers and no refetch-on-open — the table ages visibly instead,
   * and ↻ is the only thing that re-downloads.
   */
  private async ensureLitellmTable(): Promise<LitellmEntry[]> {
    const stored = this.usage.litellmTable();
    if (stored?.entries.length) {
      return stored.entries;
    }
    return (await this.refreshLitellmTable()).entries;
  }

  /**
   * Re-download and replace the mirror wholesale (~129 KB stored from a
   * ~1.6 MB file). On failure the existing table is left untouched and the
   * error surfaces: a stale table still prices every model it knows, whereas
   * an emptied one silently turns every estimate into "—".
   */
  async refreshLitellmTable(): Promise<LitellmTable> {
    let res: Response;
    try {
      res = await fetch(LITELLM_PRICES_URL);
    } catch (err) {
      throw new AiError(`Couldn't reach the LiteLLM price list: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new AiError(`LiteLLM price list fetch failed (HTTP ${res.status}).`);
    }
    const entries = parseLitellmTable(await res.json());
    if (!entries.length) {
      // Shape changed upstream — keep whatever we already had rather than
      // replacing a working table with nothing.
      throw new AiError("The LiteLLM price list returned no usable model prices.");
    }
    const table: LitellmTable = { entries, fetchedAt: Date.now() };
    await this.usage.saveLitellmTable(table);
    return table;
  }

  /** One model's LiteLLM price, or undefined when nothing there covers it. */
  private async litellmPrice(
    providerId: string,
    modelId: string,
  ): Promise<{ input: number; output: number } | undefined> {
    const litellmId = this.litellmProviderFor(providerId);
    if (!litellmId) {
      return undefined;
    }
    return lookupLitellm(await this.ensureLitellmTable(), litellmId, modelId);
  }

  /**
   * Model list for an arbitrary preset (price table add/refresh) — unlike
   * `listModels`, this never touches the active form. Requires a stored key
   * when the preset needs one (req: keyed providers only contribute prices
   * once the user has provided a key).
   */
  private async listModelsFor(providerId: string): Promise<AiModelInfo[]> {
    const preset = presetById(providerId);
    const s = this.store.get();
    // "custom" has no fixed base URL — usable only while it's the active form.
    const baseUrl = preset?.baseUrl || (s.providerId === providerId ? s.baseUrl : "");
    if (!preset || !baseUrl) {
      throw new AiError("Unknown provider or no base URL configured.");
    }
    const key = (await this.store.getKey(providerId)) ?? "";
    if (preset.needsKey && !key) {
      throw new AiError(`${preset.label}: no API key stored — add one to fetch its prices.`);
    }
    return createAiProvider({ providerId, kind: preset.kind, baseUrl, model: "" }).listModels(key);
  }

  /**
   * Models a provider serves, each carrying the price the dropdown shows:
   * the provider's own API price when it publishes one, else the LiteLLM
   * table's (req 4). No `source` means nothing prices it — rendered "—",
   * never a guessed number.
   */
  async priceCandidates(providerId: string): Promise<PriceCandidate[]> {
    const models = await this.listModelsFor(providerId);
    const litellmId = this.litellmProviderFor(providerId);
    // A missing table must not cost us the endpoint's own prices, which need
    // no download at all.
    const entries = litellmId ? await this.ensureLitellmTable().catch(() => []) : [];
    return models.map((m) => {
      if (!m.est && m.inputPerMTok != null && m.outputPerMTok != null) {
        return { id: m.id, input: m.inputPerMTok, output: m.outputPerMTok, source: "api" as const };
      }
      const p = litellmId ? lookupLitellm(entries, litellmId, m.id) : undefined;
      return p ? { id: m.id, ...p, source: "litellm" as const } : { id: m.id };
    });
  }

  /**
   * Add one row. The provider's own API price wins; otherwise the LiteLLM
   * list. No source at all → refuse with the honest reason.
   */
  async addPriceRow(providerId: string, modelId: string): Promise<void> {
    const models = await this.listModelsFor(providerId);
    const m = models.find((mo) => mo.id === modelId);
    if (!m) {
      throw new AiError(`Model "${modelId}" is not in this provider's list.`);
    }
    let price: { input: number; output: number; source: PriceRow["source"] } | undefined;
    if (!m.est && m.inputPerMTok != null && m.outputPerMTok != null) {
      price = { input: m.inputPerMTok, output: m.outputPerMTok, source: "api" };
    } else {
      const p = await this.litellmPrice(providerId, modelId);
      if (p) {
        price = { ...p, source: "litellm" };
      }
    }
    if (!price) {
      throw new AiError(
        `No price source covers "${modelId}" — ` +
          `${presetById(providerId)?.label ?? providerId} doesn't publish prices and ` +
          `the LiteLLM list doesn't have it. Its usage will show "—".`,
      );
    }
    const rows = this.usage
      .apiPriceRows()
      .filter((r) => !(r.providerId === providerId && r.model === modelId));
    rows.push({
      providerId,
      model: m.id,
      input: price.input,
      output: price.output,
      source: price.source,
      fetchedAt: Date.now(),
    });
    await this.usage.savePriceRows(rows);
  }

  /**
   * D1 — file a price the moment a model is actually used, keyed on the
   * SERVER-reported id. The server routinely reports a more versioned id than
   * the one requested (`gpt-5-mini` → `gpt-5-mini-2025-08-07`); pricing the
   * requested id would file the row under a name the usage table never shows.
   *
   * Only runs when nothing already covers the pair, so the extra model-list
   * request happens once per new model, not once per call. Best-effort
   * throughout: the call it follows has already succeeded, and no pricing
   * failure may turn that into an error.
   *
   * D2 — this re-adds a row the user removed with ✕, so ✕ means "until next
   * use". The price table's hint says so rather than implying permanence.
   */
  private async autoPrice(providerId: string, model: string): Promise<void> {
    if (!model || findPrice(providerId, model, this.usage.apiPriceRows())) {
      return;
    }
    let price: { input: number; output: number; source: PriceRow["source"] } | undefined;
    try {
      const m = (await this.listModelsFor(providerId)).find(
        (mo) => mo.id.toLowerCase() === model.toLowerCase(),
      );
      if (m && !m.est && m.inputPerMTok != null && m.outputPerMTok != null) {
        price = { input: m.inputPerMTok, output: m.outputPerMTok, source: "api" };
      }
    } catch {
      // Endpoint unreachable or keyless — LiteLLM may still cover the model.
    }
    if (!price) {
      try {
        const p = await this.litellmPrice(providerId, model);
        if (p) {
          price = { ...p, source: "litellm" };
        }
      } catch {
        // No local table and no network: the model stays unpriced and shows
        // "—", which is the honest answer. ＋ Price used models retries later.
      }
    }
    if (!price) {
      return;
    }
    const rows = this.usage
      .apiPriceRows()
      .filter((r) => !(r.providerId === providerId && r.model === model));
    rows.push({ providerId, model, ...price, fetchedAt: Date.now() });
    await this.usage.savePriceRows(rows);
  }

  /** Drop one row. Costs for that model revert to "—" everywhere. */
  async removePriceRow(providerId: string, model: string): Promise<void> {
    await this.usage.savePriceRows(
      this.usage.apiPriceRows().filter((r) => !(r.providerId === providerId && r.model === model)),
    );
  }

  /**
   * Price every (provider, model) pair in the usage ledger that no current
   * row covers. Endpoint price wins, LiteLLM fills in; pairs with no source
   * anywhere are reported, not guessed. Provider failures (no key, custom
   * endpoint not active, network) are reported per provider.
   */
  async addPricesFromUsage(): Promise<{
    added: string[];
    unpriced: string[];
    errors: string[];
  }> {
    const rows = this.usage.apiPriceRows();
    const added: string[] = [];
    const unpriced: string[] = [];
    const errors: string[] = [];
    const pending = usedModels(this.usage.state()).filter(
      (u) => !findPrice(u.providerId, u.model, rows),
    );
    const byProvider = new Map<string, string[]>();
    for (const u of pending) {
      byProvider.set(u.providerId, [...(byProvider.get(u.providerId) ?? []), u.model]);
    }
    for (const [pid, modelIds] of byProvider) {
      let models: AiModelInfo[] | undefined;
      let entries: LitellmEntry[] | undefined;
      const litellmId = this.litellmProviderFor(pid);
      let fetchError: string | undefined;
      try {
        models = await this.listModelsFor(pid);
      } catch (err) {
        fetchError = (err as Error).message;
      }
      if (litellmId) {
        try {
          entries = await this.ensureLitellmTable();
        } catch (err) {
          fetchError = fetchError ?? (err as Error).message;
        }
      }
      if (!models && !entries) {
        errors.push(fetchError ?? `${pid}: no price source reachable`);
        continue;
      }
      for (const modelId of modelIds) {
        const mo = models?.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
        const endpointPriced = mo && !mo.est && mo.inputPerMTok != null && mo.outputPerMTok != null;
        const p = endpointPriced
          ? {
              input: mo.inputPerMTok as number,
              output: mo.outputPerMTok as number,
              source: "api" as const,
            }
          : (() => {
              const lp =
                entries && litellmId ? lookupLitellm(entries, litellmId, modelId) : undefined;
              return lp ? { ...lp, source: "litellm" as const } : undefined;
            })();
        if (!p) {
          unpriced.push(`${pid}: ${modelId}`);
          continue;
        }
        rows.push({
          providerId: pid,
          model: modelId,
          input: p.input,
          output: p.output,
          source: p.source,
          fetchedAt: Date.now(),
        });
        added.push(`${pid}: ${modelId}`);
      }
    }
    await this.usage.savePriceRows(rows);
    return { added, unpriced, errors };
  }

  /**
   * Re-fetch every row from its own source. Rows whose source no longer
   * prices the model are removed and reported; unreachable/keyless providers
   * keep their rows (they age into "stale") and are reported too.
   */
  async refreshPrices(): Promise<{ removed: string[]; errors: string[] }> {
    let rows = this.usage.apiPriceRows();
    const removed: string[] = [];
    const errors: string[] = [];
    for (const pid of [
      ...new Set(rows.filter((r) => r.source === "api").map((r) => r.providerId)),
    ]) {
      try {
        const res = mergeFetched(rows, pid, await this.listModelsFor(pid), Date.now());
        rows = res.rows;
        removed.push(...res.removed.map((m) => `${pid}: ${m}`));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    // LiteLLM rows re-read the local mirror rather than re-downloading, so a
    // refresh works offline. Use ↻ on the LiteLLM table itself to pull newer
    // numbers from GitHub.
    const litellmRows = rows.filter((r) => r.source === "litellm");
    let entries: LitellmEntry[] | undefined;
    if (litellmRows.length) {
      try {
        entries = await this.ensureLitellmTable();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (entries) {
      for (const pid of new Set(litellmRows.map((r) => r.providerId))) {
        const litellmId = this.litellmProviderFor(pid);
        if (!litellmId) {
          continue; // mapping gone (e.g. custom endpoint unset) — rows age into stale
        }
        // mergeLitellm keys on each row's own model id, so resolve per row —
        // the table's id may be namespaced where the row's is not.
        const prices: PriceMap = new Map();
        for (const r of litellmRows) {
          if (r.providerId !== pid) {
            continue;
          }
          const p = lookupLitellm(entries, litellmId, r.model);
          if (p) {
            prices.set(r.model.toLowerCase(), p);
          }
        }
        const res = mergeLitellm(rows, pid, prices, Date.now());
        rows = res.rows;
        removed.push(...res.removed.map((m) => `${pid}: ${m}`));
      }
    }
    await this.usage.savePriceRows(rows);
    return { removed, errors };
  }

  /**
   * Run one assist verb against a live connection. Throws AiError with a
   * user-readable message on any failure; returns null when consent is refused.
   */
  async run(req: AiVerbRequest, driver: Driver): Promise<AiVerbResult | null> {
    if (!this.store.aiEnabledFor(req.connId)) {
      throw new AiError("AI is disabled for this connection (Settings & Guides → AI Assistant).");
    }
    if (!(await this.ensureConsent())) {
      return null;
    }

    const hints = await driver.schemaHints(req.database);
    // Trim relevance comes from the prompt AND the current SQL — a follow-up
    // like "add the plan name" names no tables itself; the query does.
    const focus =
      req.verb === "generate" ? [req.prompt, req.sql].filter(Boolean).join("\n") : (req.sql ?? "");
    const fksByTable = await this.collectFks(driver, focus, hints.tables);
    const ctx = buildSchemaContext(
      focus,
      schemaInputFromHints(hints, fksByTable),
      SCHEMA_TOKEN_BUDGET,
    );

    const config = this.store.providerConfig();
    const key = (await this.store.getKey(config.providerId)) ?? "";
    const provider = createAiProvider(config);
    const started = Date.now();
    const res = await provider.complete(
      {
        system: systemPrompt(req.verb, req.connType),
        user:
          req.verb === "generate"
            ? generateUserPrompt(req.prompt ?? "", ctx.text, req.sql, req.history)
            : req.verb === "explain"
              ? explainUserPrompt(req.sql ?? "", ctx.text)
              : fixUserPrompt(req.sql ?? "", req.error ?? "", ctx.text),
        // Room for reasoning tokens (GPT-5 family) on top of the answer itself.
        maxTokens: 4096,
      },
      key,
    );
    await this.usage.record({
      ts: Date.now(),
      providerId: config.providerId,
      model: res.model,
      verb: req.verb,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });

    const ms = Date.now() - started;
    // Before the estimate below, so the very first call with a new model is
    // itself costed instead of showing "—" until the next one.
    await this.autoPrice(config.providerId, res.model);
    const tokens = res.inputTokens + res.outputTokens;
    // Same estimate the usage ledger shows — the response carries exact tokens
    // but no dollar amount, so price comes from the price table.
    const costUsd = estimateCost(
      res.inputTokens,
      res.outputTokens,
      findPrice(config.providerId, res.model, this.priceTable()),
    );
    const attribution = { ms, tokens, costUsd, provider: config.providerId, model: res.model };
    if (req.verb === "explain") {
      return {
        sql: "",
        text: res.text.trim(),
        trimmedTo: ctx.trimmed ? ctx.tables.length : undefined,
        ...attribution,
      };
    }
    const { sql, explanation } = extractSql(res.text);
    return {
      sql,
      text: explanation,
      trimmedTo: ctx.trimmed ? ctx.tables.length : undefined,
      destructive: isDestructive(sql) ?? undefined,
      mutation: isMutation(sql) ?? undefined,
      ...attribution,
    };
  }

  /**
   * Best-effort FK enrichment for the tables the request references. Table
   * names from schemaHints don't always resolve to a driver path (engines
   * qualify differently), so failures are silently tolerated — context.ts
   * treats missing FK data as "no arrows", never an error.
   */
  private async collectFks(
    driver: Driver,
    focus: string,
    tables: string[],
  ): Promise<Record<string, ForeignKey[]> | undefined> {
    const wanted = referencedTables(focus, tables).slice(0, MAX_FK_LOOKUPS);
    const targets = wanted.length ? wanted : tables.length <= MAX_FK_LOOKUPS ? tables : [];
    if (!targets.length) {
      return undefined;
    }
    const out: Record<string, ForeignKey[]> = {};
    await Promise.all(
      targets.map(async (t) => {
        try {
          const fks = await driver.foreignKeys(t.includes(".") ? t.split(".") : [t]);
          if (fks.length) {
            out[t] = fks;
          }
        } catch {
          // Unresolvable path on this engine — arrows for this table are skipped.
        }
      }),
    );
    return Object.keys(out).length ? out : undefined;
  }
}
