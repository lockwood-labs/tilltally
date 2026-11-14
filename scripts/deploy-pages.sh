#!/usr/bin/env bash
# Deploy the TillTally frontend to Cloudflare Pages, with the service
# worker cache (and the in-app version stamp) auto-stamped for this deploy.
#
# Why: the installed PWA must pick up updates on its own — no reinstall,
# no manual cache bumps. Stamping a unique version into sw.js changes its
# bytes on every deploy, so browsers fetch the new worker, which caches
# the new shell under a new name and activates immediately (skipWaiting);
# app.js then reloads the page once onto the new shell.
#
# Version = short git hash (falls back to a UTC timestamp outside a repo).
#
# Usage:
#   scripts/deploy-pages.sh [--branch main]
# Env:
#   WRANGLER_CMD   wrangler invocation to use (default: "npx wrangler")
#   PAGES_PROJECT  Pages project name (default: tilltally)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PROJECT="${PAGES_PROJECT:-tilltally}"
read -r -a WRANGLER <<< "${WRANGLER_CMD:-npx wrangler}"

if git rev-parse --short HEAD >/dev/null 2>&1; then
  VERSION="$(git rev-parse --short HEAD)"
else
  VERSION="$(date -u +%Y%m%d%H%M%S)"
fi
echo "Deploy version: $VERSION"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Stage a clean copy of just the static frontend.
for f in index.html app.js core.js config.js styles.css manifest.webmanifest sw.js icon.svg icon-192.png icon-512.png icon-maskable-512.png icon-180.png; do
  cp "$ROOT/$f" "$STAGE/$f"
done

# Stamp the version into the staged copies (repo copies keep the
# __TILLTALLY_VERSION__ placeholder, so the repo stays deploy-agnostic).
sed -i "s/__TILLTALLY_VERSION__/$VERSION/g" "$STAGE/sw.js" "$STAGE/config.js"
if grep -q "__TILLTALLY_VERSION__" "$STAGE/sw.js" "$STAGE/config.js"; then
  echo "ERROR: version placeholder survived stamping" >&2
  exit 1
fi
grep -o 'tilltally-shell-[^"]*' "$STAGE/sw.js" | head -1

"${WRANGLER[@]}" pages deploy "$STAGE" --project-name "$PROJECT" "$@"
echo "Deployed $PROJECT with shell version $VERSION."
