#!/usr/bin/env bash
# install.sh with the background service, against the system's real
# service manager (the systemd user manager on Linux, launchd on macOS):
# the two builds given are served as two releases on loopback; install.sh
# installs the first with FLIGHTDECK_SERVICE=yes on a port and a data dir
# of its own, and the service must answer from the installed binary; a
# re-run with the second release must stop the service, replace the
# binary and start it again, so the process the data dir's lock names is
# a new one whose executable is the file now installed, not the one it
# replaced (/proc/<pid>/exe on Linux; the inode lsof shows on macOS),
# with the service's port and data dir as they were. The service is
# removed at the end. CI runs it on the binary it builds, on Linux in the
# binary's job and on macOS in the service job.
#
# Usage: scripts/installer-service-gate.sh <binary> <second binary> <port>
#
# The two binaries must print different versions (`--version`). The
# machine must have no Flightdeck service installed and nothing on the
# port; on Linux the user needs a running systemd user manager (see
# scripts/service-gate.sh). The binary and the data dir go under
# $HOME/.cache, since the service refuses a binary in the temporary
# directory; whatever happens, the script removes the service and that
# directory before it exits.
#
# Environment:
#   INSTALLER_GATE_TIMEOUT  seconds to wait for the service to answer
#                           (default 90: a first start creates the
#                           database)
set -euo pipefail

TIMEOUT="${INSTALLER_GATE_TIMEOUT:-90}"
# How long one HTTP request may take: the health routes answer in
# milliseconds, five seconds is slack for a loaded runner.
REQUEST_TIMEOUT_SECS=5

say() { printf '== %s\n' "$*"; }
die() { printf 'installer-service-gate: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 3 ]] || die "usage: scripts/installer-service-gate.sh <binary> <second binary> <port>"
FIRST="$1" SECOND="$2" PORT="$3"
[[ -x "$FIRST" && -x "$SECOND" ]] || die "both binaries must be executables"
V1="$("$FIRST" --version)" V2="$("$SECOND" --version)"
[[ "$V1" != "$V2" ]] || die "the two binaries print the same version ($V1)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "Linux and macOS only" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
"$FIRST" service status >/dev/null 2>&1 && status=0 || status=$?
[[ "$status" -eq 3 ]] || die "a Flightdeck service is installed already, or this system cannot run one (flightdeck service status exits $status): this gate installs its own"
if curl -s -o /dev/null --max-time "$REQUEST_TIMEOUT_SECS" "http://127.0.0.1:$PORT/"; then die "something answers on port $PORT"; fi

mkdir -p "$HOME/.cache"
BASE="$(mktemp -d "$HOME/.cache/flightdeck-installer-gate.XXXXXX")"
BIN_DIR="$BASE/bin"
DATA="$BASE/data dir"
BIN="$BIN_DIR/flightdeck"
HTTP_PID=""
cleanup() {
  status=$?
  if [[ -x "$BIN" ]]; then "$BIN" service remove >/dev/null 2>&1 || true; fi
  if [[ -n "$HTTP_PID" ]]; then kill "$HTTP_PID" 2>/dev/null || true; fi
  rm -rf "$BASE"
  exit "$status"
}
trap cleanup EXIT

say "two releases on loopback: v0.0.1-gate ($V1) and v0.0.2-gate ($V2)"
for pair in "v0.0.1-gate:$FIRST" "v0.0.2-gate:$SECOND"; do
  tag="${pair%%:*}" src="${pair#*:}"
  dir="$BASE/release/releases/download/$tag"
  mkdir -p "$dir" "$BASE/stage-$tag"
  cp "$src" "$BASE/stage-$tag/flightdeck"
  asset="flightdeck_${OS}_${ARCH}.tar.gz"
  tar -czf "$dir/$asset" -C "$BASE/stage-$tag" flightdeck
  if command -v sha256sum >/dev/null; then sum="$(sha256sum "$dir/$asset" | cut -d' ' -f1)"; else sum="$(shasum -a 256 "$dir/$asset" | cut -d' ' -f1)"; fi
  echo "$sum  $asset" >"$dir/checksums.txt"
done
python3 -u -m http.server 0 --bind 127.0.0.1 -d "$BASE/release" >"$BASE/http.log" 2>&1 &
HTTP_PID=$!
HTTP_PORT=""
for _ in $(seq 1 40); do
  HTTP_PORT="$(sed -n 's/.* port \([0-9][0-9]*\).*/\1/p' "$BASE/http.log" | head -1)"
  [[ -n "$HTTP_PORT" ]] && break
  sleep 0.25
done
[[ -n "$HTTP_PORT" ]] || { cat "$BASE/http.log"; die "the release server did not start"; }

# run_installer TAG LOG: the repository's install.sh read from sh's stdin,
# as `curl | sh` runs it, with the service accepted, on this gate's port
# and data dir.
run_installer() {
  env FLIGHTDECK_RELEASE_URL="http://127.0.0.1:$HTTP_PORT" VERSION="$1" INSTALL_DIR="$BIN_DIR" \
    FLIGHTDECK_SERVICE=yes FLIGHTDECK_CONNECT=none FLIGHTDECK_PORT="$PORT" FLIGHTDECK_DATA_DIR="$DATA" \
    sh <"$ROOT/install.sh" >"$2" 2>&1 || { cat "$2"; die "install.sh $1 failed"; }
  cat "$2"
}

# serving_pid: once the service answers its health routes, the PID the
# data dir's lock file names.
serving_pid() {
  local deadline=$((SECONDS + TIMEOUT))
  while ((SECONDS < deadline)); do
    if curl -fsS -o /dev/null --max-time "$REQUEST_TIMEOUT_SECS" "http://127.0.0.1:$PORT/api/health" &&
      curl -fsS -o /dev/null --max-time "$REQUEST_TIMEOUT_SECS" "http://127.0.0.1:$PORT/ingest/health"; then
      local pid
      pid="$(tr -d '[:space:]' <"$DATA/flightdeck.lock" 2>/dev/null || true)"
      if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; return 0; fi
    fi
    sleep 0.5
  done
  return 1
}

# runs_installed PID: the process PID runs the file installed at $BIN now,
# not a file the installer replaced.
runs_installed() {
  case "$OS" in
    linux)
      [[ "$(readlink "/proc/$1/exe")" == "$BIN" ]] && [[ "$(stat -L -c %i "/proc/$1/exe")" == "$(stat -c %i "$BIN")" ]] ;;
    darwin)
      lsof -a -p "$1" -d txt -Fi 2>/dev/null | sed -n 's/^i//p' | grep -qx "$(stat -f %i "$BIN")" ;;
  esac
}

say "install.sh v0.0.1-gate with FLIGHTDECK_SERVICE=yes, port $PORT, data dir $DATA"
run_installer v0.0.1-gate "$BASE/install1.log"
grep -q 'The Flightdeck service is installed and runs' "$BASE/install1.log" || die "the installer did not install the service"
grep -q 'Next: open the address above. Flightdeck runs in the background' "$BASE/install1.log" || die "the closing line does not say the service runs"
PID1="$(serving_pid)" || die "the service did not answer on port $PORT within ${TIMEOUT}s"
runs_installed "$PID1" || die "the serving process $PID1 does not run $BIN"
say "the service answers on $PORT from pid $PID1, which runs $BIN ($("$BIN" --version))"

say "install.sh v0.0.2-gate again: the upgrade"
run_installer v0.0.2-gate "$BASE/install2.log"
grep -q 'Stopping the Flightdeck service to replace the binary it runs' "$BASE/install2.log" || die "the re-run did not stop the service"
grep -q 'The Flightdeck service restarted and runs' "$BASE/install2.log" || die "the re-run did not restart the service"
[[ "$("$BIN" --version)" == "$V2" ]] || die "the installed binary is not the second release"
PID2="$(serving_pid)" || die "the service did not answer on port $PORT after the upgrade"
[[ "$PID2" != "$PID1" ]] || die "the same process ($PID1) still serves: the service was not restarted"
if kill -0 "$PID1" 2>/dev/null; then die "the first process ($PID1) still runs"; fi
runs_installed "$PID2" || die "the serving process $PID2 does not run the binary now installed at $BIN"
"$BIN" service status >"$BASE/status.log" 2>&1 || { cat "$BASE/status.log"; die "flightdeck service status after the upgrade"; }
cat "$BASE/status.log"
grep -q -- "--port $PORT" "$BASE/status.log" || die "the service lost its port"
grep -qF -- "$DATA" "$BASE/status.log" || die "the service lost its data dir"
say "pid $PID1 is gone; pid $PID2 serves, running $BIN ($V2), with its port and data dir"

say "remove"
"$BIN" service remove
"$BIN" service status >/dev/null 2>&1 && status=0 || status=$?
[[ "$status" -eq 3 ]] || die "flightdeck service status exits $status after remove, not 3 (not installed)"
if [[ "$OS" == linux ]] && systemctl --user list-unit-files 2>/dev/null | grep -qi flightdeck; then
  die "systemctl --user list-unit-files still lists a flightdeck unit"
fi
say "INSTALLER SERVICE GATE OK ($OS)"
