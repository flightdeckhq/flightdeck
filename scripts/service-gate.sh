#!/usr/bin/env bash
# `flightdeck service` against the system's real service manager: the
# systemd user manager on Linux, launchd on macOS. It installs the
# service on a port of its own with a fresh data dir whose name has a
# space, quotes and a %, checks that it answers from the process the
# manager runs, kills that process with SIGKILL and waits for the manager
# to start a new one, restarts it, checks that a plain `flightdeck` on
# its data dir says the service runs, installs it again on a second port
# and sees it move, and removes it: the file is gone, nothing answers,
# and the data dir still holds the database. CI runs it on the binary it
# builds (Linux in the binary's job, macOS in a job of its own) and the
# install gate on the released binary.
#
# Usage: scripts/service-gate.sh <binary> <port> <second port>
#
# The machine must have no Flightdeck service installed (the script
# refuses to replace one) and nothing on either port. On Linux the user
# needs a running systemd user manager: a runner with no login session
# gets one from `sudo loginctl enable-linger "$USER"`, which the workflow
# runs. Whatever happens, the script removes the service it installed and
# its data dir before it exits.
#
# Environment:
#   SERVICE_GATE_TIMEOUT  seconds to wait for each start (default 90: a
#                         first start creates the database; launchd waits
#                         up to ten seconds before it starts a killed
#                         agent again)
set -euo pipefail

TIMEOUT="${SERVICE_GATE_TIMEOUT:-90}"
# How long one HTTP request may take: the health routes answer in
# milliseconds, five seconds is slack for a loaded runner.
REQUEST_TIMEOUT_SECS=5

say() { printf '== %s\n' "$*"; }
die() { printf 'service-gate: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 3 ]] || die "usage: scripts/service-gate.sh <binary> <port> <second port>"
BIN="$1" PORT="$2" PORT2="$3"
[[ -x "$BIN" ]] || die "$BIN is not an executable"
case "$BIN" in /*) ;; *) BIN="$PWD/$BIN" ;; esac

# The service runs what install was given, read from the flags and from
# this shell's variables: nothing the runner exports may reach it.
unset FLIGHTDECK_DATABASE_URL FLIGHTDECK_DATABASE_URL_FILE FLIGHTDECK_DATA_DIR FLIGHTDECK_LISTEN \
  FLIGHTDECK_PORT FLIGHTDECK_PUBLIC FLIGHTDECK_NATS_URL FLIGHTDECK_DOMAIN FLIGHTDECK_METRICS \
  FLIGHTDECK_ALLOWED_HOSTS

case "$(uname -s)" in
  Linux)
    OS=linux
    UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/flightdeck.service"
    # systemctl --user finds the manager through XDG_RUNTIME_DIR, which a
    # runner's shell may lack while the manager runs.
    if [[ -z "${XDG_RUNTIME_DIR:-}" && -S "/run/user/$(id -u)/bus" ]]; then
      XDG_RUNTIME_DIR="/run/user/$(id -u)"
      export XDG_RUNTIME_DIR
    fi
    ;;
  Darwin)
    OS=darwin
    UNIT="$HOME/Library/LaunchAgents/com.flightdeck-hq.flightdeck.plist"
    ;;
  *) die "flightdeck service runs on Linux and macOS, not $(uname -s)" ;;
esac
[[ ! -e "$UNIT" ]] || die "$UNIT exists: this script installs a service of its own and replaces none"

WORK="$(mktemp -d)"
DATA="$WORK/data dir \"q\" 100%"
INSTALLED=0
cleanup() {
  local status=$?
  if [[ "$INSTALLED" == 1 ]]; then
    if [[ "$status" != 0 ]]; then
      say "the service's state and log, for the failure above"
      "$BIN" service status || true
      if [[ "$OS" == linux ]]; then
        journalctl --user -u flightdeck --no-pager -n 40 || true
      else
        tail -n 40 "$DATA/flightdeck.log" 2>/dev/null || true
      fi
    fi
    "$BIN" service remove >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

healthy() { curl --max-time "$REQUEST_TIMEOUT_SECS" -sf -o /dev/null "http://127.0.0.1:$1/ingest/health"; }

# lock_pid is the process that holds the data dir: the server writes its
# PID into the lock file once it has the lock.
lock_pid() { tr -d '[:space:]' <"$DATA/flightdeck.lock" 2>/dev/null || true; }

# manager_pid is the PID the manager says the service runs as.
manager_pid() {
  if [[ "$OS" == linux ]]; then
    systemctl --user show flightdeck.service --property=MainPID --value
  else
    launchctl print "gui/$(id -u)/com.flightdeck-hq.flightdeck" 2>/dev/null | sed -n 's/^	pid = \([0-9][0-9]*\)$/\1/p'
  fi
}

# wait_serving PORT [NOT-PID]: until PORT answers from the service's own
# process (the manager's PID holds the data dir), one other than NOT-PID.
wait_serving() {
  local port="$1" not="${2:-}" deadline pid
  deadline=$((SECONDS + TIMEOUT))
  while :; do
    pid="$(manager_pid)"
    if [[ -n "$pid" && "$pid" != 0 && "$pid" != "$not" && "$(lock_pid)" == "$pid" ]] && healthy "$port"; then
      printf '%s\n' "$pid"
      return 0
    fi
    ((SECONDS < deadline)) || die "port $port did not answer from the service's process within ${TIMEOUT}s (manager pid '${pid}', lock pid '$(lock_pid)')"
    sleep 0.5
  done
}

wait_down() {
  local port="$1" deadline
  deadline=$((SECONDS + TIMEOUT))
  while healthy "$port"; do
    ((SECONDS < deadline)) || die "port $port still answers ${TIMEOUT}s after the service left it"
    sleep 0.5
  done
}

healthy "$PORT" && die "port $PORT already answers"
healthy "$PORT2" && die "port $PORT2 already answers"

say "install on port $PORT, data dir $DATA"
INSTALLED=1
out="$("$BIN" service install --port "$PORT" --data-dir "$DATA")" || die "install exited $?: $out"
printf '%s\n' "$out"
grep -q "runs: http://localhost:$PORT" <<<"$out" || die "install does not name the dashboard's address"
[[ -f "$UNIT" ]] || die "install wrote no $UNIT"
if [[ "$OS" == linux ]]; then
  if command -v systemd-analyze >/dev/null; then
    systemd-analyze --user verify "$UNIT" || die "systemd-analyze refuses $UNIT"
  fi
else
  plutil -lint "$UNIT" || die "plutil refuses $UNIT"
  [[ -f "$DATA/flightdeck.log" ]] || die "launchd writes no log to $DATA/flightdeck.log"
fi
pid="$(wait_serving "$PORT")"
say "the service runs as pid $pid"
"$BIN" service status || die "status of a running service exited $?"
"$BIN" health --port "$PORT" || die "flightdeck health finds no service on $PORT"

say "kill -9 $pid: the manager must start it again"
kill -9 "$pid"
pid2="$(wait_serving "$PORT" "$pid")"
say "started again as pid $pid2"

say "flightdeck service restart"
"$BIN" service restart || die "restart exited $?"
pid3="$(wait_serving "$PORT" "$pid2")"
say "restarted as pid $pid3"

say "a plain flightdeck on the service's data dir"
set +e
plain="$("$BIN" --port "$PORT2" --data-dir "$DATA" 2>&1)"
code=$?
set -e
[[ "$code" == 1 ]] || die "a second flightdeck on the service's data dir exited $code: $plain"
grep -qx 'flightdeck: Flightdeck is already running as a service: flightdeck service status' <<<"$plain" \
  || die "a second flightdeck does not say the service runs: $plain"

say "install again on port $PORT2: the service moves"
"$BIN" service install --port "$PORT2" --data-dir "$DATA" || die "the second install exited $?"
wait_serving "$PORT2" "$pid3" >/dev/null
wait_down "$PORT"
grep -q -- "$PORT2" "$UNIT" || die "$UNIT does not name port $PORT2"

say "remove"
"$BIN" service remove || die "remove exited $?"
INSTALLED=0
[[ ! -e "$UNIT" ]] || die "remove left $UNIT"
wait_down "$PORT2"
set +e
"$BIN" service status
code=$?
set -e
[[ "$code" == 3 ]] || die "status after remove exited $code, want 3 (not installed)"
[[ -s "$DATA/flightdeck.db" ]] || die "remove did not leave the database in the data dir"
if [[ "$OS" == linux ]]; then
  if systemctl --user list-unit-files flightdeck.service | grep -q flightdeck.service; then
    die "systemd still lists flightdeck.service after remove"
  fi
else
  if launchctl print "gui/$(id -u)/com.flightdeck-hq.flightdeck" >/dev/null 2>&1; then
    die "launchd still lists the agent after remove"
  fi
fi
say "service gate passed"
