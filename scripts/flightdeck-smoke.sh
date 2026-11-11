#!/usr/bin/env bash
# Starts the flightdeck binary, posts one event through it, reads the
# session back, stops it and starts it again on the same data dir: the
# first-run path a user takes and the restart after it, as one check.
# With no database URL the binary runs on its default, the SQLite file
# in the data dir; with a postgres:// URL it runs on that database (CI
# uses a service container; locally, a throwaway database on the dev
# stack's Postgres).
#
# Usage: scripts/flightdeck-smoke.sh <binary> [database-url] [listen]
#   database-url  postgres://… or sqlite://…; omitted, the binary's
#                 default (SQLite in the data dir). An argument without
#                 "://" in this position is taken as listen.
#   listen        defaults to 127.0.0.1:4100 so the compose stack on
#                 :4000 is left alone.
# The data dir is a fresh temporary directory whose name has a space
# and a "#", the characters a mis-built SQLite URL would trip on.
set -euo pipefail

BIN="${1:?binary path}"
DB_URL=""
if [[ "${2:-}" == *"://"* ]]; then
  DB_URL="$2"
  shift
fi
LISTEN="${2:-127.0.0.1:4100}"
BASE="http://$LISTEN"
# The physical path: the binary names its database by the real path,
# and a system's temp dir can be behind a symbolic link.
TMP="$(cd "$(mktemp -d)" && pwd -P)"
DATA="$TMP/data dir #1"
LOG="$TMP/flightdeck.log"
case "$DB_URL" in
  "" | sqlite://*) BACKEND=SQLite ;;
  *) BACKEND=Postgres ;;
esac
# How long the binary gets to answer /api/health after start. It
# migrates an empty database and starts JetStream first; a cold CI
# runner does that in a few seconds, so a minute is margin.
READY_TIMEOUT_SECS=60
# How long the worker gets to store the posted session. Through the
# embedded bus this takes milliseconds; the bound only turns a hang into
# a failure.
STORE_TIMEOUT_SECS=30

# How long one HTTP request may take. The binary binds its port before
# it opens and migrates the database, so a start that wedges there
# accepts the connection and never answers: without a bound a single
# curl would wait for ever and no other timeout here would be reached.
# Every request of this script answers in milliseconds; five seconds
# is slack for a loaded runner.
REQUEST_TIMEOUT_SECS=5
CURL=(curl --max-time "$REQUEST_TIMEOUT_SECS")
# How long a second instance on the same data dir gets to refuse. It
# must exit before doing any work; the bound turns a hang into a failure.
REFUSE_TIMEOUT_SECS=20

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill -INT "$PID" || true
    wait "$PID" || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# The binary reads its settings from the environment too; a developer's
# shell must not point this run at another database or data dir. An
# array, not a function: env replaces itself with the binary, so the
# PID of the background job is the binary's own, the one the signals
# and the refusal message below are about.
FLIGHTDECK=(env -u FLIGHTDECK_DATABASE_URL -u FLIGHTDECK_DATA_DIR -u FLIGHTDECK_LISTEN
  -u FLIGHTDECK_NATS_URL -u FLIGHTDECK_DOMAIN "$BIN")

start() {
  local args=(--listen "$LISTEN" --data-dir "$DATA")
  if [ -n "$DB_URL" ]; then args+=(--database-url "$DB_URL"); fi
  # Appended: the restart's output follows the first run's.
  "${FLIGHTDECK[@]}" "${args[@]}" >>"$LOG" 2>&1 &
  PID=$!
  # A deadline, not a count of attempts: one attempt can itself take
  # REQUEST_TIMEOUT_SECS, so counting them would stretch the wait.
  local deadline=$((SECONDS + READY_TIMEOUT_SECS))
  until "${CURL[@]}" -sf -o /dev/null "$BASE/api/health"; do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "flightdeck exited before it was ready:"; cat "$LOG"; exit 1
    fi
    if ((SECONDS >= deadline)); then
      echo "no /api/health within ${READY_TIMEOUT_SECS}s"; cat "$LOG"; exit 1
    fi
    sleep 1
  done
  "${CURL[@]}" -sf "$BASE/ingest/health" >/dev/null || { echo "no /ingest/health"; cat "$LOG"; exit 1; }
}

stop() {
  kill -INT "$PID"
  if wait "$PID"; then
    echo "   exited 0"
  else
    echo "flightdeck exited non-zero on SIGINT"; cat "$LOG"; exit 1
  fi
  PID=
}

echo "== starting $BIN on $LISTEN ($BACKEND, data dir $DATA)"
start
echo "== health ok"

echo "== start-up block"
grep -A 8 '^Flightdeck ' "$LOG" || { echo "no start-up block in the log"; cat "$LOG"; exit 1; }
grep -q 'Token       tok_dev' "$LOG" || { echo "loopback start did not announce the development token"; exit 1; }
grep -q "^  Database    .*   ($BACKEND)\$" "$LOG" || { echo "the start-up block does not name a $BACKEND database"; exit 1; }
if [ -z "$DB_URL" ]; then
  grep -qF "  Database    $DATA/flightdeck.db   (SQLite)" "$LOG" ||
    { echo "the start-up block does not name $DATA/flightdeck.db"; exit 1; }
  [ -f "$DATA/flightdeck.db" ] || { echo "no flightdeck.db in the data dir"; ls -la "$DATA"; exit 1; }
  mode=$(stat -c '%a' "$DATA/flightdeck.db")
  [ "$mode" = "600" ] || { echo "flightdeck.db has mode $mode, want 600"; exit 1; }
  [ "$(find "$TMP" -name 'flightdeck.db' | wc -l)" = "1" ] ||
    { echo "a second flightdeck.db exists; the data dir's path was mangled:"; find "$TMP" -name 'flightdeck.db*'; exit 1; }
fi

echo "== dashboard and runtime config"
"${CURL[@]}" -sf "$BASE/" | grep -q '<title>Flightdeck</title>' || { echo "/ is not the dashboard"; exit 1; }
"${CURL[@]}" -sf "$BASE/events" | grep -q '<title>Flightdeck</title>' || { echo "/events did not fall back to the SPA"; exit 1; }
"${CURL[@]}" -sf "$BASE/runtime-config.json" | grep -q '"access_token":"tok_dev"' || { echo "runtime-config.json lacks the token"; exit 1; }
code=$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/events")
[ "$code" = "404" ] || { echo "bare /v1/events answered $code, want 404"; exit 1; }

echo "== one event through the pipeline"
SID=$(cat /proc/sys/kernel/random/uuid)
AID=$(cat /proc/sys/kernel/random/uuid)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
resp=$("${CURL[@]}" -sf -X POST "$BASE/ingest/v1/events" \
  -H 'Authorization: Bearer tok_dev' -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"agent_id\":\"$AID\",\"agent_name\":\"smoke\",\"agent_type\":\"coding\",\"client_type\":\"flightdeck_sensor\",\"user\":\"smoke\",\"hostname\":\"smoke-host\",\"flavor\":\"flightdeck-smoke\",\"event_type\":\"session_start\",\"host\":\"smoke-host\",\"sensor_version\":\"0.0.0\",\"capture_prompts\":false,\"timestamp\":\"$NOW\",\"context\":{}}")
echo "   ingest answered: $resp"
store_deadline=$((SECONDS + STORE_TIMEOUT_SECS))
until "${CURL[@]}" -sf -H 'Authorization: Bearer tok_dev' "$BASE/api/v1/sessions/$SID" | grep -q "\"session_id\":\"$SID\""; do
  if ((SECONDS >= store_deadline)); then
    echo "session not visible within ${STORE_TIMEOUT_SECS}s"; cat "$LOG"; exit 1
  fi
  sleep 1
done
echo "== session $SID stored and served"

echo "== a second instance on the same data dir is refused"
port="${LISTEN##*:}"
second_log="$TMP/second.log"
second_args=(--listen "${LISTEN%:*}:$((port + 1))" --data-dir "$DATA")
if [ -n "$DB_URL" ]; then second_args+=(--database-url "$DB_URL"); fi
"${FLIGHTDECK[@]}" "${second_args[@]}" >"$second_log" 2>&1 &
second=$!
refuse_deadline=$((SECONDS + REFUSE_TIMEOUT_SECS))
while kill -0 "$second" 2>/dev/null; do
  if ((SECONDS >= refuse_deadline)); then
    kill -INT "$second" || true
    wait "$second" || true
    echo "a second flightdeck started on a data dir in use:"; cat "$second_log"; exit 1
  fi
  sleep 1
done
if wait "$second"; then
  echo "a second flightdeck on a data dir in use exited 0:"; cat "$second_log"; exit 1
fi
grep -q 'in use by another flightdeck (pid '"$PID"')' "$second_log" ||
  { echo "the refusal does not name the running instance (pid $PID):"; cat "$second_log"; exit 1; }
echo "   $(cat "$second_log")"

echo "== clean shutdown"
stop
if [ "$BACKEND" = SQLite ] && [ -z "$DB_URL" ]; then
  # A clean stop folds the write-ahead log into the database file.
  left=$(find "$DATA" -maxdepth 1 \( -name 'flightdeck.db-wal' -o -name 'flightdeck.db-shm' \) | wc -l)
  [ "$left" = "0" ] || { echo "SQLite's -wal / -shm files are left after a clean stop:"; ls -la "$DATA"; exit 1; }
fi

echo "== restart on the same data dir"
start
"${CURL[@]}" -sf -H 'Authorization: Bearer tok_dev' "$BASE/api/v1/sessions/$SID" | grep -q "\"session_id\":\"$SID\"" ||
  { echo "the session stored before the stop is gone after the restart"; cat "$LOG"; exit 1; }
echo "   session $SID still served"
stop
if grep -qiE 'database is locked|SQLITE_BUSY' "$LOG"; then
  echo "the log reports a locked database:"; cat "$LOG"; exit 1
fi
echo "SMOKE OK ($BACKEND)"
