/**
 * A deliberately tiny Markdown→HTML renderer for the one document it has to
 * handle: our own CHANGELOG.md, in Keep a Changelog shape. Not a general parser —
 * headings, bullets, and inline emphasis/code/links are the whole grammar.
 *
 * Why not a dependency: this runs inside a webview with a strict CSP, the input
 * is a file we ship ourselves, and pulling a full Markdown engine into the bundle
 * for one guide tab is not a trade worth making.
 */

/** HTML-escape first, always — the output is injected into a webview. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inline spans: `code`, **bold**, _italic_, [text](url). Applied to
 * already-escaped text, so the tags we emit are the only tags present.
 */
function inline(s: string): string {
  return (
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      // Only http(s) links get rendered as links; anything else stays as text so
      // a stray javascript: or file: URL can never become clickable.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  );
}

/** A link-reference definition line, e.g. `[0.4.1]: https://…` — not content. */
function isLinkRef(line: string): boolean {
  return /^\[[^\]]+\]:\s*\S+/.test(line);
}

/**
 * Render the release sections of a changelog. Everything before the first `## `
 * (title, format blurb) is dropped — the reader is in a guide tab that already
 * says what this is. An `## [Unreleased]` section with no entries is dropped too,
 * rather than shown as an empty heading.
 */
export function renderChangelog(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let started = false;
  // Buffered so a heading with no content under it can be dropped retroactively.
  let pendingHeading = "";

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const flushHeading = () => {
    if (pendingHeading) {
      out.push(pendingHeading);
      pendingHeading = "";
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      closeList();
      // A release heading replaces an unflushed one: nothing came under it.
      pendingHeading = `<h3 class="rel">${inline(line.replace(/^##\s+/, ""))}</h3>`;
      started = true;
      continue;
    }
    if (!started || isLinkRef(line)) {
      continue;
    }
    if (/^###\s+/.test(line)) {
      closeList();
      // Keep the release heading attached: flush it before its first subsection.
      flushHeading();
      out.push(`<h4>${inline(line.replace(/^###\s+/, ""))}</h4>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushHeading();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    // An indented continuation line belongs to the bullet above it.
    if (inList && /^\s+\S/.test(raw)) {
      const last = out.pop() ?? "";
      out.push(last.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`));
      continue;
    }
    closeList();
    flushHeading();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  // A trailing pendingHeading is an empty section (typically `## [Unreleased]`).
  return out.join("\n");
}
