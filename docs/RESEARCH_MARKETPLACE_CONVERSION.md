# Research — Marketplace Listing Conversion (README & Media)

Scope: primary-source research only (official VS Code/Microsoft docs, `vsce` source, live
competitor listing pages) to inform a README/media rewrite aimed at increasing install
conversion for `brianlab.open-database-client`. No `README.md`/`package.json` changes made
here — findings only. Research date: **2026-09-12**.

## 1. Marketplace README rendering rules

### Relative image/link paths — what they resolve to
[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#advanced-usage)
states: *"If you have a `repository` property in your `package.json` that points to a
public GitHub repository, `vsce` will automatically detect it and adjust relative links
accordingly, using the `main` branch by default. You can override this with the
`--githubBranch` flag... You can also set base URLs for links and images with the
`--baseContentUrl` and `--baseImagesUrl` flags."*

The prose says "main branch by default," but the actual `vsce` source
([`guessBaseUrls`](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts#L965-L1008))
is more precise — when `--githubBranch`/`--gitlabBranch` is not passed, it falls back to
the literal ref **`HEAD`**, not the string `main`:
```ts
const branchName = githostBranch ? githostBranch : 'HEAD';
if (/^github/.test(match.groups.domain)) {
  return {
    content: `https://github.com/${project}/blob/${branchName}`,
    images: `https://github.com/${project}/raw/${branchName}`,
    repository: `https://github.com/${project}`,
  };
}
```
So today, with no `--baseContentUrl`/`--baseImagesUrl` and a GitHub `repository` field, a
relative image like `media/demo.gif` in `README.md` is rewritten at package time to
`https://github.com/<owner>/<repo>/raw/HEAD/media/demo.gif` (which itself 302-redirects to
`raw.githubusercontent.com`), and a relative **non-image** link is rewritten to
`https://github.com/<owner>/<repo>/blob/HEAD/<path>`. `--baseContentUrl`/`--baseImagesUrl`
simply override these two prefixes wholesale (content = non-image links, images = image
`src`s) — per `vsce`'s own type comments in
[`src/package.ts`](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts#L142-L147).
**Yes, relative paths to `media/demo.gif` work today** as long as the repo is public on
GitHub/GitLab and the file exists at that path on the resolved branch — this repo's
`repository` field already points at a public GitHub repo, so no `--baseContentUrl` flags
are needed for `npm run package`.

### Allowed image sources
From the same page, quoted verbatim: *"Due to security concerns, `vsce` will not publish
extensions that contain user-provided SVG images. The publishing tool checks the following
constraints:"*
- *"The icon provided in `package.json` may not be an SVG."*
- *"The badges provided in the `package.json` may not be SVGs unless they are from trusted
  badge providers."*
- *"Image URLs in `README.md` and `CHANGELOG.md` need to resolve to `https` URLs."*
- *"Images in `README.md` and `CHANGELOG.md` may not be SVGs unless they are from trusted
  badge providers."*

The "trusted badge providers" allowlist is the same one used for the `badges` manifest
field — see §2. **GIFs and PNGs are unrestricted** (no HTTPS-hosted-SVG loophole needed for
a demo GIF).

### Size limits
**Not documented anywhere I could find** — no stated `.vsix` size cap, no README/GIF byte
limit, on either the publishing-extension page or the extension-manifest page. A public ask
for the exact VSIX size ceiling was filed against Microsoft's own tracker
([microsoft/vsmarketplace#1541](https://github.com/microsoft/vsmarketplace/issues/1541), "What
is the maximum allowed VSIX / extension size?") and the VS Marketplace team's own reply was
to redirect the asker to `VSMarketplace@microsoft.com` rather than cite a number — i.e.
Microsoft confirms this isn't publicly documented. Treat any GIF-size guidance as a
practical/perf concern (page load, GitHub raw-file limits), not a documented Marketplace
rule.

### HTML tags in the rendered README
No page found states an HTML allowlist or what gets stripped. The one documented lever is
the manifest's `markdown` field: *"Controls the Markdown rendering engine used in the
Marketplace. Either `github` (default) or `standard`."*
([extension-manifest](https://code.visualstudio.com/api/references/extension-manifest#fields)).
Since `github` is the default engine, and GitHub's own README renderer passes through a
constrained set of inline HTML (raw `<img>`, `<p align>`, `<table>`, `<details>`, etc. all
render on github.com), it's a reasonable inference that the same is broadly true on the
Marketplace by default — but **this is inference, not a quoted Marketplace-specific rule**,
and I found no primary source enumerating which tags survive sanitization on
`marketplace.visualstudio.com` specifically. The competitor teardown in §3 shows `<table>`
markup and shields.io/GitHub badge images rendering correctly on live listings (e.g.
`ms-mssql.mssql`'s capability table, `cweijan.vscode-database-client2`'s badge row) — this is
first-hand confirmation those constructs work in practice, but `<details>`/`<p align=center>`
specifically were **not verified** in this pass (see Open questions).

## 2. Manifest fields & search ranking

### Field → listing-page mapping (from [extension-manifest](https://code.visualstudio.com/api/references/extension-manifest#fields))
| Field | Where it renders | Notes |
|---|---|---|
| `displayName` | Page `<h1>` | *"must be unique to the Marketplace"* |
| `description` | Sub-heading under the name, and in search result rows | |
| `categories` | Breadcrumb + category filter facets | enumerated list below |
| `keywords` | Merged into Marketplace "Tags" (search only, not shown as visible chips near the title in the current UI) | capped — see below |
| `icon` | The square icon left of the title | *"at least 128x128 pixels (256x256 for Retina screens)"*; **must not be an SVG** |
| `galleryBanner` | Documented as *"Helps format the Marketplace header to match your icon"* (`color` + `theme: dark\|light`) | **Live-page observation, not a doc statement**: I loaded `cweijan.vscode-database-client2` (which visually should test this) in a real browser on 2026-09-12 and the header rendered as plain light gray with no banner color — see screenshot evidence in this session. Docs do **not** call the field deprecated, but it visibly has no effect on the current redesigned listing page. Treat as low-leverage. |
| `badges` | Sidebar strip under the icon | must come from the approved list (below) |
| `qna` | The "Q & A" tab / link | `marketplace` (default) \| custom URL string \| `false` |
| `sponsor` | A "Sponsor" link on the page | *"an object with a single property `url`"* |
| `pricing` | A pricing label near the install count | Allowed values: `Free`, `Trial`; default `Free` |
| `repository`, `bugs`, `homepage` | "Resources" section | |
| `license` | "Resources" section / license badge | use `"SEE LICENSE IN <filename>"` if no SPDX id |

### Categories — full enumerated list (verbatim)
*"Allowed values: `[Programming Languages, Snippets, Linters, Themes, Debuggers,
Formatters, Keymaps, SCM Providers, Other, Extension Packs, Language Packs, Data Science,
Machine Learning, Visualization, Notebooks, Education, Testing]`"* — this repo's manifest
should pick from this exact set (`Other` plus something more specific is the documented
pattern shown for the sample `wordcount` extension).

### Keyword/tag limit
Manifest doc: *"This list is currently limited to 30 keywords."* Confirmed by the
publishing-extension FAQ, which gives the exact failure message: *"I get a 'You exceeded
the number of allowed tags of 30' error when I try to publish my extension? The Visual
Studio Marketplace does not allow an extension package to have more than 30 keywords in
the `package.json`. Limit the number of keywords/tags to maximum 30 to avoid this error."*

### Approved badge URL prefixes (verbatim list)
From [extension-manifest#approved-badges](https://code.visualstudio.com/api/references/extension-manifest#approved-badges):
*"Due to security concerns, we only allow badges from trusted services. We allow badges
from the following URL prefixes:"* `api.travis-ci.com`, `app.fossa.io`,
`badge.buildkite.com`, `badge.fury.io`, `badgen.net`, `badges.frapsoft.com`,
`badges.gitter.im`, `cdn.travis-ci.com`, `ci.appveyor.com`, `circleci.com`,
`cla.opensource.microsoft.com`, `codacy.com`, `codeclimate.com`, `codecov.io`,
`coveralls.io`, `david-dm.org`, `deepscan.io`, `dev.azure.com`, `docs.rs`,
`flat.badgen.net`, `github.com` (from Workflows only), `gitlab.com`, `godoc.org`,
`goreportcard.com`, `img.shields.io`, `isitmaintained.com`, `marketplace.visualstudio.com`,
`nodesecurity.io`, `opencollective.com`, `snyk.io`, `travis-ci.com`, `visualstudio.com`,
`vsmarketplacebadges.dev`. (`shields.io` badges — very common for install-count/version
badges — are covered via `img.shields.io`.)

### Search ranking / "trending" algorithm
**No documented ranking or trending algorithm found** despite a targeted search of
`code.visualstudio.com` and `learn.microsoft.com`. What **is** documented, on
[Extension Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace):
sort via `@sort:` with values `installs` (*"Sort by Marketplace installation count, in
descending order"*), `name`, `publishedDate`, `rating` (*"Sort by Marketplace rating (1-5
stars), in descending order"*), `updateDate`; and filters `@popular` (*"Show popular
extensions"*) and `@featured` (*"Show featured extensions"*) with no stated criteria for
either. Each result row shows *"a brief description, the publisher, the download count,
and a five star rating."* There is no page describing how the **default** (un-sorted)
relevance ranking is computed, so any "keyword stuffing helps ranking" claim would be
unsupported by primary sources — flag as an open question rather than act on it.

## 3. Competitor listing teardown (observed 2026-09-12, live pages)

| Extension | Installs | Rating | Price | Hero media location |
|---|---|---|---|---|
| [`cweijan.vscode-database-client2`](https://marketplace.visualstudio.com/items?itemName=cweijan.vscode-database-client2) | 1,299,741 | 4★ (142 reviews) | Free Trial | No image in first screenful — title block → badge row (retired-badge×2, GitHub stars) → 3-line description → Telemetry paragraph → first screenshot only appears under "Getting Started → Browse Tables" |
| [`mtxr.sqltools`](https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools) | 7,002,021 | 3.5★ (145 reviews) | Free | No screenshot/GIF in the first 3 sections at all — install command block → prose intro → bulleted feature list → driver logos |
| [`ms-mssql.mssql`](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql) | 9,723,938 | 3★ (205 reviews) | Free | First visual is a YouTube-thumbnail image in an "Explore and Learn" section (2nd content block), not an inline GIF; 3rd block is a GA/Preview capability **table** |
| [`qwtel.sqlite-viewer`](https://marketplace.visualstudio.com/items?itemName=qwtel.sqlite-viewer) | 3,573,682 | 4★ (81 reviews) | Free + paid Pro upsell | **Only one of the five that leads with media** — a demo GIF appears immediately after the opening paragraph, inside the first screenful; a "Caveats" section is explicit about read-only/200MB-file limits and the paid upgrade |
| [`ckolkman.vscode-postgres`](https://marketplace.visualstudio.com/items?itemName=ckolkman.vscode-postgres) | 1,497,544 | 4.5★ (60 reviews) | Free | Text-heavy: overview paragraph → caveats ("_NOT_ meant for creating/dropping...", version support) → feature bullets → usage prose; first GIF (`add_connection.gif`) lands ~4-5 screenfuls down |

**Pattern**: 4 of 5 direct competitors (including the two highest-install ones, `mssql` and
`sqltools`) bury their first screenshot/GIF well below the fold behind prose, badges, or a
telemetry disclosure. Only `qwtel.sqlite-viewer` — the one competitor with a paid tier to
justify — leads with a GIF in the first screenful. None of the five use a pricing/limits
*comparison table*; `sqlite-viewer` states its Pro-tier trigger conditions in plain prose
under "Caveats" rather than a table. These are factual observations from a single fetch on
2026-09-12; install/rating counts move constantly and will already be stale on read.

## 4. GIF/demo production — primary tooling docs

### Official VS Code guidance
There is **no dedicated official page** for marketplace screenshots/demo recording. The
[UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview) page exists but is
scoped entirely to *in-editor* UI (Activity Bar, Views, Webviews, Command Palette, etc.) —
it explicitly frames itself as *"best practices for creating extensions that seamlessly
integrate with VS Code's native interface and patterns,"* not marketplace presentation. The
only marketplace-media-adjacent guidance is the one line already quoted in §1: *"Add a
`README.md` file to the root of your extension with the content you want to show on the
extension's Marketplace page"* plus a pointer to the Go extension as a worked example — no
prescriptive screenshot/GIF rules exist in first-party docs.

### `ffmpeg` — palettegen/paletteuse (two-pass GIF encode)
From the [official filter docs](https://ffmpeg.org/ffmpeg-filters.html#palettegen-1),
`palettegen` *"Generate one palette for a whole video stream"* with options `max_colors`
(*"Set the maximum number of colors to quantize in the palette"*, palette entries beyond
the count stay black), `stats_mode` (`full` default / `diff` / `single`), and
`reserve_transparent`. Documented minimal example: `ffmpeg -i input.mkv -vf palettegen
palette.png`. `paletteuse` *"Use a palette to downsample an input video stream"* with
`dither` (default `sierra2_4a`; also `bayer`, `floyd_steinberg`, `none`, etc.),
`bayer_scale` (int 0-5, default 2 — *"low value means more visible pattern for less
banding"*), and `diff_mode=rectangle` (*"Only the changing rectangle will be reprocessed...
useful for speed if only a part of the image is changing"*). Documented example:
`ffmpeg -i input.mkv -i palette.png -lavfi paletteuse output.gif`. A practical single-pass
combined command per these same docs:
```
ffmpeg -i input.mp4 -vf "fps=15,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" out.gif
```
(`fps`/`scale`/`split` are standard ffmpeg filters used ahead of the documented
palettegen/paletteuse pair, not part of the palettegen/paletteuse spec itself.)

### `gifski`
From the [gifski README](https://github.com/ImageOptim/gifski): pipe frames in via ffmpeg
— `ffmpeg -i video.mp4 -f yuv4mpegpipe - | gifski -o anim.gif -` — or from PNG frames —
`gifski -o anim.gif frame*.png`. Quality flags: `--quality=80` (lower overall quality),
`--lossy-quality=60` (*"lower values make animations noisier/grainy, but reduce file
sizes"*), `--motion-quality=60` (*"lower values cause smearing or banding in frames with
motion, but reduce file sizes"*), and `--width`/`--height` to resize. The README's own
size-reduction advice: *"Use `--width` and `--height` to make the animation smaller. This
makes the biggest difference"* — and it's candid that GIF has a ceiling: *"Expect to lose a
lot of quality for little gain. GIF just isn't that good at compressing, no matter how much
you compromise."*

### `vhs` (charmbracelet)
From the [VHS README](https://github.com/charmbracelet/vhs): a `.tape` script drives a
recorded terminal session, e.g.:
```
Output demo.gif
Set FontSize 46
Set Width 1200
Set Height 600
Type "echo 'Welcome to VHS!'"
Sleep 500ms
Enter
Sleep 5s
```
run with `vhs demo.tape`. `Output` accepts `.gif`, `.mp4`, `.webm`, or a frame directory.
`Set` controls `FontSize`, `Width`/`Height` (or `Columns`/`Rows`), `FontFamily`, `Theme`,
`LetterSpacing`/`LineHeight`, `Padding`/`Margin`, `BorderRadius` — all of which affect
output pixel dimensions and therefore file size. VHS is terminal-only (records a PTY), so
it applies to this repo's `npm run bundle`/test terminal output, **not** to recording the
actual VS Code webview UI (query panel, grid, tree) — for that, ffmpeg screen capture +
palettegen/paletteuse or gifski remains the applicable path.

## Open questions

- **Exact HTML-tag allowlist/stripping behavior** on the Marketplace README renderer is not
  documented anywhere I found; only the `markdown: github|standard` manifest switch is
  documented, and its practical effect on constructs like `<details>` or
  `<p align="center">` was not directly verified against a live listing in this pass.
- **No public `.vsix`/README image size limit exists** — Microsoft's own team declined to
  state one in a public GitHub issue and redirected to private support. Any size target
  should be treated as a performance choice, not a compliance requirement.
- **No documented default/relevance search-ranking algorithm** — only explicit sort orders
  (`installs`, `rating`, `name`, `publishedDate`, `updateDate`) and undefined `@popular`/
  `@featured` filters are documented. Don't optimize keywords against an assumed ranking
  formula that isn't published.
- **`galleryBanner`'s real-world effect**: not marked deprecated in current docs, but a live
  screenshot of `cweijan.vscode-database-client2` (2026-09-12) shows no rendered banner
  color despite the field commonly being set by extensions of that vintage. Worth spot
  checking this extension's own current listing to see if `galleryBanner` visibly does
  anything before investing effort in tuning its `color`/`theme`.
- **`<details>`-based collapsible sections and centered `<p align="center">` image blocks**
  were not confirmed rendering correctly on a live Marketplace listing in this research
  pass — verify directly (e.g. via a throwaway pre-release build) before relying on them
  for layout in the rewritten README.
