// Fetches genuine brand icons from Devicon (MIT-licensed) into media/icons/,
// then generates a "-connected" variant of each with a green status dot.
//
//   node scripts/fetch-icons.mjs   (requires network access)
//
// Devicon: https://github.com/devicons/devicon  (MIT License)
// The brand marks themselves are trademarks of their respective owners; they
// are used here nominatively to identify the database engine.
//
// Robustness: each icon is fetched independently (one failure never aborts the
// others), with retries + backoff, from a CDN (jsDelivr) that isn't aggressively
// rate-limited, falling back to GitHub raw. A response is only written if it is
// actually SVG — so a rate-limit page can never corrupt an existing icon.

import { writeFile, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = new URL("../media/icons/", import.meta.url);

// our config `type` -> devicon "<dir>/<file>"
const ICONS = {
  postgres: "postgresql/postgresql-original.svg",
  mysql: "mysql/mysql-original.svg",
  redis: "redis/redis-original.svg",
  sqlite: "sqlite/sqlite-original.svg",
};

// Sources tried in order. jsDelivr is a CDN and rarely rate-limits.
const SOURCES = [
  (p) => `https://cdn.jsdelivr.net/gh/devicons/devicon@master/icons/${p}`,
  (p) => `https://raw.githubusercontent.com/devicons/devicon/master/icons/${p}`,
];

function isSvg(text) {
  return /^\s*(<\?xml|<svg)/i.test(text);
}

async function fetchSvg(path) {
  for (const src of SOURCES) {
    const url = src(path);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const text = await res.text();
          if (isSvg(text)) {
            return text;
          }
        }
      } catch {
        /* network hiccup — retry */
      }
      await sleep(400 * attempt); // backoff
    }
  }
  return null;
}

/** Inject a green status dot sized to the SVG's own viewBox. */
function withConnectedDot(svg) {
  const m = svg.match(/viewBox\s*=\s*["']\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  const w = m ? parseFloat(m[3]) : 128;
  const h = m ? parseFloat(m[4]) : 128;
  const cx = w * 0.8;
  const cy = h * 0.8;
  const r = Math.min(w, h) * 0.2;
  const dot =
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#3fb950" ` +
    `stroke="#ffffff" stroke-width="${r * 0.28}"/>`;
  return svg.replace(/<\/svg>\s*$/i, `${dot}</svg>`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const failed = [];
  for (const [type, path] of Object.entries(ICONS)) {
    const svg = await fetchSvg(path);
    if (!svg) {
      failed.push(type);
      console.log(`✗ ${type} — could not fetch (left existing icon untouched)`);
      continue;
    }
    await writeFile(new URL(`${type}.svg`, OUT), svg);
    await writeFile(new URL(`${type}-connected.svg`, OUT), withConnectedDot(svg));
    console.log(`✓ ${type} (+ connected)`);
    await sleep(300); // be gentle between icons
  }
  if (failed.length) {
    console.log(`\nFinished with ${failed.length} still on fallback: ${failed.join(", ")}.`);
    console.log("Re-run `npm run fetch-icons` to retry just those.");
  } else {
    console.log("\nAll four fetched. Rebuild with: npm run package");
  }
}

main().catch((e) => {
  console.error("fetch-icons failed:", e.message);
  process.exit(1);
});
