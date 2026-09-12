-- Demo data for the README hero GIF (see docs/DISCOVERY_README_MEDIA.md).
-- Not QA data: scripts/qa-fixtures.sql exists for that and is deliberately ugly
-- (oversized documents, XSS strings, `qa_` table names). This one has to look
-- like somebody's actual database on a Marketplace listing page.
--
-- Shaped around the shot list: `customers` carries beats 2-5 by itself, so the
-- recording never has to change table mid-take.
--   - 250 rows  -> previews page, and the `>` button is live
--   - 9 columns -> the column picker reads "Columns 6/9" after hiding three
--   - id PK     -> the grid is editable
--   - jsonb     -> the JSON viewer has something real to open

DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS products;

CREATE TABLE customers (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL,
  country        text NOT NULL,
  tier           text NOT NULL,
  status         text NOT NULL,
  orders_count   integer NOT NULL,
  lifetime_value numeric(10, 2) NOT NULL,
  preferences    jsonb
);

CREATE TABLE products (
  id         serial PRIMARY KEY,
  sku        text NOT NULL UNIQUE,
  name       text NOT NULL,
  category   text NOT NULL,
  price      numeric(10, 2) NOT NULL,
  in_stock   integer NOT NULL
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  placed_at   timestamptz NOT NULL,
  status      text NOT NULL,
  total       numeric(10, 2) NOT NULL,
  shipping    jsonb
);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity   integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL
);

-- Names read as a plausible customer list rather than "user_1 … user_250".
-- Everything varying is keyed off md5(g) rather than g itself: a value that
-- steps with the row number (`9.77, 19.54, 29.31 …`) or a tier that cycles every
-- four rows is instantly readable as fake on a screen recording, which is the
-- one place this data gets looked at closely.
INSERT INTO customers (name, email, country, tier, status, orders_count, lifetime_value, preferences)
SELECT
  full_name,
  lower(split_part(full_name, ' ', 1)) || '.' ||
    lower(replace(split_part(full_name, ' ', 2), ' ', '')) || r % 90 || '@example.com',
  (ARRAY['MY','SG','TH','ID','JP'])[1 + (r / 7) % 5],
  (ARRAY['free','pro','business','enterprise'])[1 + (r / 31) % 4],
  CASE WHEN (r / 13) % 11 = 0 THEN 'churned' WHEN (r / 3) % 4 = 0 THEN 'trial' ELSE 'active' END,
  (r / 17) % 40,
  round((((r / 11) % 900000) / 100.0)::numeric, 2),
  jsonb_build_object(
    'locale', (ARRAY['en-MY','en-SG','th-TH','id-ID','ja-JP'])[1 + (r / 7) % 5],
    'marketing', jsonb_build_object(
      'email', (r / 5) % 2 = 0,
      'sms', (r / 23) % 5 = 0,
      'topics', (ARRAY[
        jsonb_build_array('releases','billing'),
        jsonb_build_array('releases'),
        jsonb_build_array('billing','security','releases')])[1 + (r / 19) % 3]),
    'billing', jsonb_build_object(
      'currency', (ARRAY['MYR','SGD','THB','IDR','JPY'])[1 + (r / 7) % 5],
      'invoice_day', 1 + (r / 29) % 28)
  )
FROM (
  SELECT
    g,
    -- stable pseudo-random per row, so re-running the seed reproduces the take
    ('x' || substr(md5(g::text || 'demo'), 1, 7))::bit(28)::bigint AS r,
    -- first and last name drawn from the same cultural set, so the list reads
    -- like real customers instead of a shuffle of unrelated name parts
    (ARRAY[
      'Aisyah Rahman','Nurul Yusof','Siti Zainal','Farid Ismail','Hafiz Karim',
      'Iqbal Abdullah','Amira Hassan','Wei Ming Tan','Zhi Hao Lim','Mei Ling Wong',
      'Chun Wai Ong','Li Hua Ng','Priya Nair','Arjun Menon','Kavitha Pillai',
      'Ravi Krishnan','Lakshmi Suresh','Devi Raj','Hiroshi Sato','Yuki Tanaka',
      'Daniel Lim','Grace Chua','Marcus Goh','Intan Permata','Budi Santoso',
      'Somchai Wattana','Ploy Sirikul','Nadia Rahim','Haziq Aziz','Elena Cheng'
    ])[1 + (('x' || substr(md5(g::text || 'name'), 1, 7))::bit(28)::bigint) % 30] AS full_name
  FROM generate_series(1, 250) g
) seeded;

INSERT INTO products (sku, name, category, price, in_stock)
SELECT
  'SKU-' || lpad(g::text, 4, '0'),
  (ARRAY['Mechanical Keyboard','USB-C Hub','27" Monitor','Desk Mat','Laptop Stand',
         'Noise-cancelling Headphones','Webcam 4K','Ergonomic Mouse'])[1 + (g % 8)],
  (ARRAY['peripherals','displays','accessories','audio'])[1 + (g % 4)],
  round(((49 + (g * 37) % 900))::numeric, 2),
  (g * 17) % 120
FROM generate_series(1, 60) g;

INSERT INTO orders (customer_id, placed_at, status, total, shipping)
SELECT
  1 + (g % 250),
  now() - ((g % 180) || ' days')::interval,
  (ARRAY['paid','shipped','delivered','refunded','pending'])[1 + (g % 5)],
  round((((g * 613) % 120000) / 100.0)::numeric, 2),
  jsonb_build_object(
    'carrier', (ARRAY['DHL','J&T','Pos Laju','Ninja Van'])[1 + (g % 4)],
    'address', jsonb_build_object(
      'city', (ARRAY['Kuala Lumpur','Singapore','Bangkok','Jakarta','Tokyo'])[1 + (g % 5)],
      'postcode', lpad((10000 + (g * 91) % 80000)::text, 5, '0')),
    'tracking', 'TRK' || lpad(((g * 4517) % 1000000)::text, 7, '0'))
FROM generate_series(1, 800) g;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  1 + (g % 800),
  1 + (g % 60),
  1 + (g % 4),
  round(((49 + (g * 37) % 900))::numeric, 2)
FROM generate_series(1, 2000) g;
