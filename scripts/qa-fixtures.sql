-- QA fixtures for the cases that need data you would not have lying around:
-- the M32 grid render cap and the M33 JSON viewer's bounds and escaping.
--
--   psql "$CONN" -f scripts/qa-fixtures.sql
--
-- Safe to re-run: every table is dropped first. See docs/TESTING.md.

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS qa_big_rows;
DROP TABLE IF EXISTS qa_json;

-- ---------------------------------------------------------------------------
-- M32 — grid render cap. 50,000 rows is what froze the panel before the cap.
-- Includes a jsonb column so the summary chips are exercised at volume too.
-- ---------------------------------------------------------------------------
CREATE TABLE qa_big_rows (
  id          serial PRIMARY KEY,
  symbol      text NOT NULL,
  buy_price   numeric(12,4),
  sell_price  numeric(12,4),
  market_open boolean,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO qa_big_rows (symbol, buy_price, sell_price, market_open, payload, created_at)
SELECT
  'SYM' || (g % 500),
  (random() * 1000)::numeric(12,4),
  (random() * 1000)::numeric(12,4),
  (g % 2 = 0),
  jsonb_build_object('i', g, 'tags', jsonb_build_array('a', 'b'), 'meta',
                     jsonb_build_object('src', 'seed', 'batch', g / 1000)),
  now() - (g || ' seconds')::interval
FROM generate_series(1, 50000) g;

-- ---------------------------------------------------------------------------
-- M33 — JSON viewer. One row per case; `label` says what each one is for.
-- `ts` and `blob` are here on purpose: they are typeof 'object' in the webview
-- and must render normally, NOT as an empty JSON document.
-- ---------------------------------------------------------------------------
CREATE TABLE qa_json (
  id        serial PRIMARY KEY,
  label     text NOT NULL,
  doc       jsonb,
  doc_json  json,
  doc_text  text,          -- JSON kept as text, the SQLite/Redis shape
  ts        timestamptz DEFAULT now(),
  blob      bytea DEFAULT '\x00ff10'::bytea
);

INSERT INTO qa_json (label, doc, doc_json, doc_text) VALUES
  ('small object — opens expanded',
   '{"country":"MY","currency":"MYR","amount":55}'::jsonb,
   '{"country":"MY"}'::json,
   '{"country":"MY","currency":"MYR"}'),

  ('empty object / empty array',
   '{}'::jsonb, '[]'::json, '{}'),

  ('deep nesting — collapsed past depth 2',
   jsonb_build_object('l1', jsonb_build_object('l2', jsonb_build_object(
     'l3', jsonb_build_object('l4', jsonb_build_object('l5', 'bottom'))))),
   NULL, NULL),

  ('null document',
   NULL, NULL, NULL);

-- 5,000-element array: expansion must paint 1,000 and say it withheld 4,000.
INSERT INTO qa_json (label, doc)
SELECT 'array of 5000 — node cap + honest note',
       (SELECT jsonb_agg(jsonb_build_object('i', g, 'sku', 'SKU-' || g))
        FROM generate_series(1, 5000) g);

-- 3,000-key object: the same cap, on the object branch of buildChildren.
INSERT INTO qa_json (label, doc)
SELECT 'object with 3000 keys — node cap',
       (SELECT jsonb_object_agg('key_' || g, g) FROM generate_series(1, 3000) g);

-- ~5 MB: past JSON_TREE_MAX_CHARS, so it must open on Raw with an explanation
-- instead of building a tree.
INSERT INTO qa_json (label, doc)
VALUES ('~5 MB document — must open on Raw, not freeze',
        jsonb_build_object('note', 'oversized on purpose',
                           'blob', repeat('x', 5 * 1024 * 1024)));

-- Escaping. Every one of these must appear as literal text in the tree: no
-- markup, no broken attributes, no executed script. Dollar-quoted so Postgres
-- passes the JSON through untouched.
INSERT INTO qa_json (label, doc, doc_text) VALUES
  ('hostile payload — must render as text',
   $j${"quote\"key":"<script>alert('xss')</script>",
       "amp & key":"a & b < c > d",
       "apos'key":"it's fine",
       "attr\"break":"\" onmouseover=\"alert(1)",
       "unicode":"日本語 ✓ — em-dash",
       "nested":{"<img src=x onerror=alert(1)>":"value & more"}}$j$::jsonb,
   $t${"text_col":"<script>alert(2)</script>","amp":"a & b"}$t$);

-- A string that merely starts like JSON but does not parse: must stay plain text
-- with no chip and no ⤢ affordance.
INSERT INTO qa_json (label, doc_text)
VALUES ('not JSON despite the brace — no chip expected', '{not json at all');

ANALYZE qa_big_rows;
ANALYZE qa_json;

SELECT 'qa_big_rows' AS table, count(*) AS rows FROM qa_big_rows
UNION ALL
SELECT 'qa_json', count(*) FROM qa_json;
