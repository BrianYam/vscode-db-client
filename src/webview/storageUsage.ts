/**
 * Pure size helpers behind the settings panel's "Storage usage" readout.
 * Kept free of the vscode API so the unit tests can exercise them directly.
 */

/** UTF-8 bytes a value occupies once JSON-serialized into globalState. */
export function byteSize(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

/** Human-readable size. Sub-1KB stays exact — most of our numbers are tiny. */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
