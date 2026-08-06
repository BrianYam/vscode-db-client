#!/usr/bin/env sh
# Secret-scan gate, run from the pre-commit hook (and manually via
# `npm run scan:secrets`). Two passes because they cover different things:
#   1. full committed history, all branches (the command this script preserves)
#   2. the staged change itself — history scans can't see what isn't committed yet
set -e

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed (brew install gitleaks) — refusing to commit unscanned." >&2
  exit 1
fi

gitleaks detect --source . --log-opts="--all" --redact
gitleaks git --pre-commit --staged --redact .
