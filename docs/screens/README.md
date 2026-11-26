# Screens

Screenshots the system map shows at the journey step where each happens.

- `screens.json`: each screen, its caption, the journey steps that show it (`step` counts from 0), and the `source` files that draw it.
- `manifest.json`: the image file, its size, and the commit it was taken at. The map marks a screen *may be out of date* when one of its `source` files changed after that commit.
- `<id>.png`: written by the capture script. Never edit them by hand.

## Taking them

```bash
npm run screens
```

This photographs the real extension, not a mock-up:

1. Packages this checkout into a `.vsix`.
2. Starts throwaway containers on a private Docker network, all named `shots-*`: PostgreSQL seeded with `scripts/demo-seed.sql`, Redis seeded with `scripts/screens/redis-seed.txt`, and `codercom/code-server` with the `.vsix` installed. Workspace trust is off, or the extension never activates.
3. Adds the connections through the extension's own *Import Connections*, the same way the README media were made (see `docs/DISCOVERY_README_MEDIA.md`).
4. Drives VS Code in Chromium through each shot in `scripts/screens/shots.mjs`, starting every shot from a freshly loaded window so nothing from the last one leaks in.
5. Writes `<id>.png` here, records the commit in `manifest.json`, and removes the containers.

It needs Docker and Playwright's Chromium (`playwright-core` is a dev dependency, pinned to the version whose browser is cached). It never touches your own VS Code, databases or connections.

```bash
npm run screens -- run-query edit-cell   # only these
npm run screens -- --keep                # leave the stack up afterwards
npm run screens -- run-query --reuse     # drive a kept stack, while writing a shot
```

Then rebuild the map with `npm run system-map`.

## Not captured by the script

Three screens come from the README's `media/` folder, because the script has nothing real to show for them:

- `demo` and `ai-generate` are animated GIFs.
- `ai-generate` and `ai-usage` need a real AI provider key and real usage.

Athena has no screens: it needs real AWS credentials.

## Adding a screen

1. Add a function to `scripts/screens/shots.mjs`, keyed by the new id. It gets the kit (command palette, tree, webview and dialog helpers) and ends with `k.shot(id)`.
2. Run it on its own with `--keep`, then iterate with `--reuse` until the picture is right.
3. Add the screen to `screens.json` with the journey step it shows.
