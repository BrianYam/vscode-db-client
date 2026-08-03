// Import/export of connections. The security-critical bits — redaction, the
// import whitelist, and the encrypted bundle — plus the append-never-replace rule.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  buildExport,
  parseImport,
  mergeConnections,
  identityKey,
  redactConnectionString,
  encryptBundle,
  decryptBundle,
  isEncryptedBundle,
  EXPORT_KIND,
} = require("../out/connections/portability.js");

const OPTS = { includeSecrets: false, exportedBy: "test", exportedAt: "2026-08-02T00:00:00Z" };
let n = 0;
const mkId = () => `id${++n}`;

// ---------------------------------------------------------------- redaction

test("redactConnectionString strips the password, keeps everything else", () => {
  const r = redactConnectionString("postgresql://user:s3cret@db.host:5432/app?sslmode=require");
  assert.strictEqual(r.redacted, true);
  assert.ok(!r.value.includes("s3cret"));
  const u = new URL(r.value);
  assert.strictEqual(u.username, "user");
  assert.strictEqual(u.hostname, "db.host");
  assert.strictEqual(u.port, "5432");
  assert.strictEqual(u.pathname, "/app");
  assert.match(r.value, /sslmode=require/);
});

test("redactConnectionString leaves a password-free string untouched", () => {
  const r = redactConnectionString("redis://cache.host:6379/0");
  assert.strictEqual(r.redacted, false);
  assert.strictEqual(r.value, "redis://cache.host:6379/0");
});

test("redactConnectionString still strips when the string is not URL-parseable", () => {
  // A URL() failure must not mean "export it as-is" — failing open leaks.
  const r = redactConnectionString("weird+scheme://user:s3cret@[not a host]/db");
  assert.strictEqual(r.redacted, true);
  assert.ok(!r.value.includes("s3cret"));
  assert.ok(r.value.includes("user@"));
});

// ------------------------------------------------------------------- export

test("default export drops secrets and redacts connection strings", () => {
  const { file, redactedNames } = buildExport(
    [
      {
        config: {
          id: "c1",
          type: "postgres",
          name: "Staging",
          useConnectionString: true,
          connectionString: "postgresql://u:p@h/db",
        },
        secrets: { password: "hunter2", sshPassphrase: "kp" },
      },
    ],
    OPTS,
  );
  const json = JSON.stringify(file);
  assert.ok(!json.includes("hunter2"), "SecretStorage password leaked into the export");
  assert.ok(!json.includes("kp"), "SSH passphrase leaked into the export");
  assert.ok(!json.includes(":p@"), "connection-string password leaked into the export");
  assert.strictEqual(file.secrets, "omitted");
  assert.strictEqual(file.connections[0].redactedCredentials, true);
  assert.deepStrictEqual(redactedNames, ["Staging"]);
});

test("export never carries the local id or schemaVersion", () => {
  const { file } = buildExport(
    [{ config: { id: "c1", schemaVersion: 1, type: "mysql", name: "M", host: "h" } }],
    OPTS,
  );
  assert.strictEqual(file.connections[0].id, undefined);
  assert.strictEqual(file.connections[0].schemaVersion, undefined);
});

test("encrypted export keeps secrets and leaves connection strings intact", () => {
  const { file } = buildExport(
    [
      {
        config: {
          id: "c1",
          type: "postgres",
          name: "S",
          connectionString: "postgresql://u:p@h/db",
        },
        secrets: { password: "hunter2" },
      },
    ],
    { ...OPTS, includeSecrets: true },
  );
  assert.strictEqual(file.connections[0].password, "hunter2");
  assert.strictEqual(file.connections[0].connectionString, "postgresql://u:p@h/db");
  assert.strictEqual(file.secrets, "included");
});

// ------------------------------------------------------------------- import

const wrap = (connections) => JSON.stringify({ kind: EXPORT_KIND, version: 1, connections });

test("parseImport rejects a file that is not ours", () => {
  assert.throws(() => parseImport('{"kind":"dbeaver/export","connections":[]}'), /Not an Open DB/);
  assert.throws(() => parseImport("not json at all"), /valid JSON/);
  assert.throws(() => parseImport("[]"), /Not an Open DB/);
});

test("parseImport refuses a newer format version rather than guessing", () => {
  assert.throws(
    () => parseImport(JSON.stringify({ kind: EXPORT_KIND, version: 99, connections: [] })),
    /newer version/,
  );
});

test("parseImport points at the passphrase when handed an encrypted file", () => {
  const enc = JSON.stringify(encryptBundle("{}", "correct horse battery"));
  assert.throws(() => parseImport(enc), /passphrase/);
  assert.strictEqual(isEncryptedBundle(enc), true);
  assert.strictEqual(isEncryptedBundle(wrap([])), false);
});

test("parseImport drops unknown fields instead of spreading them into a config", () => {
  const { connections } = parseImport(
    wrap([
      {
        type: "postgres",
        name: "Ok",
        host: "h",
        port: 5432,
        evil: "rm -rf /",
        __proto__: { polluted: true },
        sshAuth: "not-a-real-mode",
      },
    ]),
  );
  assert.strictEqual(connections.length, 1);
  assert.strictEqual(connections[0].evil, undefined);
  assert.strictEqual(connections[0].sshAuth, undefined, "invalid sshAuth should be dropped");
  assert.strictEqual(connections[0].host, "h");
  assert.strictEqual(connections[0].port, 5432);
});

test("parseImport skips bad entries with a warning but keeps the good ones", () => {
  const { connections, warnings } = parseImport(
    wrap([
      { type: "oracle", name: "Nope" },
      { type: "postgres", name: "   " },
      null,
      { type: "postgres", name: "Good", host: "h" },
    ]),
  );
  assert.deepStrictEqual(
    connections.map((c) => c.name),
    ["Good"],
  );
  assert.strictEqual(warnings.length, 3);
});

test("parseImport coerces wrong-typed fields away rather than trusting them", () => {
  const { connections } = parseImport(
    wrap([{ type: "postgres", name: "N", port: "5432", ssl: "yes", host: 42 }]),
  );
  assert.strictEqual(connections[0].port, undefined);
  assert.strictEqual(connections[0].ssl, undefined);
  assert.strictEqual(connections[0].host, undefined);
});

// -------------------------------------------------------------------- merge

test("identityKey ignores the display name and matches the same server", () => {
  const a = {
    type: "postgres",
    name: "Prod",
    host: "DB.Host",
    port: 5432,
    username: "u",
    database: "app",
  };
  const b = {
    type: "postgres",
    name: "Production (copy)",
    host: "db.host",
    username: "u",
    database: "app",
  };
  assert.strictEqual(identityKey(a), identityKey(b), "default port + host case should not differ");
});

test("identityKey resolves a connection string to the same identity as separate fields", () => {
  const viaFields = {
    type: "postgres",
    name: "A",
    host: "db.host",
    port: 5432,
    username: "u",
    database: "app",
  };
  const viaString = {
    type: "postgres",
    name: "B",
    useConnectionString: true,
    connectionString: "postgresql://u:pw@db.host:5432/app",
  };
  assert.strictEqual(identityKey(viaFields), identityKey(viaString));
});

test("identityKey separates sqlite files and redis databases", () => {
  assert.notStrictEqual(
    identityKey({ type: "sqlite", name: "a", filePath: "/tmp/a.db" }),
    identityKey({ type: "sqlite", name: "b", filePath: "/tmp/b.db" }),
  );
  assert.notStrictEqual(
    identityKey({ type: "redis", name: "a", host: "h", redisDb: 0 }),
    identityKey({ type: "redis", name: "b", host: "h", redisDb: 3 }),
  );
});

test("merge appends and never touches what is already there", () => {
  const existing = [
    { id: "e1", type: "postgres", name: "Existing", host: "h1", database: "d", username: "u" },
  ];
  const { merged, added, skipped } = mergeConnections(
    existing,
    [{ type: "postgres", name: "New", host: "h2", database: "d", username: "u" }],
    mkId,
  );
  assert.strictEqual(merged.length, 2);
  assert.deepStrictEqual(merged[0], existing[0], "existing entry must be untouched");
  assert.strictEqual(added.length, 1);
  assert.strictEqual(skipped.length, 0);
  assert.ok(added[0].id && added[0].id !== "e1", "imported entries get a fresh id");
});

test("merge skips a connection that is already saved", () => {
  const existing = [
    {
      id: "e1",
      type: "postgres",
      name: "Mine",
      host: "h",
      port: 5432,
      database: "d",
      username: "u",
    },
  ];
  const incoming = [
    { type: "postgres", name: "Theirs", host: "h", database: "d", username: "u" },
    { type: "postgres", name: "Other", host: "h2", database: "d", username: "u" },
  ];
  const { added, skipped } = mergeConnections(existing, incoming, mkId);
  assert.deepStrictEqual(
    added.map((c) => c.name),
    ["Other"],
  );
  assert.deepStrictEqual(
    skipped.map((c) => c.name),
    ["Theirs"],
  );
});

test("importing the same file twice is a no-op the second time", () => {
  const incoming = [
    { type: "postgres", name: "A", host: "ha", database: "d", username: "u" },
    { type: "redis", name: "B", host: "hb", redisDb: 0 },
  ];
  const first = mergeConnections([], incoming, mkId);
  assert.strictEqual(first.added.length, 2);
  const second = mergeConnections(first.merged, incoming, mkId);
  assert.strictEqual(second.added.length, 0);
  assert.strictEqual(second.skipped.length, 2);
  assert.strictEqual(second.merged.length, 2);
});

test("a name clash on a different server is renamed, not merged", () => {
  const existing = [{ id: "e1", type: "postgres", name: "Staging", host: "h1", username: "u" }];
  const { added } = mergeConnections(
    existing,
    [
      { type: "postgres", name: "Staging", host: "h2", username: "u" },
      { type: "postgres", name: "Staging", host: "h3", username: "u" },
    ],
    mkId,
  );
  assert.deepStrictEqual(
    added.map((c) => c.name),
    ["Staging (imported)", "Staging (imported 2)"],
  );
});

test("merge hands secrets back keyed by the new id, not left on the config", () => {
  const { added, secrets } = mergeConnections(
    [],
    [{ type: "postgres", name: "A", host: "h", username: "u", password: "pw", sshPassword: "sp" }],
    mkId,
  );
  const id = added[0].id;
  assert.strictEqual(added[0].password, undefined, "secret must not stay in the config");
  assert.strictEqual(added[0].redactedCredentials, undefined);
  assert.strictEqual(secrets.get(id).password, "pw");
  assert.strictEqual(secrets.get(id).sshPassword, "sp");
});

// ------------------------------------------------------------------- crypto

test("encrypted bundle round-trips", () => {
  const plain = JSON.stringify({ kind: EXPORT_KIND, version: 1, connections: [{ name: "x" }] });
  const bundle = encryptBundle(plain, "correct horse battery staple");
  assert.strictEqual(decryptBundle(JSON.stringify(bundle), "correct horse battery staple"), plain);
});

test("encrypted bundle does not leak plaintext and re-encrypts differently each time", () => {
  const plain = JSON.stringify({ password: "hunter2", host: "db.internal" });
  const a = JSON.stringify(encryptBundle(plain, "pw"));
  const b = JSON.stringify(encryptBundle(plain, "pw"));
  assert.ok(!a.includes("hunter2") && !a.includes("db.internal"));
  assert.notStrictEqual(a, b, "salt/iv must be random per export");
});

test("wrong passphrase fails loudly", () => {
  const bundle = JSON.stringify(encryptBundle("secret data", "right"));
  assert.throws(() => decryptBundle(bundle, "wrong"), /Wrong passphrase/);
});

test("a tampered bundle is rejected by the auth tag", () => {
  const bundle = encryptBundle("secret data", "pw");
  const data = Buffer.from(bundle.data, "base64");
  data[0] ^= 0xff;
  bundle.data = data.toString("base64");
  assert.throws(() => decryptBundle(JSON.stringify(bundle), "pw"), /Wrong passphrase|modified/);
});

test("decryptBundle rejects a file that is not an encrypted bundle", () => {
  assert.throws(() => decryptBundle(wrap([]), "pw"), /Not an encrypted/);
  assert.throws(() => decryptBundle("nonsense", "pw"), /valid JSON/);
});
