import type { QueryResult } from "../drivers/Driver";

/**
 * Turning a result into an exported artifact. Host-side and pure, so the export
 * path can be tested without a webview — which matters because the column picker
 * made it conditional (M35): a file that silently drops columns is the failure
 * mode this code exists to avoid.
 */

/**
 * Narrow a result to `columns`, in the result's own order.
 *
 * `columns` is the webview's visible set; `undefined` means "everything", so any
 * caller that does not know about column visibility keeps working unchanged.
 * Unknown names are ignored rather than trusted — the list crosses a postMessage
 * boundary, and inventing a column here would produce a file full of blanks.
 */
export function projectResult(result: QueryResult, columns?: unknown): QueryResult {
  if (!Array.isArray(columns)) {
    return result;
  }
  const wanted = new Set(columns.filter((c): c is string => typeof c === "string"));
  const visible = result.columns.filter((c) => wanted.has(c));
  if (visible.length === result.columns.length) {
    return result;
  }
  return {
    ...result,
    columns: visible,
    rows: result.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const c of visible) {
        // Keep the key even when the value is undefined, so every row has the
        // same shape — a ragged export is worse than an explicit empty cell.
        out[c] = row[c];
      }
      return out;
    }),
  };
}

/** RFC-4180-ish CSV. Objects are JSON-encoded rather than "[object Object]". */
export function toCsv(result: QueryResult): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) {
      return "";
    }
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = result.columns.map(esc).join(",");
  const lines = result.rows.map((row) => result.columns.map((c) => esc(row[c])).join(","));
  return [header, ...lines].join("\n");
}
