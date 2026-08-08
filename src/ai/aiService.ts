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
  findPrice,
  LITELLM_PRICES_URL,
  LITELLM_PROVIDER_IDS,
  mergeFetched,
  mergeLitellm,
  type PriceMap,
  type PriceRow,
  parseLitellmPrices,
} from "./priceTable";
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
    await this.usage.record({
      ts: Date.now(),
      providerId: config.providerId,
      model: res.model,
      verb: "test",
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });
    return { ms: Date.now() - started, model: res.model };
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
    return models.map((m) => {
      if (m.inputPerMTok != null || m.outputPerMTok != null) {
        return m;
      }
      const p = findPrice(s.providerId, m.id, table);
      // est → rendered with "~": the number is from the price table (a prior
      // fetch or LiteLLM), not from this endpoint's own response.
      return p ? { ...m, inputPerMTok: p.input, outputPerMTok: p.output, est: true } : m;
    });
  }

  /** The full price table. Every row was fetched from a real source — nothing shipped. */
  priceTable(): PriceRow[] {
    return this.usage.apiPriceRows();
  }

  /** One LiteLLM download per settings session — the JSON is ~1.6 MB. */
  private litellmCache?: { at: number; json: unknown };

  /**
   * Community price list for providers whose own APIs publish no pricing
   * (OpenAI, Anthropic). Undefined for providers LiteLLM doesn't cover here.
   */
  private async litellmPrices(providerId: string): Promise<PriceMap | undefined> {
    const litellmId = LITELLM_PROVIDER_IDS[providerId];
    if (!litellmId) {
      return undefined;
    }
    if (!this.litellmCache || Date.now() - this.litellmCache.at > 60 * 60 * 1000) {
      let res: Response;
      try {
        res = await fetch(LITELLM_PRICES_URL);
      } catch (err) {
        throw new AiError(`Couldn't reach the LiteLLM price list: ${(err as Error).message}`);
      }
      if (!res.ok) {
        throw new AiError(`LiteLLM price list fetch failed (HTTP ${res.status}).`);
      }
      this.litellmCache = { at: Date.now(), json: await res.json() };
    }
    return parseLitellmPrices(this.litellmCache.json, litellmId);
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
   * Models a provider serves, flagged with whether a real price source covers
   * them: the provider's own API, or the LiteLLM list for APIs that publish
   * no pricing. `priced: false` means no verifiable price exists anywhere.
   */
  async priceCandidates(providerId: string): Promise<Array<{ id: string; priced: boolean }>> {
    const models = await this.listModelsFor(providerId);
    const litellm = await this.litellmPrices(providerId).catch(() => undefined);
    return models.map((m) => ({
      id: m.id,
      priced:
        (!m.est && m.inputPerMTok != null && m.outputPerMTok != null) ||
        !!litellm?.get(m.id.toLowerCase()),
    }));
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
      const litellm = await this.litellmPrices(providerId);
      const p = litellm?.get(modelId.toLowerCase());
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
      let litellm: PriceMap | undefined;
      let fetchError: string | undefined;
      try {
        models = await this.listModelsFor(pid);
      } catch (err) {
        fetchError = (err as Error).message;
      }
      try {
        litellm = await this.litellmPrices(pid);
      } catch (err) {
        fetchError = fetchError ?? (err as Error).message;
      }
      if (!models && !litellm) {
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
              const lp = litellm?.get(modelId.toLowerCase());
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
    for (const pid of [
      ...new Set(rows.filter((r) => r.source === "litellm").map((r) => r.providerId)),
    ]) {
      try {
        const prices = await this.litellmPrices(pid);
        if (!prices) {
          continue; // mapping gone — leave rows to age into stale
        }
        const res = mergeLitellm(rows, pid, prices, Date.now());
        rows = res.rows;
        removed.push(...res.removed.map((m) => `${pid}: ${m}`));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
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
