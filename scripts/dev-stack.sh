#!/usr/bin/env bash
# The contributors' dev stack: Postgres and NATS from
# docker/docker-compose.dev.yml, and the `flightdeck` binary built from
# this checkout and run in the background on 127.0.0.1:4000, where the
# development token works. `make dev`, `make down`, `make logs` and
# `make dev-reset` call this script.
#
# Usage: scripts/dev-stack.sh up | down | reset | logs | dump | status
#   up      start the containers, build bin/flightdeck-dev from source
#           and run it; idempotent (a running stack is left alone)
#   down    stop the binary (SIGINT, clean exit) and the containers;
#           the database and bus volumes stay
#   reset   down, drop the volumes and the data dir, up again
#   logs    tail the binary's log
#   dump    print the binary's last 300 log lines and the containers'
#           status and logs (CI runs it when a job fails)
#   status  whether the binary and the containers are running
#
# Layout (all under .dev/, gitignored): data/ (the binary's data dir:
# secrets.json, embedded NATS store), flightdeck.log (stdout and
# stderr; tests/shared/fixtures.py reads the worker's lines from it),
# flightdeck.pid.
#
# Environment:
#   DEV_LISTEN        listen address (default 127.0.0.1:4000; must stay
#                     a loopback address for the development token)
#   DEV_DATABASE_URL  Postgres URL (default: the compose Postgres)
#   DEV_ARGS          extra flags for the binary (for example --metrics)
#   DEV_BUILD         0 skips the build and runs the last binary
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker/docker-compose.dev.yml")
DEV_DIR="$ROOT/.dev"
BIN="$DEV_DIR/flightdeck"
LOG="$DEV_DIR/flightdeck.log"
PIDFILE="$DEV_DIR/flightdeck.pid"
LISTEN="${DEV_LISTEN:-127.0.0.1:4000}"
DATABASE_URL="${DEV_DATABASE_URL:-postgres://flightdeck:flightdeck_dev@127.0.0.1:5432/flightdeck?sslmode=disable}"

# How long the binary gets to answer both health endpoints after start.
# A first start migrates an empty database and creates the JetStream
# store; a warm laptop does it in a few seconds, a cold CI runner or a
# repository on a Windows mount in well under a minute, so 90 s turns a
# hang into a failure without flagging a slow disk.
READY_TIMEOUT_SECS=90
# How long a SIGINT gets before the process is reported as stuck: the
# binary drains requests and stops its services within its own 30 s
# shutdown bound, so 40 s covers it with margin.
STOP_TIMEOUT_SECS=40

say() { printf '== %s\n' "$*"; }
die() { printf 'dev-stack: %s\n' "$*" >&2; exit 1; }

running_pid() {
  local pid
  [[ -f "$PIDFILE" ]] || return 1
  pid="$(cat "$PIDFILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

wait_ready() {
  local base="http://$LISTEN" pid="$1" i
  for ((i = 0; i < READY_TIMEOUT_SECS; i++)); do
    if curl -sf -o /dev/null "$base/api/health" && curl -sf -o /dev/null "$base/ingest/health"; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

cmd_up() {
  mkdir -p "$DEV_DIR"
  say "containers (Postgres, NATS)"
  "${COMPOSE[@]}" up -d --wait
  if pid="$(running_pid)"; then
    say "flightdeck already running (pid $pid) on http://$LISTEN"
    return 0
  fi
  if [[ "${DEV_BUILD:-1}" != "0" ]]; then
    say "building $BIN from source"
    (cd "$ROOT" && go build -o "$BIN" ./cmd/flightdeck)
  fi
  [[ -x "$BIN" ]] || die "no binary at $BIN (run without DEV_BUILD=0)"
  if [[ ! -f "$ROOT/webui/dist/index.html" ]]; then
    say "webui/dist has no dashboard bundle: / answers 503 until \`make build-webui\` and \`make dev\` again (the API and ingestion work without it)"
  fi
  say "starting flightdeck on http://$LISTEN (log: $LOG)"
  # The two overrides the test suites rely on: the integration suite
  # shares one token across hundreds of requests, so the 1000/min
  # production rate limit would answer 429; the reconciler ticks every
  # 5 s instead of 60 so the tests that wait for a state transition
  # stay short (tests/integration/test_session_states.py sizes its
  # waits from the same number).
  # DEV_ARGS is a flag list, split on whitespace on purpose; the
  # ${a[@]+...} form keeps an empty list from tripping `set -u` on
  # bash 3.2 (macOS).
  local -a extra=()
  read -r -a extra <<<"${DEV_ARGS:-}"
  FLIGHTDECK_RATE_LIMIT_PER_MINUTE="${FLIGHTDECK_RATE_LIMIT_PER_MINUTE:-1000000}" \
  FLIGHTDECK_RECONCILER_INTERVAL_SECS="${FLIGHTDECK_RECONCILER_INTERVAL_SECS:-5}" \
    nohup "$BIN" --listen "$LISTEN" --database-url "$DATABASE_URL" --data-dir "$DEV_DIR/data" ${extra[@]+"${extra[@]}"} \
    >"$LOG" 2>&1 &
  pid=$!
  echo "$pid" >"$PIDFILE"
  if ! wait_ready "$pid"; then
    printf 'flightdeck is not ready after %ss; its log:\n' "$READY_TIMEOUT_SECS" >&2
    tail -n 50 "$LOG" >&2
    rm -f "$PIDFILE"
    die "not ready"
  fi
  # The start-up block: version, URLs, token, data dir, database, bus.
  sed -n '/^Flightdeck /,/^Press Ctrl+C/p' "$LOG" | sed '/^Press Ctrl+C/d'
}

cmd_down() {
  local pid i
  if pid="$(running_pid)"; then
    say "stopping flightdeck (pid $pid)"
    kill -INT "$pid"
    for ((i = 0; i < STOP_TIMEOUT_SECS; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf 'dev-stack: flightdeck (pid %s) did not exit on SIGINT within %ss; killing it\n' "$pid" "$STOP_TIMEOUT_SECS" >&2
      kill -KILL "$pid" || true
    fi
  fi
  rm -f "$PIDFILE"
  say "containers down (volumes kept)"
  "${COMPOSE[@]}" down
}

cmd_reset() {
  cmd_down
  say "dropping the volumes and $DEV_DIR/data"
  "${COMPOSE[@]}" down -v
  rm -rf "$DEV_DIR/data"
  cmd_up
}

cmd_logs() {
  [[ -f "$LOG" ]] || die "no log at $LOG; is the stack up?"
  tail -n 200 -f "$LOG"
}

cmd_dump() {
  if [[ -f "$LOG" ]]; then
    say "flightdeck log (last 300 lines)"
    tail -n 300 "$LOG" || true
  else
    say "no flightdeck log at $LOG"
  fi
  say "containers"
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail=100 || true
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    say "flightdeck running (pid $pid) on http://$LISTEN"
  else
    say "flightdeck not running"
  fi
  "${COMPOSE[@]}" ps
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  logs) cmd_logs ;;
  dump) cmd_dump ;;
  status) cmd_status ;;
  *) die "usage: $0 up | down | reset | logs | dump | status" ;;
esac
