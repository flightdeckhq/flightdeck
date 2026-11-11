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
TMP="$(mktemp -d)"
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
# shell must not point this run at another database or data dir.
flightdeck() {
  env -u FLIGHTDECK_DATABASE_URL -u FLIGHTDECK_DATA_DIR -u FLIGHTDECK_LISTEN \
    -u FLIGHTDECK_NATS_URL -u FLIGHTDECK_DOMAIN "$BIN" "$@"
}

start() {
  local args=(--listen "$LISTEN" --data-dir "$DATA")
  if [ -n "$DB_URL" ]; then args+=(--database-url "$DB_URL"); fi
  # Appended: the restart's output follows the first run's.
  flightdeck "${args[@]}" >>"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 "$READY_TIMEOUT_SECS"); do
    if curl -sf -o /dev/null "$BASE/api/health"; then break; fi
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "flightdeck exited before it was ready:"; cat "$LOG"; exit 1
    fi
    sleep 1
  done
  curl -sf "$BASE/api/health" >/dev/null || { echo "no /api/health within ${READY_TIMEOUT_SECS}s"; cat "$LOG"; exit 1; }
  curl -sf "$BASE/ingest/health" >/dev/null || { echo "no /ingest/health"; cat "$LOG"; exit 1; }
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
curl -sf "$BASE/" | grep -q '<title>Flightdeck</title>' || { echo "/ is not the dashboard"; exit 1; }
curl -sf "$BASE/events" | grep -q '<title>Flightdeck</title>' || { echo "/events did not fall back to the SPA"; exit 1; }
curl -sf "$BASE/runtime-config.json" | grep -q '"access_token":"tok_dev"' || { echo "runtime-config.json lacks the token"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/events")
[ "$code" = "404" ] || { echo "bare /v1/events answered $code, want 404"; exit 1; }

echo "== one event through the pipeline"
SID=$(cat /proc/sys/kernel/random/uuid)
AID=$(cat /proc/sys/kernel/random/uuid)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
resp=$(curl -sf -X POST "$BASE/ingest/v1/events" \
  -H 'Authorization: Bearer tok_dev' -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"agent_id\":\"$AID\",\"agent_name\":\"smoke\",\"agent_type\":\"coding\",\"client_type\":\"flightdeck_sensor\",\"user\":\"smoke\",\"hostname\":\"smoke-host\",\"flavor\":\"flightdeck-smoke\",\"event_type\":\"session_start\",\"host\":\"smoke-host\",\"sensor_version\":\"0.0.0\",\"capture_prompts\":false,\"timestamp\":\"$NOW\",\"context\":{}}")
echo "   ingest answered: $resp"
for _ in $(seq 1 "$STORE_TIMEOUT_SECS"); do
  if curl -sf -H 'Authorization: Bearer tok_dev' "$BASE/api/v1/sessions/$SID" | grep -q "\"session_id\":\"$SID\""; then
    echo "== session $SID stored and served"
    break
  fi
  sleep 1
done
curl -sf -H 'Authorization: Bearer tok_dev' "$BASE/api/v1/sessions/$SID" | grep -q "\"session_id\":\"$SID\"" \
  || { echo "session not visible within ${STORE_TIMEOUT_SECS}s"; cat "$LOG"; exit 1; }

echo "== a second instance on the same data dir is refused"
port="${LISTEN##*:}"
second_log="$TMP/second.log"
second_args=(--listen "${LISTEN%:*}:$((port + 1))" --data-dir "$DATA")
if [ -n "$DB_URL" ]; then second_args+=(--database-url "$DB_URL"); fi
flightdeck "${second_args[@]}" >"$second_log" 2>&1 &
second=$!
for _ in $(seq 1 "$REFUSE_TIMEOUT_SECS"); do
  kill -0 "$second" 2>/dev/null || break
  sleep 1
done
if kill -0 "$second" 2>/dev/null; then
  kill -INT "$second" || true
  wait "$second" || true
  echo "a second flightdeck started on a data dir in use:"; cat "$second_log"; exit 1
fi
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
curl -sf -H 'Authorization: Bearer tok_dev' "$BASE/api/v1/sessions/$SID" | grep -q "\"session_id\":\"$SID\"" ||
  { echo "the session stored before the stop is gone after the restart"; cat "$LOG"; exit 1; }
echo "   session $SID still served"
stop
if grep -qiE 'database is locked|SQLITE_BUSY' "$LOG"; then
  echo "the log reports a locked database:"; cat "$LOG"; exit 1
fi
echo "SMOKE OK ($BACKEND)"
