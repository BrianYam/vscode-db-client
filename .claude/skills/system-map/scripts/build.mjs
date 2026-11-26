#!/usr/bin/env node
// Validates docs/system-map/map.json against the repo and renders
// <project>-system-map.html: one self-contained
// page with no dependencies and no network requests.
//
// map.json is the only committed source. The page is build output, kept out
// of git by the folder's .gitignore. Screenshots come from docs/screens/.
//
//   node build.mjs [--repo <root>] [--dir <docs dir>] [--screens <dir>]
//                  [--check] [--pdf] [--open] [--verbose]
//
//   --check    validate only; write nothing
//   --pdf      also write the How it works guide as <project>-guide.pdf, by
//              printing the document the page itself generates (needs
//              Playwright's Chromium). The page's "Guide PDF" button makes the
//              same PDF in the browser.
//
// The format is described in ../references/map-schema.md. Every error below
// stops the build: a map that points at something untrue is worse than none.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = opt("--repo", join(skillDir, "../../.."));
const mapDir = join(root, opt("--dir", "docs/system-map"));
const screensDir = join(root, opt("--screens", "docs/screens"));
const mapFile = join(mapDir, "map.json");

const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const readJson = (file, fallback) =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;

if (!existsSync(mapFile)) {
  console.error(`No ${relative(root, mapFile)}. Run the system-map skill.`);
  process.exit(1);
}
const map = JSON.parse(readFileSync(mapFile, "utf8"));

// ---------------------------------------------------------------- validate
const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const BASES = ["code", "record", "human", "inferred"];
// A component's kind decides its row on the board, unless `layer` says otherwise.
const LAYER_OF = {
  app: "frontend",
  service: "api",
  module: "domain",
  library: "domain",
  database: "data",
  storage: "data",
  queue: "data",
  external: "external",
  ops: "ops",
};
const LAYERS = [
  { id: "frontend", name: "Frontend", sub: "What people see and use" },
  { id: "api", name: "API", sub: "The doors the apps knock on" },
  { id: "domain", name: "Business logic", sub: "Where the rules live" },
  { id: "data", name: "Data", sub: "Where things are kept" },
  {
    id: "external",
    name: "Outside services",
    sub: "Things we rent, not build",
  },
  { id: "ops", name: "Ops", sub: "How it ships and runs" },
];

for (const k of ["meta", "overview", "components", "journeys", "startHere"]) {
  if (!map[k]) fail(`map.json: missing "${k}"`);
}
if (errors.length) {
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
for (const k of ["project", "defaultBranch", "commit", "buildCommand"]) {
  if (!map.meta[k]) fail(`meta.${k} is required`);
}
for (const k of ["areas", "glossary", "decisions", "dangerZones", "openQuestions", "changelog"]) {
  map[k] ??= [];
}

const lineCounts = new Map();
const linesIn = (file) => {
  if (!lineCounts.has(file)) {
    lineCounts.set(file, readFileSync(join(root, file), "utf8").split("\n").length);
  }
  return lineCounts.get(file);
};
const claims = { code: 0, record: 0, human: 0, inferred: 0 };
const answered = new Set(map.openQuestions.filter((q) => q.status === "answered").map((q) => q.id));

function checkRefs(refs, where) {
  for (const r of refs || []) {
    if (r.file) {
      const full = join(root, r.file);
      if (!existsSync(full)) {
        fail(`${where}: file not found "${r.file}"`);
        continue;
      }
      if (r.line != null) {
        if (statSync(full).isDirectory()) {
          fail(`${where}: "${r.file}" is a folder, so it has no line ${r.line}`);
        } else {
          const n = linesIn(r.file);
          if (r.line < 1 || r.line > n || (r.endLine ?? r.line) > n) {
            fail(`${where}: "${r.file}" has ${n} lines, not line ${r.endLine ?? r.line}`);
          }
        }
      }
    } else if (r.answer) {
      if (!answered.has(r.answer)) {
        fail(`${where}: ref to ${r.answer}, which is not an answered question`);
      }
    } else if (r.mr == null && !r.commit && !r.url) {
      fail(`${where}: a ref needs one of file, mr, commit, url, answer`);
    }
  }
}
/** A claim: its basis, and the refs that basis requires. */
function checkClaim(x, where, basisKey = "basis", refsKey = "refs") {
  const basis = x[basisKey];
  const refs = x[refsKey] || [];
  if (!BASES.includes(basis)) {
    fail(`${where}: ${basisKey} must be one of ${BASES.join(", ")}`);
    return;
  }
  claims[basis]++;
  if (basis === "code" && !refs.some((r) => r.file)) {
    fail(`${where}: basis "code" needs a file ref`);
  }
  if (basis === "record" && !refs.some((r) => r.file || r.mr != null || r.commit || r.url)) {
    fail(`${where}: basis "record" needs a ref to the record`);
  }
  if (basis === "human" && !refs.some((r) => r.answer)) {
    fail(`${where}: basis "human" needs an answer ref`);
  }
  checkRefs(refs, where);
}

// Plain-language check: text a reader of the guide sees should carry no code.
const IDENT =
  /`[^`]+`|\b(?!iPad\b|iPhone\b|iOS\b|macOS\b)[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]+\b|\b(?:GET|POST|PUT|PATCH|DELETE) \/|\b\w+\/[\w/]+\.\w+\b/;
function plain(text, where) {
  const m = IDENT.exec(text || "");
  if (m) warn(`${where}: "${m[0]}" reads like code; move it to tech`);
}

const ids = {
  area: new Set(),
  component: new Set(),
  journey: new Set(),
  glossary: new Set(),
  decision: new Set(),
  dangerZone: new Set(),
  question: new Set(),
};
const claim = (set, id, what) => {
  if (!id) fail(`${what} without an id`);
  else if (!/^[A-Za-z0-9-]+$/.test(id)) fail(`${what} "${id}": ids are letters, digits and dashes`);
  else if (set.has(id)) fail(`${what} id used twice: ${id}`);
  set.add(id);
};
for (const a of map.areas) claim(ids.area, a.id, "area");
for (const c of map.components) claim(ids.component, c.id, "component");
for (const j of map.journeys) claim(ids.journey, j.id, "journey");
for (const g of map.glossary) claim(ids.glossary, g.id, "glossary entry");
for (const d of map.decisions) claim(ids.decision, d.id, "decision");
for (const z of map.dangerZones) claim(ids.dangerZone, z.id, "danger zone");
for (const q of map.openQuestions) {
  claim(ids.question, q.id, "open question");
  if (!/^Q-\d{3,}$/.test(q.id || ""))
    fail(`open question "${q.id}": id is Q- and three or more digits`);
}
const need = (kind, id, where) => {
  if (!ids[kind].has(id)) fail(`${where}: unknown ${kind} "${id}"`);
};

plain(map.overview.summary, "overview.summary");
for (const l of map.overview.loop || []) plain(l, "overview.loop");

for (const c of map.components) {
  const at = `component ${c.id}`;
  if (!c.name || !c.summary) fail(`${at}: needs a name and a summary`);
  if (!LAYER_OF[c.kind]) fail(`${at}: kind must be one of ${Object.keys(LAYER_OF).join(", ")}`);
  if (c.layer && !LAYERS.some((l) => l.id === c.layer)) fail(`${at}: unknown layer "${c.layer}"`);
  if (c.area) need("area", c.area, at);
  for (const p of c.paths || []) {
    if (!existsSync(join(root, p))) fail(`${at}: path not found "${p}"`);
  }
  for (const d of c.dependsOn || []) {
    need("component", d.id, at);
    if (!d.why) fail(`${at}: the arrow to ${d.id} needs a why`);
  }
  checkClaim(c, at);
}
for (const j of map.journeys) {
  const at = `journey ${j.id}`;
  if (!j.title || !j.actor || !j.trigger || !j.summary) {
    fail(`${at}: needs a title, an actor, a trigger and a summary`);
  }
  if (j.area) need("area", j.area, at);
  if (!j.steps?.length) fail(`${at}: needs steps`);
  const inGuide = j.audience !== "team";
  if (inGuide) {
    plain(j.summary, `${at} summary`);
    for (const r of j.rules || []) plain(r, `${at} rule`);
  }
  j.steps?.forEach((s, i) => {
    const sat = `${at} step ${i + 1}`;
    if (!s.title) fail(`${sat}: needs a title`);
    need("component", s.component, sat);
    checkClaim(s, sat);
    if (inGuide) {
      plain(s.title, sat);
      plain(s.detail, sat);
    }
  });
  const rel = j.related || {};
  for (const id of rel.glossary || []) need("glossary", id, at);
  for (const id of rel.dangerZones || []) need("dangerZone", id, at);
  for (const id of rel.decisions || []) need("decision", id, at);
  for (const id of rel.questions || []) need("question", id, at);
}
for (const g of map.glossary) {
  const at = `glossary ${g.id}`;
  if (!g.term || !g.definition) fail(`${at}: needs a term and a definition`);
  for (const id of g.components || []) need("component", id, at);
  checkClaim(g, at);
}
for (const d of map.decisions) {
  const at = `decision ${d.id}`;
  if (!d.title || !d.decision || !d.why) fail(`${at}: needs a title, a decision and a why`);
  for (const id of d.components || []) need("component", id, at);
  checkClaim(d, at);
  if (d.whyBasis) checkClaim(d, `${at} (why)`, "whyBasis", "whyRefs");
}
for (const z of map.dangerZones) {
  const at = `danger zone ${z.id}`;
  if (!z.title || !z.risk || !z.guidance) fail(`${at}: needs a title, a risk and guidance`);
  for (const id of z.components || []) need("component", id, at);
  checkClaim(z, at);
}
const SECURITY =
  /\b(password|token|session|auth|permission|access control|bypass|leak|expos|vulnerab|injection|rate.?limit)/i;
for (const q of map.openQuestions) {
  const at = `open question ${q.id}`;
  for (const id of q.relatesTo || []) {
    if (!["component", "journey", "decision", "dangerZone"].some((k) => ids[k].has(id))) {
      fail(`${at}: relatesTo "${id}" is not a component, journey, decision or danger zone`);
    }
  }
  if (!["open", "answered"].includes(q.status)) fail(`${at}: status is open or answered`);
  if (q.status === "answered" && !q.answer) fail(`${at}: answered needs an answer`);
  if (q.sensitive) {
    // A weakness spelled out in the map is a weakness published.
    if (!map.meta.securityContact) fail(`${at}: a sensitive question needs meta.securityContact`);
    if (!q.topic) fail(`${at}: a sensitive question needs a topic`);
    for (const k of ["question", "context", "refs", "tech"]) {
      if (q[k] && (!Array.isArray(q[k]) || q[k].length)) {
        fail(`${at}: a sensitive question carries no ${k}`);
      }
    }
    if (q.answer && q.answer.length > 120)
      fail(`${at}: a sensitive answer is a pointer of at most 120 characters`);
  } else {
    if (!q.question) fail(`${at}: needs a question`);
    checkRefs(q.refs, at);
    if (SECURITY.test(`${q.question} ${q.context || ""}`)) {
      warn(`${at}: reads as security-related; should it be sensitive?`);
    }
  }
}
for (const r of map.startHere.readingOrder || []) {
  if (!existsSync(join(root, r.path))) fail(`startHere.readingOrder: file not found "${r.path}"`);
}
for (const id of map.startHere.firstJourneys || []) need("journey", id, "startHere.firstJourneys");

// ---------------------------------------------------------------- database
// Optional. When map.json has a `database` key, docs/database/schema.json
// (written by the repo's schema export from the files in
// database.schemaDir) draws the Data tab. Its sourceHash must match those
// files now, so the diagram can never show tables that changed since.
const schemaDir = join(root, map.database?.schemaDir || "src/database/schema");
const dbModelFile = join(root, "docs/database/schema.json");
const dbmlFile = join(root, "docs/database/schema.dbml");
let dbModel = null;
if (map.database) {
  if (!existsSync(dbModelFile) || !existsSync(dbmlFile)) {
    fail("database: no docs/database/schema.json; run the schema export");
  } else {
    dbModel = JSON.parse(readFileSync(dbModelFile, "utf8"));
    const h = createHash("sha256");
    for (const f of readdirSync(schemaDir)
      .filter((x) => x.endsWith(".ts") && x !== "index.ts")
      .sort()) {
      h.update(f);
      h.update(readFileSync(join(schemaDir, f)));
    }
    if (h.digest("hex").slice(0, 16) !== dbModel.sourceHash) {
      fail("database: the schema changed since docs/database was written; rerun the schema export");
    }
    const tableNames = new Set(dbModel.tables.map((t) => t.name));
    const placed = new Map();
    for (const g of map.database.groups || []) {
      if (g.component) need("component", g.component, `database group ${g.name}`);
      for (const t of g.tables) {
        if (!tableNames.has(t)) fail(`database group ${g.name}: no table "${t}"`);
        if (placed.has(t)) fail(`database: table "${t}" is in two groups`);
        placed.set(t, g.name);
      }
    }
    for (const t of tableNames) {
      if (!placed.has(t))
        fail(`database: table "${t}" is in no group; add it to map.json database.groups`);
    }
  }
}

// ---------------------------------------------------------------- screens
// docs/screens/screens.json lists every screen and the journey steps that
// show it; manifest.json records which were captured, and at which commit.
const screenList = readJson(join(screensDir, "screens.json"), {
  screens: [],
}).screens;
const manifest = readJson(join(screensDir, "manifest.json"), {
  screens: [],
}).screens;
const capturedById = Object.fromEntries(manifest.map((m) => [m.id, m]));
const journeyById = Object.fromEntries(map.journeys.map((j) => [j.id, j]));
const screenIds = new Set();
for (const s of screenList) {
  const at = `screen ${s.id}`;
  if (screenIds.has(s.id)) fail(`${at}: id used twice`);
  screenIds.add(s.id);
  need("component", s.component, at);
  // `document`: a page of a PDF the app makes (A4); `email`: an email it
  // sends (a mail app's width, the whole message shown).
  if (!["web", "phone", "document", "email"].includes(s.platform))
    fail(`${at}: platform is web, phone, document or email`);
  for (const p of s.source || []) {
    if (!existsSync(join(root, p))) fail(`${at}: source not found "${p}"`);
  }
  for (const sh of s.shows || []) {
    const j = journeyById[sh.journey];
    if (!j) fail(`${at}: shows unknown journey "${sh.journey}"`);
    else if (!j.steps[sh.step]) {
      fail(
        `${at}: journey ${sh.journey} has no step ${sh.step}; if steps moved, update docs/screens/screens.json`,
      );
    }
  }
}
for (const m of manifest) {
  if (!screenIds.has(m.id)) fail(`manifest: "${m.id}" is not in screens.json`);
  else if (!existsSync(join(screensDir, m.file))) fail(`manifest: file not found "${m.file}"`);
}

if (errors.length) {
  console.error(`System map: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const open = map.openQuestions.filter((q) => q.status === "open").length;
const health = `valid: ${map.components.length} components, ${map.journeys.length} journeys, ${map.glossary.length} glossary, ${map.decisions.length} decisions, ${map.dangerZones.length} danger zones · claims: ${claims.code} code, ${claims.record} record, ${claims.human} human, ${claims.inferred} inferred · ${open} open questions · ${manifest.length} of ${screenList.length} screens`;
if (warnings.length) {
  console.log(
    `${warnings.length} plain-language or sensitivity warning(s)${flag("--verbose") ? ":" : " (--verbose to list)"}`,
  );
  if (flag("--verbose")) for (const w of warnings) console.log(`  ~ ${w}`);
}
if (flag("--check")) {
  console.log(health);
  process.exit(0);
}

// ---------------------------------------------------------------- page data
// The page reads one shape; map.json is turned into it here, so the format
// people and the skill edit can change without touching the page.
const mime = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" };
const shots = {};
let stale = 0;
const screensAt = {}; // journey id -> step index -> [screen ids]
for (const s of screenList) {
  for (const sh of s.shows || []) {
    screensAt[sh.journey] ??= {};
    screensAt[sh.journey][sh.step] ??= [];
    screensAt[sh.journey][sh.step].push(s.id);
  }
  const m = capturedById[s.id];
  if (!m) continue;
  // Out of date when a file that draws the screen changed after the capture.
  const changed =
    m.capturedAt && s.source?.length
      ? git("log", "--oneline", `${m.capturedAt}..HEAD`, "--", ...s.source)
      : "";
  if (changed) stale++;
  shots[s.id] = {
    src: `data:${mime[m.file.split(".").pop()]};base64,${readFileSync(join(screensDir, m.file)).toString("base64")}`,
    w: m.width,
    h: m.height,
    stale: Boolean(changed),
  };
}

const refPath = (r) => ({ path: r.file, line: r.line, note: r.note || r.label });
const fileRefs = (refs) => (refs || []).filter((r) => r.file).map(refPath);
const recordLabel = (refs) =>
  (refs || [])
    .map((r) => r.label || (r.mr != null ? `!${r.mr}` : r.commit) || "")
    .filter(Boolean)
    .join(", ");
const layerOf = (c) => c.layer || LAYER_OF[c.kind];
const commit = map.meta.commit;
// The publisher's mark (meta.mark, the product icon by default): shown in the
// page's header, as its favicon, and on the guide's cover and pages.
const markFile = map.meta.mark || "media/icon.svg";
if (!existsSync(join(root, markFile))) {
  console.error(`meta.mark: file not found "${markFile}"`);
  process.exit(1);
}
const mark = readFileSync(join(root, markFile), "utf8")
  .replace(/<\?xml[\s\S]*?\?>/g, "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\s+/g, " ")
  .trim();
// The folders whose commits make the map out of date (meta.codePaths).
const codePaths = map.meta.codePaths || ["src"];

const data = {
  meta: {
    sha: commit.slice(0, 7),
    branch: map.meta.defaultBranch,
    date: git("log", "-1", "--format=%cI", commit) || map.meta.generatedAt,
    // Commits to the code since the map was written.
    behind: Number(git("rev-list", "--count", `${commit}..HEAD`, "--", ...codePaths) || 0),
    generatedAt: map.meta.generatedAt,
    repoUrl: map.meta.repoUrl || "",
    forge: map.meta.forge || "github",
    release: git("describe", "--tags", "--abbrev=0", "--match", "v*"),
    buildCommand: map.meta.buildCommand,
    securityContact: map.meta.securityContact || "",
    publisher: map.meta.publisher || "BrianLab",
    license: map.meta.license || "",
    slug: "",
    mark,
  },
  system: {
    name: map.meta.project,
    client: map.meta.client || "",
    headline: map.meta.tagline || "",
    summary: map.overview.summary,
    actors: (map.overview.users || []).map((u) => ({
      name: u.name,
      does: u.goal,
    })),
    loop: map.overview.loop || [],
  },
  tiers: LAYERS,
  // Areas group the busy Business logic row, and the feature picker.
  groups: map.areas.map((a) => ({ id: a.id, tier: "domain", name: a.name })),
  areas: map.areas,
  parts: map.components.map((c) => ({
    id: c.id,
    tier: layerOf(c),
    group: c.area,
    name: c.name,
    summary: c.summary,
    lead: c.detail,
    basis: c.basis,
    responsible: c.responsibilities,
    code: fileRefs(c.refs),
    uses: (c.dependsOn || []).map((d) => ({ to: d.id, why: d.why })),
  })),
  features: map.journeys.map((j) => ({
    id: j.id,
    area: j.area,
    audience: j.audience,
    name: j.title,
    actor: j.actor,
    trigger: j.trigger,
    summary: j.summary,
    rules: j.rules || [],
    steps: j.steps.map((s, i) => ({
      part: s.component,
      title: s.title,
      detail: s.detail,
      basis: s.basis,
      hood: s.tech,
      refs: fileRefs(s.refs),
      screens: screensAt[j.id]?.[i] || [],
    })),
    check: (j.checks || []).map((c) => ({ q: c.question, a: c.answer })),
    concepts: j.related?.glossary || [],
    risks: j.related?.dangerZones || [],
    decisions: j.related?.decisions || [],
    questions: j.related?.questions || [],
  })),
  concepts: map.glossary.map((g) => ({
    id: g.id,
    term: g.term,
    aka: g.aliases || [],
    definition: g.definition,
    not: g.not,
    avoid: g.avoid,
    tech: g.engineering,
    basis: g.basis,
    parts: g.components || [],
    code: fileRefs(g.refs),
  })),
  decisions: map.decisions.map((d) => ({
    id: d.id,
    title: d.title,
    decision: d.decision,
    why: d.why,
    whyBasis: d.whyBasis,
    ref: recordLabel(d.refs),
    date: d.date,
    by: d.by,
    basis: d.basis,
    parts: d.components || [],
    code: fileRefs(d.refs),
  })),
  risks: map.dangerZones.map((z) => ({
    id: z.id,
    title: z.title,
    detail: z.risk,
    care: z.guidance,
    basis: z.basis,
    parts: z.components || [],
    code: fileRefs(z.refs),
  })),
  questions: map.openQuestions.map((q) => {
    const contact = map.meta.securityContact;
    return {
      id: q.id,
      // A sensitive question shows one neutral line and nothing else.
      title: q.sensitive ? `Open question on ${q.topic}, raised with ${contact}` : q.question,
      detail: q.sensitive
        ? "The details are with the security contact, not in this map."
        : q.context,
      owner: q.owner,
      ref: recordLabel(q.refs),
      meanwhile: q.meanwhile,
      sensitive: Boolean(q.sensitive),
      progress: q.progress,
      status: q.status,
      answer: q.answer,
      answeredBy: q.answeredBy,
      parts: (q.relatesTo || []).filter((id) => ids.component.has(id)),
      code: q.sensitive ? [] : fileRefs(q.refs),
    };
  }),
  screens: screenList.map((s) => ({
    id: s.id,
    part: s.component,
    kind: s.platform,
    group: s.group,
    title: s.caption,
    route: s.route,
    role: s.role,
    note: s.note,
  })),
  start: {
    read: map.startHere.readingOrder || [],
    trace: map.startHere.firstJourneys || [],
    run: (map.startHere.runLocally || []).map((r) => ({
      cmd: r.command,
      what: r.step,
    })),
    rules: map.startHere.rules || [],
  },
  changelog: map.changelog,
  database: dbModel
    ? {
        groups: map.database.groups,
        tables: dbModel.tables,
        refs: dbModel.refs,
        enums: dbModel.enums,
        dbml: readFileSync(dbmlFile, "utf8"),
      }
    : null,
};

// ---------------------------------------------------------------- render
const slug = map.meta.project
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
data.meta.slug = slug;
const pageName = `${slug}-system-map.html`;
const pdfName = `${slug}-guide.pdf`;
const outFile = join(mapDir, pageName);

// JSON inside <script>: keep "</script>" and "<!--" from ending the block.
const embed = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const asset = (f) => readFileSync(join(skillDir, "assets", f), "utf8");
/** Instrument Sans, embedded for the page itself. */
function uiFonts() {
  const dir = join(skillDir, "assets/fonts");
  return [400, 500, 600]
    .map((w) => [w, `instrument-sans-latin-${w}.woff2`])
    .filter(([, f]) => existsSync(join(dir, f)))
    .map(
      ([w, f]) =>
        `@font-face { font-family: "Instrument Sans"; font-weight: ${w}; font-style: normal; font-display: swap; src: url("data:font/woff2;base64,${readFileSync(join(dir, f)).toString("base64")}") format("woff2"); }`,
    )
    .join("\n");
}

/** The guide's print stylesheet with its fonts embedded. */
function guideCss() {
  const assets = join(skillDir, "assets");
  const b64 = (f) => readFileSync(join(assets, f)).toString("base64");
  const fonts = [
    ["Montserrat", 700, "montserrat-latin-700.woff2"],
    ["Montserrat", 800, "montserrat-latin-800.woff2"],
    ["Montserrat", 900, "montserrat-latin-900.woff2"],
    ["Inter", 400, "inter-latin-400.woff2"],
    ["Inter", 600, "inter-latin-600.woff2"],
  ]
    .filter(([, , f]) => existsSync(join(assets, "fonts", f)))
    .map(
      ([family, weight, f]) =>
        `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: normal; src: url("data:font/woff2;base64,${b64(`fonts/${f}`)}") format("woff2"); }`,
    )
    .join("\n");
  return asset("guide-print.css").replace("/*{{FONTS}}*/", fonts);
}

const fill = {
  "{{TITLE}}": `${map.meta.project} system map`,
  "{{BUILD_CMD}}": map.meta.buildCommand,
  "{{FAVICON}}": `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`,
  "{{CSS}}": asset("viewer.css").replace("/*{{FONTS}}*/", uiFonts()),
  "{{DATA}}": embed(data),
  "{{SHOTS}}": embed(shots),
  "{{GUIDE_CSS}}": guideCss().replace(/</g, "\\3c "),
  "{{JS}}": `${asset("guide.js")}\n${asset("viewer.js")}`,
};
const html = asset("template.html").replace(
  /\{\{(TITLE|BUILD_CMD|FAVICON|CSS|DATA|SHOTS|GUIDE_CSS|JS)\}\}/g,
  (m) => fill[m],
);
mkdirSync(mapDir, { recursive: true });
writeFileSync(outFile, html);

// The page and the PDF are build output: keep them out of git.
const ignoreFile = join(mapDir, ".gitignore");
const ignore = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
const wanted = ["*-system-map.html", "*-guide.pdf"].filter((l) => !ignore.split("\n").includes(l));
if (wanted.length) {
  writeFileSync(
    ignoreFile,
    `${ignore || "# Build output of the system map; map.json is the source.\n"}${wanted.join("\n")}\n`,
  );
}

console.log(health);
const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(
  `wrote ${relative(root, outFile)} (${mb} MB) · describes ${data.meta.branch} at ${data.meta.sha}${data.meta.behind ? `, ${data.meta.behind} app commits behind HEAD` : ""}${stale ? ` · ${stale} screens may be out of date` : ""}`,
);

// --pdf: the same guide the page's "Guide PDF" button makes, written to a
// file. It opens the page just built and prints the document the page itself
// generates, so there is one renderer, not two.
if (flag("--pdf")) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(outFile).href, { waitUntil: "load" });
    const doc = await page.evaluate(() => window.systemMapGuideDocument());
    await page.setContent(doc, { waitUntil: "load" });
    await page.pdf({
      path: join(mapDir, pdfName),
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
  const pdfMb = (statSync(join(mapDir, pdfName)).size / 1024 / 1024).toFixed(1);
  console.log(`wrote ${relative(root, join(mapDir, pdfName))} (${pdfMb} MB)`);
}

if (flag("--open")) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFileSync(cmd, [outFile]);
}
