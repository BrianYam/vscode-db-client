// Shared guards for the publish scripts. A publish must correspond exactly to
// a release cut with `npm run release:*` — never a dirty tree or a version
// bumped some other way — whichever registry it is going to.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

export const run = (cmd, cmdArgs) => {
  const res = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: true });
  if (res.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} exited with ${res.status}`);
};

/** Returns the manifest identity once every check has passed. */
export function assertReleasedState() {
  const { version, publisher, name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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

  return { version, publisher, name };
}

/**
 * Build the .vsix once. Both registries are then handed this exact file, so
 * Cursor/VSCodium users get byte-for-byte what VS Code users get — letting each
 * CLI package on its own would produce two separate builds of "the same" version.
 * `vsce package` runs vscode:prepublish (typecheck + production bundle).
 */
export function packageVsix(name, version) {
  const file = `${name}-${version}.vsix`;
  run("npx", ["--yes", "@vscode/vsce", "package", "--out", file]);
  return file;
}
