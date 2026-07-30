/**
 * Shared assembly for `Driver.schemaHints`. Every SQL engine reads (table, column)
 * pairs out of its catalog in a different dialect, but the grouping and the flat
 * fallback list are identical — so they live here rather than three times over.
 */

/**
 * Caps on how much schema a driver pulls for completion. Generous enough for a
 * real database, low enough that a pathological catalog can't stall the editor.
 * Drivers query LIMIT+1 rows so exceeding the cap is proof of truncation.
 */
export const HINT_TABLE_LIMIT = 2000;
export const HINT_COLUMN_LIMIT = 20000;

export interface GroupedColumns {
  /** Every distinct column name, for when the table in scope is unknown. */
  columns: string[];
  /** Column names per table, in the order the catalog returned them. */
  columnsByTable: Record<string, string[]>;
}

/**
 * Group catalog rows by table, preserving column order (drivers order by
 * ordinal position, which is the order a human expects to see them).
 */
export function groupColumns(pairs: Array<{ table: string; column: string }>): GroupedColumns {
  const columnsByTable: Record<string, string[]> = {};
  const flat = new Set<string>();
  for (const { table, column } of pairs) {
    if (!table || !column) {
      continue;
    }
    // Same column name can repeat across tables; keep per-table duplicates out
    // so a table listed twice by the catalog doesn't double up.
    if (!columnsByTable[table]) {
      columnsByTable[table] = [];
    }
    const bucket = columnsByTable[table];
    if (!bucket.includes(column)) {
      bucket.push(column);
    }
    flat.add(column);
  }
  return { columns: [...flat], columnsByTable };
}
