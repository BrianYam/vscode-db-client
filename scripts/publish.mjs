#!/usr/bin/env node
// Publish helper: push the *current* version to the VS Code Marketplace (and
// optionally Open VSX), but only from a properly released state. Guards the
// repo's versioning policy — versions are cut with `npm run release:*`, never
// by vsce — so publishing can't drift from CHANGELOG.md or ship a dirty tree.
//
// Usage:
//   npm run publish:marketplace              # checks, then `vsce publish`
//   npm run publish:marketplace -- --dry-run # checks only, publish nothing
//   OVSX_PAT=… npm run publish:marketplace -- --ovsx   # also Open VSX
//
// Auth: `npx @vscode/vsce login brianlab` once per machine (see
// docs/PUBLISHING.md). Open VSX reads its token from the OVSX_PAT env var.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const alsoOvsx = args.includes("--ovsx");

const { version, publisher, name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

// 1. Clean tree — a publish must correspond exactly to a release commit.
const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
if (dirty) fail(`Working tree is not clean — commit or stash first:\n${dirty}`);

// 2. CHANGELOG must have a stamped section for this version (created by the
//    `version` hook during `npm run release:*`). Its absence means the version
//    was bumped some other way — refuse rather than publish unreleased state.
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${version}]`)) {
  fail(
    `CHANGELOG.md has no "## [${version}]" section. Cut releases with ` +
      `\`npm run release:patch|minor|major\`, then publish.`,
  );
}

// 3. The release tag should exist too (npm version creates it). Warn only —
//    it may legitimately be missing on a machine that pulled without tags.
const tags = execSync("git tag --list", { cwd: root }).toString();
if (!tags.split("\n").includes(`v${version}`)) {
  console.warn(`⚠ Tag v${version} not found locally (did you pull with --tags?).`);
}

console.log(`✔ Checks passed for ${publisher}.${name}@${version}`);
if (dryRun) {
  console.log("Dry run — not publishing.");
  process.exit(0);
}

const run = (cmd, cmdArgs) => {
  const res = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: true });
  if (res.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} exited with ${res.status}`);
};

// `vsce publish` runs vscode:prepublish (typecheck + production bundle) itself.
console.log("\nPublishing to the VS Code Marketplace…");
run("npx", ["--yes", "@vscode/vsce", "publish"]);

if (alsoOvsx) {
  if (!process.env.OVSX_PAT) fail("--ovsx given but OVSX_PAT is not set.");
  console.log("\nPublishing to Open VSX…");
  run("npx", ["--yes", "ovsx", "publish"]);
}

console.log(
  `\n✔ Published ${publisher}.${name}@${version}. Don't forget: git push && git push --tags`,
);
