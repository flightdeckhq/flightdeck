#!/usr/bin/env bash
# Checks that the installers the project's site serves are the root
# installers, byte for byte.
#
# The README's install command is
#   curl -fsSL https://flightdeck-hq.com/install.sh | sh
# GitHub Pages serves docs/ of main at that domain as static files. It
# cannot redirect to the repository's raw file, so docs/install.sh and
# docs/install.ps1 are copies of install.sh and install.ps1. A copy
# that falls behind its source would hand the one-command install an
# installer other than the one CI tests and the install gate runs, so
# this script fails when a copy differs from its source or is missing.
#
# Two more things the served copies depend on:
#   - docs/.nojekyll exists, so Pages publishes docs/ as the files it
#     holds, with no Jekyll build between the repository and the site.
#   - Both installers are ASCII. Pages sends a .ps1 without a charset,
#     and Windows PowerShell 5.1 then decodes the response as
#     ISO-8859-1: a non-ASCII byte would reach `iex` as other
#     characters than the ones in the file.
#
# Usage: scripts/check-installer-copies.sh           check (CI runs it in
#                                                    the marketplace-schema
#                                                    job, "Repo scripts and
#                                                    manifests")
#        scripts/check-installer-copies.sh --write   refresh the copies
#                                                    (make installer-copies)
# ROOT_DIR overrides the repository root, for
# scripts/test-check-installer-copies.sh, which runs this script on a
# temp tree with a copy changed and expects it to fail.
set -euo pipefail

ROOT="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The installers, as paths from the repository root; each is served
# from docs/ under the same name.
INSTALLERS="install.sh install.ps1"

write=0
case "${1:-}" in
  "") ;;
  --write) write=1 ;;
  -h | --help)
    # The header comment, up to the first line that is not a comment.
    awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
    exit 0
    ;;
  *)
    echo "check-installer-copies: unknown argument: $1" >&2
    echo "usage: scripts/check-installer-copies.sh [--write]" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  echo "check-installer-copies: more than one argument" >&2
  echo "usage: scripts/check-installer-copies.sh [--write]" >&2
  exit 2
fi

status=0
fail() { echo "FAIL: $1" >&2; status=1; }

for name in $INSTALLERS; do
  source_file="$ROOT/$name"
  copy="$ROOT/docs/$name"
  if [ ! -f "$source_file" ]; then
    fail "$name is missing from the repository root"
    continue
  fi
  # LC_ALL=C makes the bracket expression a byte range, so the test is
  # the same under any locale: a line with a byte outside printable
  # ASCII and whitespace fails. -a keeps grep reading such a file as
  # text, so it reports the line and not "binary file matches". grep
  # exits 1 when every line is clean, which is not a failure here.
  bad_line="$({ LC_ALL=C grep -an "[^[:print:][:space:]]" "$source_file" || true; } | head -1 | cut -d: -f1)"
  if [ -n "$bad_line" ]; then
    fail "$name has a non-ASCII byte (line $bad_line); the site serves it without a charset, so keep it ASCII"
  fi
  if [ "$write" -eq 1 ]; then
    cp "$source_file" "$copy"
    echo "wrote docs/$name"
    continue
  fi
  if [ ! -f "$copy" ]; then
    fail "docs/$name is missing: the site would answer 404 for it (run: make installer-copies)"
  elif ! cmp -s "$source_file" "$copy"; then
    fail "docs/$name differs from $name: the site would serve another installer than the one tested (run: make installer-copies)"
  fi
done

[ -f "$ROOT/docs/.nojekyll" ] || fail "docs/.nojekyll is missing: Pages would build docs/ with Jekyll instead of publishing its files as they are"

if [ "$status" -ne 0 ]; then
  echo "check-installer-copies FAILED" >&2
  exit 1
fi
[ "$write" -eq 1 ] || echo "check-installer-copies OK: docs/install.sh and docs/install.ps1 match the root installers"
