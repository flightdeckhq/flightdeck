#!/usr/bin/env bash
# Starts the flightdeck binary against a Postgres database, posts one
# event through it and reads the session back: the first-run path a user
# takes, as one check. CI runs it against a service container; locally
# it runs against the dev stack's Postgres on a throwaway database.
#
# Usage: scripts/flightdeck-smoke.sh <binary> <database-url> [listen]
#   listen defaults to 127.0.0.1:4100 so the compose stack on :4000 is
#   left alone. The data dir is a fresh temporary directory.
set -euo pipefail

BIN="${1:?binary path}"
DB_URL="${2:?postgres url}"
LISTEN="${3:-127.0.0.1:4100}"
BASE="http://$LISTEN"
DATA="$(mktemp -d)"
LOG="$DATA/flightdeck.log"
# How long the binary gets to answer /api/health after start. It
# migrates an empty database (36 migrations) and starts JetStream first;
# a cold CI runner does that in a few seconds, so a minute is margin.
READY_TIMEOUT_SECS=60
# How long the worker gets to store the posted session. Through the
# embedded bus this takes milliseconds; the bound only turns a hang into
# a failure.
STORE_TIMEOUT_SECS=30

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill -INT "$PID" || true
    wait "$PID" || true
  fi
  rm -rf "$DATA"
}
trap cleanup EXIT

echo "== starting $BIN on $LISTEN (data dir $DATA)"
"$BIN" --listen "$LISTEN" --database-url "$DB_URL" --data-dir "$DATA/data" >"$LOG" 2>&1 &
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
echo "== health ok"

echo "== start-up block"
grep -A 8 '^Flightdeck ' "$LOG" || { echo "no start-up block in the log"; cat "$LOG"; exit 1; }
grep -q 'Token       tok_dev' "$LOG" || { echo "loopback start did not announce the development token"; exit 1; }

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

echo "== clean shutdown"
kill -INT "$PID"
if wait "$PID"; then
  echo "   exited 0"
else
  echo "flightdeck exited non-zero on SIGINT"; cat "$LOG"; exit 1
fi
PID=
echo "SMOKE OK"
