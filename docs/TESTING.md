# Testing Guide — Open DB Client

A step-by-step manual test run covering all four engines. Each part is independent —
do the SQLite one first (zero setup), then whichever databases you care about.

---

## Part 0 — Build & launch the extension

1. Open a terminal in the project folder:
   ```bash
   cd /Users/brianyam/Documents/BrianLabProject/vscode-db-client
   npm install      # first time only
   npm run compile
   ```
2. Open the folder in VS Code: `code .` (or File → Open Folder).
3. Press **F5** (or Run → Start Debugging → "Run Extension").
4. A **second VS Code window** opens titled `[Extension Development Host]`.
   **All testing happens in this second window.**
5. In that window, click the **database icon** in the left activity bar.
   You should see an empty **CONNECTIONS** panel with a `＋` and refresh icon in its title bar.

> If the icon or panel is missing, see **Part 6 — Troubleshooting**.

---

## Part 1 — SQLite (no server needed, start here)

1. Click **＋ Add Connection** in the panel title bar.
2. Answer the prompts:
   - Database type → **SQLite**
   - Connection name → `sample-sqlite`
   - SQLite file path → `/Users/brianyam/Documents/BrianLabProject/vscode-db-client/samples/sample.db`
3. **Expect:** a `sample-sqlite` node appears in the tree.
4. Expand it → you should see **`customers`** (table) and **`london_customers`** (view).
5. Click **`customers`** → a **Query** tab opens showing 4 rows (Ada, Grace, Alan, Linus).
6. Right-click `sample-sqlite` → **New Query**, type:
   ```sql
   SELECT city, COUNT(*) AS n FROM customers GROUP BY city;
   ```
   Press **Cmd+Enter** → expect a grid with cities and counts.

✅ Pass = you saw rows without any database server running.
_(Note: SQLite writes don't persist yet — SELECT only. That's the one known limitation.)_

---

## Part 2 — PostgreSQL

### Option A — your real Postgres (from your screenshot)
Use host `127.0.0.1`, port `5432`, username `shortcut`, and your password.

### Option B — throwaway Postgres via Docker (recommended for testing)
```bash
docker run --name odbc-pg -e POSTGRES_USER=shortcut \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=demo -p 5432:5432 -d postgres:16

# seed a table
sleep 5
docker exec -i odbc-pg psql -U shortcut -d demo -c \
 "CREATE TABLE products(id serial primary key, name text, price numeric);
  INSERT INTO products(name,price) VALUES ('Keyboard',49.9),('Mouse',19.5),('Monitor',199);"
```

### Steps
1. **＋ Add Connection** → type **PostgreSQL**, name `test-pg`,
   host `127.0.0.1`, port `5432`, user `shortcut`, password `test`, database `demo`.
2. Expand `test-pg` → expect the **`public`** schema → expand → **`products`** table.
3. Click `products` → expect 3 rows in the grid.
4. **New Query** → `SELECT name FROM products WHERE price > 40;` → Cmd+Enter → expect Keyboard, Monitor.

Teardown when done: `docker rm -f odbc-pg`

---

## Part 3 — MySQL / MariaDB

### Throwaway MySQL via Docker
```bash
docker run --name odbc-mysql -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=demo -p 3306:3306 -d mysql:8

# wait for it to be ready (~20-30s), then seed
sleep 30
docker exec -i odbc-mysql mysql -uroot -ptest demo -e \
 "CREATE TABLE users(id INT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(100));
  INSERT INTO users(email) VALUES ('a@x.com'),('b@x.com');"
```

### Steps
1. **＋ Add Connection** → **MySQL / MariaDB**, name `test-mysql`,
   host `127.0.0.1`, port `3306`, user `root`, password `test`, database `demo`.
2. Expand → expect the **`demo`** database → **`users`** table.
3. Click `users` → expect 2 rows.
4. **New Query** → `SELECT COUNT(*) AS total FROM users;` → expect `total = 2`.

Teardown: `docker rm -f odbc-mysql`

---

## Part 4 — Redis

### Throwaway Redis via Docker
```bash
docker run --name odbc-redis -p 6379:6379 -d redis:7
docker exec -i odbc-redis redis-cli SET greeting "hello world"
docker exec -i odbc-redis redis-cli RPUSH mylist a b c
```

### Steps
1. **＋ Add Connection** → **Redis**, name `test-redis`,
   host `127.0.0.1`, port `6379`, username (blank), password (blank), Redis DB index `0`.
2. Expand `test-redis` → expect keys **`greeting`** and **`mylist`**.
3. Click `greeting` → expect a grid showing `hello world`.
4. Click `mylist` → expect 3 rows (a, b, c).
5. **New Query** → type `GET greeting` → Cmd+Enter → expect `hello world`.

Teardown: `docker rm -f odbc-redis`

---

## Part 5 — The point of the whole exercise: unlimited connections

1. With several connections already added, keep adding more — a 4th, 5th, 6th.
2. **Expect:** every one saves. No "Premium Only" wall, no 3/3 limit.
3. **Reload persistence test:** in the Extension Development Host window, run
   **Developer: Reload Window** (Cmd+Shift+P → type "Reload Window").
4. **Expect:** all connections are still listed after reload, and expanding them still
   connects (passwords were saved in SecretStorage).

✅ This is the KPI: more than 3 connections, persisting across restarts, for free.

---

## Part 6 — Troubleshooting & where to see errors

- **A tree node shows `⚠ <message>`** — that's a connection/query error surfaced inline
  (wrong password, server not running, etc.). Read the message; fix the connection with
  right-click → **Edit Connection**.
- **Extension-host errors / console.log** — in the FIRST window (the one where you pressed
  F5), open the **Debug Console** to see extension-side logs and stack traces.
- **Webview (query grid) errors** — in the query tab, run
  **Developer: Open Webview Developer Tools** (Cmd+Shift+P) to see its console.
- **Nothing appears after F5** — confirm `npm run compile` succeeded and `out/extension.js`
  exists; check the Debug Console for an activation error.
- **Changed the code?** Re-run `npm run compile`, then click **Restart** (⟳) in the debug
  toolbar of the first window, or just press F5 again.
- **Docker container won't connect** — give it more time to start (MySQL is slow, ~30s),
  and confirm the port with `docker ps`.

---

## QA Gate checklist (maps to `task.md`)

- [ ] SQLite: open sample.db → browse → SELECT works
- [ ] Postgres: connect → browse schema/table → query → preview
- [ ] MySQL: connect → browse → query
- [ ] Redis: connect → list keys → typed preview → command
- [ ] Added > 3 connections with no limit
- [ ] Reload window → connections persist, passwords intact
