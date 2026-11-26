/* System map — the "How it works" guide.
 * Builds HTML strings from the map's data, in the page:
 *   - body()           the chapters, shown in the How it works tab
 *   - printDocument()  a whole print-ready document (cover, who uses it,
 *                      contents, chapters, words used). The Guide PDF button
 *                      builds it on the spot from the data and screenshots
 *                      inside this page and prints it, so the PDF is never
 *                      older than the map it came from.
 *
 * `h` lets the caller decide how text and screenshots become HTML:
 *   h.rich(text)        the page links team words; print does not
 *   h.shot(screen, img) the page makes it open the lightbox; print uses a figure
 */
const SystemMapGuide = (() => {
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

  /** Plain text to HTML with `code` and *emphasis*, and nothing else. */
  const plainRich = (text) =>
    String(text ?? "")
      .split(/(`[^`]+`|\*[^*\s][^*]*\*)/)
      .map((seg) => {
        if (seg.length > 2 && seg.startsWith("`") && seg.endsWith("`")) {
          return `<code>${esc(seg.slice(1, -1))}</code>`;
        }
        if (seg.length > 2 && seg.startsWith("*") && seg.endsWith("*")) {
          return `<i>${esc(seg.slice(1, -1))}</i>`;
        }
        return esc(seg);
      })
      .join("");

  /** Features a reader of the guide should see, grouped by area, in order. */
  function chapters(D) {
    return D.areas
      .map((a) => ({
        area: a,
        features: D.features.filter((f) => f.area === a.id && f.audience !== "team"),
      }))
      .filter((c) => c.features.length);
  }

  function feature(D, SHOTS, f, n, h) {
    const screen = Object.fromEntries(D.screens.map((s) => [s.id, s]));
    const shown = new Set();
    const steps = f.steps
      .map((s) => {
        // Each screenshot once per feature, at the first step that uses it.
        const figs = (s.screens || [])
          .filter((id) => SHOTS[id] && !shown.has(id) && shown.add(id))
          .map((id) => h.shot(screen[id], SHOTS[id]))
          .join("");
        return `<li><div class="g-step"><b>${h.rich(s.title)}</b>${s.detail ? `<p>${h.rich(s.detail)}</p>` : ""}</div>${figs ? `<div class="g-shots">${figs}</div>` : ""}</li>`;
      })
      .join("");
    const rules = f.rules?.length
      ? `<div class="g-rules"><h3>Good to know</h3><ul>${f.rules.map((r) => `<li>${h.rich(r)}</li>`).join("")}</ul></div>`
      : "";
    return `<article class="g-feature" id="g-${f.id}">
      <div class="g-kicker">${esc(n)}</div>
      <h2>${esc(f.name)}</h2>
      <p class="g-who"><span><b>Who</b> ${esc(f.actor)}</span><span><b>When</b> ${esc(f.trigger)}</span></p>
      <p class="g-sum">${h.rich(f.summary)}</p>
      <h3>How it works</h3>
      <ol class="g-steps">${steps}</ol>
      ${rules}
      ${h.after ? h.after(f) : ""}
    </article>`;
  }

  /** Every chapter: `<section>` per area, `<article>` per feature. */
  function body(D, SHOTS, h) {
    return chapters(D)
      .map(
        (c, i) => `<section class="g-area" id="g-area-${c.area.id}">
          ${h.areaHead ? h.areaHead(c, i) : `<h1 class="g-area-title"><span>${i + 1}</span>${esc(c.area.name)}</h1>`}
          ${c.features.map((f, j) => feature(D, SHOTS, f, `${i + 1}.${j + 1}`, h)).join("")}
        </section>`,
      )
      .join("");
  }

  /**
   * The publisher's mark: the SVG the build reads from meta.mark (the
   * product icon by default), with extra attributes on its root element.
   */
  function brandMark(D, attrs = "") {
    const svg = D?.meta?.mark || "";
    return attrs ? svg.replace(/<svg\b/, `<svg ${attrs}`) : svg;
  }

  /** Running header and footer, as on the template's content slides. */
  function pageRules(D, title, note) {
    const q = (t) => `"${String(t).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const mark = `url("data:image/svg+xml,${encodeURIComponent(brandMark(D, 'width="5.4mm" height="5.4mm"'))}")`;
    const head =
      "vertical-align: bottom; padding-bottom: 3mm; border-bottom: 0.3mm solid #111; margin-bottom: 8mm;";
    const foot = "vertical-align: top; padding-top: 6mm;";
    const none = [
      "top-left",
      "top-center",
      "top-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]
      .map((b) => `@${b} { content: none; border: 0; }`)
      .join(" ");
    return `@page {
  size: A4;
  margin: 33mm 16mm 23mm;
  @top-left { content: ${q(title)}; font: 400 9pt "Inter", sans-serif; color: #0b0b0b; ${head} }
  @top-center { content: ""; ${head} }
  @top-right { content: ${mark}; ${head} padding-bottom: 2.2mm; }
  @bottom-left { content: ${q(D.meta.publisher.toUpperCase())}; font: 800 8.5pt "Montserrat", sans-serif; color: #000; ${foot} }
  @bottom-center { content: ${q(note)}; font: 400 6.5pt "Inter", sans-serif; color: #8a8a8a; ${foot} }
  @bottom-right { content: counter(page); font: 700 9.5pt "Montserrat", sans-serif; color: #000; ${foot} }
}
/* the cover and the chapter dividers run to the edge of the paper */
@page bleed { margin: 0; ${none} }`;
  }

  /** The whole guide as one print-ready HTML document. `css` is guide-print.css. */
  function printDocument(D, SHOTS, css) {
    const m = D.meta;
    const list = chapters(D);
    const h = {
      rich: plainRich,
      // A chapter opens on a black page: its number, its name, what is in it.
      areaHead: (c, i) => `<div class="chapter">
  <div class="ch-top"><span>${esc(D.system.name)} · How it works</span>${brandMark(D)}</div>
  <div class="ch-num">${String(i + 1).padStart(2, "0")}</div>
  <h1>${esc(c.area.name)}</h1>
  <div class="ch-in">In this chapter</div>
  <ol class="ch-list">${c.features.map((f, j) => `<li><span>${i + 1}.${j + 1}</span><div><b>${esc(f.name)}</b>${esc(f.actor)}</div></li>`).join("")}</ol>
  <div class="ch-foot">${brandMark(D)}<span>${esc(D.meta.publisher.toUpperCase())}</span></div>
</div>`,
      shot: (sc, img) =>
        `<figure class="${sc.kind}"><img src="${img.src}" alt="" width="${img.w}" height="${img.h}"><figcaption>${esc(sc.title)}${sc.role ? ` · ${esc(sc.role)}` : ""}</figcaption></figure>`,
    };
    const date = new Date(m.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const audience = D.system.client.split(" · ")[0];
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(D.system.name)} - How it works${m.release ? ` (${esc(m.release)})` : ""}</title>
<style>${pageRules(D, `${D.system.name} · How it works`, `${m.license ? `${m.license} licensed, open source. ` : ""}Prepared by ${m.publisher}.`)}
${css}</style>
</head>
<body>
<section class="cover">
  <div class="cv-main">
    <div class="cv-rule"></div>
    <div class="cv-label">Guide${m.release ? ` · Version ${esc(m.release.replace(/^v/, ""))}` : ""}</div>
    <h1>${esc(D.system.name)}<br><em>How it works</em></h1>
    <p class="cv-sub">${esc(D.system.headline)}. How each feature works, step by step.</p>
    <div class="cv-meta">
      <div><b>Prepared by</b>${esc(m.publisher)}</div>
      <div><b>Prepared for</b>${esc(audience)}</div>
      <div><b>Date</b>${esc(date)}</div>
    </div>
  </div>
  <div class="cv-side"><div class="cv-mark">${brandMark(D)}</div><span class="cv-word">${esc(m.publisher)}</span></div>
</section>
<section class="front">
  <h1>What it is</h1>
  <p class="lead">${plainRich(D.system.summary)}</p>
  <h2>Who uses it</h2>
  <table class="roles"><tbody>${D.system.actors.map((a) => `<tr><td>${esc(a.name)}</td><td>${plainRich(a.does)}</td></tr>`).join("")}</tbody></table>
</section>
<section class="front">
  <h1>The loop everything turns on</h1>
  <ol class="loop">${D.system.loop.map((l) => `<li>${plainRich(l)}</li>`).join("")}</ol>
</section>
<section class="front toc">
  <h1>In this guide</h1>
  <ol>${list.map((c, i) => `<li><b><span>${String(i + 1).padStart(2, "0")}</span>${esc(c.area.name)}</b><ol>${c.features.map((f, j) => `<li><span>${i + 1}.${j + 1}</span>${esc(f.name)}</li>`).join("")}</ol></li>`).join("")}</ol>
</section>
${body(D, SHOTS, h)}
<section class="words">
  <h1>Words used</h1>
  <dl>${D.concepts
    .filter((c) => !c.tech)
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((c) => `<div><dt>${esc(c.term)}</dt><dd>${plainRich(c.definition)}</dd></div>`)
    .join("")}</dl>
</section>
</body>
</html>`;
  }

  return { chapters, feature, body, printDocument, brandMark, esc };
})();
