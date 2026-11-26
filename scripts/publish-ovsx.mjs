#!/usr/bin/env node
// Publish the *current* version to Open VSX only (Cursor, VSCodium, Gitpod…).
// For a normal release use `npm run publish:marketplace -- --ovsx`, which sends
// one .vsix to both registries. This exists for publishing to Open VSX on its
// own — e.g. a version already live on the Marketplace that Open VSX lacks.
//
// Usage:
//   npm run publish:ovsx                          # checks, package, publish
//   npm run publish:ovsx -- --dry-run             # checks only, publish nothing
//   npm run publish:ovsx -- --vsix path/to.vsix   # publish an existing file as-is
//
// Auth: the token is read from the OVSX_PAT env var, which `ovsx` picks up
// itself — it is never passed on a command line, so it can't land in shell
// history or process listings. Load it with:
//   read -s "OVSX_PAT?Open VSX token: " && export OVSX_PAT
import { existsSync } from "node:fs";
import { assertReleasedState, fail, packageVsix, run } from "./release-checks.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const vsixIdx = args.indexOf("--vsix");
const givenVsix = vsixIdx >= 0 ? args[vsixIdx + 1] : undefined;
if (vsixIdx >= 0 && !givenVsix) fail("--vsix needs a file path.");
if (givenVsix && !existsSync(givenVsix)) fail(`No such file: ${givenVsix}`);

const { version, publisher, name } = assertReleasedState();
// The already-published check below is for package.json's version, so a file
// built for a different one would slip past it.
if (givenVsix && !givenVsix.endsWith(`-${version}.vsix`)) {
  fail(`${givenVsix} does not look like a ${version} build (expected *-${version}.vsix).`);
}

if (!process.env.OVSX_PAT) {
  fail('OVSX_PAT is not set. Run: read -s "OVSX_PAT?Open VSX token: " && export OVSX_PAT');
}

// Open VSX rejects a version it already has; asking first turns that into a
// clear message instead of a failed upload after a full production build.
const existing = await fetch(`https://open-vsx.org/api/${publisher}/${name}/${version}`);
if (existing.ok)
  fail(`${publisher}.${name}@${version} is already on Open VSX — cut a new version to publish.`);

// An unverified namespace hides its extensions, so the check above can't see
// an inactive upload of this version — Open VSX would then reject a re-publish.
const ns = await fetch(`https://open-vsx.org/api/${publisher}`);
if (ns.ok && (await ns.json()).verified === false) {
  console.warn(
    `⚠ Namespace "${publisher}" is not verified on Open VSX: this upload will stay inactive until the ` +
      "claim is approved, and an earlier inactive upload of this version can't be detected from here.",
  );
}

console.log(`✔ Checks passed for ${publisher}.${name}@${version} (not live on Open VSX)`);
if (dryRun) {
  console.log("Dry run — not publishing.");
  process.exit(0);
}

const vsix = givenVsix ?? packageVsix(name, version);
console.log(`\nPublishing ${vsix} to Open VSX…`);
run("npx", ["--yes", "ovsx", "publish", vsix]);

console.log(
  `\n✔ Published ${publisher}.${name}@${version} to Open VSX.` +
    "\n  Check it:  npm run marketplace:verify -- --ovsx" +
    `\n  Listing:   https://open-vsx.org/extension/${publisher}/${name}` +
    "\n  Cursor's mirror can lag Open VSX by hours — not finding it there yet is not a failed publish.",
);
