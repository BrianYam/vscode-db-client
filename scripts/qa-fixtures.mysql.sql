-- MySQL / MariaDB counterpart of scripts/qa-fixtures.sql, for the M33 JSON
-- viewer cases. mysql2 parses a JSON column into an object before the webview
-- sees it, exactly as pg does, so detection should behave identically.
--
--   docker exec -i <container> mysql -uroot -ptest qa < scripts/qa-fixtures.mysql.sql
--
-- Safe to re-run. See docs/TESTING.md.

-- The mysql client defaults to latin1 on many setups, which silently mangles the
-- unicode test values into mojibake on load (verified). Set it here so the file is
-- correct however it is invoked.
SET NAMES utf8mb4;

DROP TABLE IF EXISTS qa_big_rows;
DROP TABLE IF EXISTS qa_json;

CREATE TABLE qa_json (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  label    VARCHAR(120) NOT NULL,
  doc      JSON,
  doc_text TEXT,
  ts       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  blob_col VARBINARY(8) DEFAULT 0x00FF10
);

INSERT INTO qa_json (label, doc, doc_text) VALUES
  ('small object — opens expanded',
   '{"country":"MY","currency":"MYR","amount":55}',
   '{"country":"MY","currency":"MYR"}'),
  ('empty object', '{}', '{}'),
  ('deep nesting — collapsed past depth 2',
   '{"l1":{"l2":{"l3":{"l4":{"l5":"bottom"}}}}}', NULL),
  ('null document', NULL, NULL),
  ('not JSON despite the brace — no chip expected', NULL, '{not json at all'),
  ('hostile payload — must render as text',
   '{"quote\\"key":"<script>alert(1)</script>","amp & key":"a & b < c > d","apos''key":"it''s fine","attr\\"break":"\\" onmouseover=\\"alert(1)","unicode":"日本語 ✓","nested":{"<img src=x onerror=alert(1)>":"value & more"}}',
   '{"text_col":"<script>alert(2)</script>"}');

-- 5,000-element array for the node cap, built without a recursive CTE so this
-- works on MariaDB and older MySQL too. GROUP_CONCAT truncates at 1 KB by
-- default, which silently cuts the array in half — raise it first.
SET SESSION group_concat_max_len = 4 * 1024 * 1024;

INSERT INTO qa_json (label, doc)
SELECT 'array of 5000 — node cap + honest note',
       CAST(CONCAT('[', GROUP_CONCAT(CONCAT('{"i":', n, ',"sku":"SKU-', n, '"}') SEPARATOR ','), ']') AS JSON)
FROM (
  SELECT (a.i + b.i * 10 + c.i * 100 + d.i * 1000) + 1 AS n
  FROM (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) d
) nums;

-- ~5 MB document: must open on Raw rather than building a tree.
INSERT INTO qa_json (label, doc)
VALUES ('~5 MB document — must open on Raw, not freeze',
        JSON_OBJECT('note', 'oversized on purpose', 'blob', REPEAT('x', 5 * 1024 * 1024)));

-- M32 render cap: 50,000 rows, with a JSON column so chips are exercised too.
CREATE TABLE qa_big_rows (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(32) NOT NULL,
  buy_price   DECIMAL(12,4),
  sell_price  DECIMAL(12,4),
  market_open TINYINT(1),
  payload     JSON,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO qa_big_rows (symbol, buy_price, sell_price, market_open, payload)
SELECT CONCAT('SYM', n % 500), RAND() * 1000, RAND() * 1000, n % 2,
       JSON_OBJECT('i', n, 'tags', JSON_ARRAY('a', 'b'),
                   'meta', JSON_OBJECT('src', 'seed', 'batch', FLOOR(n / 1000)))
FROM (
  SELECT (a.i + b.i * 10 + c.i * 100 + d.i * 1000 + e.i * 10000) + 1 AS n
  FROM (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) d,
       (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4) e
) nums;

SELECT 'qa_big_rows' AS tbl, COUNT(*) AS rows_seeded FROM qa_big_rows
UNION ALL
SELECT 'qa_json', COUNT(*) FROM qa_json;
