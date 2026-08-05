import * as vscode from "vscode";
import type { Driver, ForeignKey } from "../drivers/Driver";
import { AiError, hostOf, isLocalBaseUrl } from "./AiProvider";
import type { AiStore } from "./aiStore";
import {
  buildSchemaContext,
  extractSql,
  isDestructive,
  referencedTables,
  schemaInputFromHints,
} from "./context";
import {
  type AiExchange,
  type AiVerb,
  explainUserPrompt,
  fixUserPrompt,
  generateUserPrompt,
  systemPrompt,
} from "./prompts";
import { createAiProvider } from "./registry";
import type { UsageStore } from "./usageStore";

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
  /** Wall-clock provider round-trip, for the "answered in Xs" line. */
  ms: number;
  /** input + output token total, so the cost of the call is visible in place. */
  tokens: number;
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
  async listModels(): Promise<string[]> {
    const s = this.store.get();
    if (!s.providerId || !s.baseUrl) {
      throw new AiError("Pick a preset and fill in the base URL first.");
    }
    const key = (await this.store.getKey(s.providerId)) ?? "";
    return createAiProvider(this.store.providerConfig()).listModels(key);
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
    if (req.verb === "explain") {
      return {
        sql: "",
        text: res.text.trim(),
        trimmedTo: ctx.trimmed ? ctx.tables.length : undefined,
        ms,
        tokens,
      };
    }
    const { sql, explanation } = extractSql(res.text);
    return {
      sql,
      text: explanation,
      trimmedTo: ctx.trimmed ? ctx.tables.length : undefined,
      destructive: isDestructive(sql) ?? undefined,
      ms,
      tokens,
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
