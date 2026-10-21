#!/usr/bin/env bash
# Upload index parts as assets of a GitHub release (they are not tracked by
# git), and record the release tag in each index's manifest.json. Commit the
# manifests afterwards; the Pages workflow downloads the parts at deploy time.
# Only rebuilt indices need publishing; the others keep their release.
#
#   bash scripts/publish_indices.sh [-t tag] [names...]
#
# Default tag: indices-<today>. Default names: every index in site/index.
# Needs the GitHub CLI (gh), logged in, run from a clone of the repository.
# Without gh: create the release on GitHub's web page, drag in the files from
# `python3 scripts/index_parts.py list site [names]`, then run
# `python3 scripts/index_parts.py set-release site <tag> [names]`.
set -euo pipefail

WA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WA_DIR"
TAG="indices-$(date -u +%Y-%m-%d)"
if [ "${1:-}" = "-t" ]; then
  TAG=$2
  shift 2
fi

command -v gh >/dev/null || { echo "Install the GitHub CLI (gh) and run 'gh auth login' first." >&2; exit 1; }
python3 -I scripts/index_parts.py verify site "$@"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  gh release create "$TAG" --prerelease --title "Index files $TAG" \
    --notes "Index files for the web site (not a code release). Each site/index/<name>/manifest.json names the release holding its parts; the Pages workflow downloads them at deploy time."
fi
mapfile -t FILES < <(python3 -I scripts/index_parts.py list site "$@")
gh release upload "$TAG" "${FILES[@]}" --clobber
python3 -I scripts/index_parts.py set-release site "$TAG" "$@"
echo "Uploaded ${#FILES[@]} parts to $TAG. Now commit site/index/*/manifest.json and push."
