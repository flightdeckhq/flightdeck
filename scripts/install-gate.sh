#!/usr/bin/env bash
# The from-scratch install gate's checks: an installed `flightdeck` (or a
# container running it) serves health, prints its token, accepts one
# sensor-shaped event, lists the session and serves the dashboard. The
# install-gate workflow runs this on every leg after installing through
# the channel under test; it runs anywhere bash, curl and od exist:
# Linux, macOS and the Git Bash of a Windows runner.
#
# Usage:
#   scripts/install-gate.sh run <listen> <binary> [flag...]
#       Starts <binary> --listen <listen> --data-dir <fresh temp dir>
#       [flag...] with its output in a log, checks it, stops it with
#       SIGINT and requires a clean exit. The database is the binary's
#       default, a SQLite file in that data dir, unless the environment
#       names another (FLIGHTDECK_DATABASE_URL).
#   scripts/install-gate.sh check <base-url> <log-command...>
#       Checks a server somebody else started (a container): the
#       start-up block is read from the output of <log-command>, for
#       example `docker logs flightdeck`.
#
# Environment:
#   GATE_EXPECT_VERSION   when set, `<binary> --version` must print
#                         "flightdeck <this>" (run mode only)
#   GATE_READY_TIMEOUT    seconds to wait for /ingest/health (default 90:
#                         a first start migrates an empty database and
#                         starts JetStream; a cold runner takes seconds,
#                         a Windows runner on a cold disk longer)
#   GATE_STORE_TIMEOUT    seconds for the posted session to appear in the
#                         API (default 30; the embedded bus delivers in
#                         milliseconds, the bound turns a hang into a failure)
set -euo pipefail

READY_TIMEOUT="${GATE_READY_TIMEOUT:-90}"
STORE_TIMEOUT="${GATE_STORE_TIMEOUT:-30}"

say() { printf '== %s\n' "$*"; }
die() { printf 'install-gate: %s\n' "$*" >&2; exit 1; }

# uuid prints a random version-4 UUID with od on /dev/urandom, which
# every bash the gate runs under has (Git Bash included); /proc, uuidgen
# and python are not all present on every runner.
uuid() {
  local hex
  hex="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s-%s-4%s-%x%s-%s\n' \
    "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "$(( (0x${hex:16:1} & 0x3) | 0x8 ))" "${hex:17:3}" "${hex:20:12}"
}

# token_from reads the start-up block's Token line: `tok_dev` on a
# loopback listen, the minted `ftd_...` token on any other. Under GitHub
# Actions the token is masked in the job log before anything prints it.
token_from() {
  local token
  token="$(sed -n 's/^[[:space:]]*Token[[:space:]]\{1,\}\([A-Za-z0-9_]\{1,\}\).*/\1/p' | head -n 1)"
  if [[ -n "$token" && -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::add-mask::%s\n' "$token" >&2
  fi
  printf '%s\n' "$token"
}

wait_ready() {
  local base="$1" alive_cmd="${2:-true}" i
  for ((i = 0; i < READY_TIMEOUT; i++)); do
    if curl -sf -o /dev/null "$base/ingest/health"; then return 0; fi
    eval "$alive_cmd" || return 1
    sleep 1
  done
  return 1
}

# checks BASE TOKEN runs the HTTP checks against a ready server.
checks() {
  local base="$1" token="$2" sid aid now resp i
  curl -sf "$base/api/health" >/dev/null || die "no /api/health"
  say "health ok"

  say "dashboard"
  # Each body is captured before it is searched: a `curl | grep -q`
  # under pipefail fails when grep exits before curl finishes writing.
  body="$(curl -sf "$base/")" || die "GET / failed"
  grep -q '<title>Flightdeck</title>' <<<"$body" || die "GET / is not the dashboard"
  body="$(curl -sf "$base/runtime-config.json")" || die "GET /runtime-config.json failed"
  grep -q "\"access_token\":\"$token\"" <<<"$body" || die "/runtime-config.json does not carry the printed token"

  say "one sensor-shaped event"
  sid="$(uuid)"; aid="$(uuid)"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  resp="$(curl -sf -X POST "$base/ingest/v1/events" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$sid\",\"agent_id\":\"$aid\",\"agent_name\":\"install-gate\",\"agent_type\":\"coding\",\"client_type\":\"flightdeck_sensor\",\"user\":\"gate\",\"hostname\":\"gate-host\",\"flavor\":\"install-gate\",\"event_type\":\"session_start\",\"host\":\"gate-host\",\"sensor_version\":\"0.0.0\",\"capture_prompts\":false,\"timestamp\":\"$now\",\"context\":{}}")" \
    || die "POST /ingest/v1/events failed"
  printf '   ingest answered: %s\n' "$resp"

  body=""
  for ((i = 0; i < STORE_TIMEOUT; i++)); do
    body="$(curl -sf -H "Authorization: Bearer $token" "$base/api/v1/sessions/$sid" || true)"
    if grep -q "\"session_id\":\"$sid\"" <<<"$body"; then break; fi
    sleep 1
  done
  grep -q "\"session_id\":\"$sid\"" <<<"$body" || die "session $sid not served within ${STORE_TIMEOUT}s"
  body="$(curl -sf -H "Authorization: Bearer $token" "$base/api/v1/sessions")" || die "GET /api/v1/sessions failed"
  grep -q "$sid" <<<"$body" || die "GET /api/v1/sessions does not list $sid"
  say "session $sid stored and listed"
}

mode_run() {
  local listen="$1" bin="$2"; shift 2
  local base="http://$listen" work log pid token
  [[ -n "${GATE_EXPECT_VERSION:-}" ]] && {
    local printed
    printed="$("$bin" --version)"
    [[ "$printed" == "flightdeck $GATE_EXPECT_VERSION" ]] || die "--version printed '$printed', want 'flightdeck $GATE_EXPECT_VERSION'"
    say "version $printed"
  }
  work="$(mktemp -d)"
  log="$work/flightdeck.log"
  say "starting $bin on $listen (data dir $work/data)"
  "$bin" --listen "$listen" --data-dir "$work/data" "$@" >"$log" 2>&1 &
  pid=$!
  # shellcheck disable=SC2064  # expand pid now: the trap runs after it is unset
  trap "kill -INT $pid 2>/dev/null || true; rm -rf '$work'" EXIT

  if ! wait_ready "$base" "kill -0 $pid 2>/dev/null"; then
    printf 'flightdeck is not ready after %ss; its output:\n' "$READY_TIMEOUT" >&2
    token_from <"$log" >/dev/null  # registers the mask before the log is shown
    cat "$log" >&2
    die "not ready"
  fi
  token="$(token_from <"$log")"
  [[ -n "$token" ]] || { cat "$log" >&2; die "no Token line in the start-up block"; }
  say "token from the start-up block: ${token:0:8}…"
  checks "$base" "$token"

  say "clean shutdown"
  kill -INT "$pid"
  if wait "$pid"; then
    say "exited 0"
  elif [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
    # Git Bash cannot deliver a console Ctrl+C to a native process; the
    # exit status after kill is not the binary's own.
    say "stopped (exit status not checked on Windows)"
  else
    cat "$log" >&2
    die "flightdeck exited non-zero on SIGINT"
  fi
  trap - EXIT
  rm -rf "$work"
  echo "GATE OK"
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
  checks "$base" "$token"
  echo "GATE OK"
}

case "${1:-}" in
  run) [[ $# -ge 3 ]] || die "usage: $0 run <listen> <binary> [flag...]"; shift; mode_run "$@" ;;
  check) [[ $# -ge 3 ]] || die "usage: $0 check <base-url> <log-command...>"; shift; mode_check "$@" ;;
  *) die "usage: $0 run <listen> <binary> [flag...] | check <base-url> <log-command...>" ;;
esac
