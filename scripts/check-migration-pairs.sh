#!/usr/bin/env bash
# Checks that the Postgres and SQLite migration directories stay in
# step: from the first SQLite version onward, both directories list the
# same version numbers, and every version in either directory is an
# up/down pair.
#
# SQLite starts from one baseline (000001) that equals the Postgres
# schema at the version the baseline was written from (recorded below).
# Every schema change after that lands as a pair with the same version
# number in storage/migrations/postgres and storage/migrations/sqlite,
# so a change to one backend cannot land without the other.
#
# Usage: scripts/check-migration-pairs.sh   (CI runs it in the Go job)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_DIR="$ROOT/storage/migrations/postgres"
LITE_DIR="$ROOT/storage/migrations/sqlite"

# The Postgres version the SQLite baseline (sqlite 000001) was translated
# from. Postgres versions up to it have no SQLite counterpart; every
# later version must exist in both directories.
BASELINE_FROM_POSTGRES=36

status=0
fail() { echo "FAIL: $1" >&2; status=1; }

# versions <dir>: prints the distinct version numbers of a directory,
# failing on a file that is not an up/down pair or is misnamed.
versions() {
  local dir="$1" f name stem kind
  declare -A ups=() downs=()
  for f in "$dir"/*.sql; do
    name="$(basename "$f")"
    if [[ ! "$name" =~ ^([0-9]{6})_([a-z0-9_]+)\.(up|down)\.sql$ ]]; then
      fail "$dir/$name is not named 000NNN_description.{up,down}.sql"
      continue
    fi
    stem="${BASH_REMATCH[1]}_${BASH_REMATCH[2]}"
    kind="${BASH_REMATCH[3]}"
    if [ "$kind" = up ]; then ups["$stem"]=1; else downs["$stem"]=1; fi
  done
  for stem in "${!ups[@]}"; do
    [ -n "${downs[$stem]:-}" ] || fail "$dir/$stem.up.sql has no $stem.down.sql"
    echo "${stem%%_*}"
  done
  for stem in "${!downs[@]}"; do
    [ -n "${ups[$stem]:-}" ] || fail "$dir/$stem.down.sql has no $stem.up.sql"
  done
}

pg_versions="$(versions "$PG_DIR" | sort -u)"
lite_versions="$(versions "$LITE_DIR" | sort -u)"

[ -n "$pg_versions" ] || fail "no migrations in $PG_DIR"
[ -n "$lite_versions" ] || fail "no migrations in $LITE_DIR"

# A version number appears once per directory.
for dir in "$PG_DIR" "$LITE_DIR"; do
  dups="$(ls "$dir"/*.up.sql | xargs -n1 basename | cut -c1-6 | sort | uniq -d)"
  [ -z "$dups" ] || fail "$dir has more than one migration for version(s): $(echo "$dups" | tr '\n' ' ')"
done

# Postgres versions after the baseline need an SQLite pair.
while IFS= read -r v; do
  [ -n "$v" ] || continue
  if ((10#$v > BASELINE_FROM_POSTGRES)); then
    grep -qx "$v" <<<"$lite_versions" ||
      fail "postgres migration $v has no sqlite migration $v (add storage/migrations/sqlite/${v}_<description>.{up,down}.sql)"
  fi
done <<<"$pg_versions"

# SQLite versions after the baseline need a Postgres pair.
while IFS= read -r v; do
  [ -n "$v" ] || continue
  if ((10#$v == 1)); then
    continue # the baseline
  fi
  if ((10#$v <= BASELINE_FROM_POSTGRES)); then
    fail "sqlite migration $v is numbered inside the Postgres history the baseline replaces (use a number above $BASELINE_FROM_POSTGRES)"
  elif ! grep -qx "$v" <<<"$pg_versions"; then
    fail "sqlite migration $v has no postgres migration $v (add storage/migrations/postgres/${v}_<description>.{up,down}.sql)"
  fi
done <<<"$lite_versions"

# The newest version is the same on both sides.
pg_latest="$(tail -n1 <<<"$pg_versions")"
lite_latest="$(tail -n1 <<<"$lite_versions")"
if ((10#$pg_latest > BASELINE_FROM_POSTGRES)) && [ "$pg_latest" != "$lite_latest" ]; then
  fail "newest postgres migration is $pg_latest, newest sqlite migration is $lite_latest"
fi

if [ "$status" -eq 0 ]; then
  echo "migration pairs OK: postgres up to $pg_latest, sqlite up to $lite_latest (baseline from postgres $BASELINE_FROM_POSTGRES)"
fi
exit "$status"
