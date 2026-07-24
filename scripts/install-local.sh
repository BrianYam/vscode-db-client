#!/usr/bin/env bash
# Install the freshly-built .vsix into your local VS Code, overwriting the
# installed copy in place (no uninstall needed). Targets the version currently
# in package.json, so run it straight after `npm run package` / `npm run release:*`.
#
# Usage:  ./scripts/install-local.sh
# Then reload the window: Cmd/Ctrl+Shift+P -> "Developer: Reload Window".
set -euo pipefail

# Resolve the repo root from this script's location, so it runs from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Read name + version out of package.json (node is already a dev dependency here).
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
VSIX="${NAME}-${VERSION}.vsix"

if ! command -v code >/dev/null 2>&1; then
  echo "error: the 'code' CLI is not on your PATH." >&2
  echo "  Fix once via VS Code: Cmd/Ctrl+Shift+P -> \"Shell Command: Install 'code' command in PATH\"." >&2
  exit 1
fi

if [ ! -f "$VSIX" ]; then
  echo "error: $VSIX not found. Build it first with: npm run package" >&2
  exit 1
fi

echo "Installing $VSIX ..."
code --install-extension "$VSIX" --force
echo "Done. Reload VS Code: Cmd/Ctrl+Shift+P -> \"Developer: Reload Window\"."
