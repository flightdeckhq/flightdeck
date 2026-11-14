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
#            left alone, one on the other database is replaced. In
#            order: build the dashboard bundle (when it is missing or
#            older than the dashboard's sources) and the binary; start
#            the Postgres container; stop what the new binary replaces
#            (this checkout's running binary, or the seven-container
#            stack, below); start the binary and wait until it serves.
#            A build that fails therefore leaves whatever was running
#            as it was.
#   restart  the same, replacing a running binary on the database it
#            ran on; the Postgres container keeps running. Run it after
#            a change to the Go or dashboard sources.
#   down     stop the binary, and the containers when this checkout
#            started them (see "Whose containers"). Volumes and the
#            data dir stay.
#   reset    delete the data of the database being started (postgres:
#            the compose volumes; sqlite: the SQLite file) and the bus
#            store, and start again. The only command that deletes
#            data; see "Reset" for what it asks first.
#   logs     follow the binary's log
#   dump     the binary's last 300 log lines and the containers'
#            status and logs (CI runs it when a job fails)
#   status   what runs, and where its files are
#   env      the FLIGHTDECK_TEST_* settings of the running stack, as
#            export lines for a shell: eval "$(scripts/dev-stack.sh env)"
#
# Files, under the dev dir (<repo>/.dev, gitignored): `flightdeck` (the
# binary), `flightdeck.log` and `flightdeck.log.1` (this start's and the
# previous start's stdout and stderr), `flightdeck.pid`, `stack.env`,
# which records the running stack for the test harness
# (tests/shared/fixtures.py reads it), and `postgres.project`, the
# compose project whose Postgres this checkout started. The data dir
# (secrets.json, the bus store, the SQLite file) is <dev dir>/data,
# unless the dev dir is on a filesystem that keeps no file modes (a
# Windows drive under WSL): the binary refuses a secrets file it cannot
# keep private, so the data dir then goes under $XDG_STATE_HOME
# (~/.local/state) instead.
#
# Whose containers. Compose records, on every container, the directory
# of the compose files it was started from. The containers of the
# project are this checkout's when that directory is this checkout's
# docker/. Another checkout's containers are never stopped, removed or
# attached to: `up` refuses to start beside them, `down` leaves them
# running, `reset` refuses. A second stack beside a running one sets
# its own FLIGHTDECK_DEV_PROJECT, FLIGHTDECK_DEV_PORT and
# FLIGHTDECK_DEV_PG_PORT. FLIGHTDECK_DEV_TAKEOVER=<project> says the
# containers are this checkout's all the same (a checkout that moved).
#
# Moving from the seven-container stack: `up` stops that stack's
# service containers (nginx, dashboard, ingestion, workers, api, nats)
# once the new binary is built and the Postgres container answers,
# after the workers have drained their queue, and removes them once the
# binary serves. Until then they are stopped, not removed, and the
# message of a start that fails says how to start them again. The
# Postgres container and every volume stay as they are; the binary then
# serves the same database. A queue that cannot be read, or that is not
# empty after the wait, stops the move: its events would stay behind in
# the old NATS volume, which the binary does not read.
# FLIGHTDECK_DEV_ALLOW_UNDRAINED=1 moves all the same.
#
# Reset. On either database, `reset` refuses while something that is
# not this stack listens on its port (a binary of another dev dir may be
# using that database). On Postgres it first says what it is about to
# delete (the volume, and how many sessions and events are in it). It
# refuses when nothing says this checkout started that Postgres. Above
# RESET_UNCONFIRMED_MAX_SESSIONS sessions, or when the database cannot
# be counted, it wants the project's name: CONFIRM=<project> (`make
# dev-reset CONFIRM=docker`), or typed at its prompt on a terminal.
#
# Environment (a second stack beside a running one sets the first three):
#   FLIGHTDECK_DEV_PROJECT   compose project (default docker, so the
#                            container is docker-postgres-1)
#   FLIGHTDECK_DEV_PORT      port of the binary on 127.0.0.1 (4000)
#   FLIGHTDECK_DEV_PG_PORT   host port of the Postgres container (5432)
#   FLIGHTDECK_DEV_DIR       dev dir (default <repo>/.dev)
#   FLIGHTDECK_DEV_DATA_DIR  data dir (default: see above)
#   FLIGHTDECK_DEV_DB        postgres or sqlite, when the command line
#                            names neither
#   FLIGHTDECK_DEV_ARGS      extra flags for the binary (--metrics)
#   FLIGHTDECK_DEV_BUILD     0 runs the binary already in the dev dir
#   FLIGHTDECK_DEV_WEBUI     0 leaves the dashboard bundle as it is (an
#                            empty one answers 503 on /; the API and
#                            ingestion work without it)
#   FLIGHTDECK_DEV_TAKEOVER, FLIGHTDECK_DEV_ALLOW_UNDRAINED, CONFIRM
#                            the three deliberate overrides above
#   FLIGHTDECK_DEV_READY_TIMEOUT_SECS, FLIGHTDECK_DEV_STOP_TIMEOUT_SECS,
#   FLIGHTDECK_DEV_DRAIN_TIMEOUT_SECS
#                            the three waits below, for the script's
#                            own test (scripts/test-dev-stack.sh)
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
OWNER="$DEV_DIR/postgres.project"
LISTEN="127.0.0.1:$PORT"
BASE_URL="http://localhost:$PORT"
PG_CONTAINER="$PROJECT-postgres-1"
PG_DATABASE=flightdeck
PG_VOLUME="${PROJECT}_postgres_data"
PG_BASE_URL="postgres://flightdeck:flightdeck_dev@127.0.0.1:$PG_PORT"
COMPOSE_DIR="$ROOT/docker"

export FLIGHTDECK_DEV_PG_PORT="$PG_PORT"
COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_DIR/docker-compose.dev.yml")

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
READY_TIMEOUT_SECS="${FLIGHTDECK_DEV_READY_TIMEOUT_SECS:-120}"
# How long a SIGTERM gets before the stop is forced. The binary drains
# its requests and stops its services in two steps of at most 30 s
# each; 70 s covers both.
STOP_TIMEOUT_SECS="${FLIGHTDECK_DEV_STOP_TIMEOUT_SECS:-70}"
# How long the old stack's workers get to empty their queue once its
# front door and ingestion are stopped. They store an event in
# milliseconds; 30 s covers a backlog of thousands.
DRAIN_TIMEOUT_SECS="${FLIGHTDECK_DEV_DRAIN_TIMEOUT_SECS:-30}"
# The most sessions a Postgres database may hold and still be deleted
# by `reset` without the project's name. The canonical test fixtures
# (tests/e2e-fixtures/seed.py) are about 60 sessions, so a database at
# or under 100 holds a seed and little else; one run of the integration
# suite or any real use is well past it, and a database someone works
# from holds thousands.
RESET_UNCONFIRMED_MAX_SESSIONS=100

# The longest log line `dump` prints. The binary's lines are a few
# hundred characters; the cut keeps one pathological line (an error
# that quotes a request body) from flooding a CI log.
DUMP_LINE_CHARS=2000

say() { printf '== %s\n' "$*"; }
warn() { printf 'dev-stack: %s\n' "$*" >&2; }
die() {
  warn "$@"
  exit 1
}

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

# running_pid: the pid of the stack's binary when it runs. A pid file
# can outlive its process (a reboot), and the number can since belong
# to another program, so the process must also be a flightdeck.
running_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  case "$(ps -p "$pid" -o comm= 2>/dev/null)" in
    *flightdeck*) printf '%s' "$pid" ;;
    *) return 1 ;;
  esac
}

# state <key>: a value of the running stack's state file, empty when
# there is none.
state() {
  [ -f "$STATE" ] || return 0
  sed -n "s/^$1=//p" "$STATE"
}

# asked_mode [mode]: the database the caller asked for, on the command
# line or in FLIGHTDECK_DEV_DB; empty when neither names one.
asked_mode() {
  local mode="${1:-${FLIGHTDECK_DEV_DB:-}}"
  case "$mode" in
    "" | postgres | sqlite) printf '%s' "$mode" ;;
    *) die "unknown database '$mode': want postgres or sqlite" ;;
  esac
}

# have_docker: whether there is a docker daemon to talk to. The SQLite
# stack needs none, so its commands must work without one.
have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
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

# running_container <service>: the id of this project's running
# container of the service, empty when it does not run.
running_container() {
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1"
}

legacy_containers() {
  project_containers "${LEGACY_FRONT[@]}" "${LEGACY_PRODUCERS[@]}" "${LEGACY_REST[@]}"
}

stop_containers() {
  local ids
  ids="$(project_containers "$@")"
  [ -z "$ids" ] || echo "$ids" | xargs docker stop >/dev/null
}

# same_dir <a> <b>: whether the two paths name one directory.
same_dir() {
  [ "$1" != "$2" ] || return 0
  [ -d "$1" ] && [ -d "$2" ] && [ "$(cd "$1" && pwd -P)" = "$(cd "$2" && pwd -P)" ]
}

# foreign_owner <container id>...: the directory another checkout
# started one of these containers from, as compose recorded it on the
# container; nothing when they are this checkout's, or carry no record.
foreign_owner() {
  local id dir
  for id in "$@"; do
    dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id" 2>/dev/null || true)"
    [ -n "$dir" ] || continue
    if ! same_dir "$dir" "$COMPOSE_DIR"; then
      printf '%s' "$dir"
      return 0
    fi
  done
}

# taken_over: whether the caller said this project's containers are
# this checkout's whatever compose recorded.
taken_over() { [ "${FLIGHTDECK_DEV_TAKEOVER:-}" = "$PROJECT" ]; }

# refuse_foreign <what the command would do> <container id>...: stop
# when another checkout started the containers.
refuse_foreign() {
  local doing="$1" other
  shift
  [ "$#" -gt 0 ] || return 0
  other="$(foreign_owner "$@")"
  [ -n "$other" ] || return 0
  taken_over && return 0
  die "the containers of compose project $PROJECT were started from $other, not from this checkout ($COMPOSE_DIR); this would $doing. A second stack beside that one sets its own FLIGHTDECK_DEV_PROJECT, FLIGHTDECK_DEV_PORT and FLIGHTDECK_DEV_PG_PORT. If they are this checkout's all the same (it moved), say so with FLIGHTDECK_DEV_TAKEOVER=$PROJECT."
}

# owns_postgres: whether this checkout started the project's Postgres:
# the container says so while it exists, and after `down` removed it
# the dev dir still does.
owns_postgres() {
  local id
  id="$(project_containers postgres)"
  if [ -n "$id" ]; then
    # shellcheck disable=SC2086  # ids, one per line
    [ -z "$(foreign_owner $id)" ] || taken_over
  else
    [ -f "$OWNER" ] && [ "$(cat "$OWNER")" = "$PROJECT" ]
  fi
}

# port_taken: whether something accepts connections on the address the
# binary is about to listen on.
port_taken() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

# queue_state <nats container>: what the old stack's NATS monitor says
# of the workers' queue: `empty`, `busy` (messages not yet delivered,
# or delivered and not acknowledged), or `unknown` when the monitor
# cannot be read. Unknown is not empty.
queue_state() {
  local out
  if ! out="$(docker exec "$1" wget -qO- 'http://localhost:8222/jsz?consumers=true' 2>/dev/null)"; then
    printf unknown
    return 0
  fi
  case "$out" in
    *'"server_id"'*) ;;
    *)
      printf unknown
      return 0
      ;;
  esac
  # A here-string, not a pipe: grep -q exits at its first match, and
  # under pipefail a writer cut off by that makes the pipeline fail,
  # which would read a busy queue as an empty one.
  if grep -Eq '"num_(ack_)?pending": *[1-9]' <<<"$out"; then
    printf busy
  else
    printf empty
  fi
}

# legacy_start_hint: the command that starts the old stack's stopped
# containers again, in the order they depend on each other.
legacy_start_hint() {
  local names
  names="$(project_containers nats api workers ingestion dashboard nginx |
    xargs docker inspect -f '{{.Name}}' 2>/dev/null | sed 's|^/||' | tr '\n' ' ')"
  printf 'docker start %s' "$names"
}

# The stack this one replaces ran the services as containers of the
# same compose project. They hold port 4000 and consume the same
# database, so they stop before the binary starts: in order, and with
# the workers given time to store what ingestion had already accepted.
# Containers only; no volume is touched, and nothing is removed here.
#
# stop_legacy_services strict: a queue that cannot be read, or is not
# empty after the wait, ends the script; the binary has a bus of its
# own and would never see those events. The first read happens before
# anything is stopped, so a monitor that does not answer leaves the old
# stack whole.
# stop_legacy_services lenient (`down`): the events stay in the old
# stack's NATS volume, where that stack finds them when it starts
# again, so the stop goes on with a warning.
stop_legacy_services() {
  local strictness="$1" nats queue=empty i
  nats="$(running_container nats)"
  if [ -n "$nats" ] && [ "$strictness" = strict ] && [ "${FLIGHTDECK_DEV_ALLOW_UNDRAINED:-}" != 1 ]; then
    queue="$(queue_state "$nats")"
    if [ "$queue" = unknown ]; then
      die "the NATS monitor of the seven-container stack (project $PROJECT) does not answer, so its queue cannot be read: events may be waiting in it, and they would stay behind in the ${PROJECT}_nats_data volume. Nothing was stopped. Bring that NATS back to health and run this again, or move without waiting for the queue with FLIGHTDECK_DEV_ALLOW_UNDRAINED=1."
    fi
  fi
  say "stopping the service containers of the seven-container stack (project $PROJECT); Postgres and the volumes stay"
  if [ -z "$nats" ]; then
    say "no NATS container runs in project $PROJECT: there is no queue to wait for"
  fi
  stop_containers "${LEGACY_FRONT[@]}"
  stop_containers "${LEGACY_PRODUCERS[@]}"
  if [ -n "$nats" ]; then
    for ((i = 0; ; i++)); do
      queue="$(queue_state "$nats")"
      [ "$queue" != empty ] || break
      ((i < DRAIN_TIMEOUT_SECS)) || break
      sleep 1
    done
    if [ "$queue" != empty ]; then
      case "$queue" in
        busy) queue="the workers still had queued events after ${DRAIN_TIMEOUT_SECS}s" ;;
        *) queue="the old stack's NATS monitor stopped answering, so its queue cannot be read" ;;
      esac
      if [ "$strictness" = strict ] && [ "${FLIGHTDECK_DEV_ALLOW_UNDRAINED:-}" != 1 ]; then
        die "$queue: those events would stay behind in the ${PROJECT}_nats_data volume. The front door and ingestion are stopped, not removed; nothing else was. Start them again and let the workers finish ($(legacy_start_hint)), then run this again; or move with the events left in that volume: FLIGHTDECK_DEV_ALLOW_UNDRAINED=1."
      fi
      warn "$queue; they stay in the ${PROJECT}_nats_data volume"
    fi
  fi
  stop_containers "${LEGACY_REST[@]}"
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

# build_binary: the bundle, then the binary, into $BIN.new. The binary
# that may be running from $BIN is replaced only once it has stopped.
build_binary() {
  mkdir -p "$DEV_DIR"
  rm -f "$BIN.new"
  build_webui
  say "building $BIN from source"
  (cd "$ROOT" && go build -o "$BIN.new" ./cmd/flightdeck)
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
      warn "flightdeck (pid $pid) did not exit within ${STOP_TIMEOUT_SECS}s of SIGTERM; killing it"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE" "$STATE"
}

# alive <pid>: whether the process runs. One that has exited and was
# not collected yet still answers kill -0; its state is then Z.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -p "$1" -o stat= 2>/dev/null)" in
    Z* | "") return 1 ;;
  esac
}

# answers: whether both health endpoints answer on the stack's address.
answers() {
  curl -sf -o /dev/null "http://$LISTEN/api/health" && curl -sf -o /dev/null "http://$LISTEN/ingest/health"
}

# wait_ready <pid>: until the binary started here serves, or is gone, or
# the time is up. Serving takes three things together. The process is
# alive. Its own log holds the end of its start-up block: the binary
# binds its listener before anything else and prints that block just
# before it starts serving, so only then is an answer on the port its
# answer. And both health endpoints answer.
# An answer alone proves nothing: a server that took the port in the
# meantime answers just as well while this binary, still loading, has
# yet to find the address busy and exit.
wait_ready() {
  local pid="$1" i
  for ((i = 0; i < READY_TIMEOUT_SECS; i++)); do
    alive "$pid" || return 1
    if grep -q '^Press Ctrl+C to stop' "$LOG" 2>/dev/null && answers; then
      return 0
    fi
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

# cmd_up [mode] [replace]: `replace` (restart) rebuilds and replaces a
# binary that already runs on the database asked for.
cmd_up() {
  local mode replace="${2:-}" pid="" data running legacy="" hint=""
  mode="$(asked_mode "${1:-}")"
  if pid="$(running_pid)"; then
    running="$(state FLIGHTDECK_DEV_MODE)"
    # A running stack is left alone unless another database was asked
    # for by name: `make test-integration` must not move a stack
    # started with DB=sqlite onto Postgres.
    if [ "$replace" != replace ] && { [ -z "$mode" ] || [ "$running" = "$mode" ]; }; then
      say "flightdeck already running (pid $pid) on $BASE_URL, database: $running"
      return 0
    fi
    if [ "$replace" != replace ]; then
      say "a stack on ${running:-another database} is running; it is replaced by one on $mode once that is built"
    fi
  else
    pid=""
  fi
  mode="${mode:-postgres}"

  if have_docker; then
    legacy="$(legacy_containers)"
    # shellcheck disable=SC2086  # ids, one per line
    refuse_foreign "stop that stack and put this checkout's binary in its place" $legacy
    if [ "$mode" = postgres ]; then
      # shellcheck disable=SC2046  # ids, one per line
      refuse_foreign "attach this checkout's binary to that stack's database" $(project_containers postgres)
    fi
  elif [ "$mode" = postgres ]; then
    die "no docker daemon answers, and the Postgres stack runs its database in a container (make dev DB=sqlite needs none)"
  fi

  # Nothing this run stops holds the port (no binary of this checkout,
  # no seven-container stack), so whatever listens there is another
  # stack: the binary would exit on the busy address while the
  # readiness probe is answered by the stranger.
  if [ -z "$pid" ] && [ -z "$legacy" ] && port_taken; then
    die "something already listens on $LISTEN, and it is not this checkout's stack. A dev stack beside another one sets its own FLIGHTDECK_DEV_PORT (and FLIGHTDECK_DEV_PROJECT and FLIGHTDECK_DEV_PG_PORT for its Postgres)."
  fi

  # Everything that can fail without touching what runs comes first:
  # the build, then (below) the Postgres container.
  if [ "${FLIGHTDECK_DEV_BUILD:-1}" != "0" ]; then
    build_binary
  else
    # What an interrupted run built is not what this one was asked to run.
    rm -f "$BIN.new"
    [ -x "$BIN" ] || die "no binary at $BIN (run without FLIGHTDECK_DEV_BUILD=0)"
  fi
  if [ ! -f "$ROOT/webui/dist/index.html" ]; then
    say "no dashboard bundle in webui/dist: / answers 503 until the stack is started without FLIGHTDECK_DEV_WEBUI=0"
  fi
  data="$(data_dir)"
  mkdir -p "$data"
  chmod 700 "$data"

  local -a db_args=()
  if [ "$mode" = postgres ]; then
    say "Postgres container ($PG_CONTAINER, 127.0.0.1:$PG_PORT)"
    "${COMPOSE[@]}" up -d --wait postgres
    printf '%s\n' "$PROJECT" >"$OWNER"
    db_args=(--database-url "$PG_BASE_URL/$PG_DATABASE?sslmode=disable")
  fi

  # Now what the new binary replaces.
  [ -z "$pid" ] || stop_binary
  if [ -n "$legacy" ]; then
    stop_legacy_services strict
    hint=" The seven-container stack's containers are stopped, not removed: $(legacy_start_hint) starts that stack again."
  fi
  if port_taken; then
    rm -f "$BIN.new"
    die "something still listens on $LISTEN after this checkout's own stack was stopped.$hint"
  fi
  [ ! -f "$BIN.new" ] || mv -f "$BIN.new" "$BIN"

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
  if ! wait_ready "$pid" || ! alive "$pid"; then
    rm -f "$PIDFILE"
    if ! alive "$pid" && answers; then
      # The tests would have run against whatever this is.
      warn "$BASE_URL answers, but the binary started here has exited; the end of its log:"
      tail -n 50 "$LOG" >&2
      die "something else is serving on $LISTEN.$hint"
    fi
    warn "flightdeck is not serving after ${READY_TIMEOUT_SECS}s; the end of its log:"
    tail -n 50 "$LOG" >&2
    kill -KILL "$pid" 2>/dev/null || true
    die "not ready.$hint"
  fi
  if [ -n "$legacy" ]; then
    # The binary serves the database: the old stack's containers go.
    echo "$legacy" | xargs docker rm >/dev/null
  fi
  write_state "$mode" "$data"
  # The start-up block: version, URLs, token, data dir, database, bus.
  sed -n '/^Flightdeck /,/^Press Ctrl+C/p' "$LOG" | sed '/^Press Ctrl+C/d'
  say "make logs follows the log, make down stops the stack, make dev-restart rebuilds it"
}

cmd_restart() {
  local mode
  mode="$(asked_mode "${1:-$(state FLIGHTDECK_DEV_MODE)}")"
  cmd_up "$mode" replace
}

cmd_down() {
  local ids other legacy
  stop_binary
  have_docker || return 0
  ids="$(project_containers postgres) $(legacy_containers)"
  # shellcheck disable=SC2086  # ids, split on whitespace
  set -- $ids
  [ "$#" -gt 0 ] || return 0
  other="$(foreign_owner "$@")"
  if [ -n "$other" ] && ! taken_over; then
    say "the containers of compose project $PROJECT were started from $other, not from this checkout: they are left running (make down in that checkout stops them)"
    return 0
  fi
  legacy="$(legacy_containers)"
  [ -z "$legacy" ] || stop_legacy_services lenient
  say "containers down (volumes kept)"
  "${COMPOSE[@]}" down --remove-orphans
}

# pg_scalar <sql>: the one value a query returns from the stack's
# database, empty when the database cannot be asked.
pg_scalar() {
  docker exec "$PG_CONTAINER" psql -U flightdeck -d "$PG_DATABASE" -tAX -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || true
}

# pg_rows <table>: how many rows the table holds; 0 when the database
# has no such table (it was never migrated), empty when it cannot be
# asked.
pg_rows() {
  case "$(pg_scalar "SELECT to_regclass('public.$1') IS NOT NULL")" in
    t) pg_scalar "SELECT count(*) FROM public.$1" ;;
    f) printf 0 ;;
    *) ;;
  esac
}

# confirm_postgres_reset: say what `reset` is about to delete and stop
# unless it may: see "Reset" in the header.
confirm_postgres_reset() {
  local data="$1" sessions events answer
  have_docker || die "no docker daemon answers: there is no Postgres volume to reset"
  # shellcheck disable=SC2046  # ids, one per line
  refuse_foreign "delete that stack's database" $(project_containers postgres) $(legacy_containers)
  if ! owns_postgres; then
    die "nothing says this checkout started the Postgres of compose project $PROJECT (no container of it started from $COMPOSE_DIR, no $OWNER): refusing to delete the $PG_VOLUME volume. Start the stack here first (make dev), or delete the volume yourself: docker compose -p $PROJECT -f docker/docker-compose.dev.yml down -v"
  fi
  "${COMPOSE[@]}" up -d --wait postgres >/dev/null
  sessions="$(pg_rows sessions)"
  events="$(pg_rows events)"
  say "reset is about to delete the $PG_VOLUME volume (the Postgres database: ${sessions:-an unknown number of} sessions, ${events:-an unknown number of} events) and the bus store in $data/nats"
  if [ -n "$sessions" ] && [ "$sessions" -le "$RESET_UNCONFIRMED_MAX_SESSIONS" ]; then
    return 0
  fi
  if [ "${CONFIRM:-}" = "$PROJECT" ]; then
    say "confirmed: CONFIRM=$PROJECT"
    return 0
  fi
  if [ -n "${CONFIRM:-}" ]; then
    die "CONFIRM=$CONFIRM does not name the compose project ($PROJECT): nothing was deleted"
  fi
  if [ -t 0 ] && [ -t 1 ]; then
    printf 'Type the compose project name (%s) to delete them, anything else to keep them: ' "$PROJECT"
    read -r answer || answer=""
    [ "$answer" = "$PROJECT" ] || die "not confirmed: nothing was deleted"
    return 0
  fi
  die "the database holds more than a seed (over $RESET_UNCONFIRMED_MAX_SESSIONS sessions, or it could not be counted): nothing was deleted. To delete it, name the project: make dev-reset CONFIRM=$PROJECT"
}

cmd_reset() {
  local mode data legacy=""
  data="$(data_dir)"
  # What serves on the port must be this stack, as for `up`: a binary
  # of another dev dir (or anything else) there may be using the very
  # database this would delete, and the start that ends a reset would
  # fail on the busy port only after the deletion.
  if have_docker; then legacy="$(legacy_containers)"; fi
  if ! running_pid >/dev/null && [ -z "$legacy" ] && port_taken; then
    die "something listens on $LISTEN, and it is not this checkout's stack: it may be using the database a reset would delete, and the reset could not start the stack again. Nothing was deleted. Stop it first (make down where it was started), or give this stack its own FLIGHTDECK_DEV_PORT and FLIGHTDECK_DEV_PROJECT."
  fi
  # The database to reset: the one asked for, else the running
  # stack's, else whichever this checkout has data in. There is no
  # default: a reset with nothing to go on deletes nothing.
  mode="$(asked_mode "${1:-}")"
  mode="${mode:-$(state FLIGHTDECK_DEV_MODE)}"
  if [ -z "$mode" ]; then
    if have_docker && owns_postgres; then
      mode=postgres
    elif [ -f "$data/flightdeck.db" ]; then
      mode=sqlite
    else
      die "nothing to reset: no dev stack of this checkout is running, and it has neither started a Postgres of compose project $PROJECT nor a SQLite database in $data"
    fi
  fi
  if [ "$mode" = postgres ]; then
    confirm_postgres_reset "$data"
    stop_binary
    "${COMPOSE[@]}" down -v --remove-orphans
    rm -rf "$data/nats"
  else
    say "reset is about to delete the SQLite database $data/flightdeck.db and the bus store in $data/nats"
    stop_binary
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
    say "flightdeck log (last 300 lines of $LOG, each cut at $DUMP_LINE_CHARS characters)"
    tail -n 300 "$LOG" | cut -c "1-$DUMP_LINE_CHARS" || true
  else
    say "no flightdeck log at $LOG"
  fi
  if have_docker; then
    say "containers of project $PROJECT"
    "${COMPOSE[@]}" ps -a || true
    "${COMPOSE[@]}" logs --tail=300 || true
  fi
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    say "flightdeck running (pid $pid) on $BASE_URL, database: $(state FLIGHTDECK_DEV_MODE)"
    say "log $LOG, data dir $(state FLIGHTDECK_DEV_DATA_DIR)"
  else
    say "flightdeck not running"
  fi
  if have_docker; then
    "${COMPOSE[@]}" ps -a
  fi
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
