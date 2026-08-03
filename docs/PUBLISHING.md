# Publishing Open DB Client to the VS Code Marketplace

End-to-end guide for getting `brianlab.open-database-client` live on the Visual Studio
Code Marketplace, and keeping it updated. One-time setup is Steps 1–3; every
release after that is just the [release loop](#the-release-loop).

> **Cost:** Publishing is free. You do **not** need a paid Azure subscription or
> a credit card. The only things you ever enter are your Microsoft/GitHub login
> and an access token.

---

## How the pieces fit

Publishing touches three separate Microsoft systems, which is what makes the
setup confusing the first time. The order that works:

1. **Azure DevOps** → generate a Personal Access Token (PAT)
2. **VS Code Marketplace** → create the `brianlab` publisher
3. **vsce CLI** → log in with the token, then publish

Do them in that order and it's smooth.

## Prerequisites

- **Node.js ≥ 20.18.1** — vsce complains with `EBADENGINE` below that.
- No global install needed: this repo invokes vsce via `npx --yes @vscode/vsce`
  (see the `package` and `publish:marketplace` scripts in `package.json`).
- `package.json` already carries the required fields: `name: open-database-client`,
  `publisher: brianlab`, `displayName`, `version`, `engines.vscode`, and a
  `repository` pointing at GitHub (the Marketplace uses it to resolve README
  links and show the repo link on the extension page).

## Step 1 — Create an Azure DevOps token (one-time)

1. Go to **https://aex.dev.azure.com/**
   > ⚠️ Use this URL, **not** `dev.azure.com`. Typing `dev.azure.com` directly
   > often bounces you to `portal.azure.com` (the cloud console — the wrong
   > place). `aex.dev.azure.com` goes straight to the DevOps organizations
   > page. If it still redirects, open a **private/incognito window** — a
   > cached session is usually the culprit.
2. Sign in with your Microsoft or GitHub account. If you have no organization
   yet, create one — name it, pick the nearest region, continue. **No payment
   screen appears.**
3. Click the **User settings** icon (top-right, next to your avatar) →
   **Personal access tokens**.
4. Click **+ New Token** and set:
   - **Name:** e.g. `vsce-publish`
   - **Organization:** **All accessible organizations** ← important; a
     single-org token will not work for publishing
   - **Expiration:** up to a year (custom)
   - **Scopes:** click **Show all scopes** at the bottom, scroll to
     **Marketplace**, check **Manage** (it covers publish + future updates)
5. **Create**, then **copy the token immediately** — it is shown only once.
   Keep it in your password manager; never commit it or paste it into files
   in this repo.

> **Heads-up (timing):** Microsoft is retiring global Azure DevOps PATs on
> **December 1, 2026**. The PAT method still works and is the simplest way to
> publish manually. For automated CI publishing after that date, migrate to
> Microsoft Entra ID / managed-identity authentication.

## Step 2 — Create the publisher (one-time)

1. Go to **https://marketplace.visualstudio.com/manage**
2. Create a new publisher with ID **`brianlab`** — it must exactly match the
   `publisher` field in `package.json`, or every publish fails with
   `ERROR: publisher not found`.
3. Fill in the display name and any optional fields.

## Step 3 — Log in with vsce (one-time per machine)

```bash
npx --yes @vscode/vsce login brianlab
```

Paste the token from Step 1 when prompted. You should see confirmation that
verification succeeded.

## The release loop

This repo's versioning policy (see `CLAUDE.md`) is the source of truth: notes
accumulate under `## [Unreleased]` in `CHANGELOG.md`, and `npm run release:*`
bumps + stamps + tags + builds the `.vsix`. Publishing is a separate, explicit
step on top:

```bash
# 1. Cut the release (clean tree required — runs tests, bumps version,
#    stamps CHANGELOG, commits, tags, builds the .vsix)
npm run release:patch     # or release:minor / release:major

# 2. Publish the version you just cut — on success this also runs
#    `git push` + `git push --tags` for you
npm run publish:marketplace

# 3. A few minutes later, confirm the Marketplace picked it up
npm run marketplace:verify
```

`publish:marketplace` runs `scripts/publish.mjs`, which refuses to publish
unless the working tree is clean and `CHANGELOG.md` has a stamped section for
the current version — so you can't accidentally ship an un-released state.
After a successful publish it pushes the release commit and tags to origin
(the version is public at that point, so the tag must not stay local).
Note the split: `release:*` stays local on purpose — until you publish, a bad
release can still be undone (`git tag -d vX.Y.Z` + `git reset --hard HEAD~1`).

Flags:

```bash
npm run publish:marketplace -- --dry-run   # run only the checks, publish nothing
npm run publish:marketplace -- --no-push   # publish but leave git push to you
```

Under the hood the script calls `vsce publish`, which triggers
`vscode:prepublish` (typecheck + production esbuild bundle) before uploading.

### Verifying what's live

A fresh publish spends **5–10 minutes** in Marketplace validation before going
public (it shows in [the manage dashboard](https://marketplace.visualstudio.com/manage/publishers/brianlab)
first). To check without opening a browser:

```bash
npm run marketplace:verify             # live version vs local package.json
npm run marketplace:verify -- --ovsx   # also check Open VSX
npm run marketplace:show               # full `vsce show` listing
```

`marketplace:verify` (`scripts/marketplace-status.mjs`) hits the public gallery
API — no login needed — and exits non-zero when the extension isn't found or
the live version differs from local, so it doubles as a CI/post-publish gate.
Once live, users find it in VS Code's Extensions view by searching
**"Open DB Client"**, or at:

- https://marketplace.visualstudio.com/items?itemName=brianlab.open-database-client

> **Do not use `vsce publish patch/minor/major` directly** — it would bump the
> version without running `scripts/stamp-changelog.mjs`, breaking the
> version-⇄-changelog lock-step. Always bump via `npm run release:*`.

### Manual fallback

If you'd rather upload by hand: `npm run package` produces
`open-database-client-<version>.vsix` (note: this local build intentionally uses
placeholder content URLs — fine for local installs, but prefer
`publish:marketplace` for the real Marketplace so README links resolve to
GitHub). The `.vsix` can be uploaded through the web UI at
https://marketplace.visualstudio.com/manage, or installed locally to test:

```bash
code --install-extension open-database-client-0.4.3.vsix
```

## Optional — publish to Open VSX too

The VS Code Marketplace only serves official VS Code. Editors like **Cursor**,
**VSCodium**, and **Gitpod** pull from a separate registry, **Open VSX** —
also free. One-time setup: create an account + access token at
https://open-vsx.org, then create the namespace:

```bash
npx --yes ovsx create-namespace brianlab -p <YOUR_OPEN_VSX_TOKEN>
```

After that, each release can go to both registries:

```bash
OVSX_PAT=<YOUR_OPEN_VSX_TOKEN> npm run publish:marketplace -- --ovsx
```

The script publishes to the VS Code Marketplace first, then to Open VSX with
the token from the `OVSX_PAT` environment variable (never store the token in
the repo).

## Common gotchas

| Problem | Fix |
| --- | --- |
| `dev.azure.com` redirects to `portal.azure.com` | Use `https://aex.dev.azure.com/`; if it still loops, try a private/incognito window or another browser |
| A page asks for credit card details | You've wandered into `signup.azure.com` (paid cloud). Publishing never needs a card — back out and use `aex.dev.azure.com` |
| Publish fails with an auth error | Check **both**: token scope is `Marketplace → Manage`, **and** the org dropdown was set to **All accessible organizations** |
| `ERROR: publisher not found` | Create the `brianlab` publisher first (Step 2); the ID must match `package.json` |
| `ERROR: The extension '<name>' already exists in the Marketplace` | Extension `name`s are reserved **globally across all publishers** (even by unpublished/removed extensions, which don't show in search). Pick a different `name` in `package.json` — this is why ours is `open-database-client` while the `displayName` stays "Open DB Client" |
| Publish rejected on version | You can't republish the same version number — cut a new one with `npm run release:*` |
| `EBADENGINE` warning | Update Node.js to ≥ 20.18.1 |
| `scripts/publish.mjs` aborts on a dirty tree / missing changelog section | That's the guard working: commit or stash your changes, and cut the version via `npm run release:*` before publishing |

## Command cheat sheet

```bash
npx --yes @vscode/vsce login brianlab          # authenticate (paste PAT)
npm run release:patch                          # bump + stamp CHANGELOG + tag + build .vsix
npm run publish:marketplace                    # checked publish of the current version
npm run publish:marketplace -- --dry-run       # run the safety checks only
OVSX_PAT=… npm run publish:marketplace -- --ovsx   # also publish to Open VSX
npm run marketplace:verify                     # live Marketplace version vs local
npm run marketplace:show                       # full `vsce show` listing
npx --yes @vscode/vsce unpublish brianlab.open-database-client  # remove (use with care)
```
