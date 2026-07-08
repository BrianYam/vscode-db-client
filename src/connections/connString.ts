/**
 * Pure helpers for connection-string handling used by the SSH tunnel. Kept
 * dependency-free so they are unit-testable without a live server.
 */

/** Parse the target host/port a connection string points at. */
export function csTarget(cs: string, defaultPort: number): { host: string; port: number } {
  const u = new URL(cs);
  return {
    host: u.hostname || "127.0.0.1",
    port: u.port ? Number(u.port) : defaultPort,
  };
}

/** Rewrite a connection string's host/port (leaving user/pass/db/query intact). */
export function csRewriteHostPort(cs: string, host: string, port: number): string {
  const u = new URL(cs);
  u.hostname = host;
  u.port = String(port);
  return u.toString();
}
