#!/usr/bin/env bash
# Runs the Go tests that need a database, on Postgres against the dev
# stack's server and on SQLite against a temp file per test.
#
# Those tests skip unless the environment names a backend, so `go test
# ./...` alone never runs the Postgres half. Postgres: this script gives
# each package its own fresh database on the running stack's Postgres
# server, seeds it with docker/postgres/init.sql and migrates it to the
# newest migration through the workers' own migrate path, runs the
# package's tests against it, and drops every database it created on
# exit. The shared `flightdeck` database is never touched. SQLite: the
# storage/storagetest package creates and migrates a file in each test's
# temp directory, so the SQLite pass needs no server; it runs the
# packages that have been converted to the storage boundary
# (DUAL_PACKAGES), with FLIGHTDECK_TEST_BACKEND=sqlite.
#
# A database per package keeps packages from seeing each other's rows;
# the assembler needs one to itself because it claims every due trace
# in its database, including the staging store tests' traces.
#
# The run fails when a package fails, when any test in a listed package
# skips (a DB-gated test that skips did not run), or when a test file
# outside the list opens Postgres, reads a Postgres DSN variable or
# imports storage/storagetest (a new DB-gated package must be added to
# DB_PACKAGES, and to DUAL_PACKAGES once it runs on SQLite).
#
# The Go tests that need a real NATS server (gated on TEST_NATS_URL) run
# here too, against the stack's NATS, under the same rules with
# NATS_PACKAGES. They create streams of their own and delete them; the
# FLIGHTDECK stream is never touched.
#
# Requires: the dev stack running (`make dev`), Go, docker.
# Usage: make test-go-db   (or scripts/go-db-tests.sh)
#
# Environment overrides:
#   FLIGHTDECK_TEST_BACKEND  postgres, sqlite or both (default both):
#                  which passes to run. The per-package Postgres
#                  databases are created either way: the storage
#                  module's schema parity test compares the two
#                  backends and needs Postgres in the SQLite pass too.
#   PG_CONTAINER   Postgres container name (default docker-postgres-1)
#   PG_BASE_URL    DSN prefix the tests connect through, without the
#                  database name (default
#                  postgres://flightdeck:flightdeck_dev@127.0.0.1:5432)
#   NATS_TEST_URL  NATS server the TEST_NATS_URL tests use (default
#                  nats://127.0.0.1:4222, the dev stack's loopback port)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_CONTAINER="${PG_CONTAINER:-docker-postgres-1}"
PG_BASE_URL="${PG_BASE_URL:-postgres://flightdeck:flightdeck_dev@127.0.0.1:5432}"
NATS_TEST_URL="${NATS_TEST_URL:-nats://127.0.0.1:4222}"
BACKENDS="${FLIGHTDECK_TEST_BACKEND:-both}"
MIGRATIONS_DIR="$ROOT/storage/migrations/postgres"

case "$BACKENDS" in
  postgres | sqlite | both) ;;
  *) echo "FLIGHTDECK_TEST_BACKEND=$BACKENDS: want postgres, sqlite or both" >&2; exit 2 ;;
esac

# The Go modules whose test files are scanned for DB and NATS gates.
MODULES=(api ingestion storage workers)

# Every Go test package with a test that opens a database from the
# environment, as <module>/<package dir> (<module> alone for a module's
# root package). All of them run on Postgres.
DB_PACKAGES=(
  api/app
  api/internal/auth
  api/internal/store
  ingestion/app
  ingestion/internal/assembler
  ingestion/internal/auth
  ingestion/internal/handlers
  ingestion/internal/otlpstage
  ingestion/internal/session
  storage
  workers/app
  workers/internal/processor
  workers/internal/writer
)

# The DB_PACKAGES that go through the storage boundary and so run on
# SQLite as well. A package joins this list when its tests open their
# database through storage/storagetest.
DUAL_PACKAGES=(
  api/app
  api/internal/auth
  api/internal/store
  ingestion/app
  ingestion/internal/auth
  storage
)

# Every Go test package with a test that reads TEST_NATS_URL, as
# <module>/<package dir>.
NATS_PACKAGES=(
  ingestion/internal/nats
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

# pkg_module / pkg_dir split "<module>/<dir>" ("<module>" alone is the
# module's root package).
pkg_module() { echo "${1%%/*}"; }
pkg_dir() { if [[ "$1" == */* ]]; then echo "./${1#*/}/"; else echo "./"; fi; }

# --- Every DB-gated test package is in the list ---------------------------
cd "$ROOT"
# A package counts as DB-gated when a test file opens a connection
# (pgxpool.New, pgx.Connect), names any *POSTGRES_URL variable, however
# it reads it (Getenv, LookupEnv, a helper), or imports
# storage/storagetest. Lines that call Setenv are left out: the config
# tests set FLIGHTDECK_POSTGRES_URL to a dummy value to test config
# parsing and never open a database.
found=()
while IFS= read -r pkg; do found+=("$pkg"); done < <(
  grep -rnE 'pgxpool\.New|pgx\.Connect|[A-Z_]*POSTGRES_URL|flightdeck/storage/storagetest"' \
    --include='*_test.go' "${MODULES[@]}" |
    grep -v 'Setenv(' | cut -d: -f1 | xargs -r -n1 dirname | sort -u
)
for pkg in ${found[@]+"${found[@]}"}; do
  if [[ ! " ${DB_PACKAGES[*]} " == *" $pkg "* ]]; then
    fail "$pkg has a test that opens a database or reads a Postgres DSN but is not in DB_PACKAGES in scripts/go-db-tests.sh"
  fi
done
for pkg in "${DB_PACKAGES[@]}"; do
  if [[ ! " ${found[*]-} " == *" $pkg "* ]]; then
    fail "$pkg is in DB_PACKAGES but no test there opens a database or reads a Postgres DSN; remove it from scripts/go-db-tests.sh"
  fi
done
# A package that opens its database through storagetest runs on SQLite
# too, and only such packages do.
found_dual=()
while IFS= read -r pkg; do found_dual+=("$pkg"); done < <(
  grep -rln 'flightdeck/storage/storagetest"' --include='*_test.go' "${MODULES[@]}" |
    xargs -r -n1 dirname | sort -u
)
for pkg in ${found_dual[@]+"${found_dual[@]}"}; do
  if [[ ! " ${DUAL_PACKAGES[*]} " == *" $pkg "* ]]; then
    fail "$pkg imports storage/storagetest but is not in DUAL_PACKAGES in scripts/go-db-tests.sh"
  fi
done
for pkg in "${DUAL_PACKAGES[@]}"; do
  if [[ ! " ${found_dual[*]-} " == *" $pkg "* ]]; then
    fail "$pkg is in DUAL_PACKAGES but no test there imports storage/storagetest; remove it from scripts/go-db-tests.sh"
  fi
  if [[ ! " ${DB_PACKAGES[*]} " == *" $pkg "* ]]; then
    fail "$pkg is in DUAL_PACKAGES but not in DB_PACKAGES in scripts/go-db-tests.sh"
  fi
done
found_nats=()
while IFS= read -r pkg; do found_nats+=("$pkg"); done < <(
  grep -rn 'TEST_NATS_URL' --include='*_test.go' "${MODULES[@]}" |
    cut -d: -f1 | xargs -r -n1 dirname | sort -u
)
for pkg in ${found_nats[@]+"${found_nats[@]}"}; do
  if [[ ! " ${NATS_PACKAGES[*]} " == *" $pkg "* ]]; then
    fail "$pkg has a test that reads TEST_NATS_URL but is not in NATS_PACKAGES in scripts/go-db-tests.sh"
  fi
done
for pkg in "${NATS_PACKAGES[@]}"; do
  if [[ ! " ${found_nats[*]-} " == *" $pkg "* ]]; then
    fail "$pkg is in NATS_PACKAGES but no test there reads TEST_NATS_URL; remove it from scripts/go-db-tests.sh"
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
# job already runs every package under -race with the Postgres tests
# skipped.
summary=()
status=0

# run_pkg <backend> <pkg>: runs one package's tests on one backend and
# records a summary line.
run_pkg() {
  local backend="$1" pkg="$2"
  local db dsn module dir log start rc passed skipped line
  db="$(db_name "$pkg")"
  dsn="$PG_BASE_URL/$db?sslmode=disable"
  module="$(pkg_module "$pkg")"
  dir="$(pkg_dir "$pkg")"
  log="$workdir/test-$backend-$db.log"
  group "go test $dir ($module) on $backend"
  start=$SECONDS
  set +e
  (
    cd "$module" &&
      env -u FLIGHTDECK_POSTGRES_URL \
        FLIGHTDECK_TEST_BACKEND="$backend" \
        TEST_POSTGRES_URL="$dsn" \
        TEST_ASSEMBLER_POSTGRES_URL="$dsn" \
        go test -count=1 -v "$dir"
  ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  endgroup
  passed="$(grep -cE '^\s*--- PASS' "$log" || true)"
  skipped="$(grep -cE '^\s*--- SKIP' "$log" || true)"
  line="$pkg [$backend]: $passed passed, $skipped skipped, $((SECONDS - start))s"
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
}

if [ "$BACKENDS" != sqlite ]; then
  for pkg in "${DB_PACKAGES[@]}"; do
    run_pkg postgres "$pkg"
  done
fi
if [ "$BACKENDS" != postgres ]; then
  for pkg in "${DUAL_PACKAGES[@]}"; do
    run_pkg sqlite "$pkg"
  done
fi

# --- Run each NATS-gated package against the stack's NATS -----------------
for pkg in "${NATS_PACKAGES[@]}"; do
  module="$(pkg_module "$pkg")"
  dir="$(pkg_dir "$pkg")"
  log="$workdir/test-nats-$(echo "$pkg" | tr '/' '_').log"
  group "go test $dir ($module) on NATS $NATS_TEST_URL"
  start=$SECONDS
  set +e
  (
    cd "$module" &&
      TEST_NATS_URL="$NATS_TEST_URL" go test -count=1 -v "$dir"
  ) 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  endgroup
  passed="$(grep -cE '^\s*--- PASS' "$log" || true)"
  skipped="$(grep -cE '^\s*--- SKIP' "$log" || true)"
  line="$pkg (NATS): $passed passed, $skipped skipped, $((SECONDS - start))s"
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
echo "Go DB tests (backends: $BACKENDS; Postgres $pg_version) and NATS tests:"
printf '  %s\n' "${summary[@]}"
if [ "$status" -ne 0 ]; then
  fail "Go DB tests failed; see the package groups above"
fi
