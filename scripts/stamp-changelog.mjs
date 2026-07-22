#!/usr/bin/env node
// Release helper: turn the accumulating "## [Unreleased]" section into a dated
// "## [x.y.z]" section for the version currently in package.json, and leave a
// fresh empty "## [Unreleased]" on top for the next cycle.
//
// Run automatically by the `version` npm lifecycle hook (see package.json), so
// every `npm version` / `npm run release:*` keeps CHANGELOG.md in lock-step with
// the version number. Idempotent: if the version already has a section, it's a
// no-op (safe to re-run).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");

if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG already has a [${version}] section — nothing to stamp.`);
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const marker = "## [Unreleased]";
if (!changelog.includes(marker)) {
  console.error(`CHANGELOG.md has no "${marker}" section to release — aborting.`);
  process.exit(1);
}

// Insert the dated heading directly after [Unreleased], so the entries that were
// accumulating there now belong to this version and [Unreleased] resets to empty.
const stamped = changelog.replace(marker, `${marker}\n\n## [${version}] - ${today}`);
writeFileSync(changelogPath, stamped, "utf8");
console.log(`Stamped CHANGELOG.md: [Unreleased] -> [${version}] - ${today}`);
