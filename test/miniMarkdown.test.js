// The tiny Markdown renderer behind the "What's new" guide. It only has to handle
// our own CHANGELOG.md — but it renders into a webview, so escaping matters.
const { test } = require("node:test");
const assert = require("node:assert");
const { renderChangelog } = require("../out/webview/miniMarkdown.js");

const SAMPLE = `# Changelog

All notable changes are documented in this file.

## [Unreleased]

## [0.4.1] - 2026-07-31

### Fixed
- Query panel now shows \`NULL\` distinctly
- A long entry that
      wraps onto a continuation line

### Added
- **Bold** thing and a [link](https://example.com/x)

[0.4.1]: https://example.com/compare
`;

test("renders release headings and bullets, newest first", () => {
  const h = renderChangelog(SAMPLE);
  assert.match(h, /<h3 class="rel">\[0\.4\.1\] - 2026-07-31<\/h3>/);
  assert.match(h, /<h4>Fixed<\/h4>/);
  assert.match(h, /<li>Query panel now shows <code>NULL<\/code> distinctly<\/li>/);
});

test("drops the title block, link definitions, and an empty Unreleased section", () => {
  const h = renderChangelog(SAMPLE);
  assert.ok(!h.includes("All notable changes"), "preamble should not be rendered");
  assert.ok(!h.includes("Unreleased"), "an empty section should not show as a bare heading");
  assert.ok(!h.includes("compare"), "link-reference definitions are not content");
});

test("folds a wrapped continuation line into its bullet", () => {
  const h = renderChangelog(SAMPLE);
  assert.match(h, /<li>A long entry that wraps onto a continuation line<\/li>/);
});

test("renders inline emphasis and http links", () => {
  const h = renderChangelog(SAMPLE);
  assert.match(h, /<strong>Bold<\/strong>/);
  assert.match(h, /<a href="https:\/\/example\.com\/x">link<\/a>/);
});

test("escapes HTML in the source rather than passing it through", () => {
  const h = renderChangelog('## [1.0.0]\n\n### Added\n- <img src=x onerror="alert(1)">\n');
  assert.ok(!h.includes("<img"), "raw HTML must not survive into the webview");
  assert.match(h, /&lt;img/);
});

test("does not turn a non-http URL into a link", () => {
  const h = renderChangelog("## [1.0.0]\n\n### Added\n- [click](javascript:alert(1))\n");
  assert.ok(!h.includes("<a href"), "only http(s) links are rendered");
});

test("an empty or unreadable changelog renders to nothing, not a broken shell", () => {
  assert.strictEqual(renderChangelog(""), "");
  assert.strictEqual(renderChangelog("# Changelog\n\nJust a preamble.\n"), "");
});
