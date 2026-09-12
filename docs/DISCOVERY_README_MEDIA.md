# Discovery — README media (hero GIF + demo)

Requested 2026-09-12. Companion to `M-README` in `docs/task.md`. Encoding
commands and Marketplace image rules live in
`docs/RESEARCH_MARKETPLACE_CONVERSION.md`.

## What we have (updated 2026-09-12)

| Asset | Captured | Size | Shows |
| --- | --- | --- | --- |
| `media/demo.gif` | **2026-09-12** | 2.5 MB | 5 engines → preview → page → **cell edit** → column picker → JSON viewer |
| `media/query-panel.png` | **2026-09-12** | 334 KB | Query panel, column picker open, row gutter, JSON chips |
| `media/ai-query-generation.gif` | 2026-08-06 | 413 KB | AI assist bar generating SQL — still accurate, kept |
| `media/ai-assistance-setup.png` | 2026-08-06 | 169 KB | Provider/key setup — still accurate, kept |
| `media/ai-usage-table.png` | 2026-08-06 | 264 KB | Usage ledger — still accurate, kept |

## The problem with the current hero

`demo.gif` shows *setup*, not *value*. The first 8 seconds are a form being
filled in — the least interesting thing the extension does, and a step a viewer
has not yet decided to take. A listing visitor is deciding "is this better than
what I have"; the answer is the editable grid, the five engines and the AI bar,
none of which appear until the end.

Decision: **the hero GIF opens on an already-connected tree.** Setup moves to a
later, optional shot or stays as a still.

## Hero GIF — shot list

Target: ≤ 20 s, ≤ 2.5 MB, 1280×800 logical (2× retina capture, downscaled),
VS Code Dark+, editor font ≥ 15 px so it survives the Marketplace's column width.

| # | Beat | Seconds | What the viewer learns |
| --- | --- | --- | --- |
| 1 | Tree already open, showing **five connections** — Postgres, MySQL, SQLite, Redis, Athena — expanded one level | 0–2 | Five engines, one tree, no cap |
| 2 | Click a Postgres table → **Preview Rows**; grid paints; click `›` to page | 2–5 | Browsing is one click; previews page, not truncate |
| 3 | Double-click a cell, type a new value, `Enter`; row flashes committed | 5–8 | **The grid is writable** — the single strongest differentiator |
| 4 | Click `Columns ▾`, uncheck two columns; button reads `Columns 5/9` | 8–11 | Wide tables are tameable |
| 5 | Click `⤢` on a JSONB cell; tree expands; copy a path | 11–14 | Real JSON inspection, not a wall of text |
| 6 | Type a prompt in the AI bar → **Generate**; SQL appears; 🔒 auto-lock badge shows on a mutation | 14–18 | AI with a safety rail, your key |
| 7 | Hold on the results footer: elapsed time + row count | 18–20 | Honest about what it did |

Beat 3 is the one to protect. If the GIF has to be cut, cut beats 5–7, never 3.

## Second GIF (optional) — Athena

Athena is the newest capability and the one no free competitor has. 10–12 s:
pick an SSO profile → browse catalog → database → table → **Preview Rows** →
footer showing **bytes scanned**. The last frame is the whole pitch: a billed
engine that tells you what the click cost.

## Stills to re-shoot

- `query-panel.png` — same framing, but with the column picker open, the row
  gutter visible and a JSON cell summary in view.
- Keep the three AI stills; they are still accurate.

## Capture notes

- Record at 2× on a clean profile: no other extensions in the activity bar, no
  personal paths in the tree, no real hostnames. Sample data, not client data.
- Move the mouse deliberately and pause ~400 ms after each click — a GIF that
  reads as fast on capture reads as frantic on loop.
- Loop-friendly: end on a frame close to the opening one so the restart is not
  jarring.
- Everything under `media/` is excluded from the `.vsix` (`.vscodeignore`) and
  served to the Marketplace from GitHub raw — so a new asset must be **pushed to
  `main`** before it renders on the listing.

## Open decisions

- Whether to commit an `.mp4` source alongside the GIF for future re-cuts. The
  previous AI recording was deleted after conversion, so beat changes mean a
  full re-record.

## How the 2026-09-12 capture was actually done

Fully automated — no human screen time, and reproducible for a re-cut.

1. Three throwaway containers on a private Docker network (`dbdemo-postgres`,
   `dbdemo-mysql`, `dbdemo-redis`), deliberately separate from anything already
   running on the machine.
2. `scripts/demo-seed.sql` into Postgres. **This is the part worth keeping**: the
   first seed keyed every column off the row number, which produced a
   `lifetime_value` marching `9.77, 19.54, 29.31 …` and a tier cycling every
   four rows. It reads as fake instantly on screen. The committed version keys
   everything off `md5(g)` instead.
3. `codercom/code-server` with the built `.vsix` installed.
   **`security.workspace.trust.enabled: false` is required** — without it the
   workspace opens in Restricted Mode, which disables the extension entirely and
   the activity-bar icon simply never appears. This cost a debugging cycle.
4. The five connections came from an **Import Connections** file rather than five
   passes over the form — the extension's own portability format is the fastest
   way to seed a demo. Shape is in `src/connections/portability.ts`.
5. Beats driven through browser automation, then encoded with ffmpeg.

### Encoding

The recorder emits a GIF with variable inter-frame delays. Retiming that
directly with `setpts` **silently dropped 15 of 25 frames** (they collide once
quantised to centiseconds). Decode to PNGs first, then encode at a constant rate:

```sh
ffmpeg -i raw.gif -vsync 0 frames/f_%03d.png
ffmpeg -framerate 1.6 -pattern_type glob -i 'frames/f_*.png' \
  -vf "scale=1280:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=full" pal.png
ffmpeg -framerate 1.6 -pattern_type glob -i 'frames/f_*.png' -i pal.png \
  -lavfi "scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 demo.gif
```

`dither=bayer` beats the default floyd_steinberg on flat UI colour — it keeps
small text crisp instead of stippling it. 128 colours holds the text and saves
~400 KB over 192. Duplicate the first and last frames to give the loop a
readable start and end.

### Still open

- **The AI beat is not in the hero.** Driving Generate needs a real provider key
  and the capture environment has none. `ai-query-generation.gif` still matches
  shipped behaviour and carries the AI section on its own.
- **Athena has no GIF.** It needs real AWS credentials. It appears in the tree as
  a configured connection, which is all the hero claims.
