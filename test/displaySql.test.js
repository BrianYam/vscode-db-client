// The editable "equivalent SQL" shown for table previews (sort/filter/paginate).
const { test } = require("node:test");
const assert = require("node:assert");
const { displaySql } = require("../out/drivers/postgres.js");

test("basic preview SQL", () => {
  assert.strictEqual(
    displaySql("public.users", { limit: 100 }, "ILIKE"),
    "SELECT * FROM public.users LIMIT 100"
  );
});

test("sort adds ORDER BY", () => {
  assert.strictEqual(
    displaySql("public.users", { limit: 100, sort: { column: "name", dir: "desc" } }, "ILIKE"),
    "SELECT * FROM public.users ORDER BY name DESC LIMIT 100"
  );
});

test("column filter adds WHERE ... ILIKE with wildcards", () => {
  assert.strictEqual(
    displaySql("public.users", { limit: 100, columnFilters: [{ column: "email", value: "foo" }] }, "ILIKE"),
    "SELECT * FROM public.users WHERE email ILIKE '%foo%' LIMIT 100"
  );
});

test("exact (FK) filter uses = with a literal", () => {
  assert.strictEqual(
    displaySql("public.orders", { limit: 100, filter: { column: "user_id", value: "abc" } }, "ILIKE"),
    "SELECT * FROM public.orders WHERE user_id = 'abc' LIMIT 100"
  );
});

test("offset appears after LIMIT", () => {
  assert.strictEqual(
    displaySql("public.users", { limit: 100, offset: 200 }, "ILIKE"),
    "SELECT * FROM public.users LIMIT 100 OFFSET 200"
  );
});

test("everything combines in order", () => {
  const sql = displaySql(
    "public.users",
    {
      limit: 100,
      offset: 100,
      columnFilters: [{ column: "email", value: "a" }],
      sort: { column: "name", dir: "asc" },
    },
    "ILIKE"
  );
  assert.strictEqual(
    sql,
    "SELECT * FROM public.users WHERE email ILIKE '%a%' ORDER BY name ASC LIMIT 100 OFFSET 100"
  );
});
