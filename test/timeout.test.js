// withTimeout: the escape hatch that stops a hung connect/query wedging the UI (M10).
const { test } = require("node:test");
const assert = require("node:assert");
const { withTimeout } = require("../out/timeout.js");

test("resolves with the value when the op settles in time", async () => {
  const v = await withTimeout(Promise.resolve(42), 1000, "op");
  assert.strictEqual(v, 42);
});

test("propagates the original rejection (not a timeout) when the op fails fast", async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000, "op"), /boom/);
});

test("rejects with a labelled timeout when the op never settles", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, "SSH tunnel"),
    /SSH tunnel timed out after 0s/,
  );
});

test("timeout message reports the cap in whole seconds", async () => {
  // Small ms so the suite stays fast; 1100ms rounds to 1s and proves the format.
  await assert.rejects(
    withTimeout(new Promise(() => {}), 1100, "Loading"),
    /Loading timed out after 1s/,
  );
});
