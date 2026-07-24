/**
 * Reject if `p` hasn't settled within `ms`. The original op keeps running — this
 * only stops the *caller* waiting, so a hung network op (a dead SSH host, a stalled
 * SCAN) can't wedge the UI indefinitely. `label` names the op in the surfaced error.
 *
 * Kept dependency-free (no vscode) so it stays unit-testable under `node:test`.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
