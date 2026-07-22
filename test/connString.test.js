// Connection-string parsing + host/port rewrite (the fragile SSH-tunnel path).
const { test } = require("node:test");
const assert = require("node:assert");
const { csTarget, csRewriteHostPort } = require("../out/connections/connString.js");

test("csTarget parses host and explicit port", () => {
  const t = csTarget("postgresql://user:pass@db.internal:6543/app", 5432);
  assert.strictEqual(t.host, "db.internal");
  assert.strictEqual(t.port, 6543);
});

test("csTarget falls back to the default port when none given", () => {
  const t = csTarget("postgresql://user:pass@db.internal/app", 5432);
  assert.strictEqual(t.host, "db.internal");
  assert.strictEqual(t.port, 5432);
});

test("csRewriteHostPort swaps host/port, keeps user/pass/db", () => {
  const out = csRewriteHostPort(
    "postgresql://user:s3cret@rds.aws.com:5432/shortcut",
    "127.0.0.1",
    10958,
  );
  const u = new URL(out);
  assert.strictEqual(u.hostname, "127.0.0.1");
  assert.strictEqual(u.port, "10958");
  assert.strictEqual(u.username, "user");
  assert.strictEqual(u.password, "s3cret");
  assert.strictEqual(u.pathname, "/shortcut");
});

test("csRewriteHostPort preserves query params (e.g. sslmode)", () => {
  const out = csRewriteHostPort(
    "postgresql://u:p@host:5432/db?sslmode=require",
    "127.0.0.1",
    20000,
  );
  assert.match(out, /sslmode=require/);
  assert.match(out, /127\.0\.0\.1:20000/);
});
