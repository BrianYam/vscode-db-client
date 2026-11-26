#!/usr/bin/env node
// Publish helper: push the *current* version to the VS Code Marketplace (and
// optionally Open VSX), but only from a properly released state. Guards the
// repo's versioning policy — versions are cut with `npm run release:*`, never
// by vsce — so publishing can't drift from CHANGELOG.md or ship a dirty tree.
//
// Usage:
//   npm run publish:marketplace              # checks, package once, `vsce publish`, git push + tags
//   npm run publish:marketplace -- --dry-run # checks only, publish nothing
//   npm run publish:marketplace -- --no-push # publish but skip the git push
//   npm run publish:marketplace -- --ovsx    # also Open VSX, same .vsix (needs OVSX_PAT)
//
// Auth: `npx @vscode/vsce login brianlab` once per machine (see
// docs/PUBLISHING.md). Open VSX reads its token from the OVSX_PAT env var —
// load it with `read -s "OVSX_PAT?Open VSX token: " && export OVSX_PAT`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertReleasedState, fail, packageVsix, root, run } from "./release-checks.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const alsoOvsx = args.includes("--ovsx");

const { version, publisher, name } = assertReleasedState();
// Check the token before anything goes out: failing after the Marketplace
// half has published would leave the two registries on different versions.
if (alsoOvsx && !process.env.OVSX_PAT) fail("--ovsx given but OVSX_PAT is not set.");

console.log(`✔ Checks passed for ${publisher}.${name}@${version}`);
if (dryRun) {
  console.log("Dry run — not publishing.");
  process.exit(0);
}

// Package once and hand both registries the same file (see packageVsix).
const vsix = packageVsix(name, version);

console.log("\nPublishing to the VS Code Marketplace…");
run("npx", ["--yes", "@vscode/vsce", "publish", "--packagePath", vsix]);

if (alsoOvsx) {
  console.log("\nPublishing to Open VSX…");
  run("npx", ["--yes", "ovsx", "publish", vsix]);
}

// The version is now public — the release commit + tag must not stay local.
// (release:* deliberately doesn't push, so a bad bump can still be undone;
// past this point there is nothing left to undo.)
if (args.includes("--no-push")) {
  console.log(
    `\n✔ Published ${publisher}.${name}@${version}. --no-push given — remember: git push && git push --tags`,
  );
} else {
  console.log("\nPushing release commit + tags…");
  run("git", ["push"]);
  run("git", ["push", "--tags"]);
  console.log(`\n✔ Published ${publisher}.${name}@${version} and pushed the release to origin.`);
  cutGithubRelease();
}

/**
 * Create the GitHub release too, now that the tag is on origin.
 *
 * Deliberately NOT fatal. Everything irreversible has already happened by this
 * point — the Marketplace has the version and the tag is pushed — so exiting
 * non-zero here would report a failed publish that actually succeeded. A
 * missing release page is a thing you can add in one command afterwards.
 */
function cutGithubRelease() {
  console.log("\nCreating the GitHub release…");
  const res = spawnSync("node", [join(root, "scripts", "github-release.mjs")], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (res.status !== 0) {
    console.warn(
      "\n⚠ The GitHub release was not created — the publish itself was fine. " +
        "Run `npm run release:github` once the reason above is dealt with.",
    );
  }
}
