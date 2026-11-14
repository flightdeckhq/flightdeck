#!/usr/bin/env bash
# Tests scripts/install-gate.sh itself. The gate exists to fail when an
# installed flightdeck is broken, so it is run here against a fake
# `flightdeck` that is broken in one way at a time, and each run must
# end in a failure (never a hang) that names the fault, with the fake
# stopped and the gate's temp dir removed. One fake that behaves must
# pass, restart included.
#
# Usage: scripts/test-install-gate.sh [binary]
#   binary   a real flightdeck binary (built with the dashboard bundle);
#            when given, the gate must also pass against it, on its
#            default database.
# Environment:
#   TEST_GATE_LISTEN   the address the fakes and the binary listen on
#                      (default 127.0.0.1:4390)
# Needs bash, curl, python3 (the fake is a small HTTP server) and
# timeout(1): Linux, which is where CI runs it.
set -euo pipefail

GATE="$(cd "$(dirname "$0")" && pwd)/install-gate.sh"
REAL_BIN="${1:-}"
LISTEN="${TEST_GATE_LISTEN:-127.0.0.1:4390}"
BASE="http://$LISTEN"
TMP="$(mktemp -d)"
FAKE="$TMP/bin/flightdeck"
PIDFILE="$TMP/fake.pid"
# The gate's waits, shortened: the fakes answer at once or never, so
# three seconds tells the two apart and keeps the whole test under a
# minute.
SHORT_WAIT_SECS=3
# The bound on one gate run. The slowest failing case waits
# SHORT_WAIT_SECS for readiness and then the gate's ten-second cleanup
# grace before it kills the fake; a run that reaches this bound hung,
# which is the failure this test exists to catch.
RUN_BOUND_SECS=60
# How long the stranger server and a real binary get to answer.
READY_WAIT_SECS=30

PASSED=0
STRANGER_PID=""

cleanup() {
  local pid
  if [[ -n "$STRANGER_PID" ]]; then kill -KILL "$STRANGER_PID" 2>/dev/null || true; fi
  if [[ -s "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE")"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$TMP/bin" "$TMP/work"
# The fake binary. FAKE_MODE picks its one fault; "ok" has none. It
# takes the flags the gate passes, prints a start-up block shaped like
# the binary's, keeps its sessions in the data dir so a restart finds
# them, and exits 0 on SIGINT.
cat >"$FAKE" <<'PY'
#!/usr/bin/env python3
import http.server
import json
import os
import pathlib
import signal
import sys
import time

mode = os.environ.get("FAKE_MODE", "ok")
args = sys.argv[1:]
if args == ["--version"]:
    print("flightdeck v0.0.0-fake")
    sys.exit(0)

listen = args[args.index("--listen") + 1]
data = pathlib.Path(args[args.index("--data-dir") + 1])
pidfile = os.environ.get("FAKE_PIDFILE")
if pidfile:
    pathlib.Path(pidfile).write_text(str(os.getpid()))

if mode == "exit1":
    print("flightdeck: fake start-up failure", file=sys.stderr)
    sys.exit(1)
if mode in ("deaf", "stubborn"):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
else:
    # A shell without job control starts a background command with
    # SIGINT ignored, and Python then leaves it ignored; the binary
    # handles the signal however it was started, so the fake does too.
    signal.signal(signal.SIGINT, signal.default_int_handler)
if mode == "deaf":
    # Wedged before listening, and ignoring the signal.
    while True:
        time.sleep(3600)
if mode == "usurped":
    # What the real binary does when another server takes its port as it
    # starts: the stranger answers at once, while this process is still
    # alive and has printed nothing (it is loading); only then does it
    # find the address busy and exit. FAKE_STRANGER_PIDFILE gets the
    # stranger's pid, for the test to stop it.
    import subprocess
    env = dict(os.environ, FAKE_MODE="ok", FAKE_PIDFILE=os.environ["FAKE_STRANGER_PIDFILE"])
    subprocess.Popen([sys.argv[0], "--listen", args[args.index("--listen") + 1], "--data-dir", str(data) + "-stranger"],
                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(1.5)
    print("flightdeck: listen %s: address already in use" % args[args.index("--listen") + 1], file=sys.stderr)
    sys.exit(1)

TOKEN = "tok_dev"
data.mkdir(parents=True, exist_ok=True)
(data / "flightdeck.db").touch()
store = data / "sessions"
sessions = set()
if store.exists() and mode != "amnesia":
    sessions = set(store.read_text().split())


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def answer(self, code, body, ctype="application/json"):
        raw = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authed(self):
        return mode == "open-auth" or self.headers.get("Authorization") == "Bearer " + TOKEN

    def do_GET(self):
        path = self.path
        if path in ("/ingest/health", "/api/health"):
            return self.answer(200, '{"status":"ok"}')
        if path == "/":
            return self.answer(200, "<html><head><title>Flightdeck</title></head></html>", "text/html")
        if path == "/runtime-config.json":
            return self.answer(200, '{"access_token":"%s"}' % TOKEN)
        if path.startswith("/api/v1/sessions"):
            if not self.authed():
                return self.answer(401, '{"error":"unauthorized"}')
            if path == "/api/v1/sessions":
                rows = [{"session_id": s} for s in sorted(sessions)]
                return self.answer(200, json.dumps({"sessions": rows}, separators=(",", ":")))
            sid = path.rsplit("/", 1)[1]
            if sid in sessions and mode != "no-session":
                return self.answer(200, json.dumps({"session_id": sid}, separators=(",", ":")))
        return self.answer(404, '{"error":"not found"}')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path != "/ingest/v1/events":
            return self.answer(404, '{"error":"not found"}')
        if not self.authed():
            return self.answer(401, '{"error":"unauthorized"}')
        sid = json.loads(body).get("session_id")
        if not sid:
            return self.answer(400, '{"error":"session_id"}')
        sessions.add(sid)
        if mode != "amnesia":
            store.write_text("\n".join(sorted(sessions)))
        return self.answer(200, '{"status":"ok"}')


host, port = listen.rsplit(":", 1)
try:
    server = http.server.ThreadingHTTPServer((host, int(port)), Handler)
except OSError as err:
    print("flightdeck: listen %s: %s" % (listen, err), file=sys.stderr)
    sys.exit(1)

if mode == "wide-dir":
    print("WARN data dir %s has mode 0755; it holds the database, the message-bus store "
          "and secrets.json and should be 0700 (chmod 700 %s)" % (data, data))
backend = "Postgres" if mode == "wrong-db" else "SQLite"
print("\nFlightdeck v0.0.0-fake\n")
print("  Dashboard   http://%s" % listen)
print("  Token       %s   (development token: the server listens on loopback only)" % TOKEN)
print("  Data dir    %s" % data)
print("  Database    %s   (%s)" % (data / "flightdeck.db", backend))
print("\nPress Ctrl+C to stop.\n", flush=True)

try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
sys.exit(3 if mode == "bad-exit" else 0)
PY
chmod +x "$FAKE"

# gate MODE [ENV=VALUE...] runs the gate against the fake in MODE, under
# the bound, and leaves its exit status in RC and its output in OUT.
gate() {
  local mode="$1"; shift
  : >"$PIDFILE"
  set +e
  OUT="$(env FAKE_MODE="$mode" FAKE_PIDFILE="$PIDFILE" TMPDIR="$TMP/work" \
    GATE_READY_TIMEOUT="$SHORT_WAIT_SECS" GATE_STORE_TIMEOUT="$SHORT_WAIT_SECS" GATE_STOP_TIMEOUT="$SHORT_WAIT_SECS" \
    "$@" timeout "$RUN_BOUND_SECS" "$GATE" run "$LISTEN" "$FAKE" 2>&1)"
  RC=$?
  set -e
}

# left_clean NAME: whatever the gate's outcome, the fake is gone and
# the gate's temp dir is removed.
left_clean() {
  local name="$1" pid
  if [[ -s "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      fail "$name: the gate left the fake binary running (pid $pid)"
    fi
  fi
  if [[ -n "$(ls -A "$TMP/work")" ]]; then
    fail "$name: the gate left its temp dir behind: $(ls -A "$TMP/work")"
  fi
}

# expect_fail NAME MODE PATTERN [ENV=VALUE...]: the gate fails with
# status 1 (its own, not the cleanup's and not the bound's) and says
# PATTERN.
expect_fail() {
  local name="$1" mode="$2" pattern="$3"; shift 3
  gate "$mode" "$@"
  if [[ "$RC" == 124 || "$RC" == 137 ]]; then
    printf '%s\n' "$OUT" >&2
    fail "$name: the gate hung and was stopped by the ${RUN_BOUND_SECS}s bound"
  fi
  if [[ "$RC" != 1 ]]; then
    printf '%s\n' "$OUT" >&2
    fail "$name: the gate exited $RC, want 1"
  fi
  if ! grep -qE -e "$pattern" <<<"$OUT"; then
    printf '%s\n' "$OUT" >&2
    fail "$name: the failure does not say /$pattern/"
  fi
  left_clean "$name"
  PASSED=$((PASSED + 1))
  printf '  ok: %s\n' "$name"
}

echo "-- a fake that behaves passes, restart included"
gate ok
if [[ "$RC" != 0 ]]; then printf '%s\n' "$OUT" >&2; fail "the gate exited $RC against the well-behaved fake"; fi
grep -q 'still served after the restart' <<<"$OUT" || { printf '%s\n' "$OUT" >&2; fail "the gate passed without the restart check"; }
grep -q 'requests without the token are refused' <<<"$OUT" || { printf '%s\n' "$OUT" >&2; fail "the gate passed without the auth check"; }
grep -qx 'GATE OK (SQLite)' <<<"$OUT" || { printf '%s\n' "$OUT" >&2; fail "no GATE OK line"; }
left_clean "well-behaved fake"
PASSED=$((PASSED + 1))
echo "  ok: GATE OK (SQLite)"

echo "-- each fault fails the gate, within the bound"
expect_fail "a binary that exits at once" exit1 'install-gate: not ready'
expect_fail "a binary that never listens and ignores SIGINT" deaf 'install-gate: not ready'
expect_fail "a server that accepts the event and never serves the session" no-session 'not served within'
expect_fail "a server that needs no token" open-auth 'with no token answered 200, want 401'
expect_fail "a binary that ignores SIGINT once it serves" stubborn 'after SIGINT and had to be killed'
expect_fail "a binary that exits non-zero on SIGINT" bad-exit 'exited 3 on SIGINT'
expect_fail "a server that forgets the session over a restart" amnesia 'after the restart'
expect_fail "a start-up block that names another database" wrong-db 'want a SQLite database'
expect_fail "a data-dir mode warning" wide-dir 'wider than 0700'
expect_fail "a --version that is not the expected one" ok "--version printed 'flightdeck v0.0.0-fake'" GATE_EXPECT_VERSION=v9.9.9

echo "-- a server that takes the port as the binary starts is not mistaken for it"
STRANGER_PIDFILE="$TMP/stranger-usurper.pid"
expect_fail "a stranger that answers while the binary is still loading" usurped \
  'the binary started here has exited: something else is on that port' FAKE_STRANGER_PIDFILE="$STRANGER_PIDFILE"
if [[ -s "$STRANGER_PIDFILE" ]]; then
  kill -INT "$(cat "$STRANGER_PIDFILE")" 2>/dev/null || true
  deadline=$((SECONDS + READY_WAIT_SECS))
  while curl --max-time 2 -s -o /dev/null "$BASE/ingest/health"; do
    ((SECONDS < deadline)) || fail "the usurping stranger did not stop"
    sleep 0.2
  done
fi

echo "-- a server already on the port is not mistaken for the binary"
FAKE_MODE=ok "$FAKE" --listen "$LISTEN" --data-dir "$TMP/stranger" >"$TMP/stranger.log" 2>&1 &
STRANGER_PID=$!
deadline=$((SECONDS + READY_WAIT_SECS))
until curl --max-time 2 -sf -o /dev/null "$BASE/ingest/health"; do
  ((SECONDS < deadline)) || fail "the stranger server did not start: $(cat "$TMP/stranger.log")"
  sleep 0.2
done
expect_fail "a stranger on the port" ok 'already answers'
kill -INT "$STRANGER_PID"
wait "$STRANGER_PID" || fail "the stranger server exited non-zero"
STRANGER_PID=""

if [[ -n "$REAL_BIN" ]]; then
  echo "-- the real binary passes"
  set +e
  OUT="$(TMPDIR="$TMP/work" timeout "$((RUN_BOUND_SECS * 3))" "$GATE" run "$LISTEN" "$REAL_BIN" 2>&1)"
  RC=$?
  set -e
  if [[ "$RC" != 0 ]]; then printf '%s\n' "$OUT" >&2; fail "the gate exited $RC against $REAL_BIN"; fi
  grep -qx 'GATE OK (SQLite)' <<<"$OUT" || { printf '%s\n' "$OUT" >&2; fail "no GATE OK line for $REAL_BIN"; }
  : >"$PIDFILE"
  left_clean "real binary"
  PASSED=$((PASSED + 1))
  echo "  ok: GATE OK (SQLite) for $REAL_BIN"
fi

echo "INSTALL GATE TESTS OK ($PASSED cases)"
