// Pure-logic unit tests (R0 safety net). Runs on Node 22's built-in test runner
// against the compiled output — no test framework dependency.
const { test } = require("node:test");
const assert = require("node:assert");
const { quoteIdent, quoteBacktick } = require("../out/drivers/ident.js");

test("quoteIdent wraps in double quotes", () => {
  assert.strictEqual(quoteIdent("users"), '"users"');
});

test("quoteIdent doubles embedded double quotes (injection guard)", () => {
  assert.strictEqual(quoteIdent('a"b'), '"a""b"');
  // A hostile identifier cannot break out of the quotes.
  assert.strictEqual(quoteIdent('x"; DROP TABLE t; --'), '"x""; DROP TABLE t; --"');
});

test("quoteBacktick wraps in backticks and doubles embedded backticks", () => {
  assert.strictEqual(quoteBacktick("users"), "`users`");
  assert.strictEqual(quoteBacktick("a`b"), "`a``b`");
});

test("non-string identifiers are coerced safely", () => {
  assert.strictEqual(quoteIdent(123), '"123"');
});
