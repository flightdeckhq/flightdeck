#!/usr/bin/env bash
# Smoke test of the compose files users run, docker/docker-compose.yml
# and docker/docker-compose.postgres.yml, against a flightdeck image:
# each shape is started the way its header says and used the way a new
# user would use it.
#
#   up; both health endpoints answer; the first start's log carries the
#   start-up block with a minted token and names the database; the
#   token is read from /runtime-config.json, as the header tells users
#   to; the development token is refused; one event is posted with that
#   token and its session read back; `down` (volumes kept) and `up`
#   again; the same token and the same session are still served.
#
# The base file alone runs on SQLite; with the Postgres overlay it runs
# on the bundled Postgres, which compose must refuse to start without
# POSTGRES_PASSWORD. Each shape is a compose project of its own
# (<project>-sqlite, <project>-postgres), removed with its volumes at
# the end, also when a check fails.
#
# Usage: scripts/compose-smoke.sh <image> [host port] [project]
#   image      the flightdeck image to run, for example flightdeck:ci
#   host port  loopback port to publish on (default 4003)
#   project    prefix of the two compose project names (default
#              fd-compose-smoke)
# CI runs it in the release snapshot job, on the image built there.
# Needs docker with compose v2 and curl, on Linux.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <image> [host port] [project]" >&2; exit 2; }
IMAGE="$1"
PORT="${2:-4003}"
PROJECT="${3:-fd-compose-smoke}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="http://127.0.0.1:$PORT"

# How long a start gets to answer both health endpoints. The container
# starts in a second or two; with the overlay it waits for Postgres's
# health check (up to 50 s) and then creates the schema.
READY_TIMEOUT_SECS=120
# How long the workers get to store the one event.
STORE_TIMEOUT_SECS=30

export FLIGHTDECK_IMAGE="$IMAGE" FLIGHTDECK_PUBLISH_PORT="$PORT"
# A password for the overlay that no real install uses.
SMOKE_PASSWORD="compose-smoke-$$"

compose=(docker compose)
active=()
TMP="$(mktemp -d)"
# Both files, so the overlay's Postgres and its volume go too; the
# password only has to satisfy the file's interpolation.
cleanup() {
  local p
  for p in ${active[@]+"${active[@]}"}; do
    POSTGRES_PASSWORD="$SMOKE_PASSWORD" docker compose -p "$p" -f "$ROOT/docker/docker-compose.yml" \
      -f "$ROOT/docker/docker-compose.postgres.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- docker compose ps" >&2
  "${compose[@]}" ps -a >&2 || true
  echo "--- docker compose logs" >&2
  "${compose[@]}" logs --tail=200 >&2 || true
  exit 1
}

# has <pattern> <command>...: whether the command succeeds and its
# output (stderr included) has a line matching the pattern. The output
# is taken whole before it is searched. Piped into `grep -q` under
# pipefail, a command still writing when grep exits at its first match
# is killed by the closed pipe and the pipeline fails with the match
# found: the check then fails at random, as `compose logs` once did.
has() {
  local pattern="$1" out
  shift
  out="$("$@" 2>&1)" || return 1
  grep -q -- "$pattern" <<<"$out"
}

wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECS))
  until curl -sf -o /dev/null "$BASE/api/health" && curl -sf -o /dev/null "$BASE/ingest/health"; do
    ((SECONDS < deadline)) || fail "not serving on $BASE within ${READY_TIMEOUT_SECS}s"
    sleep 1
  done
}

runtime_token() {
  curl -sf "$BASE/runtime-config.json" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

# smoke <name> <database label> <compose file>...
smoke() {
  local name="$1" database="$2" f token again sid aid now code deadline
  shift 2
  compose=(docker compose -p "$PROJECT-$name")
  for f in "$@"; do compose+=(-f "$ROOT/docker/$f"); done
  active+=("$PROJECT-$name")

  echo "== $name: up"
  "${compose[@]}" up -d
  wait_ready

  echo "== $name: the first start's log has the start-up block and the token"
  "${compose[@]}" logs flightdeck >"$TMP/first.log" 2>&1
  grep -q "Database    .*   ($database)" "$TMP/first.log" || fail "the start-up block does not name a $database database"
  grep -q 'Token       ftd_.*(minted now' "$TMP/first.log" || fail "the first start's log does not print a minted token"

  echo "== $name: the token from /runtime-config.json"
  token="$(runtime_token)"
  case "$token" in
    ftd_*) ;;
    *) fail "/runtime-config.json does not carry an ftd_ token (got '${token:0:8}')" ;;
  esac
  grep -qF "Token       $token " "$TMP/first.log" || fail "the logged token is not the one /runtime-config.json serves"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer tok_dev' "$BASE/api/v1/sessions?limit=1")"
  [ "$code" = "401" ] || fail "the development token answered $code, want 401"
  has '<title>Flightdeck</title>' curl -sf "$BASE/" || fail "/ is not the dashboard"

  echo "== $name: one event in, its session out"
  sid="$(cat /proc/sys/kernel/random/uuid)"
  aid="$(cat /proc/sys/kernel/random/uuid)"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  curl -sf -o /dev/null -X POST "$BASE/ingest/v1/events" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$sid\",\"agent_id\":\"$aid\",\"agent_name\":\"compose-smoke\",\"agent_type\":\"coding\",\"client_type\":\"flightdeck_sensor\",\"user\":\"smoke\",\"hostname\":\"smoke-host\",\"flavor\":\"compose-smoke\",\"event_type\":\"session_start\",\"host\":\"smoke-host\",\"sensor_version\":\"0.0.0\",\"capture_prompts\":false,\"timestamp\":\"$now\",\"context\":{}}" ||
    fail "ingestion refused the event"
  deadline=$((SECONDS + STORE_TIMEOUT_SECS))
  until has "\"session_id\":\"$sid\"" curl -sf -H "Authorization: Bearer $token" "$BASE/api/v1/sessions/$sid"; do
    ((SECONDS < deadline)) || fail "the session is not served within ${STORE_TIMEOUT_SECS}s"
    sleep 1
  done

  echo "== $name: down, volumes kept; up again"
  "${compose[@]}" down
  "${compose[@]}" up -d
  wait_ready
  again="$(runtime_token)"
  [ "$again" = "$token" ] || fail "the token changed across down and up"
  has "\"session_id\":\"$sid\"" curl -sf -H "Authorization: Bearer $token" "$BASE/api/v1/sessions/$sid" ||
    fail "the session stored before the down is gone"
  has 'Token       ftd_.*(from /data/secrets.json)' "${compose[@]}" logs flightdeck ||
    fail "the second start did not take its token from /data/secrets.json"

  echo "== $name: down -v"
  "${compose[@]}" down -v
  echo "   $name ok ($database, token and session kept across down and up)"
}

smoke sqlite SQLite docker-compose.yml

echo "== postgres: compose refuses the overlay without POSTGRES_PASSWORD"
if env -u POSTGRES_PASSWORD docker compose -p "$PROJECT-postgres" \
  -f "$ROOT/docker/docker-compose.yml" -f "$ROOT/docker/docker-compose.postgres.yml" config >"$TMP/config.out" 2>&1; then
  echo "FAIL: the Postgres overlay rendered without POSTGRES_PASSWORD" >&2
  exit 1
fi
grep -q 'set POSTGRES_PASSWORD' "$TMP/config.out" ||
  { cat "$TMP/config.out" >&2; echo "FAIL: the refusal does not say to set POSTGRES_PASSWORD" >&2; exit 1; }

export POSTGRES_PASSWORD="$SMOKE_PASSWORD"
smoke postgres Postgres docker-compose.yml docker-compose.postgres.yml

echo "COMPOSE SMOKE OK ($IMAGE)"
