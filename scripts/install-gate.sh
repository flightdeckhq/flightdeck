#!/usr/bin/env bash
# The from-scratch install gate's checks: an installed `flightdeck` (or a
# container running it), started with no database configured, serves
# health, prints its token, names a SQLite database in its start-up
# block, accepts one sensor-shaped event, lists the session, serves the
# dashboard, and still serves that session after a stop and a restart on
# the same data. The install-gate workflow runs this on every leg after
# installing through the channel under test, and CI runs it against the
# binary and the image it builds; it runs anywhere bash, curl and od
# exist: Linux, macOS and the Git Bash of a Windows runner.
#
# Usage:
#   scripts/install-gate.sh run <listen> <binary> [flag...]
#       Starts <binary> --listen <listen> --data-dir <fresh temp dir>
#       [flag...] with its output in a log, checks it, stops it with
#       SIGINT and requires a clean exit, then starts it again on the
#       same data dir and requires the session to be served still. The
#       binary's own settings are removed from its environment
#       (FLIGHTDECK_DATABASE_URL and the others it reads), so the
#       database is its default, a SQLite file in that data dir, and
#       nothing the caller's shell exports can supply one. The one
#       other database is named as a flag:
#       `--database-url postgres://…` with GATE_EXPECT_DATABASE=Postgres.
#   scripts/install-gate.sh check <base-url> <log-command...>
#       Checks a server somebody else started (a container, a service):
#       the start-up block is read from the output of <log-command>, for
#       example `docker logs flightdeck`. With GATE_STATE_FILE set, the
#       token and the session's id are kept there for `kept`.
#   scripts/install-gate.sh kept <base-url> [log-command...]
#       After the caller stopped that server and started it again on the
#       same data: the session `check` recorded in GATE_STATE_FILE is
#       still served with the same token. <log-command> is shown when it
#       is not.
#
# Environment:
#   GATE_EXPECT_VERSION   when set, `<binary> --version` must print
#                         "flightdeck <this>" (run mode only)
#   GATE_EXPECT_DATABASE  the backend the start-up block must name:
#                         SQLite (the default) or Postgres
#   GATE_STATE_FILE       where `check` writes, and `kept` reads, the
#                         token and the session id (created 0600)
#   GATE_READY_TIMEOUT    seconds to wait for /ingest/health (default 90:
#                         a first start creates the database, a SQLite
#                         file or the schema of an empty Postgres
#                         database, applies the migrations and starts
#                         JetStream; a cold runner takes seconds, a
#                         Windows runner on a cold disk longer)
#   GATE_STORE_TIMEOUT    seconds for the posted session to appear in the
#                         API (default 30; the embedded bus delivers in
#                         milliseconds, the bound turns a hang into a failure)
set -euo pipefail

READY_TIMEOUT="${GATE_READY_TIMEOUT:-90}"
STORE_TIMEOUT="${GATE_STORE_TIMEOUT:-30}"
EXPECT_DATABASE="${GATE_EXPECT_DATABASE:-SQLite}"
# How long one HTTP request may take. The binary binds its port before
# it opens and migrates the database, so a start that wedges there
# accepts the connection and never answers; without a bound one curl
# would wait for ever and no timeout above would be reached. Every
# request here answers in milliseconds; five seconds is slack for a
# loaded runner.
REQUEST_TIMEOUT_SECS=5
CURL=(curl --max-time "$REQUEST_TIMEOUT_SECS")
# How long a stopped server gets to release its port before the restart
# (kept mode has no process to wait on); a stop takes a second or two.
STOP_TIMEOUT_SECS=30

# The session the checks posted, for the restart check.
GATE_SID=""

say() { printf '== %s\n' "$*"; }
die() { printf 'install-gate: %s\n' "$*" >&2; exit 1; }

case "$EXPECT_DATABASE" in
  SQLite | Postgres) ;;
  *) die "GATE_EXPECT_DATABASE is '$EXPECT_DATABASE', want SQLite or Postgres" ;;
esac

# uuid prints a random version-4 UUID with od on /dev/urandom, which
# every bash the gate runs under has (Git Bash included); /proc, uuidgen
# and python are not all present on every runner.
uuid() {
  local hex
  hex="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s-%s-4%s-%x%s-%s\n' \
    "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "$(( (0x${hex:16:1} & 0x3) | 0x8 ))" "${hex:17:3}" "${hex:20:12}"
}

# token_from reads the first start-up block's Token line: `tok_dev` on a
# loopback listen, the minted `ftd_...` token on any other (a later
# start prints only the token's first characters, so the first block is
# the one that carries it). Under GitHub Actions the token is masked in
# the job log before anything prints it.
token_from() {
  local token
  token="$(sed -n 's/^[[:space:]]*Token[[:space:]]\{1,\}\([A-Za-z0-9_]\{1,\}\).*/\1/p' | head -n 1)"
  if [[ -n "$token" && -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::add-mask::%s\n' "$token" >&2
  fi
  printf '%s\n' "$token"
}

# startup_checks reads the server's output on stdin: the start-up block
# names the expected backend, and the data dir draws no warning (the
# binary warns when its data dir is wider than 0700; a directory it
# created, or the image's /data, never is).
startup_checks() {
  local out line
  out="$(cat)"
  line="$(grep -E '^[[:space:]]*Database[[:space:]]' <<<"$out" | head -n 1 || true)"
  [[ -n "$line" ]] || die "no Database line in the start-up block"
  grep -qE "\($EXPECT_DATABASE\)[[:space:]]*\$" <<<"$line" || die "the start-up block names '${line#"${line%%[![:space:]]*}"}', want a $EXPECT_DATABASE database"
  if grep -q 'should be 0700' <<<"$out"; then
    die "the server warns that its data dir is wider than 0700: $(grep 'should be 0700' <<<"$out" | head -n 1)"
  fi
  say "database: $EXPECT_DATABASE"
}

wait_ready() {
  local base="$1" alive_cmd="${2:-true}" deadline
  # A deadline, not a count of attempts: one attempt can itself take
  # REQUEST_TIMEOUT_SECS.
  deadline=$((SECONDS + READY_TIMEOUT))
  until "${CURL[@]}" -sf -o /dev/null "$base/ingest/health"; do
    eval "$alive_cmd" || return 1
    ((SECONDS < deadline)) || return 1
    sleep 1
  done
}

# checks BASE TOKEN runs the HTTP checks against a ready server and
# leaves the posted session's id in GATE_SID.
checks() {
  local base="$1" token="$2" sid aid now resp body deadline
  "${CURL[@]}" -sf "$base/api/health" >/dev/null || die "no /api/health"
  say "health ok"

  say "dashboard"
  # Each body is captured before it is searched: a `curl | grep -q`
  # under pipefail fails when grep exits before curl finishes writing.
  body="$("${CURL[@]}" -sf "$base/")" || die "GET / failed"
  grep -q '<title>Flightdeck</title>' <<<"$body" || die "GET / is not the dashboard"
  body="$("${CURL[@]}" -sf "$base/runtime-config.json")" || die "GET /runtime-config.json failed"
  grep -q "\"access_token\":\"$token\"" <<<"$body" || die "/runtime-config.json does not carry the printed token"

  say "one sensor-shaped event"
  sid="$(uuid)"; aid="$(uuid)"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  resp="$("${CURL[@]}" -sf -X POST "$base/ingest/v1/events" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$sid\",\"agent_id\":\"$aid\",\"agent_name\":\"install-gate\",\"agent_type\":\"coding\",\"client_type\":\"flightdeck_sensor\",\"user\":\"gate\",\"hostname\":\"gate-host\",\"flavor\":\"install-gate\",\"event_type\":\"session_start\",\"host\":\"gate-host\",\"sensor_version\":\"0.0.0\",\"capture_prompts\":false,\"timestamp\":\"$now\",\"context\":{}}")" \
    || die "POST /ingest/v1/events failed"
  printf '   ingest answered: %s\n' "$resp"

  body=""
  deadline=$((SECONDS + STORE_TIMEOUT))
  while :; do
    body="$("${CURL[@]}" -sf -H "Authorization: Bearer $token" "$base/api/v1/sessions/$sid" || true)"
    if grep -q "\"session_id\":\"$sid\"" <<<"$body"; then break; fi
    ((SECONDS < deadline)) || die "session $sid not served within ${STORE_TIMEOUT}s"
    sleep 1
  done
  body="$("${CURL[@]}" -sf -H "Authorization: Bearer $token" "$base/api/v1/sessions")" || die "GET /api/v1/sessions failed"
  grep -q "$sid" <<<"$body" || die "GET /api/v1/sessions does not list $sid"
  say "session $sid stored and listed"
  GATE_SID="$sid"
}

# still_served BASE TOKEN SID: after a restart on the same data, the
# session stored before the stop is served to the same token.
still_served() {
  local base="$1" token="$2" sid="$3" body
  body="$("${CURL[@]}" -sf -H "Authorization: Bearer $token" "$base/api/v1/sessions/$sid")" \
    || die "after the restart, GET /api/v1/sessions/$sid failed: the session or the token did not survive"
  grep -q "\"session_id\":\"$sid\"" <<<"$body" || die "after the restart, session $sid is not served"
  body="$("${CURL[@]}" -sf -H "Authorization: Bearer $token" "$base/api/v1/sessions")" || die "after the restart, GET /api/v1/sessions failed"
  grep -q "$sid" <<<"$body" || die "after the restart, GET /api/v1/sessions does not list $sid"
  say "session $sid still served after the restart"
}

# Run mode's server: RUN_PID is the binary, RUN_LOG its output (both
# starts append to it), RUN_WORK the temp dir that holds the log and the
# data dir.
RUN_PID=""
RUN_LOG=""
RUN_WORK=""

run_cleanup() {
  if [[ -n "$RUN_PID" ]] && kill -0 "$RUN_PID" 2>/dev/null; then
    kill -INT "$RUN_PID" 2>/dev/null || true
    wait "$RUN_PID" 2>/dev/null || true
  fi
  [[ -z "$RUN_WORK" ]] || rm -rf "$RUN_WORK"
}

# run_start BASE BINARY ARG... starts the binary and waits for it.
run_start() {
  local base="$1"; shift
  "$@" >>"$RUN_LOG" 2>&1 &
  RUN_PID=$!
  if ! wait_ready "$base" "kill -0 $RUN_PID 2>/dev/null"; then
    printf 'flightdeck is not ready after %ss; its output:\n' "$READY_TIMEOUT" >&2
    token_from <"$RUN_LOG" >/dev/null  # registers the mask before the log is shown
    cat "$RUN_LOG" >&2
    die "not ready"
  fi
}

run_stop() {
  kill -INT "$RUN_PID"
  if wait "$RUN_PID"; then
    say "exited 0"
  elif [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
    # Git Bash cannot deliver a console Ctrl+C to a native process; the
    # process is ended outright and the exit status after kill is not
    # the binary's own. The restart below then starts from what a
    # killed process left, which the binary must also recover from.
    say "stopped (exit status not checked on Windows)"
  else
    cat "$RUN_LOG" >&2
    die "flightdeck exited non-zero on SIGINT"
  fi
  RUN_PID=""
}

mode_run() {
  local listen="$1" bin="$2"; shift 2
  local base="http://$listen" token
  [[ -n "${GATE_EXPECT_VERSION:-}" ]] && {
    local printed
    printed="$("$bin" --version)"
    [[ "$printed" == "flightdeck $GATE_EXPECT_VERSION" ]] || die "--version printed '$printed', want 'flightdeck $GATE_EXPECT_VERSION'"
    say "version $printed"
  }
  # The binary reads its settings from the environment too. The gate's
  # claim is a start with nothing configured, so nothing a runner or a
  # developer's shell exports reaches it; unset here rather than through
  # `env -u`, so the background job's PID stays the binary's own.
  unset FLIGHTDECK_DATABASE_URL FLIGHTDECK_DATA_DIR FLIGHTDECK_LISTEN \
    FLIGHTDECK_NATS_URL FLIGHTDECK_DOMAIN FLIGHTDECK_METRICS
  RUN_WORK="$(mktemp -d)"
  RUN_LOG="$RUN_WORK/flightdeck.log"
  trap run_cleanup EXIT
  local cmd=("$bin" --listen "$listen" --data-dir "$RUN_WORK/data" "$@")

  say "starting $bin on $listen (data dir $RUN_WORK/data)"
  run_start "$base" "${cmd[@]}"
  token="$(token_from <"$RUN_LOG")"
  [[ -n "$token" ]] || { cat "$RUN_LOG" >&2; die "no Token line in the start-up block"; }
  say "token from the start-up block: ${token:0:8}…"
  startup_checks <"$RUN_LOG"
  if [[ "$EXPECT_DATABASE" == SQLite ]]; then
    [[ -f "$RUN_WORK/data/flightdeck.db" ]] || { ls -la "$RUN_WORK/data" >&2 || true; die "no flightdeck.db in the data dir"; }
  fi
  checks "$base" "$token"

  say "clean shutdown"
  run_stop

  say "restart on the same data dir"
  run_start "$base" "${cmd[@]}"
  still_served "$base" "$token" "$GATE_SID"
  run_stop

  trap - EXIT
  run_cleanup
  echo "GATE OK ($EXPECT_DATABASE)"
}

mode_check() {
  local base="$1"; shift
  local token
  say "waiting for $base"
  # The mask is registered from the logs before they are ever shown.
  show_logs() { eval "$*" 2>&1 | token_from >/dev/null || true; eval "$*" >&2 || true; }
  wait_ready "$base" || { show_logs "$@"; die "not ready after ${READY_TIMEOUT}s"; }
  token="$(eval "$*" 2>&1 | token_from)"
  [[ -n "$token" ]] || { show_logs "$@"; die "no Token line in the output of: $*"; }
  say "token from the start-up block: ${token:0:8}…"
  eval "$*" 2>&1 | startup_checks
  checks "$base" "$token"
  if [[ -n "${GATE_STATE_FILE:-}" ]]; then
    # The token is the server's secret: the file is the caller's alone.
    (umask 077 && printf '%s\n%s\n' "$token" "$GATE_SID" >"$GATE_STATE_FILE")
  fi
  echo "GATE OK ($EXPECT_DATABASE)"
}

mode_kept() {
  local base="$1"; shift
  local token sid
  [[ -n "${GATE_STATE_FILE:-}" && -r "${GATE_STATE_FILE:-}" ]] || die "kept needs GATE_STATE_FILE, written by a check run"
  { IFS= read -r token && IFS= read -r sid; } <"$GATE_STATE_FILE" || die "$GATE_STATE_FILE does not hold a token and a session id"
  [[ -n "$token" && -n "$sid" ]] || die "$GATE_STATE_FILE does not hold a token and a session id"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then printf '::add-mask::%s\n' "$token" >&2; fi
  say "waiting for $base"
  if ! wait_ready "$base"; then
    if [[ $# -gt 0 ]]; then eval "$*" >&2 || true; fi
    die "not ready after ${READY_TIMEOUT}s"
  fi
  if ! (still_served "$base" "$token" "$sid"); then
    if [[ $# -gt 0 ]]; then eval "$*" >&2 || true; fi
    exit 1
  fi
  echo "GATE OK (restart)"
}

# mode_down BASE waits until nothing answers on BASE: the caller stopped
# the server and is about to start it again on the same port.
mode_down() {
  local base="$1" deadline
  deadline=$((SECONDS + STOP_TIMEOUT_SECS))
  while "${CURL[@]}" -s -o /dev/null "$base/ingest/health"; do
    ((SECONDS < deadline)) || die "$base still answers ${STOP_TIMEOUT_SECS}s after the stop"
    sleep 1
  done
  say "$base is down"
}

usage="usage: $0 run <listen> <binary> [flag...] | check <base-url> <log-command...> | kept <base-url> [log-command...] | down <base-url>"
case "${1:-}" in
  run) [[ $# -ge 3 ]] || die "$usage"; shift; mode_run "$@" ;;
  check) [[ $# -ge 3 ]] || die "$usage"; shift; mode_check "$@" ;;
  kept) [[ $# -ge 2 ]] || die "$usage"; shift; mode_kept "$@" ;;
  down) [[ $# -eq 2 ]] || die "$usage"; shift; mode_down "$@" ;;
  *) die "$usage" ;;
esac
