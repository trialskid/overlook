#!/bin/sh
# Builds the tree to publish in a fresh folder (default: a temp dir): every tracked file at HEAD, nothing else
# (local/, config/homelab.json, .env and CLAUDE.local.md are never tracked), then runs the leak scan on it with the
# private denylist. Publishing is a separate, deliberate step: a new repository
# with one commit of this tree (the working repository's history is not published).
# Usage: scripts/export-public.sh [out-dir]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$(mktemp -d)/overlook}
mkdir -p "$out"
git -C "$here" archive --format=tar HEAD | tar -x -C "$out"
cp "$here/local/denylist.txt" "$out/.denylist.txt"; [ -f "$here/local/denylist-words.txt" ] && cp "$here/local/denylist-words.txt" "$out/.denylist-words.txt"
cd "$out"
git init -q && git add -A && git -c user.email=export@invalid -c user.name=export commit -qm export >/dev/null
git rm -q --cached .denylist.txt .denylist-words.txt 2>/dev/null || true
scripts/leak-scan.sh .denylist.txt && rm -f .denylist.txt .denylist-words.txt && rm -rf .git
echo "exported to $out ($(find . -type f | wc -l | tr -d ' ') files)"
