// ConnectionStore's list handling. store.ts imports vscode as a *type* only, so
// it runs against a fake context with no editor present.
const { test } = require("node:test");
const assert = require("node:assert");
const { ConnectionStore, CONNECTIONS_KEY } = require("../out/connections/store.js");

function fakeCtx(connections = []) {
  const state = new Map([[CONNECTIONS_KEY, connections]]);
  const secrets = new Map();
  return {
    globalState: {
      get: (k, d) => (state.has(k) ? state.get(k) : d),
      update: async (k, v) => void state.set(k, v),
    },
    secrets: {
      store: async (k, v) => void secrets.set(k, v),
      get: async (k) => secrets.get(k),
      delete: async (k) => void secrets.delete(k),
    },
  };
}

const conn = (id, name) => ({ id, name, type: "postgres" });
const names = (store) => store.all().map((c) => c.name);

test("editing a connection keeps its position in the list", async () => {
  // Regression: save() used to filter the entry out and push it back, so every
  // edit sent the connection to the bottom — silently discarding the order the
  // user had dragged them into via reorder().
  const store = new ConnectionStore(fakeCtx([conn("a", "A"), conn("b", "B"), conn("c", "C")]));
  await store.save({ ...conn("b", "B"), notes: "edited" });
  assert.deepStrictEqual(names(store), ["A", "B", "C"], "B must stay in the middle");
  assert.strictEqual(store.get("b").notes, "edited", "the edit still applies");
});

test("a renamed connection keeps its position too", async () => {
  const store = new ConnectionStore(fakeCtx([conn("a", "A"), conn("b", "B"), conn("c", "C")]));
  await store.save(conn("b", "B-renamed"));
  assert.deepStrictEqual(names(store), ["A", "B-renamed", "C"]);
});

test("a new connection is appended", async () => {
  const store = new ConnectionStore(fakeCtx([conn("a", "A")]));
  await store.save(conn("z", "Z"));
  assert.deepStrictEqual(names(store), ["A", "Z"]);
});

test("saving stamps the current schema version", async () => {
  const store = new ConnectionStore(fakeCtx());
  await store.save(conn("a", "A"));
  assert.strictEqual(typeof store.get("a").schemaVersion, "number");
});

test("notes survive a save/read round-trip through globalState", async () => {
  const store = new ConnectionStore(fakeCtx());
  await store.save({ ...conn("a", "A"), notes: "prod — do not write" });
  assert.strictEqual(store.get("a").notes, "prod — do not write");
});

test("repeated edits never reorder the list", async () => {
  const store = new ConnectionStore(fakeCtx([conn("a", "A"), conn("b", "B"), conn("c", "C")]));
  for (let i = 0; i < 5; i++) {
    await store.save({ ...conn("a", "A"), notes: `pass ${i}` });
    await store.save({ ...conn("c", "C"), notes: `pass ${i}` });
  }
  assert.deepStrictEqual(names(store), ["A", "B", "C"]);
});
