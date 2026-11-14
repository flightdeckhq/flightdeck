#!/usr/bin/env bash
# Checks that every script the Makefile or a workflow runs by its path
# is executable in git. A script with a shebang that is committed with
# mode 100644 runs for whoever wrote it (their checkout has the bit, or
# their filesystem ignores it) and fails with "Permission denied" on a
# fresh clone, which is how scripts/release.sh stopped `make
# release-prep`.
#
# "Run by its path" means the path is the command word of a line in the
# Makefile or in .github/workflows/*.yml: `./scripts/release.sh prep`,
# `run: scripts/install-gate.sh ...`, `VAR=1 scripts/x.sh`. A script
# handed to an interpreter or a tool (`python3 scripts/version.py`,
# `shellcheck scripts/x.sh`) needs no executable bit and is not looked
# at. The mode is read from git's index, not the working tree: a
# checkout on a filesystem without modes shows every file executable.
#
# Usage: scripts/check-script-modes.sh   (CI runs it in the scripts job)
# CHECK_ROOT overrides the repository, for
# scripts/test-check-script-modes.sh, which runs this script on fixture
# repositories.
set -euo pipefail

ROOT="${CHECK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# command_words prints the command word of every simple command in the
# Makefile and the workflows, one per line, without a leading "./".
# A line that ends in a backslash continues on the next one, so the
# words of a continuation line are arguments, not a command.
# Comment lines are dropped, and so is every "key: value" line whose key
# is not "run" (a step's name, a matrix entry, a Make target: text, not
# a command); "&&", "||", ";", "|" and "(" start a new command; Make's
# "@", a YAML list dash, the "run:" key, shell keywords and VAR=value
# prefixes before the command word are skipped.
command_words() {
  local files=()
  [ -f Makefile ] && files+=(Makefile)
  while IFS= read -r f; do
    files+=("$f")
  done < <(git ls-files -- '.github/workflows/*.yml' '.github/workflows/*.yaml')
  [ "${#files[@]}" -gt 0 ] || return 0
  awk '{ if (sub(/\\$/, "")) printf "%s ", $0; else print }' "${files[@]}" |
    sed -E \
    -e '/^[[:space:]]*#/d' \
    -e '/^[[:space:]]*(-[[:space:]]+)?run:/!{/^[[:space:]]*(-[[:space:]]+)?[A-Za-z_][A-Za-z0-9_.-]*:([[:space:]]|$)/d;}' \
    -e 's/(&&|\|\|)/;/g' |
    tr ';|(' '\n' |
    sed -E \
      -e 's/^[[:space:]@-]+//' \
      -e 's/^run:[[:space:]]*//' \
      -e 's/^((if|then|else|elif|do|while|until|exec|time|!)[[:space:]]+)+//' \
      -e 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+//' \
      -e 's/[[:space:]].*$//' \
      -e 's/^"(.*)"$/\1/' \
      -e 's|^\./||' |
    sort -u
}

# The command words that are tracked files, as "<mode> <path>".
tracked="$(git ls-files -s | awk -F'\t' '
  NR == FNR { want[$0] = 1; next }
  ($2 in want) { split($1, meta, " "); print meta[1], $2 }
' <(command_words) -)"

status=0
checked=0
while read -r mode path; do
  [ -n "$path" ] || continue
  first=""
  IFS= read -r first <"$path" || true
  case "$first" in
    '#!'*) ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  if [ "$mode" != 100755 ]; then
    echo "FAIL: $path is run by its path from the Makefile or a workflow but is committed with mode $mode;" \
      "make it executable: git update-index --chmod=+x $path" >&2
    status=1
  fi
done <<<"$tracked"

if [ "$status" -ne 0 ]; then
  exit 1
fi
echo "script modes ok: $checked scripts run by path, all executable"
