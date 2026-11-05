#!/usr/bin/env bash
# Runs the Go tests that need Postgres against the dev stack's Postgres.
#
# Those tests skip unless TEST_POSTGRES_URL (or, for the assembler,
# TEST_ASSEMBLER_POSTGRES_URL) names a database, so `go test ./...`
# alone never runs them. This script gives each package its own fresh
# database on the running stack's Postgres server, seeds it with
# docker/postgres/init.sql and migrates it to the newest migration
# through the workers' own migrate path, runs the package's tests
# against it, and drops every database it created on exit. The shared
# `flightdeck` database is never touched.
#
# A database per package keeps packages from seeing each other's rows;
# the assembler needs one to itself because it claims every due trace
# in its database, including the staging store tests' traces.
#
# The run fails when a package fails, when any test in a listed package
# skips (a DB-gated test that skips did not run), or when a test file
# outside the list opens Postgres or reads a Postgres DSN variable (a
# new DB-gated package must be added to DB_PACKAGES).
#
# Requires: the dev stack running (`make dev`), Go, docker.
# Usage: make test-go-db   (or scripts/go-db-tests.sh)
#
# Environment overrides:
#   PG_CONTAINER   Postgres container name (default docker-postgres-1)
#   PG_BASE_URL    DSN prefix the tests connect through, without the
#                  database name (default
#                  postgres://flightdeck:flightdeck_dev@127.0.0.1:5432)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_CONTAINER="${PG_CONTAINER:-docker-postgres-1}"
PG_BASE_URL="${PG_BASE_URL:-postgres://flightdeck:flightdeck_dev@127.0.0.1:5432}"
MIGRATIONS_DIR="$ROOT/docker/postgres/migrations"

# Every Go test package with a test that opens Postgres through a DSN
# from the environment, as <module>/<package dir>.
DB_PACKAGES=(
  api/internal/auth
  api/internal/store
  ingestion/internal/assembler
  ingestion/internal/auth
  ingestion/internal/handlers
  ingestion/internal/otlpstage
  ingestion/internal/session
  workers/internal/processor
  workers/internal/writer
)

# How long to wait for Postgres to accept connections. The stack's own
# healthcheck gives up after 5 tries 5 s apart, so 60 s covers a cold
# start with margin.
PG_READY_TIMEOUT_SECS=60

in_ci() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }
group() { if in_ci; then echo "::group::$1"; else echo "== $1"; fi; }
endgroup() { if in_ci; then echo "::endgroup::"; fi; }
fail() { if in_ci; then echo "::error::$1"; else echo "FAIL: $1" >&2; fi; exit 1; }

psql_admin() {
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U flightdeck -d postgres "$@"
}

# --- Every DB-gated test package is in the list ---------------------------
cd "$ROOT"
# A package counts as DB-gated when a test file opens a connection
# (pgxpool.New, pgx.Connect) or names any *POSTGRES_URL variable, however
# it reads it (Getenv, LookupEnv, a helper). Lines that call Setenv are
# left out: the config tests set FLIGHTDECK_POSTGRES_URL to a dummy
# value to test config parsing and never open a database.
found=()
while IFS= read -r pkg; do found+=("$pkg"); done < <(
  grep -rnE 'pgxpool\.New|pgx\.Connect|[A-Z_]*POSTGRES_URL' \
    --include='*_test.go' api ingestion workers |
    grep -v 'Setenv(' | cut -d: -f1 | xargs -r -n1 dirname | sort -u
)
for pkg in ${found[@]+"${found[@]}"}; do
  if [[ ! " ${DB_PACKAGES[*]} " == *" $pkg "* ]]; then
    fail "$pkg has a test that opens Postgres or reads a Postgres DSN but is not in DB_PACKAGES in scripts/go-db-tests.sh"
  fi
done
for pkg in "${DB_PACKAGES[@]}"; do
  if [[ ! " ${found[*]-} " == *" $pkg "* ]]; then
    fail "$pkg is in DB_PACKAGES but no test there opens Postgres or reads a Postgres DSN; remove it from scripts/go-db-tests.sh"
  fi
done

# --- Wait for Postgres ----------------------------------------------------
deadline=$((SECONDS + PG_READY_TIMEOUT_SECS))
until docker exec "$PG_CONTAINER" pg_isready -q -U flightdeck -d postgres; do
  if ((SECONDS >= deadline)); then
    fail "Postgres in $PG_CONTAINER not ready after ${PG_READY_TIMEOUT_SECS}s (is the dev stack up?)"
  fi
  sleep 1
done
pg_version="$(psql_admin -tAc 'SHOW server_version')"
echo "Postgres server $pg_version in $PG_CONTAINER"

# --- Databases: one per package, dropped on exit ---------------------------
workdir="$(mktemp -d)"
created=()
cleanup() {
  for db in ${created[@]+"${created[@]}"}; do
    psql_admin -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" || true
  done
  rm -rf "$workdir"
}
trap cleanup EXIT

# The newest migration number, from the file names (the glob sorts them).
latest_migration=0
for f in "$MIGRATIONS_DIR"/[0-9]*.up.sql; do
  n="$(basename "$f")"
  n="${n%%_*}"
  latest_migration=$((10#$n))
done
[ "$latest_migration" -gt 0 ] || fail "no migrations found in $MIGRATIONS_DIR"

group "build the workers binary for its migrate-only mode"
(cd workers && go build -o "$workdir/workers" ./cmd/)
endgroup

run_id="$$"
db_name() { echo "fd_gotest_${run_id}_$(echo "$1" | tr '/' '_' | sed 's/_internal_/_/')"; }

group "create, seed and migrate one database per package (to migration $latest_migration)"
for pkg in "${DB_PACKAGES[@]}"; do
  db="$(db_name "$pkg")"
  psql_admin -c "CREATE DATABASE \"$db\""
  created+=("$db")
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U flightdeck -d "$db" \
    <docker/postgres/init.sql >/dev/null
  env -u FLIGHTDECK_POSTGRES_URL \
    FLIGHTDECK_POSTGRES_URL="$PG_BASE_URL/$db?sslmode=disable" \
    FLIGHTDECK_MIGRATIONS_DIR="$MIGRATIONS_DIR" \
    FLIGHTDECK_MIGRATE_ONLY=true \
    FLIGHTDECK_METRICS_PORT=0 \
    "$workdir/workers" >"$workdir/migrate-$db.log" 2>&1 ||
    { cat "$workdir/migrate-$db.log"; fail "migrating $db failed"; }
  state="$(docker exec "$PG_CONTAINER" psql -tA -U flightdeck -d "$db" \
    -c 'SELECT version, dirty FROM schema_migrations')"
  if [ "$state" != "$latest_migration|f" ]; then
    fail "$db is at migration '$state', want '$latest_migration|f'"
  fi
  echo "$db: migrated to $latest_migration"
done
endgroup

# --- Run each package against its own database ----------------------------
# Without -race: two allocation tests in ingestion/internal/handlers
# (otlp_decode_test.go) skip under the race detector, which changes what
# allocations cost, and the no-skip check below would flag them. The Go
# job already runs every package under -race with the DB tests skipped.
summary=()
status=0
for pkg in "${DB_PACKAGES[@]}"; do
  db="$(db_name "$pkg")"
  dsn="$PG_BASE_URL/$db?sslmode=disable"
  module="${pkg%%/*}"
  log="$workdir/test-$db.log"
  group "go test ./${pkg#*/}/ ($module) on $db"
  start=$SECONDS
  set +e
  (
    cd "$module" &&
      env -u FLIGHTDECK_POSTGRES_URL \
        TEST_POSTGRES_URL="$dsn" \
        TEST_ASSEMBLER_POSTGRES_URL="$dsn" \
        go test -count=1 -v "./${pkg#*/}/"
  ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  endgroup
  passed="$(grep -cE '^\s*--- PASS' "$log" || true)"
  skipped="$(grep -cE '^\s*--- SKIP' "$log" || true)"
  line="$pkg: $passed passed, $skipped skipped, $((SECONDS - start))s"
  if [ "$rc" -ne 0 ]; then
    line="$line, FAILED (exit $rc)"
    status=1
  fi
  if [ "$skipped" -ne 0 ]; then
    line="$line, FAILED (a test skipped)"
    grep -E -A1 '^\s*--- SKIP' "$log" || true
    status=1
  fi
  if [ "$passed" -eq 0 ]; then
    line="$line, FAILED (no test passed)"
    status=1
  fi
  summary+=("$line")
done

echo
echo "Go DB tests on Postgres $pg_version:"
printf '  %s\n' "${summary[@]}"
if [ "$status" -ne 0 ]; then
  fail "Go DB tests failed; see the package groups above"
fi
