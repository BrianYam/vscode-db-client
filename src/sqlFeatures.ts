import * as vscode from "vscode";
import type { ConnectionManager } from "./connections/manager";
import type { QueryStore } from "./connections/queryStore";
import type { ConnectionStore } from "./connections/store";
import type { SchemaHints } from "./drivers/Driver";
import { logInfo } from "./log";
import { type Candidate, suggest } from "./sqlComplete";
import { canFormat, formatSql, vocabularyFor } from "./sqlDialect";

/**
 * Cap on items handed to VS Code. It applies its own prefix filtering on top, so
 * this only keeps the payload sane on a wide schema.
 */
const MAX_NATIVE_ITEMS = 400;

/** Our candidate kinds → the icons VS Code draws in its completion list. */
const NATIVE_KIND: Record<Candidate["kind"], vscode.CompletionItemKind> = {
  column: vscode.CompletionItemKind.Field,
  table: vscode.CompletionItemKind.Struct,
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  dataType: vscode.CompletionItemKind.TypeParameter,
};

interface Binding {
  connId: string;
  database: string;
}

// Documents explicitly opened as query files (uri -> connection). Reliable for
// files opened through our commands; path-resolution is the durable fallback.
const bindings = new Map<string, Binding>();

/** Record which connection an opened query document belongs to. */
export function bindQueryDoc(uri: vscode.Uri, connId: string, database: string): void {
  bindings.set(uri.toString(), { connId, database });
}

/**
 * Contributes NATIVE VS Code IntelliSense (a CompletionItemProvider) and inline
 * Run/JSON CodeLens to `.sql` files that belong to this extension — so results
 * run against the right connection and render in OUR grid, using VS Code's own
 * editor and completion UI (nothing reinvented).
 */
export function registerSqlFeatures(
  ctx: vscode.ExtensionContext,
  queries: QueryStore,
  manager: ConnectionManager,
  store: ConnectionStore,
): void {
  const hintCache = new Map<string, SchemaHints>();

  const bindingFor = (uri: vscode.Uri): Binding | undefined => {
    return bindings.get(uri.toString()) ?? queries.resolveUri(uri);
  };

  async function hintsFor(b: Binding) {
    const key = `${b.connId}::${b.database}`;
    const cached = hintCache.get(key);
    if (cached) {
      return cached;
    }
    const driver = await manager.getDriver(b.connId);
    const hints = await driver.schemaHints(b.database || undefined);
    hintCache.set(key, hints);
    return hints;
  }

  const selector: vscode.DocumentSelector = { language: "sql", scheme: "file" };

  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        async provideCompletionItems(document, position) {
          const b = bindingFor(document.uri);
          if (!b) {
            return undefined;
          }
          let hints: SchemaHints;
          try {
            hints = await hintsFor(b);
          } catch {
            hints = { tables: [], columns: [] };
          }
          // Same engine the query panel uses, so both surfaces are dialect-aware,
          // table-aware and context-aware from one implementation.
          const type = store.get(b.connId)?.type ?? "postgres";
          const vocab = vocabularyFor(type);
          const textBeforeCaret = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position),
          );
          const { items } = suggest(
            textBeforeCaret,
            {
              tables: hints.tables,
              columns: hints.columns,
              columnsByTable: hints.columnsByTable,
              keywords: vocab.keywords,
              functions: vocab.functions,
              dataTypes: vocab.dataTypes,
            },
            // Generous: VS Code does its own prefix filtering on top, so the cap
            // only needs to keep the payload sane.
            MAX_NATIVE_ITEMS,
          );
          return items.map((c, i) => {
            const it = new vscode.CompletionItem(c.label, NATIVE_KIND[c.kind]);
            it.detail = c.detail ?? c.kind;
            // Preserve our ranking; VS Code sorts lexicographically on sortText.
            it.sortText = String(i).padStart(4, "0");
            return it;
          });
        },
      },
      " ",
      ".",
      ",",
      "(", // trigger characters (also Ctrl+Space)
    ),

    // Shift+Alt+F on a query file. Uses the connection's type for the dialect —
    // read from the store, not the driver, so formatting never forces a connect.
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document, options) {
        const b = bindingFor(document.uri);
        const type = b && store.get(b.connId)?.type;
        if (!type || !canFormat(type)) {
          return undefined;
        }
        const original = document.getText();
        let formatted: string;
        try {
          formatted = formatSql(original, type, { tabWidth: options.tabSize });
        } catch (err) {
          // Returning no edits leaves the document untouched, which is the whole
          // point — a parse error must never mangle the user's query.
          void vscode.window.showErrorMessage(`Format failed: ${(err as Error).message}`);
          return undefined;
        }
        if (formatted === original) {
          return undefined;
        }
        const whole = new vscode.Range(
          document.positionAt(0),
          document.positionAt(original.length),
        );
        return [vscode.TextEdit.replace(whole, formatted)];
      },
    }),

    vscode.languages.registerCodeLensProvider(selector, {
      provideCodeLenses(document) {
        const b = bindingFor(document.uri);
        if (!b) {
          return [];
        }
        const lenses: vscode.CodeLens[] = [];
        for (const stmt of splitStatements(document)) {
          const args = [b.connId, b.database, stmt.text];
          lenses.push(
            new vscode.CodeLens(stmt.range, {
              title: "▶ Run",
              command: "openDbClient.runSql",
              arguments: args,
            }),
            new vscode.CodeLens(stmt.range, {
              title: "{ } JSON",
              command: "openDbClient.runSqlJson",
              arguments: args,
            }),
          );
        }
        return lenses;
      },
    }),
  );

  // Clear cached hints when a connection is edited/closed elsewhere.
  ctx.subscriptions.push({ dispose: () => hintCache.clear() });
  logInfo("sqlFeatures", "registered SQL completion + code lens providers");
}

interface Statement {
  text: string;
  range: vscode.Range;
}

/** Split a document into `;`-terminated statements, anchoring a lens on each. */
function splitStatements(document: vscode.TextDocument): Statement[] {
  const full = document.getText();
  const out: Statement[] = [];
  let start = 0;
  const push = (from: number, to: number) => {
    const slice = full.slice(from, to);
    const text = slice.trim();
    if (!text) {
      return;
    }
    const lead = slice.search(/\S/);
    const pos = document.positionAt(from + Math.max(0, lead));
    out.push({ text, range: new vscode.Range(pos, pos) });
  };
  for (let i = 0; i < full.length; i++) {
    if (full[i] === ";") {
      push(start, i + 1);
      start = i + 1;
    }
  }
  if (start < full.length) {
    push(start, full.length);
  }
  return out;
}
