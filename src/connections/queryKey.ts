/**
 * Encoding/decoding of the self-describing query-storage folder key
 * `<connId>@@<db>[@<schema>]`. Pure (no vscode import) so it is unit-testable.
 */

export function encodeKey(connId: string, scope: string[]): string {
  return `${connId}@@${scope.join("@")}`;
}

export function parseKey(key: string): { connId: string; scope: string[] } {
  const at = key.indexOf("@@");
  if (at < 0) {
    return { connId: key, scope: [] };
  }
  const connId = key.slice(0, at);
  const rest = key.slice(at + 2);
  return { connId, scope: rest ? rest.split("@") : [] };
}
