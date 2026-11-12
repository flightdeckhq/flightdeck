#!/usr/bin/env bash
# Self-test of scripts/check-installer-copies.sh on temp trees.
#
# A tree whose copies match passes. Each of these fails and names its
# reason: a copy that differs by one byte, a missing copy, a missing
# docs/.nojekyll, a missing root installer and a non-ASCII byte in an
# installer. --write repairs a stale and a missing copy, after which the
# check passes; it does not hide a non-ASCII byte. An unknown argument
# is a usage error.
#
# Usage: scripts/test-check-installer-copies.sh   (CI runs it in the
# marketplace-schema job, "Repo scripts and manifests")
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-installer-copies.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

status=0
fail() { echo "FAIL: $1" >&2; status=1; }

# tree <name>: a repository root with both installers, their copies and
# docs/.nojekyll, all in step. Prints its path.
tree() {
  local dir="$work/$1"
  mkdir -p "$dir/docs"
  printf '#!/bin/sh\necho install\n' >"$dir/install.sh"
  printf 'Write-Host install\n' >"$dir/install.ps1"
  cp "$dir/install.sh" "$dir/docs/install.sh"
  cp "$dir/install.ps1" "$dir/docs/install.ps1"
  : >"$dir/docs/.nojekyll"
  echo "$dir"
}

# expect <rc> <description> <tree> [args...]: runs the check on a tree
# and compares its exit code; the output is kept in $work/out.
expect() {
  local want="$1" what="$2" dir="$3" rc=0
  shift 3
  ROOT_DIR="$dir" "$CHECK" "$@" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    fail "$what: exit $rc, want $want"
    sed 's/^/    /' "$work/out" >&2
  else
    echo "ok: $what (exit $rc)"
  fi
}

# expect_output <pattern> <description>: the last run's output contains
# the pattern (grep -E).
expect_output() {
  if grep -Eq -- "$1" "$work/out"; then
    echo "ok: $2"
  else
    fail "$2: output lacks '$1':"
    sed 's/^/    /' "$work/out" >&2
  fi
}

good="$(tree good)"
expect 0 "copies that match pass" "$good"
expect_output 'check-installer-copies OK' "the verdict is printed"

stale="$(tree stale)"
printf '#!/bin/sh\necho instal1\n' >"$stale/docs/install.sh"
expect 1 "a copy that differs by one byte fails" "$stale"
expect_output 'docs/install\.sh differs from install\.sh' "the failure names the copy and its source"
expect_output 'make installer-copies' "and the command that repairs it"

stale_ps1="$(tree stale-ps1)"
printf 'Write-Host install\r\n' >"$stale_ps1/docs/install.ps1"
expect 1 "a copy that differs only in its line ending fails" "$stale_ps1"
expect_output 'docs/install\.ps1 differs from install\.ps1' "the failure names the PowerShell copy"

missing="$(tree missing)"
rm "$missing/docs/install.ps1"
expect 1 "a missing copy fails" "$missing"
expect_output 'docs/install\.ps1 is missing' "the failure names the missing copy"

nojekyll="$(tree nojekyll)"
rm "$nojekyll/docs/.nojekyll"
expect 1 "a missing docs/.nojekyll fails" "$nojekyll"
expect_output 'docs/\.nojekyll is missing' "the failure names the file"

nosource="$(tree nosource)"
rm "$nosource/install.sh"
expect 1 "a missing root installer fails" "$nosource"
expect_output 'install\.sh is missing from the repository root' "the failure names the installer"

# A UTF-8 e-acute (0xC3 0xA9) on line 2, in the source and its copy
# alike: the copies match and the check still fails.
nonascii="$(tree nonascii)"
printf 'Write-Host install\n# caf\303\251\n' >"$nonascii/install.ps1"
cp "$nonascii/install.ps1" "$nonascii/docs/install.ps1"
expect 1 "a non-ASCII byte in an installer fails" "$nonascii"
expect_output 'install\.ps1 has a non-ASCII byte \(line 2\)' "the failure names the installer and the line"
expect 1 "--write does not hide a non-ASCII byte" "$nonascii" --write

# --write repairs a stale copy and a missing one.
expect 0 "--write refreshes a stale copy" "$stale" --write
expect_output 'wrote docs/install\.sh' "and says what it wrote"
expect 0 "the refreshed tree passes" "$stale"
expect 0 "--write creates a missing copy" "$missing" --write
expect 0 "the completed tree passes" "$missing"

expect 2 "an unknown argument is exit 2" "$good" --fix
expect_output 'unknown argument: --fix' "the failure names the argument"
expect 2 "a second argument is exit 2" "$good" --write --write
expect 0 "--help exits 0" "$good" --help
expect_output '^Usage: scripts/check-installer-copies.sh' "and prints the header"

if [ "$status" -ne 0 ]; then
  echo "check-installer-copies self-test FAILED" >&2
  exit 1
fi
echo "check-installer-copies self-test OK"
