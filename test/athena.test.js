// Athena driver: the frozen persisted-config contract, plus the result-reading
// helpers that GetQueryResults makes non-obvious ([SDD][M-ATH]).
const { test } = require("node:test");
const assert = require("node:assert");
const {
  AthenaDriver,
  describeDml,
  formatBytes,
  pageSize,
  stripHeaderRow,
} = require("../out/drivers/athena.js");

/*
 * Verbatim shapes of the two Athena connections already persisted in
 * globalState before this rewrite. They are fixtures, not examples: the whole
 * point of the rewrite was that these keep working without being re-entered, so
 * renaming a field in ConnectionConfig has to fail here rather than silently
 * orphan a saved connection at runtime.
 */
const SAVED_KEYS_MODE = {
  id: "c_aj954fqfmt3rxr1v",
  type: "athena",
  name: "aerobus-athena-ak",
  host: "127.0.0.1",
  port: 5432,
  redisDb: 0,
  sshEnabled: false,
  sshPort: 22,
  sshAuth: "auto",
  sshConnectTimeout: 5000,
  awsAuthMode: "keys",
  awsRegion: "ap-southeast-1",
  awsAccessKeyId: "AKIAEXAMPLEEXAMPLE00",
  athenaWorkgroup: "aerobus-staging-wg",
  athenaOutputLocation: "s3://example-bucket/athena-results/",
  schemaVersion: 1,
};

const SAVED_PROFILE_MODE = {
  id: "c_2yc0wh43mt3s7dpv",
  type: "athena",
  name: "aerobus-athena-profile",
  host: "127.0.0.1",
  port: 5432,
  redisDb: 0,
  sshEnabled: false,
  sshPort: 22,
  sshAuth: "auto",
  sshConnectTimeout: 5000,
  awsAuthMode: "profile",
  awsRegion: "ap-southeast-1",
  awsProfile: "example-profile",
  athenaWorkgroup: "aerobus-staging-wg",
  schemaVersion: 1,
};

test("a saved keys-mode connection is read back by its persisted field names", () => {
  const d = new AthenaDriver(SAVED_KEYS_MODE);
  assert.strictEqual(d.workgroup, "aerobus-staging-wg");
  // Absent from the record and from the form, but still defaulted, not dropped.
  assert.strictEqual(d.catalog, "AwsDataCatalog");
});

test("a saved profile-mode connection is read back by its persisted field names", () => {
  const d = new AthenaDriver(SAVED_PROFILE_MODE);
  assert.strictEqual(d.workgroup, "aerobus-staging-wg");
  assert.strictEqual(d.config.awsProfile, "example-profile");
  assert.strictEqual(d.config.awsAuthMode, "profile");
});

test("keys mode resolves the secret from SecretStorage, never from the config", () => {
  const d = new AthenaDriver(SAVED_KEYS_MODE);
  const creds = d.credentialProvider({ awsSecretAccessKey: "s3cret", awsSessionToken: "tok" });
  assert.strictEqual(creds.accessKeyId, "AKIAEXAMPLEEXAMPLE00");
  assert.strictEqual(creds.secretAccessKey, "s3cret");
  assert.strictEqual(creds.sessionToken, "tok");
});

test("keys mode with no stored secret fails loudly rather than falling back", () => {
  const d = new AthenaDriver(SAVED_KEYS_MODE);
  // Silently dropping to the ambient provider chain here would connect as
  // whatever role the machine happens to hold — a different account than the
  // one the user configured, which is worse than an error.
  assert.throws(() => d.credentialProvider({}), /secret access key are required/i);
});

test("profile mode returns a provider, so the SDK can refresh SSO sessions", () => {
  const d = new AthenaDriver(SAVED_PROFILE_MODE);
  assert.strictEqual(typeof d.credentialProvider({}), "function");
});

test("connect without a region refuses before building a client", async () => {
  const d = new AthenaDriver({ ...SAVED_PROFILE_MODE, awsRegion: "" });
  await assert.rejects(() => d.connect({}), /region is required/i);
});

test("cancelling a token that was never started is a no-op, not an error", async () => {
  const d = new AthenaDriver(SAVED_PROFILE_MODE);
  await d.cancel("no-such-token");
});

// ---- result reading -------------------------------------------------------

test("page one asks for one extra row to pay for the repeated header", () => {
  assert.strictEqual(pageSize(100, false), 101);
  assert.strictEqual(pageSize(100, true), 100);
});

test("the extra row is not requested past Athena's 1000 ceiling", () => {
  assert.strictEqual(pageSize(1000, false), 1000);
  assert.strictEqual(pageSize(5000, false), 1000);
  assert.strictEqual(pageSize(undefined, false), 1000);
});

const row = (...vals) => ({ Data: vals.map((v) => ({ VarCharValue: v })) });

test("the repeated header row is detected and dropped", () => {
  const rows = [row("id", "name"), row("1", "ana")];
  assert.deepStrictEqual(stripHeaderRow(rows, ["id", "name"]), [rows[1]]);
});

test("a data row that merely looks like data is kept", () => {
  const rows = [row("1", "ana"), row("2", "bo")];
  assert.deepStrictEqual(stripHeaderRow(rows, ["id", "name"]), rows);
});

test("a genuine first row is only dropped when it matches every column name", () => {
  // Detect rather than assume: a table whose first row happens to hold one
  // column's own name must not lose that row.
  const rows = [row("id", "bo"), row("1", "ana")];
  assert.deepStrictEqual(stripHeaderRow(rows, ["id", "name"]), rows);
});

test("stripHeaderRow copes with empty results and unknown columns", () => {
  assert.deepStrictEqual(stripHeaderRow([], ["id"]), []);
  const rows = [row("1")];
  assert.deepStrictEqual(stripHeaderRow(rows, []), rows);
});

test("statements that return no rows say what they did", () => {
  assert.strictEqual(describeDml("  create external table t (a int)"), "CREATE completed.");
  assert.strictEqual(describeDml("MSCK REPAIR TABLE t"), "MSCK completed.");
  assert.strictEqual(describeDml(""), "Statement completed.");
});

test("bytes scanned are shown in the unit Athena bills in", () => {
  assert.strictEqual(formatBytes(0), "0 B");
  assert.strictEqual(formatBytes(512), "512 B");
  assert.strictEqual(formatBytes(1024), "1.0 KB");
  assert.strictEqual(formatBytes(1536), "1.5 KB");
  assert.strictEqual(formatBytes(1024 ** 4), "1.0 TB");
});
