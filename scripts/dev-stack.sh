#!/usr/bin/env bash
# The contributor dev stack: the `flightdeck` binary built from this
# checkout, run in the background on 127.0.0.1:4000 (where the
# development token `tok_dev` works), on one of two databases:
#
#   postgres  (default) the Postgres container of
#             docker/docker-compose.dev.yml, database `flightdeck` on
#             the `docker_postgres_data` volume;
#   sqlite    a SQLite file in the stack's data dir; no container.
#
# The bus is the binary's embedded NATS in both. `make dev`, `make
# dev DB=sqlite`, `make dev-restart`, `make down`, `make logs` and
# `make dev-reset` call this script.
#
# Usage: scripts/dev-stack.sh <command> [postgres|sqlite]
#   up       start the stack; a running one on the same database is
#            left alone, one on the other database is stopped first.
#            Builds the dashboard bundle when it is missing or older
#            than the dashboard's sources, then the binary.
#   restart  stop the binary, rebuild and start it again on the
#            database it ran on; the Postgres container keeps running.
#            Run it after a change to the Go or dashboard sources.
#   down     stop the binary and the containers. Volumes and the data
#            dir stay.
#   reset    down, then delete the data of the database being started
#            (postgres: the compose volumes; sqlite: the SQLite file)
#            and the bus store, and start again. The only command that
#            deletes data.
#   logs     follow the binary's log
#   dump     the binary's last 300 log lines and the containers'
#            status and logs (CI runs it when a job fails)
#   status   what runs, and where its files are
#   env      the FLIGHTDECK_TEST_* settings of the running stack, as
#            export lines for a shell: eval "$(scripts/dev-stack.sh env)"
#
# Files, under the dev dir (<repo>/.dev, gitignored): `flightdeck` (the
# binary), `flightdeck.log` and `flightdeck.log.1` (this start's and the
# previous start's stdout and stderr), `flightdeck.pid`, and `stack.env`,
# which records the running stack for the test harness
# (tests/shared/fixtures.py reads it). The data dir (secrets.json, the
# bus store, the SQLite file) is <dev dir>/data, unless the dev dir is
# on a filesystem that keeps no file modes (a Windows drive under WSL):
# the binary refuses a secrets file it cannot keep private, so the data
# dir then goes under $XDG_STATE_HOME (~/.local/state) instead.
#
# Moving from the seven-container stack: `up` stops and removes that
# stack's service containers (nginx, dashboard, ingestion, workers,
# api, nats) after the workers have drained their queue, and leaves the
# Postgres container and every volume as they are. The binary then
# serves the same database.
#
# Environment (a second stack beside a running one sets the first five):
#   FLIGHTDECK_DEV_PROJECT   compose project (default docker, so the
#                            container is docker-postgres-1)
#   FLIGHTDECK_DEV_PORT      port of the binary on 127.0.0.1 (4000)
#   FLIGHTDECK_DEV_PG_PORT   host port of the Postgres container (5432)
#   FLIGHTDECK_DEV_DIR       dev dir (default <repo>/.dev)
#   FLIGHTDECK_DEV_DATA_DIR  data dir (default: see above)
#   FLIGHTDECK_DEV_DB        postgres or sqlite, when the command line
#                            names neither
#   FLIGHTDECK_DEV_DATABASE_URL  a Postgres URL to use in place of the
#                            container's (postgres only)
#   FLIGHTDECK_DEV_ARGS      extra flags for the binary (--metrics)
#   FLIGHTDECK_DEV_BUILD     0 runs the binary already in the dev dir
#   FLIGHTDECK_DEV_WEBUI     0 leaves the dashboard bundle as it is (an
#                            empty one answers 503 on /; the API and
#                            ingestion work without it)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${FLIGHTDECK_DEV_PROJECT:-docker}"
PORT="${FLIGHTDECK_DEV_PORT:-4000}"
PG_PORT="${FLIGHTDECK_DEV_PG_PORT:-5432}"
DEV_DIR="${FLIGHTDECK_DEV_DIR:-$ROOT/.dev}"
BIN="$DEV_DIR/flightdeck"
LOG="$DEV_DIR/flightdeck.log"
PIDFILE="$DEV_DIR/flightdeck.pid"
STATE="$DEV_DIR/stack.env"
LISTEN="127.0.0.1:$PORT"
BASE_URL="http://localhost:$PORT"
PG_CONTAINER="$PROJECT-postgres-1"
PG_DATABASE=flightdeck
PG_BASE_URL="postgres://flightdeck:flightdeck_dev@127.0.0.1:$PG_PORT"

export FLIGHTDECK_DEV_PG_PORT="$PG_PORT"
COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker/docker-compose.dev.yml")

# The services of the seven-container stack this one replaces, in the
# order they are stopped: the front door first, so nothing new arrives,
# then ingestion, then (once the queue is empty) the workers and the
# rest. Postgres is not in the list: it stays.
LEGACY_FRONT=(nginx dashboard)
LEGACY_PRODUCERS=(ingestion)
LEGACY_REST=(workers api nats)

# How long the binary gets to answer both health endpoints. A start
# connects to the database (waiting up to 60 s for a Postgres that is
# still starting), migrates it, starts JetStream and, on a database
# that has run on another bus, clears the stored stream positions; on a
# laptop that is a few seconds, on a cold CI runner or a large database
# well under two minutes.
READY_TIMEOUT_SECS=120
# How long a SIGTERM gets before the stop is forced. The binary drains
# its requests and stops its services in two steps of at most 30 s
# each; 70 s covers both.
STOP_TIMEOUT_SECS=70
# How long the old stack's workers get to empty their queue once its
# front door and ingestion are stopped. They store an event in
# milliseconds; 30 s covers a backlog of thousands.
DRAIN_TIMEOUT_SECS=30

say() { printf '== %s\n' "$*"; }
die() { printf 'dev-stack: %s\n' "$*" >&2; exit 1; }

# keeps_modes <dir>: whether a file created in dir keeps mode 0600.
keeps_modes() {
  local probe="$1/.mode-probe.$$" kept=1
  : >"$probe" && chmod 600 "$probe" && [ -n "$(find "$probe" -maxdepth 0 -perm 600)" ] && kept=0
  rm -f "$probe"
  return "$kept"
}

data_dir() {
  mkdir -p "$DEV_DIR"
  if [ -n "${FLIGHTDECK_DEV_DATA_DIR:-}" ]; then
    printf '%s' "$FLIGHTDECK_DEV_DATA_DIR"
  elif keeps_modes "$DEV_DIR"; then
    printf '%s' "$DEV_DIR/data"
  else
    # One per checkout: the name and a checksum of the path.
    printf '%s/flightdeck-dev/%s-%s' "${XDG_STATE_HOME:-$HOME/.local/state}" \
      "$(basename "$ROOT")" "$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
  fi
}

running_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# state <key>: a value of the running stack's state file, empty when
# there is none.
state() {
  [ -f "$STATE" ] || return 0
  sed -n "s/^$1=//p" "$STATE"
}

want_mode() {
  local mode="${1:-${FLIGHTDECK_DEV_DB:-postgres}}"
  case "$mode" in
    postgres | sqlite) printf '%s' "$mode" ;;
    *) die "unknown database '$mode': want postgres or sqlite" ;;
  esac
}

# project_containers <service>...: the ids of this project's containers
# of the named services, running or stopped.
project_containers() {
  local svc
  for svc in "$@"; do
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=$svc"
  done
}

stop_containers() {
  local ids
  ids="$(project_containers "$@")"
  [ -z "$ids" ] || echo "$ids" | xargs docker stop >/dev/null
}

# The stack this one replaces ran the services as containers of the
# same compose project. They hold port 4000 and consume the same
# database, so they stop before the binary starts: in order, and with
# the workers given time to store what ingestion had already accepted.
# Containers only; no volume is touched.
retire_legacy_services() {
  local all ids nats i
  all="$(project_containers "${LEGACY_FRONT[@]}" "${LEGACY_PRODUCERS[@]}" "${LEGACY_REST[@]}")"
  [ -n "$all" ] || return 0
  say "stopping the service containers of the seven-container stack (project $PROJECT); Postgres and the volumes stay"
  stop_containers "${LEGACY_FRONT[@]}"
  stop_containers "${LEGACY_PRODUCERS[@]}"
  nats="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=nats")"
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=workers")"
  if [ -n "$nats" ] && [ -n "$ids" ]; then
    # The NATS monitor reports, per consumer, the messages not yet
    # delivered and those delivered but not acknowledged.
    for ((i = 0; i < DRAIN_TIMEOUT_SECS; i++)); do
      if ! docker exec "$nats" wget -qO- 'http://localhost:8222/jsz?consumers=true' 2>/dev/null |
        grep -Eq '"num_(ack_)?pending": *[1-9]'; then
        break
      fi
      sleep 1
    done
    if ((i == DRAIN_TIMEOUT_SECS)); then
      printf 'dev-stack: the workers still had queued events after %ss; they stay in the %s_nats_data volume\n' \
        "$DRAIN_TIMEOUT_SECS" "$PROJECT" >&2
    fi
  fi
  stop_containers "${LEGACY_REST[@]}"
  echo "$all" | xargs docker rm >/dev/null
}

build_webui() {
  [ "${FLIGHTDECK_DEV_WEBUI:-1}" != "0" ] || return 0
  local index="$ROOT/webui/dist/index.html"
  if [ -f "$index" ] && [ -z "$(cd "$ROOT/dashboard" && find src public index.html package.json package-lock.json \
    vite.config.ts tsconfig.json -newer "$index" -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  if [ ! -d "$ROOT/dashboard/node_modules" ]; then
    say "installing the dashboard's dependencies (npm ci)"
    (cd "$ROOT/dashboard" && npm ci --no-audit --no-fund)
  fi
  say "building the dashboard bundle into webui/dist"
  make -C "$ROOT" --no-print-directory build-webui
}

stop_binary() {
  local pid i
  if pid="$(running_pid)"; then
    say "stopping flightdeck (pid $pid)"
    # SIGTERM, not SIGINT: a background job of a non-interactive shell
    # starts with SIGINT ignored.
    kill -TERM "$pid"
    for ((i = 0; i < STOP_TIMEOUT_SECS; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf 'dev-stack: flightdeck (pid %s) did not exit within %ss of SIGTERM; killing it\n' "$pid" "$STOP_TIMEOUT_SECS" >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE" "$STATE"
}

wait_ready() {
  local pid="$1" i
  for ((i = 0; i < READY_TIMEOUT_SECS; i++)); do
    if curl -sf -o /dev/null "http://$LISTEN/api/health" && curl -sf -o /dev/null "http://$LISTEN/ingest/health"; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

write_state() {
  local mode="$1" data="$2"
  {
    echo "# The running dev stack (scripts/dev-stack.sh). tests/shared/fixtures.py reads it."
    echo "FLIGHTDECK_DEV_MODE=$mode"
    echo "FLIGHTDECK_DEV_DATA_DIR=$data"
    echo "FLIGHTDECK_TEST_BASE_URL=$BASE_URL"
    echo "FLIGHTDECK_TEST_WORKER_LOG=$LOG"
    echo "FLIGHTDECK_TEST_WORKER_CONTAINER="
    if [ "$mode" = sqlite ]; then
      echo "FLIGHTDECK_TEST_SQLITE_DB=$data/flightdeck.db"
    else
      echo "FLIGHTDECK_TEST_DB=$PG_DATABASE"
      echo "FLIGHTDECK_TEST_POSTGRES_CONTAINER=$PG_CONTAINER"
      echo "PG_CONTAINER=$PG_CONTAINER"
      echo "PG_BASE_URL=$PG_BASE_URL"
    fi
  } >"$STATE"
}

cmd_up() {
  local mode pid data running
  mode="$(want_mode "${1:-}")"
  if pid="$(running_pid)"; then
    running="$(state FLIGHTDECK_DEV_MODE)"
    if [ "$running" = "$mode" ]; then
      say "flightdeck already running (pid $pid) on $BASE_URL, database: $mode"
      return 0
    fi
    say "a stack on ${running:-another database} is running; stopping it to start one on $mode"
    stop_binary
  fi
  retire_legacy_services
  data="$(data_dir)"
  mkdir -p "$data"
  chmod 700 "$data"

  local -a db_args=()
  if [ "$mode" = postgres ]; then
    if [ -n "${FLIGHTDECK_DEV_DATABASE_URL:-}" ]; then
      db_args=(--database-url "$FLIGHTDECK_DEV_DATABASE_URL")
    else
      say "Postgres container ($PG_CONTAINER, 127.0.0.1:$PG_PORT)"
      "${COMPOSE[@]}" up -d --wait postgres
      db_args=(--database-url "$PG_BASE_URL/$PG_DATABASE?sslmode=disable")
    fi
  fi

  if [ "${FLIGHTDECK_DEV_BUILD:-1}" != "0" ]; then
    build_webui
    say "building $BIN from source"
    (cd "$ROOT" && go build -o "$BIN" ./cmd/flightdeck)
  fi
  [ -x "$BIN" ] || die "no binary at $BIN (run without FLIGHTDECK_DEV_BUILD=0)"
  if [ ! -f "$ROOT/webui/dist/index.html" ]; then
    say "no dashboard bundle in webui/dist: / answers 503 until the stack is started without FLIGHTDECK_DEV_WEBUI=0"
  fi

  [ ! -f "$LOG" ] || mv -f "$LOG" "$LOG.1"
  say "starting flightdeck on $BASE_URL, database: $mode (log: $LOG)"
  # Two settings differ from a release: the integration suite shares
  # one token across hundreds of requests, so the 1000 a minute rate
  # limit would answer 429; and the reconciler ticks every 5 s instead
  # of 60, so the tests that wait for a state transition stay short
  # (tests/integration/test_session_states.py sizes its waits from the
  # same number).
  # FLIGHTDECK_DEV_ARGS is a flag list, split on whitespace on purpose.
  # The ${a[@]+...} form keeps an empty array from tripping `set -u` on
  # bash 3.2 (macOS).
  local -a extra=()
  read -r -a extra <<<"${FLIGHTDECK_DEV_ARGS:-}"
  # The binary reads ./pricing.yaml from its working directory.
  cd "$ROOT"
  FLIGHTDECK_RATE_LIMIT_PER_MINUTE="${FLIGHTDECK_RATE_LIMIT_PER_MINUTE:-1000000}" \
    FLIGHTDECK_RECONCILER_INTERVAL_SECS="${FLIGHTDECK_RECONCILER_INTERVAL_SECS:-5}" \
    nohup "$BIN" --listen "$LISTEN" --data-dir "$data" \
    ${db_args[@]+"${db_args[@]}"} ${extra[@]+"${extra[@]}"} >"$LOG" 2>&1 &
  pid=$!
  echo "$pid" >"$PIDFILE"
  if ! wait_ready "$pid"; then
    printf 'dev-stack: flightdeck is not serving after %ss; the end of its log:\n' "$READY_TIMEOUT_SECS" >&2
    tail -n 50 "$LOG" >&2
    kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    die "not ready"
  fi
  write_state "$mode" "$data"
  # The start-up block: version, URLs, token, data dir, database, bus.
  sed -n '/^Flightdeck /,/^Press Ctrl+C/p' "$LOG" | sed '/^Press Ctrl+C/d'
  say "make logs follows the log, make down stops the stack, make dev-restart rebuilds it"
}

cmd_restart() {
  local mode
  mode="$(want_mode "${1:-$(state FLIGHTDECK_DEV_MODE)}")"
  stop_binary
  cmd_up "$mode"
}

cmd_down() {
  stop_binary
  retire_legacy_services
  say "containers down (volumes kept)"
  "${COMPOSE[@]}" down --remove-orphans
}

cmd_reset() {
  local mode data
  mode="$(want_mode "${1:-}")"
  cmd_down
  data="$(data_dir)"
  if [ "$mode" = postgres ]; then
    say "deleting the compose volumes of project $PROJECT (the Postgres database) and the bus store in $data"
    "${COMPOSE[@]}" down -v --remove-orphans
    rm -rf "$data/nats"
  else
    say "deleting the SQLite database and the bus store in $data"
    rm -rf "$data/nats" "$data/flightdeck.db" "$data/flightdeck.db-wal" "$data/flightdeck.db-shm"
  fi
  cmd_up "$mode"
}

cmd_logs() {
  [ -f "$LOG" ] || die "no log at $LOG; is the stack up?"
  tail -n 200 -f "$LOG"
}

cmd_dump() {
  if [ -f "$LOG" ]; then
    say "flightdeck log (last 300 lines of $LOG)"
    tail -n 300 "$LOG" || true
  else
    say "no flightdeck log at $LOG"
  fi
  say "containers of project $PROJECT"
  "${COMPOSE[@]}" ps -a || true
  "${COMPOSE[@]}" logs --tail=300 || true
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    say "flightdeck running (pid $pid) on $BASE_URL, database: $(state FLIGHTDECK_DEV_MODE)"
    say "log $LOG, data dir $(state FLIGHTDECK_DEV_DATA_DIR)"
  else
    say "flightdeck not running"
  fi
  "${COMPOSE[@]}" ps -a
}

cmd_env() {
  running_pid >/dev/null || die "no dev stack is running in $DEV_DIR; start it with make dev"
  local line
  while IFS= read -r line; do
    case "$line" in
      FLIGHTDECK_TEST_* | PG_*) printf "export %s='%s'\n" "${line%%=*}" "${line#*=}" ;;
    esac
  done <"$STATE"
}

case "${1:-}" in
  up) cmd_up "${2:-}" ;;
  restart) cmd_restart "${2:-}" ;;
  down) cmd_down ;;
  reset) cmd_reset "${2:-}" ;;
  logs) cmd_logs ;;
  dump) cmd_dump ;;
  status) cmd_status ;;
  env) cmd_env ;;
  *) die "usage: $0 up|restart|down|reset|logs|dump|status|env [postgres|sqlite]" ;;
esac
