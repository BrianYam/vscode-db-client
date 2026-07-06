import * as vscode from "vscode";
import { QueryStore } from "./connections/queryStore";
import { ConnectionManager } from "./connections/manager";
import { logInfo } from "./log";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT INTO", "UPDATE", "DELETE FROM", "VALUES",
  "SET", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN", "ON",
  "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "DISTINCT", "AS", "AND",
  "OR", "NOT", "NULL", "IS NULL", "IS NOT NULL", "IN", "LIKE", "BETWEEN",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ASC", "DESC", "RETURNING", "WITH",
  "CASE", "WHEN", "THEN", "ELSE", "END", "UNION", "EXISTS",
];

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
  manager: ConnectionManager
): void {
  const hintCache = new Map<string, { tables: string[]; columns: string[] }>();

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
        async provideCompletionItems(document) {
          const b = bindingFor(document.uri);
          if (!b) {
            return undefined;
          }
          let hints: { tables: string[]; columns: string[] };
          try {
            hints = await hintsFor(b);
          } catch {
            hints = { tables: [], columns: [] };
          }
          const items: vscode.CompletionItem[] = [];
          for (const t of hints.tables) {
            const it = new vscode.CompletionItem(t, vscode.CompletionItemKind.Struct);
            it.detail = "table";
            it.sortText = "0" + t;
            items.push(it);
          }
          for (const c of hints.columns) {
            const it = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
            it.detail = "column";
            it.sortText = "1" + c;
            items.push(it);
          }
          for (const k of KEYWORDS) {
            const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
            it.sortText = "2" + k;
            items.push(it);
          }
          return items;
        },
      },
      " ", ".", ",", "(" // trigger characters (also Ctrl+Space)
    ),

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
            new vscode.CodeLens(stmt.range, { title: "▶ Run", command: "openDbClient.runSql", arguments: args }),
            new vscode.CodeLens(stmt.range, { title: "{ } JSON", command: "openDbClient.runSqlJson", arguments: args })
          );
        }
        return lenses;
      },
    })
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
