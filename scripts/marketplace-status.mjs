#!/usr/bin/env node
// Marketplace status checker: is the extension live, and does the published
// version match the local package.json? Uses the public gallery API (no auth,
// no vsce login needed), so it also works in CI or on a fresh machine.
//
// Usage:
//   npm run marketplace:verify            # live version vs local, + install count
//   npm run marketplace:verify -- --ovsx  # also check Open VSX
//   npm run marketplace:show              # full `vsce show` listing (needs network only)
//
// Exit codes: 0 = published and matches local, 1 = not found or version drift —
// so it can gate CI steps or a post-publish check.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const {
  version: local,
  publisher,
  name,
} = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const id = `${publisher}.${name}`;

if (args.includes("--show")) {
  // Delegate to vsce for the full listing (description, categories, stats).
  const res = spawnSync("npx", ["--yes", "@vscode/vsce", "show", id], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  process.exit(res.status ?? 1);
}

// IncludeVersions | IncludeStatistics | IncludeLatestVersionOnly
const FLAGS = 1 | 256 | 512;
const res = await fetch(
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json;api-version=7.1-preview.1",
    },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: id }], pageSize: 1, pageNumber: 1 }],
      flags: FLAGS,
    }),
  },
);
if (!res.ok) {
  console.error(`✖ Marketplace API returned HTTP ${res.status} — try again later.`);
  process.exit(1);
}
const ext = (await res.json()).results?.[0]?.extensions?.[0];

console.log(`Local version:  ${id}@${local}`);
if (!ext) {
  console.log("Marketplace:    not found");
  console.log(
    "\nEither it hasn't been published yet, or a fresh publish is still being " +
      "validated (usually 5–10 minutes). Page once live:\n" +
      `https://marketplace.visualstudio.com/items?itemName=${id}`,
  );
  process.exit(1);
}

const live = ext.versions?.[0]?.version ?? "unknown";
const updated = ext.lastUpdated ? new Date(ext.lastUpdated).toISOString() : "unknown";
const installs = ext.statistics?.find((s) => s.statisticName === "install")?.value;
console.log(`Marketplace:    ${id}@${live} (last updated ${updated})`);
if (installs !== undefined) console.log(`Installs:       ${installs}`);
console.log(`Page:           https://marketplace.visualstudio.com/items?itemName=${id}`);

let drift = false;
if (live === local) {
  console.log(`\n✔ Marketplace is up to date with local (${local}).`);
} else {
  drift = true;
  console.log(
    `\n⚠ Version drift: local is ${local}, Marketplace has ${live}.` +
      (live < local
        ? ` Local is ahead — publish with \`npm run publish:marketplace\` (a very recent publish may still be validating).`
        : ` Marketplace is ahead — this checkout is behind; \`git pull --tags\`.`),
  );
}

if (args.includes("--ovsx")) {
  const ovsx = await fetch(`https://open-vsx.org/api/${publisher}/${name}`);
  if (ovsx.ok) {
    const { version: ovsxLive } = await ovsx.json();
    console.log(
      `Open VSX:       ${id}@${ovsxLive}${ovsxLive === local ? " ✔" : " ⚠ (differs from local)"}`,
    );
    if (ovsxLive !== local) drift = true;
  } else {
    console.log("Open VSX:       not published (see docs/PUBLISHING.md for the --ovsx flow)");
    drift = true;
  }
}

process.exit(drift ? 1 : 0);
