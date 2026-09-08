#!/usr/bin/env node
// Release helper: publish the CURRENT version as a GitHub Release, with the
// notes taken from CHANGELOG.md and the built .vsix attached.
//
// This is the last manual step in the release chain: `release:*` cuts the
// version and builds the .vsix, `publish:marketplace` publishes and pushes the
// tag — and then the GitHub release page was being written by hand, which is
// how a repo ends up with 22 tags and one release. The notes are not authored
// here: CHANGELOG.md is already the source of truth for what shipped, so this
// reads that section rather than inventing a second description of the release.
//
// Usage:
//   npm run release:github                 # create the release for package.json's version
//   npm run release:github -- --dry-run    # print the notes and the plan, publish nothing
//   npm run release:github -- --draft      # create it as a draft to review first
//   npm run release:github -- --no-generated-notes   # changelog only, no PR list
//
// Auth, in order of preference:
//   1. the `gh` CLI if it is on PATH and logged in (no token to manage)
//   2. GITHUB_TOKEN / GH_TOKEN, used against the REST API
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const draft = args.includes("--draft");
// GitHub can append its own "What's Changed" (merged PRs, contributors) and a
// Full Changelog compare link. Worth having ON TOP of the changelog, not
// instead of it: its notes are built from PR titles, and a PR called
// "Feature/UI ux improvements" tells a user nothing about what shipped. The
// changelog says what changed; the generated part says where it came from.
const generated = !args.includes("--no-generated-notes");

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version, name } = pkg;
const tag = `v${version}`;

// owner/repo from the declared repository, so this never guesses a remote.
const repoUrl = pkg.repository?.url ?? "";
const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoUrl);
if (!m) fail(`Could not read owner/repo from package.json "repository.url" (${repoUrl}).`);
const [, owner, repo] = m;

const git = (cmd) => execSync(`git ${cmd}`, { cwd: root }).toString().trim();

// ---- guards ---------------------------------------------------------------
// Deliberately the same shape as publish.mjs: a release must correspond exactly
// to a released commit, never to whatever happens to be in the tree.

const dirty = git("status --porcelain");
if (dirty) fail(`Working tree is not clean — commit or stash first:\n${dirty}`);

if (!git("tag --list").split("\n").includes(tag)) {
  fail(`Tag ${tag} does not exist locally. Cut the version with \`npm run release:*\` first.`);
}

// The tag must be on the remote BEFORE the release is created. GitHub will
// happily create a release for a tag it cannot find by cutting a new one from
// the default branch — which silently points the release at the wrong commit.
const remoteTag = git(`ls-remote --tags origin refs/tags/${tag}`);
if (!remoteTag) {
  fail(
    `Tag ${tag} is not on origin. Push it first (\`git push --tags\`), or run ` +
      `\`npm run publish:marketplace\`, which pushes as part of publishing.`,
  );
}

// ---- release notes, straight from the changelog ----------------------------

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const notes = sectionFor(changelog, version);
if (!notes) {
  fail(
    `CHANGELOG.md has no "## [${version}]" section, or it is empty. Cut releases ` +
      `with \`npm run release:patch|minor|major\`, which stamps it.`,
  );
}

/** The body of one `## [x.y.z] - date` section, up to the next `## ` heading. */
function sectionFor(text, v) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

// ---- the .vsix -------------------------------------------------------------
// Attached so the release is installable without the Marketplace — the whole
// point of a GitHub release for a VS Code extension. Missing is a warning, not
// a failure: a notes-only release still beats no release.

const vsix = join(root, `${name}-${version}.vsix`);
const hasVsix = existsSync(vsix);
if (!hasVsix) {
  console.warn(`⚠ ${name}-${version}.vsix not found — releasing without an attached build.`);
  console.warn("  Build it with `npm run package` if you want it attached.");
}

console.log(`Release ${tag} for ${owner}/${repo}${draft ? " (draft)" : ""}`);
console.log(
  hasVsix
    ? `Asset: ${name}-${version}.vsix (${(statSync(vsix).size / 1048576).toFixed(1)} MB)`
    : "Asset: none",
);
console.log(`\n--- notes ---\n${notes}\n-------------`);
console.log(
  generated
    ? 'GitHub will append its own "What\'s Changed" (merged PRs) and a Full Changelog compare link below this.\n'
    : "--no-generated-notes: the changelog section above is the entire body.\n",
);

if (dryRun) {
  console.log("Dry run — nothing published.");
  process.exit(0);
}

// ---- publish ---------------------------------------------------------------

const hasGh = spawnSync("gh", ["--version"], { stdio: "ignore", shell: true }).status === 0;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (hasGh) {
  await viaGhCli();
} else if (token) {
  await viaRestApi(token);
} else {
  fail(
    "No way to authenticate. Either install the GitHub CLI (`brew install gh && gh auth login`), " +
      "or set GITHUB_TOKEN to a token with `contents: write` on this repo.",
  );
}

async function viaGhCli() {
  // --notes-file rather than --notes: the body is markdown with newlines and
  // backticks, and passing that through a shell argument is a quoting trap.
  const notesFile = join(tmpdir(), `release-notes-${version}-${process.pid}.md`);
  writeFileSync(notesFile, notes, "utf8");
  try {
    const cmd = ["release", "create", tag, "--title", `v${version}`, "--notes-file", notesFile];
    // Both flags together: gh sends the body AND generate_release_notes, and
    // the API pre-pends the body to what it generates.
    if (generated) cmd.push("--generate-notes");
    if (draft) cmd.push("--draft");
    if (hasVsix) cmd.push(vsix);
    const res = spawnSync("gh", cmd, { cwd: root, stdio: "inherit" });
    if (res.status !== 0) fail(`gh release create exited with ${res.status}`);
  } finally {
    unlinkSync(notesFile);
  }
  console.log(`\n✔ Released ${tag}.`);
}

async function viaRestApi(auth) {
  const api = "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${auth}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Idempotent: re-running after a partial failure must not create a second
  // release for the same tag.
  const existing = await fetch(`${api}/repos/${owner}/${repo}/releases/tags/${tag}`, { headers });
  if (existing.ok) {
    const { html_url } = await existing.json();
    fail(`A release for ${tag} already exists: ${html_url}`);
  }

  const created = await fetch(`${api}/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: `v${version}`,
      body: notes,
      draft,
      generate_release_notes: generated,
    }),
  });
  if (!created.ok) fail(`Creating the release failed: ${created.status} ${await created.text()}`);
  const release = await created.json();
  console.log(`Created ${release.html_url}`);

  if (hasVsix) {
    const upload = release.upload_url.replace(/\{.*}$/, `?name=${name}-${version}.vsix`);
    const res = await fetch(upload, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: readFileSync(vsix),
    });
    if (!res.ok) {
      // The release itself exists; say what is missing rather than pretending
      // the whole thing failed.
      console.error(`⚠ Release created, but attaching the .vsix failed: ${res.status}`);
      console.error("  Attach it by hand, or delete the release and re-run.");
      process.exit(1);
    }
    console.log(`Attached ${name}-${version}.vsix`);
  }
  console.log(`\n✔ Released ${tag}.`);
}
