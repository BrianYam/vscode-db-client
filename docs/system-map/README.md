# System map

An interactive page that explains what Open DB Client does and why, for a contributor on their first day, with a *How it works* guide (and its PDF) for people who use the extension. Prepared by BrianLab.

- `map.json` is the source: every fact the page shows, each tagged with how we know it (read from code, from a record such as a blueprint or `task.md`, Brian said, or inferred).
- `answers.md` is where the map's open questions get answered and where the map gets corrected.
- Screens come from [`docs/screens/`](../screens/README.md), which points at the README images in `media/`.
- `open-db-client-system-map.html` is build output and is not committed.

To view it, build the page and open it:

```bash
npm run system-map -- --open
```

`npm run system-map:check` validates `map.json` against the repo without writing the page.

## What is in the page

| Tab | What |
| --- | --- |
| Map | Every part by layer. *Trace a feature* lights up its path |
| How it works | The guide: each feature as plain steps, with its screens and the rules worth knowing |
| Browse all | Features, parts, words, decisions, danger zones and open questions, with search |
| All screens | Every screenshot |
| Start here | What to read and run on a first day, and what changed in the map |

**Guide PDF** (top right) builds a print document from the data inside the page and opens the print dialog; *Save as PDF* is the download. It carries the BrianLab name and the product icon, and leaves out engineering detail, danger zones and open questions.

## How it stays true

The map is maintained by a skill, `/system-map` ([`.claude/skills/system-map/`](../../.claude/skills/system-map/SKILL.md)):

1. It reads what merged since the commit the map describes (`meta.commit`), and what changed in `docs/` and `CHANGELOG.md`.
2. It re-reads the code behind every item those changes touch, and revises `map.json`.
3. It folds in new answers from `answers.md` and appends new open questions there.
4. It runs the build, which checks every file and line reference against the repo and refuses to write the page if one is wrong.

The format is in [`references/map-schema.md`](../../.claude/skills/system-map/references/map-schema.md). Possible weaknesses never go in the map; they appear as one neutral line ("open question on …, raised with Brian") and the details go to Brian directly.
