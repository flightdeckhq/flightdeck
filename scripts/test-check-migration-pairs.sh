#!/usr/bin/env bash
# Self-test of scripts/check-migration-pairs.sh: on a temp copy of the
# two migration directories, the check passes as is and fails when a
# down file is removed, when an up file has no down, when a version
# exists on one side only, and when a file is misnamed. It exists
# because the check once printed its FAIL line from a subshell and
# still exited 0.
#
# Usage: scripts/test-check-migration-pairs.sh   (CI runs it in the Go job)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-migration-pairs.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

status=0
fail() { echo "FAIL: $1" >&2; status=1; }

# fresh: resets the temp copy to the repository's directories.
fresh() {
  rm -rf "$work/postgres" "$work/sqlite"
  cp -r "$ROOT/storage/migrations/postgres" "$work/postgres"
  cp -r "$ROOT/storage/migrations/sqlite" "$work/sqlite"
}

# expect <rc> <description>: runs the check on the temp copy and
# compares its exit code.
expect() {
  local want="$1" what="$2" rc=0
  PG_DIR="$work/postgres" LITE_DIR="$work/sqlite" "$CHECK" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    fail "$what: exit $rc, want $want"
    sed 's/^/    /' "$work/out" >&2
  else
    echo "ok: $what (exit $rc)"
  fi
}

fresh
expect 0 "the repository's directories pass"

fresh
newest_down="$(ls "$work/postgres"/*.down.sql | sort | tail -n1)"
rm "$newest_down"
expect 1 "a postgres up file without its down ($(basename "$newest_down") removed)"

fresh
rm "$work/sqlite/000001_baseline.down.sql"
expect 1 "the sqlite baseline without its down"

fresh
touch "$work/postgres/000099_only_here.up.sql" "$work/postgres/000099_only_here.down.sql"
expect 1 "a postgres version with no sqlite pair"

fresh
touch "$work/sqlite/000099_only_here.up.sql" "$work/sqlite/000099_only_here.down.sql"
expect 1 "a sqlite version with no postgres pair"

fresh
touch "$work/sqlite/000099_stray.up.sql"
expect 1 "a stray up file"

fresh
touch "$work/sqlite/99_bad-name.up.sql"
expect 1 "a misnamed file"

if [ "$status" -ne 0 ]; then
  echo "check-migration-pairs self-test FAILED" >&2
  exit 1
fi
echo "check-migration-pairs self-test OK"
