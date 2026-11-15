#!/usr/bin/env bash
# Tests install.sh end to end against a local HTTP server that mirrors
# the GitHub release layout (releases/latest/download/<asset> and
# releases/download/<tag>/<asset>, checksums.txt beside them), with a
# fake `flightdeck` (a shell script that prints a version) in the
# archives, so no release and no Go build is needed. CI runs it; locally:
#   scripts/test-install-sh.sh
# Needs bash, python3 (the server, and the pseudo-terminal the connect
# question is answered on), curl, tar and sha256sum or shasum.
#
# The fake binary also answers `flightdeck connect`, the command the
# installer offers once it has installed the binary: `connect --detected`
# prints $FAKE_FLIGHTDECK_DETECTED (with \t for tabs) and every connect
# call is appended to $FAKE_FLIGHTDECK_LOG with the number of bytes it
# could read on stdin; FAKE_FLIGHTDECK_CONNECT_EXIT is the exit status of
# a connect, and FAKE_FLIGHTDECK_NO_CONNECT makes it an older release
# that does not know the command.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$ROOT/install.sh"
WORK="$(mktemp -d)"
FAKE="$WORK/release"
PORT="${TEST_INSTALL_PORT:-8765}"
TAG=v0.0.1-test
cleanup() {
  if [[ -n "${HTTP_PID:-}" ]]; then kill "$HTTP_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# One archive per platform the installer can ask for, each holding a
# fake binary that prints the tag; checksums.txt over all of them.
build_release() {
  local dir="$1"
  mkdir -p "$dir"
  : >"$dir/checksums.txt"
  for target in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64; do
    local stage="$WORK/stage-$target"
    mkdir -p "$stage"
    cat >"$stage/flightdeck" <<FAKE
#!/bin/sh
if [ "\${1:-}" = connect ]; then
  shift
  if [ -n "\${FAKE_FLIGHTDECK_NO_CONNECT:-}" ]; then echo "flag provided but not defined" >&2; exit 2; fi
  [ -z "\${FAKE_FLIGHTDECK_LOG:-}" ] || printf 'connect %s (stdin %s bytes)\n' "\$*" "\$(wc -c | tr -d ' ')" >>"\$FAKE_FLIGHTDECK_LOG"
  if [ "\${1:-}" = --detected ]; then printf '%b' "\${FAKE_FLIGHTDECK_DETECTED:-}"; exit 0; fi
  echo "fake flightdeck: connect \$*"
  exit "\${FAKE_FLIGHTDECK_CONNECT_EXIT:-0}"
fi
echo "flightdeck $TAG ($target)"
FAKE
    chmod 0755 "$stage/flightdeck"
    tar -czf "$dir/flightdeck_$target.tar.gz" -C "$stage" flightdeck
    echo "$(sha256 "$dir/flightdeck_$target.tar.gz")  flightdeck_$target.tar.gz" >>"$dir/checksums.txt"
  done
}

build_release "$FAKE/releases/latest/download"
mkdir -p "$FAKE/releases/download"
cp -R "$FAKE/releases/latest/download" "$FAKE/releases/download/$TAG"
# A tampered release: the archive no longer matches its checksum entry.
cp -R "$FAKE/releases/latest/download" "$FAKE/releases/download/v0.0.1-bad"
printf 'x' >>"$FAKE/releases/download/v0.0.1-bad/flightdeck_linux_amd64.tar.gz"
printf 'x' >>"$FAKE/releases/download/v0.0.1-bad/flightdeck_darwin_arm64.tar.gz"
# A release whose checksums.txt forgot an asset.
cp -R "$FAKE/releases/latest/download" "$FAKE/releases/download/v0.0.1-noentry"
grep -v 'flightdeck_linux_amd64\|flightdeck_darwin_arm64' "$FAKE/releases/latest/download/checksums.txt" >"$FAKE/releases/download/v0.0.1-noentry/checksums.txt"
# The script itself, served for the piped case as the project's site and raw.githubusercontent.com serve it.
cp "$INSTALL_SH" "$FAKE/install.sh"

python3 -m http.server "$PORT" --bind 127.0.0.1 -d "$FAKE" >"$WORK/http.log" 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/releases/latest/download/checksums.txt" && break
  sleep 0.25
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/releases/latest/download/checksums.txt" || { echo "local server did not start"; cat "$WORK/http.log"; exit 1; }

export FLIGHTDECK_RELEASE_URL="http://127.0.0.1:$PORT"
pass() { printf '  ok: %s\n' "$*"; }
expect_fail() {
  # expect_fail <description> <grep pattern> -- <command...>
  local desc="$1" pattern="$2"; shift 3
  local out
  if out="$("$@" 2>&1)"; then
    printf 'FAIL: %s succeeded:\n%s\n' "$desc" "$out"; exit 1
  fi
  grep -q -- "$pattern" <<<"$out" || { printf 'FAIL: %s failed for another reason:\n%s\n' "$desc" "$out"; exit 1; }
  pass "$desc"
}

echo "== install.sh against http://127.0.0.1:$PORT"

echo "-- latest, INSTALL_DIR, piped (curl | sh)"
curl -fsSL "http://127.0.0.1:$PORT/install.sh" | INSTALL_DIR="$WORK/inst1" sh >"$WORK/out1" 2>&1 || { cat "$WORK/out1"; exit 1; }
grep -q 'Checksum verified' "$WORK/out1"
grep -q 'Signature of checksums.txt not checked: FLIGHTDECK_RELEASE_URL' "$WORK/out1"
test -x "$WORK/inst1/flightdeck"
"$WORK/inst1/flightdeck" --version | grep -q "^flightdeck $TAG"
pass "installed the latest release into INSTALL_DIR"

echo "-- VERSION without the v prefix"
VERSION="${TAG#v}" INSTALL_DIR="$WORK/inst2" sh "$INSTALL_SH" >"$WORK/out2" 2>&1 || { cat "$WORK/out2"; exit 1; }
grep -q "releases/download/$TAG/" "$WORK/out2"
"$WORK/inst2/flightdeck" --version | grep -q "^flightdeck $TAG"
pass "VERSION override"

echo "-- /usr/local/bin not writable: ~/.local/bin, PATH hint"
if [[ -w /usr/local/bin ]]; then
  echo "  skip: /usr/local/bin is writable here, the fallback cannot be forced"
else
  HOME="$WORK/home" sh "$INSTALL_SH" >"$WORK/out3" 2>&1 || { cat "$WORK/out3"; exit 1; }
  test -x "$WORK/home/.local/bin/flightdeck"
  grep -q 'is not on your PATH' "$WORK/out3"
  pass "fell back to ~/.local/bin and printed the PATH hint"
fi

echo "-- GITHUB_PATH"
: >"$WORK/gh_path"
GITHUB_PATH="$WORK/gh_path" INSTALL_DIR="$WORK/inst4" sh "$INSTALL_SH" >/dev/null 2>&1
grep -qx "$WORK/inst4" "$WORK/gh_path"
pass "appended INSTALL_DIR to GITHUB_PATH"

echo "-- refusals"
expect_fail "tampered archive" "checksum mismatch" -- env VERSION=v0.0.1-bad INSTALL_DIR="$WORK/inst5" sh "$INSTALL_SH"
test ! -e "$WORK/inst5/flightdeck"
expect_fail "missing checksums entry" "has no entry for" -- env VERSION=v0.0.1-noentry INSTALL_DIR="$WORK/inst6" sh "$INSTALL_SH"
expect_fail "unknown version" "404" -- env VERSION=v9.9.9 INSTALL_DIR="$WORK/inst7" sh "$INSTALL_SH"
expect_fail "plain HTTP to a non-local host" "must be https://" -- env FLIGHTDECK_RELEASE_URL=http://example.com INSTALL_DIR="$WORK/inst8" sh "$INSTALL_SH"
# The localhost exception is on the parsed authority: user info that
# makes "localhost" a user name of another host is refused, as is a
# host that merely starts with localhost or a non-numeric port.
expect_fail "user-info trick on the localhost exception" "may not carry user info" -- env FLIGHTDECK_RELEASE_URL="http://localhost:x@example.com/" INSTALL_DIR="$WORK/inst8" sh "$INSTALL_SH"
expect_fail "user-info trick with 127.0.0.1" "may not carry user info" -- env FLIGHTDECK_RELEASE_URL="http://127.0.0.1@example.com:$PORT" INSTALL_DIR="$WORK/inst8" sh "$INSTALL_SH"
expect_fail "a host that starts with localhost" "localhost, 127.0.0.1 or" -- env FLIGHTDECK_RELEASE_URL="http://localhost.example.com:$PORT" INSTALL_DIR="$WORK/inst8" sh "$INSTALL_SH"
expect_fail "a non-numeric port" "port must be digits" -- env FLIGHTDECK_RELEASE_URL="http://localhost:80a" INSTALL_DIR="$WORK/inst8" sh "$INSTALL_SH"
test ! -e "$WORK/inst8/flightdeck"
# An unsupported CPU: a fake uname ahead on PATH.
mkdir -p "$WORK/fakebin"
# shellcheck disable=SC2016  # the $1 and $@ are the fake uname's own
printf '#!/bin/sh\ncase "$1" in -m) echo mips64 ;; *) exec /usr/bin/uname "$@" ;; esac\n' >"$WORK/fakebin/uname"
chmod 0755 "$WORK/fakebin/uname"
expect_fail "unsupported CPU" "unsupported CPU architecture: mips64" -- env PATH="$WORK/fakebin:$PATH" INSTALL_DIR="$WORK/inst9" sh "$INSTALL_SH"
expect_fail "unwritable INSTALL_DIR" "cannot" -- env INSTALL_DIR=/proc/flightdeck-cannot-exist sh "$INSTALL_SH"

echo "-- signature check with a fake cosign"
# A cosign stand-in: it checks the identity regex and issuer the
# installer must pass, prints "Verified OK" on stderr as cosign does, and
# accepts the bundle only when it reads GOOD. FLIGHTDECK_RELEASE_SIGNED_URL
# points the signature check at the local server.
mkdir -p "$WORK/fakecosign"
cat >"$WORK/fakecosign/cosign" <<'FAKE'
#!/bin/sh
expected_re='^https://github\.com/flightdeckhq/flightdeck/\.github/workflows/.+@refs/tags/v.+$'
expected_issuer='https://token.actions.githubusercontent.com'
[ "$1" = verify-blob ] || { echo "fake cosign: not verify-blob" >&2; exit 2; }
bundle=; re=; issuer=
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) bundle="$2"; shift ;;
    --certificate-identity-regexp) re="$2"; shift ;;
    --certificate-oidc-issuer) issuer="$2"; shift ;;
  esac
  shift
done
[ "$re" = "$expected_re" ] || { echo "fake cosign: identity regexp not applied: $re" >&2; exit 2; }
[ "$issuer" = "$expected_issuer" ] || { echo "fake cosign: issuer not applied: $issuer" >&2; exit 2; }
if [ "$(cat "$bundle")" = GOOD ]; then echo "Verified OK" >&2; exit 0; fi
echo "Error: verifying blob: signature mismatch" >&2
exit 1
FAKE
chmod 0755 "$WORK/fakecosign/cosign"
echo GOOD >"$FAKE/releases/latest/download/checksums.txt.sigstore.json"
echo GOOD >"$FAKE/releases/download/$TAG/checksums.txt.sigstore.json"
echo BAD >"$FAKE/releases/download/v0.0.1-bad/checksums.txt.sigstore.json"
SIGNED="FLIGHTDECK_RELEASE_SIGNED_URL=$FLIGHTDECK_RELEASE_URL"
env "$SIGNED" PATH="$WORK/fakecosign:$PATH" INSTALL_DIR="$WORK/inst10" sh "$INSTALL_SH" >"$WORK/out10" 2>&1 || { cat "$WORK/out10"; exit 1; }
grep -q 'Signature of checksums.txt verified (Sigstore)' "$WORK/out10"
"$WORK/inst10/flightdeck" --version | grep -q "^flightdeck $TAG"
pass "a good signature with the expected identity regex and issuer installs"
expect_fail "a bad signature aborts the install" "is not signed by the flightdeckhq/flightdeck release workflow" \
  -- env "$SIGNED" PATH="$WORK/fakecosign:$PATH" VERSION=v0.0.1-bad INSTALL_DIR="$WORK/inst11" sh "$INSTALL_SH"
test ! -e "$WORK/inst11/flightdeck"
expect_fail "a missing bundle aborts the install" "404" \
  -- env "$SIGNED" PATH="$WORK/fakecosign:$PATH" VERSION=v0.0.1-noentry INSTALL_DIR="$WORK/inst12" sh "$INSTALL_SH"
# Without cosign on PATH the same signed URL installs and says the
# signature was not checked. The PATH is a directory holding only the
# tools the installer runs, so a cosign the machine has (in /usr/bin on
# some runners) cannot be found.
mkdir -p "$WORK/nocosign"
for tool in sh uname curl wget sha256sum shasum openssl cut grep sed tar gzip mktemp rm mkdir install cp chmod sysctl; do
  if tool_path="$(command -v "$tool")"; then ln -s "$tool_path" "$WORK/nocosign/$tool"; fi
done
test ! -e "$WORK/nocosign/cosign"
env "$SIGNED" PATH="$WORK/nocosign" INSTALL_DIR="$WORK/inst13" sh "$INSTALL_SH" >"$WORK/out13" 2>&1 || { cat "$WORK/out13"; exit 1; }
grep -q 'not checked: cosign is not installed' "$WORK/out13"
"$WORK/inst13/flightdeck" --version | grep -q "^flightdeck $TAG"
pass "without cosign the installer says the signature was not checked"

echo "-- the default repository is always signature-checked"
# FLIGHTDECK_RELEASE_SIGNED_URL adds a URL to check; it cannot take the
# check away from the default repository. A curl stand-in serves the
# default repository's URLs from the tampered local release (bundle BAD),
# so an installer that skipped the signature would stop at the checksum
# instead.
mkdir -p "$WORK/fakecurl"
cat >"$WORK/fakecurl/curl" <<'FAKE'
#!/bin/sh
dest=
while [ $# -gt 1 ]; do
  case "$1" in -o) dest="$2"; shift ;; esac
  shift
done
case "$1" in
  https://github.com/flightdeckhq/flightdeck/*) cp "$FAKE_RELEASE_ROOT/${1#https://github.com/flightdeckhq/flightdeck/}" "$dest" ;;
  *) echo "fake curl: unexpected URL $1" >&2; exit 22 ;;
esac
FAKE
chmod 0755 "$WORK/fakecurl/curl"
expect_fail "a bad signature on the default repository aborts, whatever the signed-URL hook says" "is not signed by the flightdeckhq/flightdeck release workflow" \
  -- env -u FLIGHTDECK_RELEASE_URL FLIGHTDECK_RELEASE_SIGNED_URL="http://127.0.0.1:$PORT" FAKE_RELEASE_ROOT="$FAKE" \
  PATH="$WORK/fakecurl:$WORK/fakecosign:$PATH" VERSION=v0.0.1-bad INSTALL_DIR="$WORK/inst14" sh "$INSTALL_SH"
test ! -e "$WORK/inst14/flightdeck"

echo "-- connecting coding agents"
# The installer asks through /dev/tty. Runs without a terminal get a new
# session with none (setsid), whatever this script was started from; the
# question is answered on a pseudo-terminal that a small Python driver
# holds, with the script piped into sh as users run it, so stdin is the
# pipe and only /dev/tty is the terminal.
# How long one run on the pseudo-terminal may take: an install from the
# local server takes a second; past this the run has hung on a question.
PTY_TIMEOUT_SECS=60
cat >"$WORK/pty_answer.py" <<'PY'
# pty_answer.py ANSWER TIMEOUT COMMAND...: runs COMMAND with a new
# pseudo-terminal as its controlling terminal, types ANSWER and Enter at
# the first "[Y/n]" it prints, and exits with COMMAND's status after
# printing everything it wrote.
import os, pty, select, sys, time
answer, timeout, cmd = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out, answered, deadline = b"", False, time.monotonic() + timeout
while True:
    left = deadline - time.monotonic()
    if left <= 0:
        os.kill(pid, 9)
        sys.stdout.write(out.decode(errors="replace") + "\npty_answer: timed out\n")
        sys.exit(124)
    ready, _, _ = select.select([fd], [], [], left)
    if not ready:
        continue
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if not answered and b"[Y/n]" in out:
        os.write(fd, answer.encode() + b"\n")
        answered = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
PY
no_tty() { setsid -w "$@"; }
CLAUDE_LINE='claude-code\tnot-connected\tClaude Code\n'
export FAKE_FLIGHTDECK_LOG="$WORK/connect.log"
connect_run() {
  # connect_run <name> <env...>: install.sh piped into sh with no
  # terminal; output in $WORK/<name>.out, connect calls in the log.
  local name="$1"; shift
  : >"$FAKE_FLIGHTDECK_LOG"
  curl -fsSL "http://127.0.0.1:$PORT/install.sh" |
    no_tty env INSTALL_DIR="$WORK/inst-$name" "$@" sh >"$WORK/$name.out" 2>&1 || { cat "$WORK/$name.out"; echo "FAIL: $name: the install failed"; exit 1; }
}
must() {
  # must <file> <grep -F text> <what it proves>
  grep -qF -- "$2" "$1" || { printf 'FAIL: %s: no "%s" in %s:\n' "$3" "$2" "$1"; cat "$1"; echo "-- connect log:"; cat "$FAKE_FLIGHTDECK_LOG"; exit 1; }
}
must_not() {
  if grep -qF -- "$2" "$1"; then printf 'FAIL: %s: "%s" in %s:\n' "$3" "$2" "$1"; cat "$1"; exit 1; fi
}

connect_run quiet FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE"
must "$WORK/quiet.out" 'To connect Claude Code: flightdeck connect claude-code' "no terminal: the command is printed"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "no terminal: nothing is connected"
must_not "$WORK/quiet.out" '[Y/n]' "no terminal: nothing is asked"
pass "without a terminal the installer prints the command and connects nothing"

connect_run named FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT=claude-code
must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes (stdin 0 bytes)' "FLIGHTDECK_CONNECT=claude-code connects it, its stdin empty"
must "$WORK/named.out" 'fake flightdeck: connect claude-code --yes' "the connect's own output is shown"
must_not "$WORK/named.out" 'To connect Claude Code' "a connected agent gets no hint"
# The script run by path with input waiting on its stdin (typed ahead,
# or a pipe): the connect must not read it.
: >"$FAKE_FLIGHTDECK_LOG"
printf 'typed ahead\n' | no_tty env INSTALL_DIR="$WORK/inst-named2" FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT=claude-code \
  sh "$INSTALL_SH" >"$WORK/named2.out" 2>&1 || { cat "$WORK/named2.out"; exit 1; }
must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes (stdin 0 bytes)' "the connect reads nothing of the installer's stdin"
pass "FLIGHTDECK_CONNECT=claude-code connects it without asking, with nothing on its stdin"

connect_run all FAKE_FLIGHTDECK_DETECTED='claude-code\tconnected\tClaude Code\nother-agent\tnot-connected\tOther Agent\tsome later field\n' FLIGHTDECK_CONNECT=all
must "$FAKE_FLIGHTDECK_LOG" 'connect other-agent --yes' "all connects every agent not connected"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "all leaves a connected agent alone"
must "$WORK/all.out" 'Claude Code is already connected to Flightdeck.' "a connected agent is reported"
pass "FLIGHTDECK_CONNECT=all connects the agents not connected yet and reads only the first three fields"

connect_run none FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT=none
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "none connects nothing"
must "$WORK/none.out" 'To connect Claude Code: flightdeck connect claude-code' "none prints the command"
pass "FLIGHTDECK_CONNECT=none connects nothing and prints the command"

connect_run failed FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT=claude-code FAKE_FLIGHTDECK_CONNECT_EXIT=1
test -x "$WORK/inst-failed/flightdeck"
must "$WORK/failed.out" 'Connecting Claude Code did not finish (see above); run it again later: flightdeck connect claude-code' "a failed connect says how to retry"
must "$WORK/failed.out" "run \`flightdeck\` and open the URL it prints" "the install carries on after a failed connect"
pass "a connect that fails does not fail the install"

connect_run unknown FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT='claude-code, no-such-agent' FAKE_FLIGHTDECK_CONNECT_EXIT=2
must "$FAKE_FLIGHTDECK_LOG" 'connect no-such-agent --yes' "every listed id is tried"
must "$WORK/unknown.out" 'run it again later: flightdeck connect no-such-agent' "an id the binary refuses is reported"
pass "a list with spaces and an unknown id: each is tried, the install succeeds"

connect_run nothing
must "$WORK/nothing.out" 'To connect a coding agent later: flightdeck connect (it lists the agents it can connect)' "no agent found"
pass "with no agent found the closing lines name flightdeck connect"

connect_run older FAKE_FLIGHTDECK_NO_CONNECT=1 FLIGHTDECK_CONNECT=claude-code
must_not "$WORK/older.out" 'connect' "an older binary: no connect line"
must "$WORK/older.out" "run \`flightdeck\` and open the URL it prints" "an older binary installs as before"
pass "a binary that does not know connect (an older VERSION) skips the step"

for answer in y '' n nope; do
  : >"$FAKE_FLIGHTDECK_LOG"
  rm -rf "$WORK/inst-pty"
  out="$WORK/pty.out"
  if ! FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-pty" timeout "$((PTY_TIMEOUT_SECS + 10))" \
    python3 "$WORK/pty_answer.py" "$answer" "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$out" 2>&1; then
    cat "$out"; echo "FAIL: the install on a terminal, answer '$answer'"; exit 1
  fi
  must "$out" 'Connect Claude Code to Flightdeck? [Y/n]' "on a terminal the installer asks"
  case "$answer" in
    y | '')
      must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes (stdin 0 bytes)' "answer '$answer' connects"
      must_not "$out" 'To connect Claude Code' "answer '$answer': no hint"
      ;;
    *)
      must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "answer '$answer' connects nothing"
      must "$out" 'To connect Claude Code: flightdeck connect claude-code' "answer '$answer' prints the command"
      ;;
  esac
  pass "on a terminal, under curl | sh, the answer '$answer' is read from /dev/tty and followed"
done
unset FAKE_FLIGHTDECK_LOG

echo "INSTALL.SH TESTS OK"
