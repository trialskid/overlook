#!/bin/sh
# Leak scan: fails when a tracked (or staged) file contains a string from the denylist.
# The denylist is private: local/denylist.txt here (gitignored), the LEAK_DENYLIST secret in CI.
# Short terms that would match inside other words go in a second list matched as whole words (<denylist>-words.txt).
# A line whose only hits are the project's own public addresses (.leak-allow) doesn't count.
# Usage: scripts/leak-scan.sh [denylist] (default local/denylist.txt). Prints file:count, exits 1 on any hit.
list="${1:-local/denylist.txt}"
words="${list%.txt}-words.txt"
allow="$(git rev-parse --show-toplevel)/.leak-allow"
[ -s "$list" ] || { echo "leak-scan: no denylist at $list" >&2; exit 2; }
strip() { if [ -s "$allow" ]; then sed "$(sed 's/[.[\*^$/]/\\&/g; s|.*|s/&//Ig|' "$allow")"; else cat; fi; }
hits=$(git ls-files -z --cached | xargs -0 grep -I -H -n -i -F -f "$list" 2>/dev/null | strip | grep -i -F -f "$list" | cut -d: -f1 | sort | uniq -c)
if [ -s "$words" ]; then
  whits=$(git ls-files -z --cached | xargs -0 grep -I -H -n -i -w -F -f "$words" 2>/dev/null | cut -d: -f1 | sort | uniq -c)
  hits=$(printf '%s\n%s\n' "$hits" "$whits" | grep -v '^$')
fi
if [ -n "$hits" ]; then
  echo "$hits" | awk '{ print $2 ":" $1 }' | sort -u
  echo "leak-scan: $(echo "$hits" | awk '{ print $2 }' | sort -u | wc -l | tr -d ' ') file(s) with denylisted strings" >&2
  exit 1
fi
echo "leak-scan: clean"
