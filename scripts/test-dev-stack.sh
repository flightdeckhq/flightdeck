#!/usr/bin/env bash
# Tests scripts/dev-stack.sh itself: the paths where a mistake costs a
# running stack or a database. The script runs here for real, against a
# fake `docker` that keeps its containers in files and records every
# call, a fake `go` whose build can be made to fail, and a fake
# `flightdeck` that serves the two health endpoints, exits at once, or
# hands its port to a stranger. Each case states what must be left
# alone and checks the fake docker's state and its call log for it.
#
# What is covered:
#   - a build that fails stops nothing (the seven-container stack, a
#     running binary);
#   - the order of a move from the seven-container stack, and what a
#     binary that does not start leaves behind;
#   - a port that already answers, a binary that exits while a
#     stranger answers on its port, and one that accepts connections
#     and never answers;
#   - an old stack's queue that cannot be read, or is not empty;
#   - containers another checkout started: `up`, `down` and `reset`;
#   - every way `reset` refuses, and the ways it goes ahead;
#   - `down` beside another client of the database, and on a database
#     it cannot ask;
#   - the Makefile's refusal to run the split test stack under a
#     project whose volumes are a real database's.
#
# Usage: scripts/test-dev-stack.sh
# Environment:
#   TEST_DEV_STACK_PORT   the port the fake binary listens on (4392)
# Needs bash, make, curl, python3 (the fake's HTTP server) and
# timeout(1): Linux, which is where CI runs it. No docker, no Go, no
# network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/dev-stack.sh"
PORT="${TEST_DEV_STACK_PORT:-4392}"
PROJECT=fdtest
TMP="$(mktemp -d)"
F="$TMP/fake"
DEV="$TMP/dev"
DATA="$TMP/data"
OURS="$ROOT/docker"
FOREIGN="$TMP/elsewhere/docker"
# The script's waits, shortened: the fakes answer at once or never.
READY_SECS=6
STOP_SECS=5
DRAIN_SECS=2
# The bound on one run of the script. The slowest case waits READY_SECS
# and STOP_SECS once each; a run that reaches this bound hung.
RUN_BOUND_SECS=60
# How long a stranger server gets to listen.
LISTEN_WAIT_SECS=10
# How long the fake binary in its `usurped` mode stays alive, silent,
# before it exits: longer than a probe of the script, shorter than
# READY_SECS.
FAKE_LOAD_SECS=2

PASSED=0
CASE=""
OUT=""
STATUS=0
ENVV=()

fail() {
  printf 'FAIL [%s]: %s\n' "$CASE" "$*" >&2
  printf -- '--- output of the last run (status %s):\n%s\n--- the fake docker call log:\n' "$STATUS" "$OUT" >&2
  cat "$F/calls.log" >&2 2>/dev/null || true
  exit 1
}

kill_pidfile() {
  local pid
  [ -s "$1" ] || return 0
  pid="$(cat "$1")"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$1"
}

cleanup() {
  kill_pidfile "$DEV/flightdeck.pid"
  kill_pidfile "$F/stranger.pid"
  pkill -KILL -f "$F/server.py" 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$TMP/bin" "$F/containers" "$FOREIGN"

# An HTTP server that answers 200 to every GET: server.py <port>. With
# a second argument `silent` it accepts every connection and never
# answers: the first request holds its one thread, the rest wait in the
# listen backlog.
cat >"$F/server.py" <<'PY'
import http.server
import sys
import time

port = int(sys.argv[1])
silent = sys.argv[2:] == ["silent"]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if silent:
            time.sleep(3600)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY

# The fake binary. `#!/bin/bash`, not env: the kernel then names the
# process after this file, and the script looks for a process named
# flightdeck. $F/binary_mode picks what it does:
#   ok        serve until SIGTERM
#   silent    the same, on a server that accepts every connection and
#             never answers
#   exit      say the address is in use and exit 1
#   usurped   what the real binary does when a stranger takes its
#             port as it starts: the stranger answers both health
#             endpoints at once, while this process is still alive and
#             has printed no start-up block (the binary is still
#             loading); only then does it find the address busy and
#             exit 1. A readiness check that trusts an answer plus a
#             live pid passes here, against the stranger.
cat >"$F/flightdeck" <<'SH'
#!/bin/bash
F="$FAKE_STATE"
mode="$(cat "$F/binary_mode" 2>/dev/null || echo ok)"
args="$*"
port=""
while [ $# -gt 0 ]; do
  [ "$1" != --listen ] || port="${2##*:}"
  shift
done
echo "flightdeck start mode=$mode $args" >>"$F/calls.log"
case "$mode" in
  exit)
    echo "flightdeck: listen tcp 127.0.0.1:$port: bind: address already in use" >&2
    exit 1
    ;;
  usurped)
    setsid python3 "$F/server.py" "$port" >/dev/null 2>&1 &
    echo $! >"$F/stranger.pid"
    sleep "$FAKE_LOAD_SECS"
    echo "flightdeck: 127.0.0.1:$port is already in use" >&2
    exit 1
    ;;
esac
if [ "$mode" = silent ]; then
  python3 "$F/server.py" "$port" silent &
else
  python3 "$F/server.py" "$port" &
fi
child=$!
trap 'kill "$child" 2>/dev/null; exit 0' TERM INT
echo "Flightdeck fake"
echo "Press Ctrl+C to stop."
wait "$child"
SH
chmod +x "$F/flightdeck"

cat >"$TMP/bin/go" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "go $*" >>"$FAKE_STATE/calls.log"
if [ -f "$FAKE_STATE/go_fail" ]; then
  echo "go: fake compile error" >&2
  exit 1
fi
out=""
while [ $# -gt 0 ]; do
  [ "$1" != -o ] || out="$2"
  shift
done
cp "$FAKE_STATE/flightdeck" "$out"
chmod +x "$out"
SH

# The fake docker: one file per container under $FAKE_STATE/containers
# (project, service, name, dir, state), every invocation appended to
# calls.log. Flag files stand for what the tests vary: `monitor` is
# what the NATS monitor answers (absent: it does not answer),
# `pg_sessions` and `pg_events` the row counts (absent: the database
# has no such tables), `pg_down` a database that cannot be asked.
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
F="$FAKE_STATE"
echo "docker $*" >>"$F/calls.log"
field() { sed -n "s/^$2=//p" "$F/containers/$1"; }
set_state() { sed -i "s/^state=.*/state=$2/" "$F/containers/$1"; }
cmd="$1"
shift
case "$cmd" in
  info) ;;
  ps)
    all=0 project="" service=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -aq | -a) all=1 ;;
        --filter)
          shift
          case "$1" in
            label=com.docker.compose.project=*) project="${1#*project=}" ;;
            label=com.docker.compose.service=*) service="${1#*service=}" ;;
          esac
          ;;
      esac
      shift
    done
    for c in "$F"/containers/*; do
      [ -e "$c" ] || continue
      id="$(basename "$c")"
      [ -z "$project" ] || [ "$(field "$id" project)" = "$project" ] || continue
      [ -z "$service" ] || [ "$(field "$id" service)" = "$service" ] || continue
      [ "$all" = 1 ] || [ "$(field "$id" state)" = running ] || continue
      echo "$id"
    done
    ;;
  stop) for id in "$@"; do set_state "$id" exited; done ;;
  rm) for id in "$@"; do rm -f "$F/containers/$id"; done ;;
  inspect)
    template="$2"
    shift 2
    for id in "$@"; do
      [ -f "$F/containers/$id" ] || exit 1
      case "$template" in
        *working_dir*) field "$id" dir ;;
        *.Name*) echo "/$(field "$id" name)" ;;
      esac
    done
    ;;
  exec)
    shift
    case "$1" in
      wget)
        [ -f "$F/monitor" ] || exit 1
        cat "$F/monitor"
        ;;
      psql)
        [ ! -f "$F/pg_down" ] || exit 2
        sql="${*: -1}"
        case "$sql" in
          *pg_stat_activity*) cat "$F/pg_others" 2>/dev/null || true ;;
          *to_regclass*) if [ -f "$F/pg_sessions" ]; then echo t; else echo f; fi ;;
          *"FROM public.sessions"*) cat "$F/pg_sessions" ;;
          *"FROM public.events"*) cat "$F/pg_events" ;;
        esac
        ;;
    esac
    ;;
  compose)
    project="" file=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -p) project="$2" && shift 2 ;;
        -f) file="$2" && shift 2 ;;
        *) break ;;
      esac
    done
    sub="$1"
    shift
    case "$sub" in
      up)
        if [ -f "$F/compose_up_fail" ]; then
          echo "compose: fake failure to start postgres" >&2
          exit 1
        fi
        id="pg-$project"
        if [ -f "$F/containers/$id" ]; then
          set_state "$id" running
        else
          printf 'project=%s\nservice=postgres\nname=%s-postgres-1\ndir=%s\nstate=running\n' \
            "$project" "$project" "$(dirname "$file")" >"$F/containers/$id"
        fi
        ;;
      down)
        for c in "$F"/containers/*; do
          [ -e "$c" ] || continue
          [ "$(field "$(basename "$c")" project)" != "$project" ] || rm -f "$c"
        done
        case " $* " in
          *" -v "*)
            rm -f "$F/pg_sessions" "$F/pg_events"
            touch "$F/volume_removed"
            ;;
        esac
        ;;
    esac
    ;;
esac
SH
chmod +x "$TMP/bin/go" "$TMP/bin/docker"

# stack <command> [mode]: run the script; its output and status land in
# OUT and STATUS. ENVV holds extra NAME=value settings for the one run.
stack() {
  set +e
  OUT="$(timeout "$RUN_BOUND_SECS" env \
    -u FLIGHTDECK_DEV_DB -u FLIGHTDECK_DEV_BUILD -u FLIGHTDECK_DEV_ARGS -u FLIGHTDECK_DEV_PG_PORT \
    -u FLIGHTDECK_DEV_TAKEOVER -u FLIGHTDECK_DEV_ALLOW_UNDRAINED -u FLIGHTDECK_DEV_CONFIRM \
    PATH="$TMP/bin:$PATH" FAKE_STATE="$F" FAKE_LOAD_SECS="$FAKE_LOAD_SECS" \
    FLIGHTDECK_DEV_PROJECT="$PROJECT" FLIGHTDECK_DEV_PORT="$PORT" \
    FLIGHTDECK_DEV_DIR="$DEV" FLIGHTDECK_DEV_DATA_DIR="$DATA" FLIGHTDECK_DEV_WEBUI=0 \
    FLIGHTDECK_DEV_READY_TIMEOUT_SECS="$READY_SECS" FLIGHTDECK_DEV_STOP_TIMEOUT_SECS="$STOP_SECS" \
    FLIGHTDECK_DEV_DRAIN_TIMEOUT_SECS="$DRAIN_SECS" \
    ${ENVV[@]+"${ENVV[@]}"} bash "$SCRIPT" "$@" </dev/null 2>&1)"
  STATUS=$?
  set -e
  ENVV=()
  [ "$STATUS" -ne 124 ] || fail "dev-stack.sh $* did not end within ${RUN_BOUND_SECS}s"
}

# fresh <case name>: nothing running, no containers, no flags.
fresh() {
  CASE="$1"
  kill_pidfile "$DEV/flightdeck.pid"
  kill_pidfile "$F/stranger.pid"
  pkill -KILL -f "$F/server.py" 2>/dev/null || true
  rm -rf "$DEV" "$DATA" "$F/containers" "$F/calls.log" "$F/monitor" "$F/pg_sessions" "$F/pg_events" \
    "$F/pg_down" "$F/go_fail" "$F/compose_up_fail" "$F/binary_mode" "$F/volume_removed" "$F/pg_others"
  mkdir -p "$F/containers"
  : >"$F/calls.log"
}

# container <service> <started from> [state]
container() {
  printf 'project=%s\nservice=%s\nname=%s-%s-1\ndir=%s\nstate=%s\n' \
    "$PROJECT" "$1" "$PROJECT" "$1" "$2" "${3:-running}" >"$F/containers/$1-$PROJECT"
}

MONITOR_EMPTY='{"server_id":"NFAKE","streams":1,"consumers":1,"account_details":[{"stream_detail":[{"consumer_detail":[{"num_ack_pending":0,"num_pending":0}]}]}]}'
MONITOR_BUSY='{"server_id":"NFAKE","streams":1,"consumers":1,"account_details":[{"stream_detail":[{"consumer_detail":[{"num_ack_pending": 3,"num_pending": 12}]}]}]}'
LEGACY=(nginx dashboard ingestion workers api nats)

# legacy_stack <started from>: the seven-container stack, running, with
# an empty queue.
legacy_stack() {
  local svc
  for svc in "${LEGACY[@]}"; do container "$svc" "$1"; done
  printf 'project=%s\nservice=postgres\nname=%s-postgres-1\ndir=%s\nstate=running\n' \
    "$PROJECT" "$PROJECT" "$1" >"$F/containers/pg-$PROJECT"
  printf '%s' "$MONITOR_EMPTY" >"$F/monitor"
}

# state_of <container id>: running, exited or gone.
state_of() {
  if [ -f "$F/containers/$1" ]; then sed -n 's/^state=//p' "$F/containers/$1"; else echo gone; fi
}

expect_status() {
  case "$1" in
    0) [ "$STATUS" -eq 0 ] || fail "wanted success, got status $STATUS" ;;
    *) [ "$STATUS" -ne 0 ] || fail "wanted a failure, the script succeeded" ;;
  esac
}
expect_out() { case "$OUT" in *"$1"*) ;; *) fail "the output does not say: $1" ;; esac; }
expect_state() { [ "$(state_of "$1")" = "$2" ] || fail "container $1 is $(state_of "$1"), wanted $2"; }
expect_legacy() {
  local svc
  for svc in "${LEGACY[@]}"; do expect_state "$svc-$PROJECT" "$1"; done
}
expect_no_call() { ! grep -Eq -- "$1" "$F/calls.log" || fail "a call matching '$1' was made"; }
expect_call() { grep -Eq -- "$1" "$F/calls.log" || fail "no call matching '$1' was made"; }
# expect_order <pattern> <pattern>...: the first call matching each
# pattern comes after the first one matching the pattern before it.
expect_order() {
  local prev=0 line pattern
  for pattern in "$@"; do
    line="$(grep -En -m1 -- "$pattern" "$F/calls.log" | cut -d: -f1)"
    [ -n "$line" ] || fail "no call matching '$pattern' was made"
    [ "$line" -gt "$prev" ] || fail "the call matching '$pattern' came too early (line $line, after line $prev expected)"
    prev="$line"
  done
}
binary_pid() { cat "$DEV/flightdeck.pid" 2>/dev/null || true; }
expect_serving() {
  local pid
  pid="$(binary_pid)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then fail "no binary is running"; fi
  [ -f "$DEV/stack.env" ] || fail "no state file was written"
}
expect_not_serving() {
  local pid
  pid="$(binary_pid)"
  [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null || fail "a binary is running (pid $pid)"
  [ ! -f "$DEV/stack.env" ] || fail "a state file was written"
}
passed() {
  PASSED=$((PASSED + 1))
  printf 'ok  %s\n' "$CASE"
}

# stranger: a server that is not this stack's, on the stack's port.
stranger() {
  local i
  python3 "$F/server.py" "$PORT" >/dev/null 2>&1 &
  echo $! >"$F/stranger.pid"
  # Not a job of this shell: its end is not reported on stderr.
  disown
  for ((i = 0; i < LISTEN_WAIT_SECS * 10; i++)); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then return 0; fi
    sleep 0.1
  done
  fail "the stranger server did not listen within ${LISTEN_WAIT_SECS}s"
}

# ---- a build that fails stops nothing -------------------------------

fresh "a failing build leaves the seven-container stack running"
legacy_stack "$OURS"
touch "$F/go_fail"
stack up postgres
expect_status 1
expect_legacy running
expect_state "pg-$PROJECT" running
expect_no_call '^docker (stop|rm) '
expect_no_call '^docker compose .* (up|down)'
expect_no_call '^flightdeck start'
expect_not_serving
passed

fresh "a failing build on restart leaves the running binary serving"
stack up sqlite
expect_status 0
expect_serving
first="$(binary_pid)"
touch "$F/go_fail"
stack restart
expect_status 1
if [ "$(binary_pid)" != "$first" ] || ! kill -0 "$first" 2>/dev/null; then fail "the binary that was running is gone"; fi
[ -f "$DEV/stack.env" ] || fail "the running stack's state file is gone"
rm -f "$F/go_fail"
stack restart
expect_status 0
expect_serving
[ "$(binary_pid)" != "$first" ] || fail "restart did not start a new binary"
! kill -0 "$first" 2>/dev/null || fail "the replaced binary still runs"
passed

# ---- the move from the seven-container stack ------------------------

fresh "the move builds, starts Postgres, stops the old stack, starts the binary, then removes the old containers"
legacy_stack "$OURS"
stack up postgres
expect_status 0
expect_order '^go build' '^docker compose .* up -d --wait postgres' '^docker stop' '^flightdeck start' '^docker rm'
expect_legacy gone
expect_state "pg-$PROJECT" running
expect_serving
[ "$(cat "$DEV/postgres.project")" = "$PROJECT" ] || fail "the dev dir does not record the Postgres project"
passed

fresh "a binary that does not start leaves the old containers stopped, not removed, and says how to start them"
legacy_stack "$OURS"
echo exit >"$F/binary_mode"
stack up postgres
expect_status 1
expect_legacy exited
expect_state "pg-$PROJECT" running
expect_no_call '^docker rm '
expect_out "docker start $PROJECT-nats-1 $PROJECT-api-1 $PROJECT-workers-1 $PROJECT-ingestion-1 $PROJECT-dashboard-1 $PROJECT-nginx-1"
expect_not_serving
passed

fresh "a Postgres container that cannot start leaves the old stack running"
legacy_stack "$OURS"
touch "$F/compose_up_fail"
stack up postgres
expect_status 1
expect_legacy running
expect_no_call '^docker (stop|rm) '
expect_no_call '^flightdeck start'
passed

# ---- the port -------------------------------------------------------

fresh "a port that already answers stops the start before anything is started"
stranger
stack up postgres
expect_status 1
expect_out "something already listens on 127.0.0.1:$PORT"
expect_no_call '^docker compose .* up'
expect_no_call '^flightdeck start'
expect_not_serving
passed

fresh "a stranger that answers on the port while the binary is still starting is not this stack"
echo usurped >"$F/binary_mode"
stack up sqlite
expect_status 1
expect_out "the binary started here has exited"
expect_out "something else is serving on 127.0.0.1:$PORT"
expect_out "is already in use"
expect_not_serving
[ ! -e "$DEV/flightdeck.pid" ] || fail "the pid file of the binary that exited is still there"
passed

# ---- the old stack's queue ------------------------------------------

fresh "a queue that cannot be read stops the move before anything is stopped"
legacy_stack "$OURS"
rm -f "$F/monitor"
stack up postgres
expect_status 1
expect_out "Nothing was stopped"
expect_out "FLIGHTDECK_DEV_ALLOW_UNDRAINED=1"
expect_legacy running
expect_no_call '^docker (stop|rm) '
expect_no_call '^flightdeck start'
passed

fresh "a queue that is not empty after the wait stops the move with only the front door and ingestion stopped"
legacy_stack "$OURS"
printf '%s' "$MONITOR_BUSY" >"$F/monitor"
stack up postgres
expect_status 1
expect_out "the workers still had queued events after ${DRAIN_SECS}s"
expect_out "${PROJECT}_nats_data"
expect_out "docker start $PROJECT-nats-1"
expect_out "FLIGHTDECK_DEV_ALLOW_UNDRAINED=1"
for svc in nginx dashboard ingestion; do expect_state "$svc-$PROJECT" exited; done
for svc in workers api nats; do expect_state "$svc-$PROJECT" running; done
expect_no_call '^docker rm '
expect_no_call '^flightdeck start'
passed

fresh "FLIGHTDECK_DEV_ALLOW_UNDRAINED=1 moves with the events left behind, and says so"
legacy_stack "$OURS"
printf '%s' "$MONITOR_BUSY" >"$F/monitor"
ENVV=(FLIGHTDECK_DEV_ALLOW_UNDRAINED=1)
stack up postgres
expect_status 0
expect_out "they stay in the ${PROJECT}_nats_data volume"
expect_legacy gone
expect_serving
passed

fresh "an old stack with no NATS container moves, and says there is no queue"
legacy_stack "$OURS"
rm -f "$F/containers/nats-$PROJECT" "$F/monitor"
stack up postgres
expect_status 0
expect_out "no NATS container runs in project $PROJECT"
expect_serving
passed

# ---- another checkout's containers ----------------------------------

fresh "up refuses to replace a stack another checkout started, and builds nothing"
legacy_stack "$FOREIGN"
stack up postgres
expect_status 1
expect_out "were started from $FOREIGN, not from this checkout"
expect_legacy running
expect_no_call '^go build'
expect_no_call '^docker (stop|rm) '
passed

fresh "up refuses to attach to a Postgres another checkout started"
container postgres "$FOREIGN"
mv "$F/containers/postgres-$PROJECT" "$F/containers/pg-$PROJECT"
stack up postgres
expect_status 1
expect_out "attach this checkout's binary to that stack's database"
expect_no_call '^go build'
expect_no_call '^flightdeck start'
ENVV=(FLIGHTDECK_DEV_TAKEOVER="$PROJECT")
stack up postgres
expect_status 0
expect_serving
passed

fresh "down stops this checkout's binary and leaves another checkout's containers running"
legacy_stack "$FOREIGN"
rm -f "$F/containers/nginx-$PROJECT"
stack up sqlite
expect_status 1
expect_out "were started from $FOREIGN"
for svc in dashboard ingestion workers api nats; do rm -f "$F/containers/$svc-$PROJECT"; done
stack up sqlite
expect_status 0
expect_serving
stack down
expect_status 0
expect_out "they are left running"
expect_state "pg-$PROJECT" running
expect_no_call '^docker compose .* down'
expect_not_serving
passed

fresh "down removes the Postgres container this checkout started"
stack up postgres
expect_status 0
stack down
expect_status 0
expect_call '^docker compose .* down --remove-orphans'
expect_state "pg-$PROJECT" gone
expect_not_serving
passed

# ---- reset ----------------------------------------------------------

fresh "reset refuses a database with data and no confirmation, and stops nothing"
stack up postgres
expect_status 0
echo 13750 >"$F/pg_sessions"
echo 209842 >"$F/pg_events"
stack reset
expect_status 1
expect_out "${PROJECT}_postgres_data"
expect_out "13750 sessions, 209842 events"
expect_out "make dev-reset FLIGHTDECK_DEV_CONFIRM=$PROJECT"
expect_no_call '^docker compose .* down'
expect_serving
ENVV=(FLIGHTDECK_DEV_CONFIRM=docker)
stack reset
expect_status 1
expect_out "FLIGHTDECK_DEV_CONFIRM=docker is not the compose project name, $PROJECT: nothing was deleted"
expect_no_call '^docker compose .* down'
expect_serving
passed

fresh "reset goes ahead with the project's name"
stack up postgres
echo 13750 >"$F/pg_sessions"
echo 209842 >"$F/pg_events"
ENVV=(FLIGHTDECK_DEV_CONFIRM="$PROJECT")
stack reset
expect_status 0
expect_out "13750 sessions, 209842 events"
expect_call '^docker compose .* down -v --remove-orphans'
[ -f "$F/volume_removed" ] || fail "the volume was not removed"
expect_serving
passed

fresh "reset goes ahead on a seed-sized database"
stack up postgres
echo 57 >"$F/pg_sessions"
echo 2600 >"$F/pg_events"
stack reset
expect_status 0
expect_call '^docker compose .* down -v --remove-orphans'
expect_serving
passed

fresh "reset goes ahead on a database that was never migrated"
stack up postgres
stack reset
expect_status 0
expect_out "0 sessions, 0 events"
expect_call '^docker compose .* down -v --remove-orphans'
expect_serving
passed

fresh "reset refuses a database it cannot ask"
stack up postgres
touch "$F/pg_down"
stack reset
expect_status 1
expect_out "could not ask the database which clients it has"
expect_no_call '^docker compose .* down'
expect_serving
passed

fresh "reset refuses when nothing says this checkout started the stack"
stack reset
expect_status 1
expect_out "nothing to reset"
stack reset postgres
expect_status 1
expect_out "nothing says this checkout started the Postgres of compose project $PROJECT"
expect_no_call '^docker compose'
passed

fresh "reset refuses while something that is not this stack serves on its port"
container postgres "$OURS"
mv "$F/containers/postgres-$PROJECT" "$F/containers/pg-$PROJECT"
mkdir -p "$DEV"
printf '%s\n' "$PROJECT" >"$DEV/postgres.project"
echo 3 >"$F/pg_sessions"
echo 40 >"$F/pg_events"
stranger
for args in "" postgres sqlite; do
  ENVV=(FLIGHTDECK_DEV_CONFIRM="$PROJECT")
  # shellcheck disable=SC2086  # an empty args runs reset with none
  stack reset $args
  expect_status 1
  expect_out "something listens on 127.0.0.1:$PORT, and it is not this checkout's stack"
  expect_out "Nothing was deleted"
done
expect_no_call '^docker compose'
[ ! -f "$F/volume_removed" ] || fail "the volume was removed"
expect_state "pg-$PROJECT" running
passed

fresh "reset refuses another checkout's Postgres, with or without a confirmation"
container postgres "$FOREIGN"
mv "$F/containers/postgres-$PROJECT" "$F/containers/pg-$PROJECT"
echo 13750 >"$F/pg_sessions"
ENVV=(FLIGHTDECK_DEV_CONFIRM="$PROJECT")
stack reset postgres
expect_status 1
expect_out "were started from $FOREIGN"
expect_no_call '^docker compose'
expect_state "pg-$PROJECT" running
passed

fresh "reset on SQLite deletes this checkout's file and starts again"
stack up sqlite
expect_status 0
: >"$DATA/flightdeck.db"
mkdir -p "$DATA/nats"
stack reset
expect_status 0
expect_out "$DATA/flightdeck.db"
if [ -e "$DATA/flightdeck.db" ] || [ -e "$DATA/nats" ]; then fail "the SQLite file or the bus store is still there"; fi
expect_no_call '^docker compose'
expect_serving
passed

# ---- the split test stack's project ---------------------------------

# split <target> [NAME=value]: run a split target of the Makefile with
# the fake docker.
split() {
  set +e
  OUT="$(timeout "$RUN_BOUND_SECS" env -u SPLIT_PROJECT -u FLIGHTDECK_DEV_PROJECT \
    PATH="$TMP/bin:$PATH" FAKE_STATE="$F" ${ENVV[@]+"${ENVV[@]}"} \
    make -C "$ROOT" --no-print-directory "$@" </dev/null 2>&1)"
  STATUS=$?
  set -e
  ENVV=()
}

fresh "make refuses the split test stack under the dev stack's or a user install's project"
for name in docker flightdeck; do
  for target in dev-split down-split; do
    split "$target" SPLIT_PROJECT="$name"
    expect_status 1
    expect_out "SPLIT_PROJECT=$name is the compose project of the dev stack or of a user install"
  done
done
ENVV=(FLIGHTDECK_DEV_PROJECT=mine)
split down-split SPLIT_PROJECT=mine
expect_status 1
expect_no_call '^docker compose'
split dev-split SPLIT_PROJECT=fdtest-split
expect_status 0
expect_call '^docker compose -p fdtest-split -f docker/docker-compose.split.yml up -d --wait'
passed

# ---- the follow-ups of the second review ----------------------------

fresh "the binary connects with an application_name of its dev dir, which reset leaves out"
stack up postgres
expect_status 0
expect_call '^flightdeck start mode=ok .*application_name=flightdeck-dev-[0-9]+'
app="$(grep -oE 'application_name=flightdeck-dev-[0-9]+' "$F/calls.log" | head -n1 | cut -d= -f2)"
stack reset
expect_status 0
expect_call "application_name IS DISTINCT FROM '$app'"
passed

fresh "reset refuses while other clients use the Postgres database, and names them"
stack up postgres
printf 'flightdeck-dev-123 (172.18.0.1)\nflightdeck-dev-123 (172.18.0.1)\npsql (local socket)\n' >"$F/pg_others"
ENVV=(FLIGHTDECK_DEV_CONFIRM="$PROJECT")
stack reset
expect_status 1
expect_out "the database is in use by other clients: 2 x flightdeck-dev-123 (172.18.0.1); 1 x psql (local socket)"
expect_out "nothing was deleted"
expect_no_call '^docker compose .* down'
expect_serving
passed

fresh "down leaves the Postgres container running while another client uses it"
stack up postgres
printf 'flightdeck-dev-456 (172.18.0.1)\n' >"$F/pg_others"
stack down
expect_status 0
expect_out "the Postgres container is in use by other clients (flightdeck-dev-456 (172.18.0.1))"
expect_state "pg-$PROJECT" running
expect_no_call '^docker compose .* down'
expect_not_serving
rm -f "$F/pg_others"
stack down
expect_status 0
expect_state "pg-$PROJECT" gone
passed

# ---- the follow-ups of the third review -----------------------------

fresh "down leaves the Postgres container running when it cannot ask the database"
stack up postgres
touch "$F/pg_down"
stack down
expect_status 0
expect_out "could not ask the Postgres database which clients it has: the container is left running"
expect_out "docker compose -p $PROJECT -f $OURS/docker-compose.dev.yml down"
expect_state "pg-$PROJECT" running
expect_no_call '^docker compose .* down'
expect_not_serving
rm -f "$F/pg_down"
stack down
expect_status 0
expect_state "pg-$PROJECT" gone
passed

# Without the bound on each probe, the first one would wait for an
# answer that never comes, and the run would end only at
# RUN_BOUND_SECS. With it, the start gives up READY_SECS after it began
# waiting, plus one probe.
fresh "a binary that accepts connections and never answers fails the start within the readiness wait"
echo silent >"$F/binary_mode"
began=$SECONDS
stack up sqlite
took=$((SECONDS - began))
expect_status 1
expect_out "flightdeck is not serving after ${READY_SECS}s"
expect_out "not ready"
expect_not_serving
[ "$took" -le $((READY_SECS * 2)) ] || fail "the start took ${took}s, more than $((READY_SECS * 2))s"
passed

fresh "the application_name of a dev dir does not depend on how its path is written"
stack up postgres
expect_status 0
first="$(grep -oE 'application_name=flightdeck-dev-[0-9]+' "$F/calls.log" | head -n1)"
stack down
rm -f "$TMP/dev-link"
ln -s "$DEV" "$TMP/dev-link"
: >"$F/calls.log"
ENVV=(FLIGHTDECK_DEV_DIR="$TMP/dev-link/")
stack up postgres
expect_status 0
second="$(grep -oE 'application_name=flightdeck-dev-[0-9]+' "$F/calls.log" | head -n1)"
[ -n "$first" ] || fail "the binary got no application_name"
[ "$first" = "$second" ] || fail "the dev dir and a symlink to it give two names: '$first', '$second'"
ENVV=(FLIGHTDECK_DEV_DIR="$TMP/dev-link/")
stack down
rm -f "$TMP/dev-link"
passed

# sqlite_db <sessions>: a SQLite file in the data dir with that many
# sessions and twice as many events.
sqlite_db() {
  mkdir -p "$DATA"
  rm -f "$DATA/flightdeck.db"
  python3 - "$DATA/flightdeck.db" "$1" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE sessions (session_id TEXT)")
db.execute("CREATE TABLE events (event_id TEXT)")
n = int(sys.argv[2])
db.executemany("INSERT INTO sessions VALUES (?)", [(str(i),) for i in range(n)])
db.executemany("INSERT INTO events VALUES (?)", [(str(i),) for i in range(2 * n)])
db.commit()
PY
}

fresh "a SQLite reset counts first, and wants the word sqlite above a seed"
stack up sqlite
expect_status 0
sqlite_db 150
stack reset
expect_status 1
expect_out "150 sessions, 300 events"
expect_out "make dev-reset FLIGHTDECK_DEV_CONFIRM=sqlite"
[ -f "$DATA/flightdeck.db" ] || fail "the SQLite file was deleted"
expect_serving
ENVV=(FLIGHTDECK_DEV_CONFIRM="$PROJECT")
stack reset
expect_status 1
expect_out "FLIGHTDECK_DEV_CONFIRM=$PROJECT is not sqlite: nothing was deleted"
ENVV=(FLIGHTDECK_DEV_CONFIRM=sqlite)
stack reset
expect_status 0
[ ! -e "$DATA/flightdeck.db" ] || fail "the SQLite file is still there"
expect_serving
passed

fresh "a SQLite reset of a seed-sized database goes ahead, of one it cannot read does not"
stack up sqlite
sqlite_db 40
stack reset
expect_status 0
expect_out "40 sessions, 80 events"
printf 'not a database' >"$DATA/flightdeck.db"
stack reset
expect_status 1
expect_out "an unknown number of sessions"
passed

fresh "a SQLite reset refuses while another process holds the data dir's lock"
mkdir -p "$DATA"
: >"$DATA/flightdeck.db"
python3 -c 'import fcntl, sys, time
f = open(sys.argv[1], "w")
fcntl.flock(f, fcntl.LOCK_EX)
open(sys.argv[2], "w").close()
time.sleep(60)' "$DATA/flightdeck.lock" "$F/locked" &
holder=$!
for ((i = 0; i < 50; i++)); do [ -e "$F/locked" ] && break; sleep 0.1; done
stack reset sqlite
expect_status 1
expect_out "another process holds the lock on $DATA"
[ -f "$DATA/flightdeck.db" ] || fail "the SQLite file was deleted"
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null || true
rm -f "$F/locked"
stack reset sqlite
expect_status 0
passed

printf '%s cases passed\n' "$PASSED"
