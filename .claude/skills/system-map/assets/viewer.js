/* System map — viewer.
 * Plain browser JavaScript, no dependencies. `scripts/system-map.mjs` inlines
 * this file, viewer.css, the map data (#map-data) and the screenshots
 * (#map-shots) into one self-contained index.html.
 */
(() => {
  const D = JSON.parse(document.getElementById("map-data").textContent);
  const SHOTS = JSON.parse(document.getElementById("map-shots").textContent);

  // ---------------------------------------------------------------- indexes
  const KINDS = {
    feature: {
      label: "Feature",
      plural: "Features",
      icon: "▶",
      hint: "Something a person does",
    },
    part: {
      label: "Part",
      plural: "Parts",
      icon: "■",
      hint: "A piece of the codebase",
    },
    concept: {
      label: "Concept",
      plural: "Concepts",
      icon: "◆",
      hint: "A precise team word",
    },
    decision: {
      label: "Decision",
      plural: "Decisions",
      icon: "⚖",
      hint: "A choice, and why",
    },
    risk: {
      label: "Risk",
      plural: "Risks",
      icon: "⚠",
      hint: "Where changes bite",
    },
    question: {
      label: "Question",
      plural: "Questions",
      icon: "?",
      hint: "Not settled yet",
    },
  };
  const LISTS = {
    feature: D.features,
    part: D.parts,
    concept: D.concepts,
    decision: D.decisions,
    risk: D.risks,
    question: D.questions,
  };
  const by = {};
  for (const k of Object.keys(LISTS)) {
    by[k] = Object.fromEntries(LISTS[k].map((x) => [x.id, x]));
  }
  by.screen = Object.fromEntries(D.screens.map((s) => [s.id, s]));
  // The database: tables from the generated schema model, when the repo has one.
  const DB = D.database || { groups: [], tables: [], refs: [], enums: [] };
  // GitLab puts /-/ before blob and commit links; GitHub does not.
  const forgeSeg = D.meta.forge === "gitlab" ? "/-/" : "/";
  by.table = Object.fromEntries(DB.tables.map((t) => [t.name, t]));
  const groupOfTable = {};
  for (const g of DB.groups) for (const t of g.tables) groupOfTable[t] = g;
  const tierOf = Object.fromEntries(D.tiers.map((t) => [t.id, t]));
  const areaOf = Object.fromEntries(D.areas.map((a) => [a.id, a]));
  const BASIS = {
    code: "read from code",
    record: "from a record",
    human: "a teammate said",
    inferred: "inferred",
  };

  // part -> things that touch it
  const rel = {};
  for (const p of D.parts) {
    rel[p.id] = {
      features: [],
      risks: [],
      decisions: [],
      questions: [],
      concepts: [],
      inbound: [],
      screens: [],
    };
  }
  for (const f of D.features) {
    const seen = {};
    f.steps.forEach((s, i) => {
      if (!seen[s.part]) seen[s.part] = [];
      seen[s.part].push(i + 1);
    });
    for (const pid of Object.keys(seen)) {
      rel[pid].features.push({ f, nums: seen[pid] });
    }
  }
  for (const k of ["risk", "decision", "question", "concept"]) {
    for (const x of LISTS[k]) {
      for (const pid of x.parts || []) rel[pid][`${k}s`].push(x);
    }
  }
  for (const p of D.parts) {
    for (const u of p.uses || []) rel[u.to].inbound.push({ from: p.id, why: u.why });
  }
  for (const s of D.screens) rel[s.part].screens.push(s);

  // screen -> where it is shown; item -> features that mention it
  const screenUse = {};
  const mentions = { concept: {}, risk: {}, decision: {}, question: {} };
  for (const f of D.features) {
    f.steps.forEach((s, i) => {
      for (const sid of s.screens || []) {
        if (!screenUse[sid]) screenUse[sid] = [];
        screenUse[sid].push({ f, n: i + 1 });
      }
    });
    for (const k of Object.keys(mentions)) {
      for (const id of f[`${k}s`] || []) {
        if (!mentions[k][id]) mentions[k][id] = [];
        mentions[k][id].push(f);
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  /** Text for places that show no markup: drops the `code` and *emphasis* marks. */
  const plain = (s) => esc(String(s ?? "").replace(/[`*]/g, ""));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const termMap = new Map();
  for (const c of D.concepts) {
    for (const t of [c.term, ...(c.aka || [])]) {
      termMap.set(t.toLowerCase(), c.id);
      if (!/s$/i.test(t)) termMap.set(`${t.toLowerCase()}s`, c.id);
    }
  }
  const termRe = termMap.size
    ? new RegExp(
        `(?<![\\p{L}\\p{N}_-])(${[...termMap.keys()]
          .sort((a, b) => b.length - a.length)
          .map(reEsc)
          .join("|")})(?![\\p{L}\\p{N}_-])`,
        "giu",
      )
    : null;

  /** Escape text, render `code` and *emphasis*, and link the first use of each team word. */
  function rich(text, skipConcept) {
    const seen = new Set(skipConcept ? [skipConcept] : []);
    return String(text ?? "")
      .split(/(`[^`]+`|\*[^*\s][^*]*\*)/)
      .map((seg) => {
        if (seg.length > 2 && seg.startsWith("`") && seg.endsWith("`")) {
          return `<code>${esc(seg.slice(1, -1))}</code>`;
        }
        if (seg.length > 2 && seg.startsWith("*") && seg.endsWith("*")) {
          return `<i>${esc(seg.slice(1, -1))}</i>`;
        }
        if (!termRe) return esc(seg);
        let out = "";
        let last = 0;
        for (const m of seg.matchAll(termRe)) {
          const id = termMap.get(m[0].toLowerCase());
          if (seen.has(id)) continue;
          seen.add(id);
          out += `${esc(seg.slice(last, m.index))}<dfn class="term" data-go="concept:${id}" tabindex="0">${esc(m[0])}</dfn>`;
          last = m.index + m[0].length;
        }
        return out + esc(seg.slice(last));
      })
      .join("");
  }

  const fileUrl = (path) =>
    D.meta.repoUrl ? `${D.meta.repoUrl}${forgeSeg}blob/${D.meta.sha}/${path}` : null;
  function ref(path, note, line) {
    const url = fileUrl(path);
    const text = line ? `${path}:${line}` : path;
    const a = url
      ? `<a class="ref" href="${esc(url)}${line ? `#L${line}` : ""}" target="_blank" rel="noopener">${esc(text)}</a>`
      : `<span class="ref">${esc(text)}</span>`;
    return `<li>${a}${note ? `<span class="ref-note">${rich(note)}</span>` : ""}</li>`;
  }
  const refs = (list) =>
    list?.length
      ? `<ul class="refs">${list.map((r) => (typeof r === "string" ? ref(r) : ref(r.path, r.note, r.line))).join("")}</ul>`
      : "";

  const tierChip = (tid) => `<span class="chip tchip ti-${tid}">■ ${esc(tierOf[tid].name)}</span>`;
  const kindChip = (k) => `<span class="chip ty-${k}">${KINDS[k].icon} ${KINDS[k].label}</span>`;
  const basisChip = (b) => (b && BASIS[b] ? `<span class="basis b-${b}">${BASIS[b]}</span>` : "");

  /** [1,2,3,7] -> "1–3·7" */
  function runs(nums) {
    const out = [];
    let a = nums[0];
    let b = nums[0];
    for (let i = 1; i <= nums.length; i++) {
      if (nums[i] === b + 1) {
        b = nums[i];
        continue;
      }
      out.push(a === b ? `${a}` : b === a + 1 ? `${a}·${b}` : `${a}–${b}`);
      a = b = nums[i];
    }
    return out.join("·");
  }

  function ago(iso) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
    if (days <= 0) return "today";
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  const fmtDate = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  function shot(sid, opts = {}) {
    const s = by.screen[sid];
    if (!s) return "";
    const img = SHOTS[sid];
    const cls = `shot ${s.kind}${img ? "" : " missing"}${opts.small ? " small" : ""}`;
    const inner = img
      ? `<img src="${img.src}" alt="${esc(s.title)}" loading="lazy" width="${img.w}" height="${img.h}">${img.stale ? '<span class="stale">may be out of date</span>' : ""}`
      : '<span class="ph">not captured yet</span>';
    return `<button type="button" class="${cls}" data-shot="${sid}" title="${esc(s.title)}"><span class="frame">${inner}</span>${opts.caption === false ? "" : `<span class="cap">${esc(s.title)}</span>`}</button>`;
  }

  // ---------------------------------------------------------------- state
  const state = {
    view: "map",
    sel: null,
    trace: null,
    sub: "steps",
    q: "",
    kind: null,
    tier: null,
    tech: false,
  };
  const trail = [];

  try {
    state.tech = localStorage.getItem("sysmap.tech") === "1";
    const th = localStorage.getItem("sysmap.theme");
    if (th) document.documentElement.dataset.theme = th;
  } catch {
    // storage can be blocked; the page works without it
  }
  if (!document.documentElement.dataset.theme) {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function parseHash() {
    const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
    const [view, type, id] = path.split("/");
    state.view = [
      "map",
      "guide",
      "browse",
      "start",
      ...(D.screens.length ? ["screens"] : []),
      ...(DB.tables.length ? ["data"] : []),
    ].includes(view)
      ? view
      : "map";
    state.sel = type && by[type]?.[id] ? { type, id } : null;
    const t = new URLSearchParams(query || "").get("trace");
    state.trace = t && by.feature[t] ? t : null;
  }
  function hashFor(next) {
    const s = { view: state.view, sel: state.sel, trace: state.trace, ...next };
    let h = `#/${s.view}`;
    if (s.sel) h += `/${s.sel.type}/${s.sel.id}`;
    if (s.trace) h += `?trace=${s.trace}`;
    return h;
  }
  function nav(next) {
    const h = hashFor(next);
    if (h === location.hash) return render();
    if ("sel" in next && state.sel) trail.push(state.sel);
    location.hash = h;
  }
  function select(type, id, view) {
    const to = view ? { view } : {};
    if (type === "feature") {
      state.sub = "steps";
      nav({ sel: { type, id }, trace: id, ...to });
    } else nav({ sel: { type, id }, ...to });
  }

  // ---------------------------------------------------------------- top bar
  function renderTop() {
    // A repo with no screenshots or no database model gets no empty tab for it.
    const tabs = [
      ["map", "Map"],
      ["guide", "How it works"],
      ["browse", "Browse all"],
      D.screens.length ? ["screens", "All screens"] : null,
      DB.tables.length ? ["data", "Data"] : null,
      ["start", "Start here"],
    ].filter(Boolean);
    const groups = D.areas
      .map((a) => {
        const fs = D.features.filter((f) => f.area === a.id);
        if (!fs.length) return "";
        return `<optgroup label="${esc(a.name)}">${fs.map((f) => `<option value="${f.id}"${state.trace === f.id ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</optgroup>`;
      })
      .join("");
    $("#top").innerHTML = `
      <button type="button" class="brand" data-act="home" title="Back to the overview">
        <span class="mark" aria-hidden="true">${SystemMapGuide.brandMark(D)}</span>
        <b>${esc(D.system.name)}</b><small>system map</small>
      </button>
      <nav class="tabs" aria-label="Views">
        ${tabs.map(([v, l]) => `<button type="button" data-view="${v}"${state.view === v ? ' class="on" aria-current="page"' : ""}>${l}</button>`).join("")}
      </nav>
      <div class="right">
        <label class="trace${state.trace ? " on" : ""}"><span class="muted wide">Trace a feature</span>
          <select id="trace" aria-label="Trace a feature"><option value="">— none —</option>${groups}</select>
        </label>
        <button type="button" class="iconbtn${state.tech ? " on" : ""}" data-act="tech" aria-pressed="${state.tech}" title="Show file paths and implementation notes">{ } <span class="wide">Technical details</span></button>
        ${pdfLink("iconbtn", '⤓ <span class="wide">Guide PDF</span>')}
        <button type="button" class="iconbtn" data-act="theme" title="Switch light / dark" aria-label="Switch light or dark theme">◐</button>
      </div>`;
  }

  // ---------------------------------------------------------------- map
  function partCard(p, traced) {
    const r = rel[p.id];
    const nums = traced?.[p.id];
    const cls = [
      "part",
      `ti-${p.tier}`,
      state.sel?.type === "part" && state.sel.id === p.id ? "sel" : "",
      traced ? (nums ? "hit" : "dim") : "",
    ];
    const count = (n, k, icon) => (n ? `<i class="c-${k}">${icon} ${n}</i>` : "");
    return `<button type="button" class="${cls.join(" ")}" data-go="part:${p.id}" data-part="${p.id}">
      ${nums ? `<span class="badge">${runs(nums)}</span>` : ""}
      <b>${esc(p.name)}</b><span class="sum">${plain(p.summary)}</span>
      <span class="counts">${count(r.features.length, "feature", "▶")}${count(r.risks.length, "risk", "⚠")}${count(r.questions.length, "question", "?")}</span>
    </button>`;
  }

  function viewMap() {
    let traced = null;
    if (state.trace) {
      traced = {};
      by.feature[state.trace].steps.forEach((s, i) => {
        if (!traced[s.part]) traced[s.part] = [];
        traced[s.part].push(i + 1);
      });
    }
    const legend = `<div class="legend">
      ${D.tiers.map((t) => `<span class="chip tchip ti-${t.id}">■ ${esc(t.name)}</span>`).join("")}
      <button type="button" class="chip ty-feature" data-kind="feature">▶ features</button>
      <button type="button" class="chip ty-risk" data-kind="risk">⚠ risks</button>
      <button type="button" class="chip ty-question" data-kind="question">? open questions</button>
    </div>`;
    const tiers = D.tiers
      .map((t) => {
        const parts = D.parts.filter((p) => p.tier === t.id);
        if (!parts.length) return "";
        const groups = D.groups.filter((g) => g.tier === t.id);
        let body;
        if (groups.length) {
          body = groups
            .map((g) => {
              const ps = parts.filter((p) => p.group === g.id);
              return ps.length
                ? `<h6>${esc(g.name)}</h6><div class="cards">${ps.map((p) => partCard(p, traced)).join("")}</div>`
                : "";
            })
            .join("");
          const loose = parts.filter((p) => !groups.some((g) => g.id === p.group));
          if (loose.length)
            body += `<h6>Other</h6><div class="cards">${loose.map((p) => partCard(p, traced)).join("")}</div>`;
        } else {
          body = `<div class="cards">${parts.map((p) => partCard(p, traced)).join("")}</div>`;
        }
        return `<section class="tier ti-${t.id}"><div class="lab"><b>${esc(t.name)}</b><span>${esc(t.sub)}</span></div><div class="row">${body}</div></section>`;
      })
      .join("");
    return `${legend}<div class="board${traced ? " tracing" : ""}">${tiers}</div>`;
  }

  // ---------------------------------------------------------------- browse
  function itemTitle(k, x) {
    if (k === "table") return x.name;
    return k === "concept" ? x.term : k === "feature" || k === "part" ? x.name : x.title;
  }
  function itemSummary(k, x) {
    if (k === "concept") return x.definition;
    if (k === "decision") return x.decision;
    if (k === "risk" || k === "question") return x.detail;
    return x.summary;
  }
  function itemTag(k, x) {
    if (k === "feature") return areaOf[x.area]?.name;
    if (k === "part") return tierOf[x.tier].name;
    if (k === "decision") return x.ref;
    if (k === "question") return x.ref || x.owner;
    return "";
  }
  function itemTiers(k, x) {
    if (k === "part") return [x.tier];
    if (k === "feature") return x.steps.map((s) => by.part[s.part].tier);
    return (x.parts || []).map((pid) => by.part[pid].tier);
  }
  function browseList() {
    const q = state.q.trim().toLowerCase();
    return (
      Object.keys(KINDS)
        .filter((k) => !state.kind || state.kind === k)
        .map((k) => {
          const items = LISTS[k].filter((x) => {
            if (state.tier && !itemTiers(k, x).includes(state.tier)) return false;
            if (!q) return true;
            return `${itemTitle(k, x)} ${itemSummary(k, x)} ${(x.aka || []).join(" ")}`
              .toLowerCase()
              .includes(q);
          });
          if (!items.length) return "";
          return `<h6>${KINDS[k].icon} ${KINDS[k].plural} · ${items.length}</h6><div class="rows">${items
            .map(
              (
                x,
              ) => `<button type="button" class="rowitem${state.sel?.type === k && state.sel.id === x.id ? " sel" : ""}" data-go="${k}:${x.id}">
              ${kindChip(k)}<span class="rt"><b>${esc(itemTitle(k, x))}</b><span>${plain(itemSummary(k, x))}</span></span><span class="tag">${esc(itemTag(k, x) || "")}</span>
            </button>`,
            )
            .join("")}</div>`;
        })
        .join("") ||
      '<p class="empty">Nothing matches. Try a shorter word, or clear the filters.</p>'
    );
  }
  function viewBrowse() {
    return `<div class="stats">${Object.keys(KINDS)
      .map(
        (
          k,
        ) => `<button type="button" class="stat ty-${k}${state.kind === k ? " on" : ""}" data-kind="${k}" aria-pressed="${state.kind === k}">
          <strong>${LISTS[k].length}</strong><b>${KINDS[k].icon} ${KINDS[k].plural}</b><span>${KINDS[k].hint}</span></button>`,
      )
      .join("")}</div>
      <div class="filters">
        <input id="q" type="search" placeholder="Search everything…" value="${esc(state.q)}" aria-label="Search everything">
        ${D.tiers.map((t) => `<button type="button" class="chip tchip ti-${t.id}${state.tier === t.id ? " on" : ""}" data-tier="${t.id}" aria-pressed="${state.tier === t.id}">${esc(t.name)}</button>`).join("")}
      </div>
      <div id="browse-list">${browseList()}</div>`;
  }

  // ---------------------------------------------------------------- screens
  function viewScreens() {
    const groups = [];
    for (const s of D.screens) {
      let g = groups.find((x) => x.name === s.group);
      if (!g) {
        g = { name: s.group, items: [] };
        groups.push(g);
      }
      g.items.push(s);
    }
    const captured = D.screens.filter((s) => SHOTS[s.id]).length;
    return `<p class="lede">${captured} of ${D.screens.length} screens captured. A screen marked <span class="stale inline">may be out of date</span> was captured before its source files last changed.</p>
      ${groups
        .map(
          (g) =>
            `<h4 class="sgroup">${esc(g.name)} <small>${g.items.length}</small></h4><div class="gallery">${g.items
              .map((s) => {
                const use = screenUse[s.id]?.[0];
                return `<div class="gitem">${shot(s.id)}${use ? `<span class="guse">${esc(use.f.name)} · step ${use.n}</span>` : `<span class="guse">${esc(s.role || "")}</span>`}</div>`;
              })
              .join("")}</div>`,
        )
        .join("")}`;
  }

  // ---------------------------------------------------------------- guide
  /** The button that makes the guide PDF from this page (see printGuide). */
  function pdfLink(cls, label) {
    return `<button type="button" class="${cls}" data-act="pdf" title="Make a PDF of the guide from this page: every screen and how each feature works">${label}</button>`;
  }

  /**
   * Builds the guide as a print document from the data and screenshots in
   * this page, in a hidden frame, and opens the print dialog on it. "Save as
   * PDF" there is the download. Nothing is fetched and nothing is prebuilt.
   */
  function guideDocument() {
    return SystemMapGuide.printDocument(D, SHOTS, document.getElementById("guide-css").textContent);
  }
  function printGuide() {
    document.getElementById("print-frame")?.remove();
    const frame = document.createElement("iframe");
    frame.id = "print-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.onload = () => {
      // One frame later, so the screenshots are laid out before printing.
      setTimeout(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      }, 300);
    };
    frame.srcdoc = guideDocument();
    document.body.appendChild(frame);
    toast("Preparing the guide… In the print dialog, choose “Save as PDF”.");
  }
  // For the build's --pdf flag, which prints the same document without a dialog.
  window.systemMapGuideDocument = guideDocument;

  let toastTimer;
  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 7000);
  }

  function viewGuide() {
    const chapters = SystemMapGuide.chapters(D);
    const toc = chapters
      .map(
        (c, i) =>
          `<li><b>${i + 1}. ${esc(c.area.name)}</b><ul>${c.features.map((f) => `<li><button type="button" class="plain-link${state.sel?.type === "feature" && state.sel.id === f.id ? " on" : ""}" data-go="feature:${f.id}" data-toc="${f.id}">${esc(f.name)}</button></li>`).join("")}</ul></li>`,
      )
      .join("");
    const h = {
      rich,
      shot: (sc) => shot(sc.id),
      after: (f) =>
        `<p class="g-links"><button type="button" class="btn" data-go="feature:${f.id}" data-then="map">▶ Trace on the map</button><button type="button" class="btn" data-go="feature:${f.id}" data-then="swim">⇶ Swimlanes</button></p>`,
    };
    const n = chapters.reduce((a, c) => a + c.features.length, 0);
    return `<div class="guide">
      <nav class="g-toc" aria-label="Features"><h6>How it works</h6><ol>${toc}</ol></nav>
      <div class="g-body">
        <header class="g-head">
          <h1>How it works</h1>
          <p class="lede">${n} things people do with the ${esc(D.system.name)}, each as plain steps with its screens and the rules worth knowing.</p>
          <p class="g-actions">${pdfLink("btn primary", "⤓ Download as PDF")}<span class="muted">Made on the spot from this page: ${D.screens.filter((x) => SHOTS[x.id]).length} screens, as of ${fmtDate(D.meta.date)}.</span></p>
          <ol class="g-loop">${D.system.loop.map((l) => `<li>${rich(l)}</li>`).join("")}</ol>
        </header>
        ${SystemMapGuide.body(D, SHOTS, h)}
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- data
  const fkCols = {};
  for (const r of DB.refs) {
    for (const c of r.from.columns) fkCols[`${r.from.table}.${c}`] = r;
  }
  const isUserRef = (r) => r.to.table === "users" && r.from.table !== "users";

  // How the diagram is shown; remembered per viewer.
  //   cols   "names" (table names only) | "keys" | "all"
  //   layout "row" (every group side by side) | "wrap" (three per row)
  //   zoom   a number, or null to fit the whole diagram in view
  const erd = { cols: "keys", layout: "row", zoom: null, users: false };
  try {
    Object.assign(erd, JSON.parse(localStorage.getItem("sysmap.erd") || "{}"));
  } catch {
    // storage can be blocked; the defaults are fine
  }
  const saveErd = () => {
    try {
      localStorage.setItem("sysmap.erd", JSON.stringify({ ...erd, zoom: erd.zoom }));
    } catch {
      // ignore
    }
  };
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 2;
  let zoomNow = 1;

  function tableCard(t) {
    const linkOf = (c) => fkCols[`${t.name}.${c.name}`];
    const cols =
      erd.cols === "names"
        ? []
        : t.columns.filter(
            (c) =>
              erd.cols === "all" || c.pk || (linkOf(c) && (erd.users || !isUserRef(linkOf(c)))),
          );
    const hidden = t.columns.length - cols.length;
    const sel = state.sel?.type === "table" && state.sel.id === t.name;
    return `<div class="tbl${sel ? " sel" : ""}${erd.cols === "names" ? " names" : ""}" id="tbl-${t.name}" data-table="${t.name}" data-go="table:${t.name}" title="${esc(t.name)}: click to select, click again to clear">
      <button type="button" class="tbl-h" data-go="table:${t.name}">${esc(t.name)}<span>${t.columns.length}</span></button>
      ${
        erd.cols === "names"
          ? ""
          : `<ul>${cols
              .map((c) => {
                const fk = linkOf(c);
                return `<li data-col="${esc(c.name)}" class="${c.pk ? "pk" : ""}${fk ? " fk" : ""}"><span class="cn">${c.pk ? "🔑 " : fk ? "↗ " : ""}${esc(c.name)}</span><span class="ct">${esc(c.type)}${c.notNull || c.pk ? "" : "?"}</span></li>`;
              })
              .join("")}${hidden ? `<li class="more">+ ${hidden} more</li>` : ""}</ul>`
      }
    </div>`;
  }

  function seg(act, value, current, label, title) {
    return `<button type="button" class="${value === current ? "on" : ""}" data-act="${act}" data-val="${value}" aria-pressed="${value === current}" title="${esc(title)}">${label}</button>`;
  }

  function viewData() {
    if (!DB.tables.length) {
      return '<p class="empty">No schema model yet. Run the schema export, then rebuild the map.</p>';
    }
    const blob = URL.createObjectURL(new Blob([DB.dbml], { type: "text/plain" }));
    const userLinks = DB.refs.filter(isUserRef).length;
    const shown = DB.refs.length - (erd.users ? 0 : userLinks);
    return `<div class="erd-bar">
        <p class="lede">The database: ${DB.tables.length} tables, ${DB.refs.length} relations and ${DB.enums.length} lists of allowed values, generated from the code by <code>pnpm db:dbml</code>. Click a table to light up its relations and see what it holds; click it again, or the empty diagram, to clear.</p>
        <div class="erd-tools">
          <div class="segs" role="group" aria-label="Columns">${seg("erd-cols", "names", erd.cols, "Names", "Table names only: the whole map at a glance")}${seg("erd-cols", "keys", erd.cols, "Keys", "Keys and links")}${seg("erd-cols", "all", erd.cols, "All columns", "Every column")}</div>
          <div class="segs" role="group" aria-label="Layout">${seg("erd-layout", "row", erd.layout, "▥ Side by side", "Every group in one row")}${seg("erd-layout", "wrap", erd.layout, "▦ Wrapped", "Three groups per row")}</div>
          <button type="button" class="btn${erd.users ? " on" : ""}" data-act="erd-users" aria-pressed="${erd.users}">${erd.users ? "Hide" : "Show"} links to people (${userLinks})</button>
          <span class="erd-gap"></span>
          <a class="btn" href="${blob}" download="${D.meta.slug}-schema.dbml">⤓ DBML</a>
          <button type="button" class="btn" data-act="dbml-copy">Copy DBML</button>
          <a class="btn" href="https://dbdiagram.io/d" target="_blank" rel="noopener">dbdiagram.io ↗</a>
        </div>
      </div>
      <div class="erd-canvas" id="erd-canvas" tabindex="0" aria-label="Database diagram. Ctrl or Cmd and scroll to zoom, drag to move.">
        <div class="erd-zoom" role="group" aria-label="Zoom">
          <button type="button" data-act="erd-zoom" data-val="out" title="Zoom out (-)" aria-label="Zoom out">−</button>
          <button type="button" class="pct" data-act="erd-zoom" data-val="fit" title="Fit the whole diagram (0)" id="erd-pct">Fit</button>
          <button type="button" data-act="erd-zoom" data-val="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
          <button type="button" data-act="erd-zoom" data-val="1" title="Actual size (1)">1:1</button>
          <button type="button" data-act="erd-full" title="Full screen" aria-label="Full screen">⤢</button>
        </div>
        <aside class="erd-info" id="erd-info" aria-live="polite"></aside>
        <div class="erd-stage" id="erd-stage">
          <div class="erd layout-${erd.layout} cols-${erd.cols}" id="erd" style="--groups:${DB.groups.length}">
            <svg class="erd-lines" id="erd-lines" aria-hidden="true"></svg>
            ${DB.groups
              .map(
                (g) =>
                  `<section class="erd-group"><h6>${esc(g.name)}</h6>${g.tables
                    .map((n) => by.table[n])
                    .filter(Boolean)
                    .map(tableCard)
                    .join("")}</section>`,
              )
              .join("")}
            <svg class="erd-lines front" id="erd-front" aria-hidden="true"></svg>
          </div>
        </div>
      </div>
      <p class="muted erd-count">${shown} relations drawn${erd.users ? "" : `; the ${userLinks} links to the people who created or changed rows are hidden`}. Ctrl or Cmd and scroll (or pinch) to zoom, drag the background to move, <kbd>0</kbd> fits.</p>
      <h6 class="erd-enums-h">Lists of allowed values</h6>
      <div class="erd-enums">${DB.enums
        .map(
          (e) =>
            `<div class="tbl"><div class="tbl-h">${esc(e.name)}</div><ul>${e.values.map((v) => `<li><span class="cn">${esc(v)}</span></li>`).join("")}</ul></div>`,
        )
        .join("")}</div>`;
  }

  /** The selected table's description, shown inside the diagram in full screen. */
  function erdInfo() {
    const box = $("#erd-info");
    if (!box) return;
    const t = state.sel?.type === "table" && by.table[state.sel.id];
    if (!t) {
      box.innerHTML = "";
      box.hidden = true;
      return;
    }
    const g = groupOfTable[t.name];
    const out = DB.refs.filter((r) => r.from.table === t.name).length;
    const inn = DB.refs.filter((r) => r.to.table === t.name && r.from.table !== t.name).length;
    box.hidden = false;
    box.innerHTML = `<div class="d-type"><span class="chip ti-data tchip">▦ Table</span>${g ? `<span class="chip plain">${esc(g.name)}</span>` : ""}</div>
      <h3>${esc(t.name)}</h3>
      ${t.note ? `<p>${rich(t.note)}</p>` : ""}
      <p class="muted">${t.columns.length} columns · points to ${out} · pointed to by ${inn}</p>
      <button type="button" class="btn" data-act="erd-details">Columns and relations →</button>`;
  }

  /** Scales the diagram; null fits it in the visible area. */
  function applyZoom(z, anchor) {
    const canvas = $("#erd-canvas");
    const box = $("#erd");
    const stage = $("#erd-stage");
    if (!canvas || !box || !stage) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const fit = Math.min((canvas.clientWidth - 24) / w, (canvas.clientHeight - 24) / h);
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z ?? fit));
    // Keep the point under the pointer (or the middle) where it was.
    const ax = anchor?.x ?? canvas.clientWidth / 2;
    const ay = anchor?.y ?? canvas.clientHeight / 2;
    const cx = (canvas.scrollLeft + ax) / zoomNow;
    const cy = (canvas.scrollTop + ay) / zoomNow;
    zoomNow = next;
    box.style.transform = `scale(${next})`;
    stage.style.width = `${w * next}px`;
    stage.style.height = `${h * next}px`;
    if (z == null) {
      canvas.scrollLeft = 0;
      canvas.scrollTop = 0;
    } else {
      canvas.scrollLeft = cx * next - ax;
      canvas.scrollTop = cy * next - ay;
    }
    erd.zoom = z == null ? null : next;
    const pct = $("#erd-pct");
    if (pct)
      pct.textContent =
        z == null ? `Fit · ${Math.round(next * 100)}%` : `${Math.round(next * 100)}%`;
  }

  /** Draws the relations as curves between the cards (after layout). */
  function drawErd() {
    const box = $("#erd");
    const svg = $("#erd-lines");
    if (!box || !svg) return;
    // Measure at scale 1, then apply the zoom: lines and cards scale together.
    box.style.transform = "none";
    const base = box.getBoundingClientRect();
    for (const s of [svg, $("#erd-front")].filter(Boolean)) {
      s.setAttribute("width", box.scrollWidth);
      s.setAttribute("height", box.scrollHeight);
    }
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return {
        l: r.left - base.left,
        r: r.right - base.left,
        y: r.top - base.top + Math.min(r.height / 2, 14),
        cx: r.left - base.left + r.width / 2,
      };
    };
    const paths = [];
    for (const ref of DB.refs) {
      if (!erd.users && isUserRef(ref)) continue;
      const fromCard = $(`#tbl-${ref.from.table}`, box);
      const toCard = $(`#tbl-${ref.to.table}`, box);
      if (!fromCard || !toCard) continue;
      const row = $(`li[data-col="${ref.from.columns[0]}"]`, fromCard) || $(".tbl-h", fromCard);
      const a = at(row);
      const b = at($(".tbl-h", toCard));
      let d;
      if (fromCard === toCard) {
        d = `M${a.r},${a.y} C${a.r + 40},${a.y} ${b.r + 40},${b.y} ${b.r},${b.y}`;
      } else if (Math.abs(a.cx - b.cx) < 40) {
        const x = Math.max(a.r, b.r);
        d = `M${a.r},${a.y} C${x + 46},${a.y} ${x + 46},${b.y} ${b.r},${b.y}`;
      } else {
        const right = b.cx > a.cx;
        const x1 = right ? a.r : a.l;
        const x2 = right ? b.l : b.r;
        const k = Math.max(30, Math.abs(x2 - x1) / 2);
        d = `M${x1},${a.y} C${x1 + (right ? k : -k)},${a.y} ${x2 + (right ? -k : k)},${b.y} ${x2},${b.y}`;
      }
      paths.push(
        `<path class="rel${isUserRef(ref) ? " user" : ""}" data-from="${ref.from.table}" data-to="${ref.to.table}" data-cols="${[...ref.from.columns.map((c) => `${ref.from.table}.${c}`), ...ref.to.columns.map((c) => `${ref.to.table}.${c}`)].join(" ")}" d="${d}" marker-end="url(#erd-arrow)"/>`,
      );
    }
    svg.innerHTML = `<defs><marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="fa"/></marker></defs>${paths.join("")}`;
    zoomNow = 1;
    applyZoom(erd.zoom);
    focusErd(state.sel?.type === "table" ? state.sel.id : null);
  }

  /**
   * Lights up one table's relations and the tables at their other ends. The
   * lit lines are copied into a layer above the cards, so they can be traced
   * across the tables they pass over.
   */
  function focusErd(name) {
    const box = $("#erd");
    if (!box) return;
    box.classList.toggle("focus", Boolean(name));
    const near = new Set(name ? [name] : []);
    const lit = [];
    const hits = new Set();
    for (const p of box.querySelectorAll("#erd-lines path.rel")) {
      const on = name && (p.dataset.from === name || p.dataset.to === name);
      p.classList.toggle("on", Boolean(on));
      if (on) {
        near.add(p.dataset.from);
        near.add(p.dataset.to);
        lit.push(p.getAttribute("d"));
        for (const c of p.dataset.cols.split(" ")) hits.add(c);
      }
    }
    // The columns at both ends of a lit relation stand out from other keys.
    for (const li of box.querySelectorAll(".tbl li[data-col]")) {
      const table = li.closest(".tbl").dataset.table;
      li.classList.toggle("hit", hits.has(`${table}.${li.dataset.col}`));
    }
    const front = $("#erd-front");
    if (front) {
      front.innerHTML = lit.length
        ? `<defs><marker id="erd-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="fa on"/></marker></defs>${lit
            .map((d) => `<path class="rel on" d="${d}" marker-end="url(#erd-arrow-on)"/>`)
            .join("")}`
        : "";
    }
    for (const c of box.querySelectorAll(".tbl")) {
      c.classList.toggle("near", near.has(c.dataset.table));
    }
  }

  function inspTable(t) {
    const g = groupOfTable[t.name];
    const out = DB.refs.filter((r) => r.from.table === t.name);
    const inn = DB.refs.filter((r) => r.to.table === t.name && r.from.table !== t.name);
    const refRow = (r, other) =>
      `<button type="button" class="link" data-go="table:${other}"><span class="g ty-part">▦</span><span><b>${esc(other)}</b><span>${esc(r.from.columns.join(", "))} → ${esc(r.to.table)}.${esc(r.to.columns.join(", "))}${r.onDelete && r.onDelete !== "no action" ? ` · on delete ${esc(r.onDelete)}` : ""}</span></span></button>`;
    const flags = (c) =>
      [
        c.pk && "key",
        fkCols[`${t.name}.${c.name}`] && "link",
        c.unique && "unique",
        !c.notNull && !c.pk && "optional",
      ]
        .filter(Boolean)
        .join(", ");
    const comp = g?.component && by.part[g.component];
    return `${crumbs()}
      <div class="flash"><div class="d-type"><span class="chip ti-data tchip">▦ Table</span>${g ? `<span class="chip plain">${esc(g.name)}</span>` : ""}<span class="basis b-code">read from code</span></div>
        <h2 class="d-title">${esc(t.name)}</h2>
        ${t.note ? `<p class="d-lead">${rich(t.note)}</p>` : ""}</div>
      ${sec(
        "Columns",
        t.columns.length,
        `<table class="cols"><tbody>${t.columns
          .map(
            (c) =>
              `<tr><td><b>${esc(c.name)}</b>${c.note ? `<span>${rich(c.note)}</span>` : ""}</td><td><code>${esc(c.type)}</code>${c.default ? `<span>default ${esc(c.default)}</span>` : ""}</td><td>${esc(flags(c))}</td></tr>`,
          )
          .join("")}</tbody></table>`,
      )}
      ${out.length ? sec("Points to", out.length, `<div class="links">${out.map((r) => refRow(r, r.to.table)).join("")}</div>`) : ""}
      ${inn.length ? sec("Pointed to by", inn.length, `<div class="links">${inn.map((r) => refRow(r, r.from.table)).join("")}</div>`) : ""}
      ${t.indexes.length ? sec("Indexes", t.indexes.length, `<ul class="resp">${t.indexes.map((i) => `<li><code>${esc(i.columns.join(", "))}</code>${i.unique ? " · unique" : ""}</li>`).join("")}</ul>`) : ""}
      ${comp ? sec("Part of", 0, `<div class="pchips"><button type="button" class="chip tchip ti-${comp.tier}" data-go="part:${comp.id}">■ ${esc(comp.name)}</button></div>`) : ""}
      ${sec("Where the code lives", 0, refs([`apps/backend/src/database/schema/${t.file}`]))}`;
  }

  // ---------------------------------------------------------------- start
  function viewStart() {
    const s = D.start;
    return `<div class="start">
      <h1>Your first day</h1>
      <p class="lede">${rich(D.system.summary)}</p>
      <section class="card"><h3>Read these, in order</h3><ol class="reading">${s.read
        .map((r) => {
          const url = fileUrl(r.path);
          return `<li>${url ? `<a class="ref" href="${esc(url)}" target="_blank" rel="noopener">${esc(r.path)}</a>` : `<span class="ref">${esc(r.path)}</span>`}<span>${rich(r.why)}</span></li>`;
        })
        .join("")}</ol></section>
      <section class="card"><h3>Then trace these features</h3><div class="links">${s.trace.map((id) => linkRow("feature", by.feature[id])).join("")}</div></section>
      <section class="card"><h3>Run it on your machine</h3><ol class="reading">${s.run.map((r) => `<li><code>${esc(r.cmd)}</code><span>${rich(r.what)}</span></li>`).join("")}</ol></section>
      <section class="card"><h3>Rules that bite</h3><ul class="rules">${s.rules.map((r) => `<li><b>${esc(r.title)}</b><span>${rich(r.why)}</span></li>`).join("")}</ul></section>
      ${D.changelog?.length ? `<section class="card"><h3>What changed in the map</h3><ul class="rules">${D.changelog.map((c) => `<li><b>${esc(c.date)}${c.commit ? ` · ${esc(c.commit)}` : ""}</b><span>${rich(c.summary)}</span></li>`).join("")}</ul></section>` : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- inspector
  function linkRow(k, x, sub) {
    return `<button type="button" class="link" data-go="${k}:${x.id}"><span class="g ty-${k}">${KINDS[k].icon}</span><span><b>${esc(itemTitle(k, x))}</b><span>${plain(sub ?? itemSummary(k, x))}</span></span></button>`;
  }
  function sec(title, n, body, extra = "") {
    if (!body) return "";
    return `<div class="d-sec"><h5>${title}${n ? ` <span class="n">${n}</span>` : ""}${extra}</h5>${body}</div>`;
  }
  function linkSec(title, k, items) {
    return items?.length
      ? sec(
          title,
          items.length,
          `<div class="links">${items.map((x) => linkRow(k, x)).join("")}</div>`,
        )
      : "";
  }
  function partLinks(ids) {
    return ids?.length
      ? sec(
          "Where it lives",
          0,
          `<div class="pchips">${ids.map((pid) => `<button type="button" class="chip tchip ti-${by.part[pid].tier}" data-go="part:${pid}">■ ${esc(by.part[pid].name)}</button>`).join("")}</div>`,
        )
      : "";
  }

  function crumbs() {
    const prev = trail[trail.length - 1];
    const back = prev
      ? `<button type="button" class="btn ghost" data-act="back">← ${esc(itemTitle(prev.type, by[prev.type][prev.id]))}</button>`
      : state.sel
        ? '<button type="button" class="btn ghost" data-act="home">← Overview</button>'
        : "<span></span>";
    return `<div class="crumbs">${back}<span class="cr-right">${state.trace ? '<button type="button" class="btn ghost" data-act="clear-trace">Clear trace</button>' : ""}<button type="button" class="btn ghost only-drawer" data-act="close-insp" aria-label="Close panel">✕</button></span></div>`;
  }

  function inspHome() {
    const m = D.meta;
    const sha = m.repoUrl
      ? `<a href="${esc(m.repoUrl)}${forgeSeg}commit/${m.sha}" target="_blank" rel="noopener">${m.sha}</a>`
      : m.sha;
    return `${crumbs()}
      <div class="status"><span class="dot${m.behind ? " warn" : ""}"></span><div><b>Describes ${esc(m.branch)} at ${sha}</b><span>Code as of ${fmtDate(m.date)} (${ago(m.date)})${m.behind ? ` · ${m.behind} app ${m.behind === 1 ? "commit" : "commits"} since` : ""}</span><span>Rebuild with <code>${esc(m.buildCommand)}</code></span></div></div>
      <div class="flash"><div class="eyebrow">${esc(D.system.client)}</div>
        <h2 class="d-title">${esc(D.system.headline)}</h2>
        <p class="d-lead">${rich(D.system.summary)}</p></div>
      ${sec("Who uses it", 0, `<dl class="actors">${D.system.actors.map((a) => `<dt>${esc(a.name)}</dt><dd>${rich(a.does)}</dd>`).join("")}</dl>`)}
      ${sec("The one loop to understand", 0, `<ol class="loop">${D.system.loop.map((l) => `<li>${rich(l)}</li>`).join("")}</ol>`)}
      ${sec(
        "How to read the map",
        0,
        `<dl class="howto">
          <dt>${kindChip("feature")}</dt><dd>Something a person does. Pick one under <i>Trace a feature</i> to light up its path.</dd>
          <dt><span class="chip plain">■ Part</span></dt><dd>A piece of the codebase; its colour is its layer.</dd>
          <dt>${kindChip("concept")}</dt><dd>A precise team word. Dotted words in any text open their meaning.</dd>
          <dt>${kindChip("decision")}</dt><dd>A choice that was made, and why.</dd>
          <dt>${kindChip("risk")}</dt><dd>Where a careless change bites.</dd>
          <dt>${kindChip("question")}</dt><dd>Not settled yet; someone owns the answer.</dd>
          <dt><span class="basis b-code">read from code</span></dt><dd>How we know: read from the code, taken from the blueprint, or inferred.</dd>
        </dl>`,
      )}`;
  }

  function connSvg(p, big) {
    const ins = rel[p.id].inbound;
    const outs = p.uses || [];
    if (!ins.length && !outs.length) return "";
    const cw = big ? 7.6 : 6.3;
    const nh = big ? 34 : 28;
    const gy = big ? 16 : 10;
    const gap = big ? 90 : 46;
    const width = (name) => Math.max(70, Math.min(big ? 260 : 170, name.length * cw + 22));
    const label = (name) => {
      const max = big ? 32 : 24;
      return name.length > max ? `${name.slice(0, max - 1)}…` : name;
    };
    const lw = ins.length ? Math.max(...ins.map((e) => width(by.part[e.from].name))) : 0;
    const rw = outs.length ? Math.max(...outs.map((e) => width(by.part[e.to].name))) : 0;
    const cwid = width(p.name);
    const rows = Math.max(ins.length, outs.length, 1);
    const H = rows * (nh + gy) + gy;
    const cx = lw ? lw + gap : 0;
    const rx = cx + cwid + gap;
    const W = rx + rw - (outs.length ? 0 : gap);
    const cy = H / 2;
    const colY = (n, i) => (H - (n * (nh + gy) - gy)) / 2 + i * (nh + gy);
    const node = (pid, x, y, w, why, me) => {
      const q = by.part[pid];
      return `<g class="fn ti-${q.tier}${me ? " me" : ""}${q.tier === "external" ? " ext" : ""}" ${me ? "" : `data-go="part:${pid}" data-tip="${esc(why || "")}" tabindex="0" role="link"`}>
        <rect x="${x}" y="${y}" width="${w}" height="${nh}" rx="5"/><text x="${x + w / 2}" y="${y + nh / 2}" dy=".35em" text-anchor="middle">${esc(label(q.name))}</text></g>`;
    };
    const edge = (x1, y1, x2, y2) => {
      const mx = (x1 + x2) / 2;
      return `<path class="fe" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 5},${y2}" marker-end="url(#arr${big ? "b" : ""})"/>`;
    };
    let s = "";
    ins.forEach((e, i) => {
      const y = colY(ins.length, i);
      const w = width(by.part[e.from].name);
      s += edge(lw, y + nh / 2, cx, cy) + node(e.from, lw - w, y, w, e.why);
    });
    outs.forEach((e, i) => {
      const y = colY(outs.length, i);
      s +=
        edge(cx + cwid, cy, rx, y + nh / 2) + node(e.to, rx, y, width(by.part[e.to].name), e.why);
    });
    s += node(p.id, cx, cy - nh / 2, cwid, "", true);
    return `<svg class="flowsvg${big ? " big" : ""}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="What ${esc(p.name)} connects to">
      <defs><marker id="arr${big ? "b" : ""}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="fa"/></marker></defs>${s}</svg>`;
  }

  function inspPart(p) {
    const r = rel[p.id];
    const conn = connSvg(p);
    return `${crumbs()}
      <div class="flash"><div class="d-type">${tierChip(p.tier)}${basisChip(p.basis)}</div>
        <h2 class="d-title">${esc(p.name)}</h2><p class="d-lead">${rich(p.lead || p.summary)}</p></div>
      ${conn ? sec("Connections", 0, `<div class="flow">${conn}</div><div class="flow-hint">Point at a box to see how it connects and why. Click it to open it.</div>`, '<button type="button" class="btn" data-act="expand-conn">⤢ Expand</button>') : ""}
      ${r.screens.length ? sec(`Screens (${r.screens.length})`, 0, `<div class="strip">${r.screens.map((s) => shot(s.id)).join("")}</div>`) : ""}
      ${r.features.length ? sec("Features that pass through it", r.features.length, `<div class="links">${r.features.map(({ f, nums }) => linkRow("feature", f, nums.map((n) => f.steps[n - 1].title).join(" · "))).join("")}</div>`) : ""}
      ${linkSec("Risks", "risk", r.risks)}
      ${linkSec("Decisions", "decision", r.decisions)}
      ${linkSec("Open questions", "question", r.questions)}
      ${p.responsible?.length ? sec("Responsible for", 0, `<ul class="resp">${p.responsible.map((x) => `<li>${rich(x)}</li>`).join("")}</ul>`) : ""}
      ${linkSec("Team words that live here", "concept", r.concepts)}
      ${p.id === "db" && DB.tables.length ? sec("Schema", 0, `<p class="plainp">${DB.tables.length} tables and ${DB.refs.length} relations.</p><p class="g-links"><button type="button" class="btn" data-view="data">▦ Open the schema diagram</button></p>`) : ""}
      ${p.code?.length ? sec("Where the code lives", 0, refs(p.code)) : ""}`;
  }

  function stepHtml(f, s, i) {
    const p = by.part[s.part];
    const hood =
      s.hood || s.refs?.length
        ? `<details class="hood"${state.tech ? " open" : ""}><summary>Under the hood</summary><div class="hood-body">${s.hood ? `<p>${rich(s.hood)}</p>` : ""}${refs(s.refs)}</div></details>`
        : "";
    return `<li class="step ti-${p.tier}" data-hover-part="${p.id}">
      <span class="num">${i + 1}</span>
      <div><b>${esc(s.title)}</b>
        <span class="sub"><button type="button" class="plain-link" data-go="part:${p.id}">${esc(p.name)}</button> · ${esc(tierOf[p.tier].name)}</span>
        ${s.detail ? `<p class="detail">${rich(s.detail)} ${basisChip(s.basis)}</p>` : ""}
        ${hood}
        ${s.screens?.length ? `<div class="shots">${s.screens.map((sid) => shot(sid, { small: true, caption: false })).join("")}</div>` : ""}
      </div></li>`;
  }

  function flowChart(f) {
    const groups = [];
    f.steps.forEach((s, i) => {
      const last = groups[groups.length - 1];
      if (last && last.part === s.part) last.steps.push({ s, n: i + 1 });
      else groups.push({ part: s.part, steps: [{ s, n: i + 1 }] });
    });
    return `<div class="fchart"><div class="fc-start">${esc(f.actor)} · ${esc(f.trigger)}</div>${groups
      .map((g) => {
        const p = by.part[g.part];
        return `<div class="fc-arrow" aria-hidden="true"></div><div class="fc-node ti-${p.tier}"><button type="button" class="plain-link" data-go="part:${p.id}">${esc(p.name)}</button><ol>${g.steps.map(({ s, n }) => `<li value="${n}">${esc(s.title)}</li>`).join("")}</ol></div>`;
      })
      .join("")}</div>`;
  }

  function inspFeature(f) {
    const screens = [...new Set(f.steps.flatMap((s) => s.screens || []))];
    const subs = [
      ["steps", "Steps"],
      ["screens", `Screens${screens.length ? ` (${screens.length})` : ""}`],
      ["flow", "Flow chart"],
      ["more", "Concepts & risks"],
    ];
    let body;
    if (state.sub === "screens") {
      body = screens.length
        ? `<div class="strip">${screens.map((sid) => shot(sid)).join("")}</div>`
        : '<p class="empty">No screen is involved: this one happens on the server.</p>';
    } else if (state.sub === "flow") {
      body = flowChart(f);
    } else if (state.sub === "more") {
      body =
        linkSec(
          "Concepts",
          "concept",
          (f.concepts || []).map((id) => by.concept[id]),
        ) +
        linkSec(
          "Risks",
          "risk",
          (f.risks || []).map((id) => by.risk[id]),
        ) +
        linkSec(
          "Decisions",
          "decision",
          (f.decisions || []).map((id) => by.decision[id]),
        ) +
        linkSec(
          "Open questions",
          "question",
          (f.questions || []).map((id) => by.question[id]),
        );
      if (!body) body = '<p class="empty">Nothing linked yet.</p>';
    } else {
      body = `<ol class="steps">${f.steps.map((s, i) => stepHtml(f, s, i)).join("")}</ol>`;
    }
    return `${crumbs()}
      <div class="flash"><div class="d-type">${kindChip("feature")}<span class="chip plain">${esc(areaOf[f.area]?.name || "")}</span>${basisChip(f.basis)}</div>
        <h2 class="d-title">${esc(f.name)}</h2>
        <p class="muted"><b>${esc(f.actor)}</b> · ${esc(f.trigger)}</p>
        <p class="d-lead">${rich(f.summary)}</p>
        <p class="g-links"><button type="button" class="btn" data-act="swim">⇶ Open as swimlanes</button>${f.audience === "team" ? "" : `<button type="button" class="btn" data-go="feature:${f.id}" data-then="guide">☰ Read in the guide</button>`}</p></div>
      <div class="subtabs" role="tablist">${subs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${state.sub === k}" class="${state.sub === k ? "on" : ""}" data-sub="${k}">${l}</button>`).join("")}</div>
      <div class="subbody">${body}</div>
      ${f.rules?.length ? sec("Good to know", 0, `<ul class="resp">${f.rules.map((r) => `<li>${rich(r)}</li>`).join("")}</ul>`) : ""}
      ${f.check?.length ? sec("Check yourself", 0, f.check.map((c) => `<details class="check"><summary>${rich(c.q)}</summary><p>${rich(c.a)}</p></details>`).join("")) : ""}`;
  }

  function inspItem(k, x) {
    const feats = mentions[k]?.[x.id] || [];
    let head = "";
    let extra = "";
    if (k === "concept") {
      head = `<p class="d-lead">${rich(x.definition, x.id)}</p>`;
      if (x.aka?.length)
        extra += sec("Also called", 0, `<p class="plainp">${x.aka.map(esc).join(", ")}</p>`);
      if (x.not)
        extra += sec("Not to be confused with", 0, `<p class="plainp">${rich(x.not, x.id)}</p>`);
    } else if (k === "decision") {
      head = `<p class="d-lead">${rich(x.decision)}</p>`;
      extra += sec("Why", 0, `<p class="plainp">${rich(x.why)}</p>`);
      if (x.ref || x.date)
        extra += sec(
          "Recorded in",
          0,
          `<p class="plainp">${esc([x.ref, x.date, x.by ? `asked by ${x.by}` : ""].filter(Boolean).join(" · "))}</p>`,
        );
    } else if (k === "risk") {
      head = `<p class="d-lead">${rich(x.detail)}</p>`;
      if (x.care) extra += sec("When you touch this", 0, `<p class="plainp">${rich(x.care)}</p>`);
    } else {
      head = `<p class="d-lead">${rich(x.detail)}</p>`;
      if (x.status !== "answered" && x.progress)
        extra += sec(
          "Where it stands",
          0,
          `<p class="plainp">${rich(x.progress.text)} <span class="muted">(${esc(x.progress.by)}, ${esc(fmtDate(x.progress.date))})</span></p>`,
        );
      if (x.status === "answered")
        extra += sec(
          "Answer",
          0,
          `<p class="plainp">${rich(x.answer)}${x.answeredBy ? ` <span class="muted">(${esc(x.answeredBy)})</span>` : ""}</p>`,
        );
      else
        extra += sec(
          "How to answer",
          0,
          x.sensitive
            ? `<p class="plainp">This one is not answered in the repo. ${esc(D.meta.securityContact)} has the details and records the outcome.</p>`
            : '<p class="plainp">Write the answer under this question in <code>docs/system-map/answers.md</code>. The next update of the map folds it in.</p>',
        );
      if (x.owner || x.ref)
        extra += sec(
          "Who answers",
          0,
          `<p class="plainp">${esc([x.owner, x.ref].filter(Boolean).join(" · "))}</p>`,
        );
      if (x.meanwhile) extra += sec("Meanwhile", 0, `<p class="plainp">${rich(x.meanwhile)}</p>`);
    }
    return `${crumbs()}
      <div class="flash"><div class="d-type">${kindChip(k)}${basisChip(x.basis)}</div><h2 class="d-title">${esc(itemTitle(k, x))}</h2>${head}</div>
      ${extra}${partLinks(x.parts)}${linkSec("Features that involve it", "feature", feats)}
      ${x.code?.length ? sec("Where the code lives", 0, refs(x.code)) : ""}`;
  }

  function renderInsp() {
    const el = $("#insp");
    const s = state.sel;
    let html;
    if (!s) html = inspHome();
    else if (s.type === "part") html = inspPart(by.part[s.id]);
    else if (s.type === "feature") html = inspFeature(by.feature[s.id]);
    else if (s.type === "table") html = inspTable(by.table[s.id]);
    else html = inspItem(s.type, by[s.type][s.id]);
    el.innerHTML = html;
    el.classList.toggle("open", !!s);
    el.scrollTop = 0;
  }

  // ---------------------------------------------------------------- overlays
  function openOverlay(html) {
    const o = $("#overlay");
    o.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    o.classList.add("open");
    $(".sheet button", o)?.focus();
  }
  function closeOverlay() {
    $("#overlay").classList.remove("open");
    $("#overlay").innerHTML = "";
  }

  function swimlanes(f) {
    const used = D.tiers.filter((t) => f.steps.some((s) => by.part[s.part].tier === t.id));
    const cols = `40px repeat(${used.length}, minmax(200px, 1fr))`;
    const head = `<div class="sw-h"></div>${used.map((t) => `<div class="sw-h ti-${t.id}"><b>${esc(t.name)}</b><span>${esc(t.sub)}</span></div>`).join("")}`;
    const rows = f.steps
      .map((s, i) => {
        const p = by.part[s.part];
        return `<div class="sw-n">${i + 1}</div>${used
          .map((t) =>
            t.id === p.tier
              ? `<div class="sw-c ti-${t.id}"><div class="sw-card"><span>${esc(p.name)}</span><b>${esc(s.title)}</b></div>${s.screens?.length ? `<div class="shots">${s.screens.map((sid) => shot(sid, { small: true, caption: false })).join("")}</div>` : ""}</div>`
              : `<div class="sw-c ti-${t.id}"></div>`,
          )
          .join("")}`;
      })
      .join("");
    openOverlay(`<header class="sheet-h"><div>${kindChip("feature")}<h2>${esc(f.name)}</h2></div><button type="button" class="btn" data-act="close-overlay">Close ✕</button></header>
      <p class="sheet-lead">${rich(f.summary)}</p>
      <div class="swim" style="grid-template-columns:${cols}">${head}${rows}</div>`);
  }

  function expandConn(p) {
    const row = (a, b, why) =>
      `<tr><td>${esc(a)}</td><td class="arrow">→</td><td>${esc(b)}</td><td>${rich(why)}</td></tr>`;
    openOverlay(`<header class="sheet-h"><div>${tierChip(p.tier)}<h2>${esc(p.name)}: connections</h2></div><button type="button" class="btn" data-act="close-overlay">Close ✕</button></header>
      <div class="flow bigflow">${connSvg(p, true)}</div>
      <table class="conn"><tbody>${rel[p.id].inbound.map((e) => row(by.part[e.from].name, p.name, e.why)).join("")}${(p.uses || []).map((e) => row(p.name, by.part[e.to].name, e.why)).join("")}</tbody></table>`);
  }

  let lbList = [];
  let lbAt = 0;
  function openLightbox(sid, scope) {
    const els = [...(scope || document).querySelectorAll("[data-shot]")].map((e) => e.dataset.shot);
    lbList = [...new Set(els)].filter((id) => SHOTS[id]);
    lbAt = Math.max(0, lbList.indexOf(sid));
    if (!SHOTS[sid]) return;
    drawLightbox();
  }
  function drawLightbox() {
    const sid = lbList[lbAt];
    const s = by.screen[sid];
    const img = SHOTS[sid];
    const uses = screenUse[sid] || [];
    const lb = $("#lightbox");
    lb.innerHTML = `<div class="lb-inner ${s.kind}" role="dialog" aria-modal="true" aria-label="${esc(s.title)}">
      <button type="button" class="lb-nav prev" data-act="lb-prev" aria-label="Previous screen"${lbAt === 0 ? " disabled" : ""}>‹</button>
      <figure><img src="${img.src}" alt="${esc(s.title)}"><figcaption>
        <b>${esc(s.title)}</b>${img.stale ? ' <span class="stale inline">may be out of date</span>' : ""}
        <span>${esc([by.part[s.part].name, s.role, s.route].filter(Boolean).join(" · "))}</span>
        ${s.note ? `<span>${esc(s.note)}</span>` : ""}
        ${uses.length ? `<span class="lb-uses">${uses.map((u) => `<button type="button" class="plain-link" data-go="feature:${u.f.id}">${esc(u.f.name)} · step ${u.n}</button>`).join("")}</span>` : ""}
        <span class="lb-count">${lbAt + 1} / ${lbList.length}</span>
      </figcaption></figure>
      <button type="button" class="lb-nav next" data-act="lb-next" aria-label="Next screen"${lbAt === lbList.length - 1 ? " disabled" : ""}>›</button>
      <button type="button" class="btn lb-close" data-act="lb-close">Close ✕</button></div>`;
    lb.classList.add("open");
  }
  function closeLightbox() {
    $("#lightbox").classList.remove("open");
    $("#lightbox").innerHTML = "";
  }

  // ---------------------------------------------------------------- render
  let lastMain = "";
  // Set when a click or a fresh page load should scroll the guide to a feature.
  let guideJump = true;
  function render() {
    renderTop();
    const main = $("#main");
    const key =
      state.view === "guide"
        ? "guide"
        : state.view === "data"
          ? `data|${erd.cols}|${erd.layout}|${erd.users}`
          : [state.view, state.trace, state.kind, state.tier].join("|");
    const same = key === lastMain;
    const keep = same ? main.scrollTop : 0;
    lastMain = key;
    main.className = `main v-${state.view}`;
    if (state.view === "guide") {
      // Heavy (every screenshot), so build it once and only move within it.
      if (!same) main.innerHTML = viewGuide();
      for (const el of main.querySelectorAll("[data-toc]")) {
        el.classList.toggle("on", state.sel?.type === "feature" && el.dataset.toc === state.sel.id);
      }
      const target = state.sel?.type === "feature" && $(`#g-${state.sel.id}`, main);
      if (target && guideJump) target.scrollIntoView({ block: "start" });
      else main.scrollTop = keep;
      guideJump = false;
    } else if (state.view === "data" && same && $("#erd", main)) {
      // Same diagram, new selection: keep it (and full screen, zoom, scroll).
      const name = state.sel?.type === "table" ? state.sel.id : null;
      for (const c of main.querySelectorAll("#erd .tbl")) {
        c.classList.toggle("sel", c.dataset.table === name);
      }
      erdInfo();
      focusErd(name);
    } else {
      main.innerHTML =
        state.view === "browse"
          ? viewBrowse()
          : state.view === "data"
            ? viewData()
            : state.view === "screens"
              ? viewScreens()
              : state.view === "start"
                ? viewStart()
                : viewMap();
      main.scrollTop = keep;
    }
    renderInsp();
    // The relations are drawn once the cards have their size.
    if (state.view === "data" && !$("#erd-lines path", main)) {
      requestAnimationFrame(() => {
        drawErd();
        erdInfo();
      });
    }
    document.body.classList.toggle("tech", state.tech);
    document.title = `${state.sel ? `${itemTitle(state.sel.type, by[state.sel.type][state.sel.id])} · ` : ""}${D.system.name} system map`;
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", (e) => {
    const t = e.target.closest(
      "[data-go],[data-view],[data-act],[data-kind],[data-tier],[data-sub],[data-shot]",
    );
    if (!t) {
      if (e.target.id === "overlay") closeOverlay();
      if (e.target.id === "lightbox") closeLightbox();
      return;
    }
    const d = t.dataset;
    if (d.shot) return openLightbox(d.shot, t.closest(".strip,.gallery,.shots,.swim") || document);
    if (d.go) {
      const [type, id] = d.go.split(":");
      if (
        type === "table" &&
        state.view === "data" &&
        state.sel?.type === "table" &&
        state.sel.id === id
      ) {
        return nav({ sel: null });
      }
      closeOverlay();
      closeLightbox();
      if (d.then === "swim") return swimlanes(by.feature[id]);
      if (d.toc || d.then === "guide") guideJump = true;
      return select(type, id, d.then === "swim" ? undefined : d.then);
    }
    if (d.view) return nav({ view: d.view });
    if (d.sub) {
      state.sub = d.sub;
      return renderInsp();
    }
    if (d.kind) {
      state.kind = state.view === "browse" && state.kind === d.kind ? null : d.kind;
      return nav({ view: "browse" });
    }
    if (d.tier) {
      state.tier = state.tier === d.tier ? null : d.tier;
      return render();
    }
    switch (d.act) {
      case "home":
        trail.length = 0;
        return nav({ sel: null, trace: null, view: state.view });
      case "back": {
        const prev = trail.pop();
        const h = hashFor({ sel: prev || null });
        if (h === location.hash) return render();
        location.hash = h;
        return;
      }
      case "clear-trace":
        return nav({
          trace: null,
          ...(state.sel?.type === "feature" ? { sel: null } : {}),
        });
      case "close-insp":
        return nav({ sel: null });
      case "tech":
        state.tech = !state.tech;
        try {
          localStorage.setItem("sysmap.tech", state.tech ? "1" : "0");
        } catch {
          // ignore
        }
        return render();
      case "theme": {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("sysmap.theme", next);
        } catch {
          // ignore
        }
        return;
      }
      case "erd-users":
        erd.users = !erd.users;
        saveErd();
        return render();
      case "erd-cols":
        erd.cols = d.val;
        saveErd();
        return render();
      case "erd-layout":
        erd.layout = d.val;
        erd.zoom = null;
        saveErd();
        return render();
      case "erd-zoom":
        applyZoom(
          d.val === "fit" ? null : d.val === "1" ? 1 : zoomNow * (d.val === "in" ? 1.25 : 0.8),
        );
        saveErd();
        return;
      case "erd-details":
        // Leave full screen so the side panel, with everything, is in view.
        if (document.fullscreenElement) document.exitFullscreen();
        return;
      case "erd-full": {
        const c = $("#erd-canvas");
        if (document.fullscreenElement) document.exitFullscreen();
        else c?.requestFullscreen?.();
        return;
      }
      case "dbml-copy":
        try {
          navigator.clipboard.writeText(DB.dbml);
          toast("DBML copied. Paste it into dbdiagram.io to see the same diagram there.");
        } catch {
          toast("Could not copy; use Download DBML instead.");
        }
        return;
      case "pdf":
        return printGuide();
      case "swim":
        return swimlanes(by.feature[state.sel.id]);
      case "expand-conn":
        return expandConn(by.part[state.sel.id]);
      case "close-overlay":
        return closeOverlay();
      case "lb-close":
        return closeLightbox();
      case "lb-prev":
        if (lbAt > 0) lbAt--;
        return drawLightbox();
      case "lb-next":
        if (lbAt < lbList.length - 1) lbAt++;
        return drawLightbox();
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id !== "trace") return;
    const id = e.target.value;
    if (id) select("feature", id);
    else
      nav({
        trace: null,
        ...(state.sel?.type === "feature" ? { sel: null } : {}),
      });
  });

  document.addEventListener("input", (e) => {
    if (e.target.id !== "q") return;
    state.q = e.target.value;
    $("#browse-list").innerHTML = browseList();
  });

  document.addEventListener("keydown", (e) => {
    const lbOpen = $("#lightbox").classList.contains("open");
    if (e.key === "Escape") {
      if (lbOpen) return closeLightbox();
      if ($("#overlay").classList.contains("open")) return closeOverlay();
    }
    if (lbOpen && e.key === "ArrowLeft" && lbAt > 0) {
      lbAt--;
      return drawLightbox();
    }
    if (lbOpen && e.key === "ArrowRight" && lbAt < lbList.length - 1) {
      lbAt++;
      return drawLightbox();
    }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("dfn[data-go], g[data-go]")) {
      e.preventDefault();
      e.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    if (
      state.view === "data" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.target.matches?.("input,select,textarea") &&
      ["+", "=", "-", "0", "1"].includes(e.key)
    ) {
      applyZoom(e.key === "0" ? null : e.key === "1" ? 1 : zoomNow * (e.key === "-" ? 0.8 : 1.25));
      saveErd();
      return;
    }
    if (e.key === "/" && !e.target.matches?.("input,select,textarea")) {
      e.preventDefault();
      state.kind = null;
      nav({ view: "browse" });
      requestAnimationFrame(() => $("#q")?.focus());
    }
  });

  // tooltips: team words and connection boxes
  const tip = $("#tip");
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.classList.add("on");
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - r.width - 8))}px`;
    tip.style.top = `${y + 18 + r.height > innerHeight ? y - r.height - 10 : y + 18}px`;
  }
  document.addEventListener("mouseover", (e) => {
    const term = e.target.closest?.("dfn.term");
    if (term) {
      const c = by.concept[term.dataset.go.split(":")[1]];
      return showTip(`<b>${esc(c.term)}</b>${plain(c.definition)}`, e.clientX, e.clientY);
    }
    const node = e.target.closest?.("[data-tip]");
    if (node?.dataset.tip) {
      const p = by.part[node.dataset.go.split(":")[1]];
      return showTip(`<b>${esc(p.name)}</b>${plain(node.dataset.tip)}`, e.clientX, e.clientY);
    }
    const step = e.target.closest?.("[data-hover-part]");
    for (const el of document.querySelectorAll(".part.hover")) el.classList.remove("hover");
    if (step) $(`.part[data-part="${step.dataset.hoverPart}"]`)?.classList.add("hover");
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest?.("dfn.term,[data-tip]")) tip.classList.remove("on");
  });

  // drag the divider to resize the inspector
  const resizer = $("#resizer");
  resizer.addEventListener("pointerdown", (e) => {
    resizer.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.max(320, Math.min(innerWidth - 360, innerWidth - ev.clientX));
      document.documentElement.style.setProperty("--insp-w", `${w}px`);
    };
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
  });

  addEventListener("resize", () => {
    if (state.view === "data") drawErd();
  });
  document.addEventListener("fullscreenchange", () => {
    if (state.view === "data") requestAnimationFrame(() => applyZoom(null));
  });
  // Ctrl or Cmd + wheel (and trackpad pinch) zooms at the pointer.
  document.addEventListener(
    "wheel",
    (e) => {
      const canvas = e.target.closest?.("#erd-canvas");
      if (!canvas || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      applyZoom(zoomNow * Math.exp(-e.deltaY * 0.0025), {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      });
      saveErd();
    },
    { passive: false },
  );
  // Drag the background to move around the diagram.
  document.addEventListener("pointerdown", (e) => {
    const canvas = e.target.closest?.("#erd-canvas");
    if (!canvas || e.button !== 0 || e.target.closest(".tbl, .erd-zoom, .erd-info")) return;
    const start = { x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop };
    let moved = false;
    canvas.classList.add("panning");
    const move = (ev) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true;
      canvas.scrollLeft = start.l - (ev.clientX - start.x);
      canvas.scrollTop = start.t - (ev.clientY - start.y);
    };
    const up = () => {
      canvas.classList.remove("panning");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      // A click on the empty diagram, not a drag, clears the selection.
      if (!moved && state.sel?.type === "table") nav({ sel: null });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
  addEventListener("hashchange", () => {
    closeOverlay();
    closeLightbox();
    parseHash();
    render();
  });
  parseHash();
  render();
})();
