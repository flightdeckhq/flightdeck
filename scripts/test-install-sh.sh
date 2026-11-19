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
# prints $FAKE_FLIGHTDECK_DETECTED (with \t for tabs), `connect <id>
# --dry-run` prints a plan (exit status FAKE_FLIGHTDECK_DRYRUN_EXIT) and
# every connect call is appended to $FAKE_FLIGHTDECK_LOG with the number
# of bytes it could read on stdin; FAKE_FLIGHTDECK_CONNECT_EXIT is the
# exit status of a connect, and FAKE_FLIGHTDECK_NO_CONNECT makes it an
# older release that does not know the command.
#
# It answers `flightdeck service` only when FAKE_FLIGHTDECK_SERVICE_DIR
# names a directory (else it is a release older than the command): the
# installed service is the file `unit` there, holding the command line
# `service status` prints, and every service call is appended to
# `calls.log` there with the fake's version and the bytes it could read
# on stdin. FAKE_FLIGHTDECK_SERVICE_UNSUPPORTED makes it a system that
# cannot run the service (exit 4), FAKE_FLIGHTDECK_SERVICE_CHECK_SAYS a
# dry run that fails with that reason, and FAKE_FLIGHTDECK_SERVICE_INSTALL_EXIT
# and FAKE_FLIGHTDECK_SERVICE_RESTART_EXIT the exit statuses of install
# and restart; FAKE_FLIGHTDECK_NO_SERVICE_IN names a release tag whose
# fake does not know the command. Stand-ins for systemctl and launchctl
# log their calls there too, with the version of the binary installed at
# that moment, and stand-ins for `id` (root) and `uname` (macOS) go ahead
# on PATH where a case needs them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$ROOT/install.sh"
WORK="$(mktemp -d)"
FAKE="$WORK/release"
PORT="${TEST_INSTALL_PORT:-8765}"
TAG=v0.0.1-test
# The release an installer re-run upgrades to.
TAG2=v0.0.2-test
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
  local dir="$1" tag="$2"
  mkdir -p "$dir"
  : >"$dir/checksums.txt"
  for target in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64; do
    local stage="$WORK/stage-$tag-$target"
    mkdir -p "$stage"
    cat >"$stage/flightdeck" <<FAKE
#!/bin/sh
if [ "\${1:-}" = service ] && [ -n "\${FAKE_FLIGHTDECK_SERVICE_DIR:-}" ] && [ "\${FAKE_FLIGHTDECK_NO_SERVICE_IN:-}" != "$tag" ]; then
  shift
  sd="\$FAKE_FLIGHTDECK_SERVICE_DIR"
  if [ "\${1:-}" = help ]; then echo "Usage: flightdeck service install [flags]   start Flightdeck now and at every login"; exit 0; fi
  printf 'service %s by $tag (stdin %s bytes)\n' "\$*" "\$(wc -c | tr -d ' ')" >>"\$sd/calls.log"
  if [ -n "\${FAKE_FLIGHTDECK_SERVICE_UNSUPPORTED:-}" ]; then echo "flightdeck service \$1: no systemd user manager answers for this user" >&2; exit 4; fi
  case "\${1:-}" in
    status)
      if [ ! -f "\$sd/unit" ]; then echo "The Flightdeck service is not installed: flightdeck service install installs it."; exit 3; fi
      echo "Flightdeck service: the systemd user unit ~/.config/systemd/user/flightdeck.service"
      echo "  state      \${FAKE_FLIGHTDECK_SERVICE_STATE:-running, pid 4242; starts at login}"
      echo "  command    \$(cat "\$sd/unit")"
      exit 0 ;;
    install)
      if [ "\${2:-}" = --dry-run ]; then
        if [ -n "\${FAKE_FLIGHTDECK_SERVICE_CHECK_SAYS:-}" ]; then echo "flightdeck service install: \$FAKE_FLIGHTDECK_SERVICE_CHECK_SAYS" >&2; exit 1; fi
        exit 0
      fi
      if [ "\${FAKE_FLIGHTDECK_SERVICE_INSTALL_EXIT:-0}" != 0 ]; then echo "flightdeck service install: the service did not come up" >&2; exit "\$FAKE_FLIGHTDECK_SERVICE_INSTALL_EXIT"; fi
      printf '%s --port 4100 --data-dir /srv/fake\n' "\$(cd "\$(dirname "\$0")" && pwd -P)/flightdeck" >"\$sd/unit"
      echo "The Flightdeck service is installed and runs: http://localhost:4100 (pid 4242)."
      exit 0 ;;
    restart)
      if [ ! -f "\$sd/unit" ]; then exit 3; fi
      if [ "\${FAKE_FLIGHTDECK_SERVICE_RESTART_EXIT:-0}" != 0 ]; then echo "flightdeck service restart: the service did not come up" >&2; exit "\$FAKE_FLIGHTDECK_SERVICE_RESTART_EXIT"; fi
      echo "The Flightdeck service restarted and runs: http://localhost:4100 (pid 4343)."
      exit 0 ;;
  esac
  exit 2
fi
if [ "\${1:-}" = connect ]; then
  shift
  if [ -n "\${FAKE_FLIGHTDECK_NO_CONNECT:-}" ]; then echo "flag provided but not defined" >&2; exit 2; fi
  [ -z "\${FAKE_FLIGHTDECK_LOG:-}" ] || printf 'connect %s (stdin %s bytes)\n' "\$*" "\$(wc -c | tr -d ' ')" >>"\$FAKE_FLIGHTDECK_LOG"
  if [ "\${1:-}" = --detected ]; then printf '%b' "\${FAKE_FLIGHTDECK_DETECTED:-}"; exit 0; fi
  if [ "\${2:-}" = --dry-run ]; then
    echo "Connect \$1 to Flightdeck:"
    echo "  - install the fake plugin from the fake marketplace"
    echo "The fake plugin records what a fake records, and sends it to the fake server."
    exit "\${FAKE_FLIGHTDECK_DRYRUN_EXIT:-0}"
  fi
  if [ -n "\${FAKE_FLIGHTDECK_CONNECT_SAYS:-}" ]; then echo "\$FAKE_FLIGHTDECK_CONNECT_SAYS"; else echo "fake flightdeck: connect \$*"; fi
  exit "\${FAKE_FLIGHTDECK_CONNECT_EXIT:-0}"
fi
# A Ctrl+C the first time this release's --version runs (once the
# installer has put it in place): SIGINT to the process group, as a
# terminal sends it.
if [ "\${FAKE_FLIGHTDECK_INT_ON_VERSION_OF:-}" = "$tag" ] && [ ! -e "\${FAKE_FLIGHTDECK_INT_ONCE:-/nonexistent}" ]; then
  : >"\$FAKE_FLIGHTDECK_INT_ONCE"
  kill -INT 0
fi
echo "flightdeck $tag ($target)"
FAKE
    chmod 0755 "$stage/flightdeck"
    tar -czf "$dir/flightdeck_$target.tar.gz" -C "$stage" flightdeck
    echo "$(sha256 "$dir/flightdeck_$target.tar.gz")  flightdeck_$target.tar.gz" >>"$dir/checksums.txt"
  done
}

build_release "$FAKE/releases/latest/download" "$TAG"
mkdir -p "$FAKE/releases/download"
cp -R "$FAKE/releases/latest/download" "$FAKE/releases/download/$TAG"
build_release "$FAKE/releases/download/$TAG2" "$TAG2"
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
for tool in sh uname curl wget sha256sum shasum openssl cut grep sed tar gzip mktemp rm mkdir install cp chmod mv sysctl; do
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
# local server takes a second, and the unanswered question waits out the
# installer's 60 seconds (ASK_TIMEOUT_SECS); past this the run has hung.
PTY_TIMEOUT_SECS=120
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
        if answer != "__no_answer__":
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
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "no terminal: nothing is connected, nothing planned"
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
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "all leaves a connected agent alone"
must "$WORK/all.out" 'Claude Code is already connected to Flightdeck.' "a connected agent is reported"
pass "FLIGHTDECK_CONNECT=all connects the agents not connected yet and reads only the first three fields"

connect_run none FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT=none
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "none connects nothing"
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

# shellcheck disable=SC2016  # ${IFS} is part of the value, for the installer not to expand
connect_run badid FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT='claude-code,Bad;touch${IFS}x,*'
must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "a valid id beside invalid ones is connected"
must "$WORK/badid.out" 'FLIGHTDECK_CONNECT names something that is not an agent id' "an invalid id is reported"
if grep -v -e 'connect claude-code --yes' -e 'connect --detected' "$FAKE_FLIGHTDECK_LOG" | grep -q .; then
  echo "FAIL: an invalid id reached the binary:"; cat "$FAKE_FLIGHTDECK_LOG"; exit 1
fi
pass "ids that are not lower-case letters, digits and - are skipped, a * is not expanded"

connect_run nothing
must "$WORK/nothing.out" 'To connect a coding agent later: flightdeck connect (it lists the agents it can connect)' "no agent found"
pass "with no agent found the closing lines name flightdeck connect"

# An agent too old for flightdeck connect (--detected says outdated): it
# is never planned or connected, and the closing lines say to update it.
OUTDATED_LINE='claude-code\toutdated\tClaude Code\n'
CLAUDE_LINE_CONNECTED='claude-code\tconnected\tClaude Code\n'
OUTDATED_HINT='To connect Claude Code: update it (this version is too old for flightdeck connect), then run flightdeck connect claude-code'
connect_run outdated FAKE_FLIGHTDECK_DETECTED="$OUTDATED_LINE"
must "$WORK/outdated.out" "$OUTDATED_HINT" "an outdated agent: the hint to update it"
must_not "$WORK/outdated.out" 'To connect Claude Code: flightdeck connect claude-code' "an outdated agent: not the plain hint"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "an outdated agent: nothing planned or connected"
connect_run outdated-named FAKE_FLIGHTDECK_DETECTED="$OUTDATED_LINE" FLIGHTDECK_CONNECT=claude-code
must "$WORK/outdated-named.out" "$OUTDATED_HINT" "FLIGHTDECK_CONNECT naming an outdated agent: the hint"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "FLIGHTDECK_CONNECT naming an outdated agent: nothing connected"
connect_run outdated-all FAKE_FLIGHTDECK_DETECTED='claude-code\toutdated\tClaude Code\nother-agent\tnot-connected\tOther Agent\n' FLIGHTDECK_CONNECT=all
must "$WORK/outdated-all.out" "$OUTDATED_HINT" "FLIGHTDECK_CONNECT=all with an outdated agent: the hint"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "FLIGHTDECK_CONNECT=all leaves the outdated agent alone"
must "$FAKE_FLIGHTDECK_LOG" 'connect other-agent --yes' "FLIGHTDECK_CONNECT=all still connects the others"
pass "an outdated agent is not planned or connected, whatever FLIGHTDECK_CONNECT says, and the hint says to update it"

# An outdated agent connected from inside it: --detected says connected,
# and the connect FLIGHTDECK_CONNECT names exits 0 with the binary's line
# that it is already connected, which the installer prints as it is.
# shellcheck disable=SC2016 # the backquotes are the binary's own words, not a command
ALREADY_CONNECTED_SAYS='Claude Code 2.1.283 is already connected to Flightdeck: the flightdeck plugin 0.9.0 is installed and turned on from inside Claude Code; nothing changed. This version cannot show or change the server the plugin reports to: update it with `claude update` to see or change it.'
connect_run outdated-connected FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE_CONNECTED" FLIGHTDECK_CONNECT=claude-code FAKE_FLIGHTDECK_CONNECT_SAYS="$ALREADY_CONNECTED_SAYS"
must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "an outdated agent connected from inside it: its connect runs"
must "$WORK/outdated-connected.out" 'Claude Code 2.1.283 is already connected to Flightdeck' "an outdated agent connected from inside it: already connected"
must_not "$WORK/outdated-connected.out" 'needs a newer' "an outdated agent connected from inside it: not told to update before connecting"
must_not "$WORK/outdated-connected.out" 'did not finish' "an outdated agent connected from inside it: not a failure"
must_not "$WORK/outdated-connected.out" 'To connect Claude Code' "an outdated agent connected from inside it: no hint"
pass "FLIGHTDECK_CONNECT naming an outdated agent connected from inside it: the installer says it is already connected"

# A connect that exits 5 (the agent turned out too old): update it, not
# "run it again later".
connect_run exit5 FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" FLIGHTDECK_CONNECT=claude-code FAKE_FLIGHTDECK_CONNECT_EXIT=5
must "$WORK/exit5.out" 'Connecting Claude Code needs a newer Claude Code (see above): update it, then run flightdeck connect claude-code' "a connect that exits 5 says to update"
must_not "$WORK/exit5.out" 'run it again later' "a connect that exits 5 does not say to retry"
must "$WORK/exit5.out" "run \`flightdeck\` and open the URL it prints" "the install carries on after it"
pass "a connect that exits 5 says to update the agent, not to run it again later"

connect_run older FAKE_FLIGHTDECK_NO_CONNECT=1 FLIGHTDECK_CONNECT=claude-code
must_not "$WORK/older.out" 'connect' "an older binary: no connect line"
must "$WORK/older.out" "run \`flightdeck\` and open the URL it prints" "an older binary installs as before"
pass "a binary that does not know connect (an older VERSION) skips the step"

for answer in y '' n nope __no_answer__; do
  : >"$FAKE_FLIGHTDECK_LOG"
  rm -rf "$WORK/inst-pty"
  out="$WORK/pty.out"
  if ! FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-pty" timeout "$((PTY_TIMEOUT_SECS + 10))" \
    python3 "$WORK/pty_answer.py" "$answer" "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$out" 2>&1; then
    cat "$out"; echo "FAIL: the install on a terminal, answer '$answer'"; exit 1
  fi
  must "$out" 'Connect Claude Code to Flightdeck? [Y/n]' "on a terminal the installer asks"
  must "$out" 'The fake plugin records what a fake records' "the plan and what it records come before the question"
  must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --dry-run (stdin 0 bytes)' "the plan is the binary's own dry run"
  case "$answer" in
    y | '')
      must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes (stdin 0 bytes)' "answer '$answer' connects"
      must_not "$out" 'To connect Claude Code' "answer '$answer': no hint"
      ;;
    *)
      must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "answer '$answer' connects nothing"
      must "$out" 'To connect Claude Code: flightdeck connect claude-code' "answer '$answer' prints the command"
      ;;
  esac
  if [ "$answer" = __no_answer__ ]; then
    must "$out" 'No answer in 60 seconds: not connecting.' "an unanswered question times out as no"
  fi
  pass "on a terminal, under curl | sh, the answer '$answer' is read from /dev/tty and followed"
done

# A plan the binary cannot make (it printed why): nothing is asked.
: >"$FAKE_FLIGHTDECK_LOG"
FAKE_FLIGHTDECK_DRYRUN_EXIT=1 FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-pty2" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" y "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$WORK/pty2.out" 2>&1 ||
  { cat "$WORK/pty2.out"; echo "FAIL: the install with a failing dry run"; exit 1; }
must_not "$WORK/pty2.out" '[Y/n]' "a failed dry run: nothing asked"
must "$WORK/pty2.out" 'To connect Claude Code: flightdeck connect claude-code' "a failed dry run: the command is printed"
pass "when the binary cannot plan the connect, nothing is asked and the command is printed"

# A plan that needs the person's own yes (--dry-run exits 4: a caution,
# such as a marketplace from another source): nothing is asked, since the
# installer's connect passes --yes, and the person is told what to run.
: >"$FAKE_FLIGHTDECK_LOG"
FAKE_FLIGHTDECK_DRYRUN_EXIT=4 FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-pty3" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" y "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$WORK/pty3.out" 2>&1 ||
  { cat "$WORK/pty3.out"; echo "FAIL: the install with a plan that needs confirmation"; exit 1; }
must_not "$WORK/pty3.out" '[Y/n]' "a plan that needs confirmation: nothing asked"
must "$WORK/pty3.out" 'Connecting Claude Code needs your own yes (see the caution above): run flightdeck connect claude-code yourself' "a plan that needs confirmation: what to run"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "a plan that needs confirmation: nothing connected"
pass "when the dry run exits 4 (a caution), nothing is asked and the person is told to run the connect"

# An outdated agent on a terminal: no plan, no question, the hint.
: >"$FAKE_FLIGHTDECK_LOG"
FAKE_FLIGHTDECK_DETECTED="$OUTDATED_LINE" INSTALL_DIR="$WORK/inst-pty4" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" y "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$WORK/pty4.out" 2>&1 ||
  { cat "$WORK/pty4.out"; echo "FAIL: the install with an outdated agent on a terminal"; exit 1; }
must_not "$WORK/pty4.out" '[Y/n]' "an outdated agent on a terminal: nothing asked"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code' "an outdated agent on a terminal: no dry run, no connect"
must "$WORK/pty4.out" "$OUTDATED_HINT" "an outdated agent on a terminal: the hint to update it"
pass "on a terminal, an outdated agent is not asked about: the hint says to update it"

# A dry run that exits 5 (--detected said not-connected, but planning met
# a command the agent lacks): nothing is asked, and the hint says to update.
: >"$FAKE_FLIGHTDECK_LOG"
FAKE_FLIGHTDECK_DRYRUN_EXIT=5 FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-pty5" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" y "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$WORK/pty5.out" 2>&1 ||
  { cat "$WORK/pty5.out"; echo "FAIL: the install with a dry run that exits 5"; exit 1; }
must_not "$WORK/pty5.out" '[Y/n]' "a dry run that exits 5: nothing asked"
must_not "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "a dry run that exits 5: nothing connected"
must "$WORK/pty5.out" "$OUTDATED_HINT" "a dry run that exits 5: the hint to update it"
must_not "$WORK/pty5.out" 'To connect Claude Code: flightdeck connect claude-code' "a dry run that exits 5: not the plain hint"
pass "when the dry run exits 5, nothing is asked and the hint says to update the agent"

# A ps that cannot say which group is in the foreground (BusyBox's has
# no tpgid): the question is asked, and its bound still holds.
mkdir -p "$WORK/fakeps"
printf '#!/bin/sh\necho "ps: bad -o argument" >&2\nexit 1\n' >"$WORK/fakeps/ps"
chmod 0755 "$WORK/fakeps/ps"
: >"$FAKE_FLIGHTDECK_LOG"
started=$(date +%s)
PATH="$WORK/fakeps:$PATH" FLIGHTDECK_CONNECT_ASK_TIMEOUT=2 FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-ps" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" __no_answer__ "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$WORK/ps.out" 2>&1 ||
  { cat "$WORK/ps.out"; echo "FAIL: the install with a ps that has no tpgid"; exit 1; }
elapsed=$(( $(date +%s) - started ))
must "$WORK/ps.out" 'Connect Claude Code to Flightdeck? [Y/n]' "without tpgid the question is asked"
must "$WORK/ps.out" 'No answer in 2 seconds: not connecting.' "and times out at its bound"
must "$WORK/ps.out" 'To connect Claude Code: flightdeck connect claude-code' "and prints the command"
# The bound plus the install itself (a second against the local server)
# and the reader's one-second polls; far below the run's own timeout.
if [ "$elapsed" -gt 20 ]; then echo "FAIL: the unanswered question took ${elapsed}s with a 2-second bound"; exit 1; fi
: >"$FAKE_FLIGHTDECK_LOG"
PATH="$WORK/fakeps:$PATH" FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-ps2" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" y "$PTY_TIMEOUT_SECS" sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$WORK/ps2.out" 2>&1 ||
  { cat "$WORK/ps2.out"; echo "FAIL: the install with a ps that has no tpgid, answered"; exit 1; }
must "$FAKE_FLIGHTDECK_LOG" 'connect claude-code --yes' "without tpgid a yes still connects"
pass "a ps without tpgid (BusyBox): the question is asked, bounded (${elapsed}s with a 2-second bound), and a yes connects"

# In the background, the installer asks nothing: the terminal would stop
# it at the read. The pseudo-terminal's foreground group is the driver's
# shell; the install runs in a group of its own behind it.
: >"$FAKE_FLIGHTDECK_LOG"
FAKE_FLIGHTDECK_DETECTED="$CLAUDE_LINE" INSTALL_DIR="$WORK/inst-bg" timeout "$((PTY_TIMEOUT_SECS + 10))" \
  python3 "$WORK/pty_answer.py" y "$PTY_TIMEOUT_SECS" bash -c "set -m; curl -fsSL http://127.0.0.1:$PORT/install.sh | sh & wait \$!" >"$WORK/bg.out" 2>&1 ||
  { cat "$WORK/bg.out"; echo "FAIL: the install in the background"; exit 1; }
must_not "$WORK/bg.out" '[Y/n]' "in the background nothing is asked"
must "$WORK/bg.out" 'To connect Claude Code: flightdeck connect claude-code' "in the background the command is printed"
pass "an install in the background asks nothing and prints the command"
unset FAKE_FLIGHTDECK_LOG

echo "-- starting Flightdeck in the background (flightdeck service)"
# Stand-ins for the service managers: they log each call with the version
# of the binary installed at that moment, so a log shows whether the stop
# ran before the binary was replaced. launchctl print says the agent is
# gone, as it is once bootout has stopped it.
# FAKE_MANAGER_INT_ON_STOP sends a Ctrl+C (SIGINT to the process group)
# while the installer waits on the stop: in systemctl stop, or while
# launchctl print still says the agent is there.
mkdir -p "$WORK/fakemgr"
for manager in systemctl launchctl; do
  cat >"$WORK/fakemgr/$manager" <<FAKE
#!/bin/sh
if [ "$manager" = launchctl ] && [ "\$1" = print ]; then
  if [ -n "\${FAKE_MANAGER_INT_ON_STOP:-}" ]; then kill -INT 0; exit 0; fi
  exit 113
fi
printf '%s %s [installed: %s]\n' "$manager" "\$*" "\$("\$FAKE_INSTALLED_BIN" --version 2>/dev/null)" >>"\$FAKE_FLIGHTDECK_SERVICE_DIR/calls.log"
if [ "$manager" = systemctl ] && [ "\$2" = stop ] && [ -n "\${FAKE_MANAGER_INT_ON_STOP:-}" ]; then kill -INT 0; fi
exit "\${FAKE_MANAGER_EXIT:-0}"
FAKE
  chmod 0755 "$WORK/fakemgr/$manager"
done
# An install(1) that fails as on a full disk.
mkdir -p "$WORK/fullinstall"
printf '#!/bin/sh\necho "install: error writing to the file: No space left on device" >&2\nexit 1\n' >"$WORK/fullinstall/install"
chmod 0755 "$WORK/fullinstall/install"
# root, and macOS on Apple silicon.
mkdir -p "$WORK/fakeroot" "$WORK/fakedarwin"
# shellcheck disable=SC2016  # the $1 and $@ are the stand-ins' own
printf '#!/bin/sh\ncase "$1" in -u) echo 0 ;; *) exec /usr/bin/id "$@" ;; esac\n' >"$WORK/fakeroot/id"
# shellcheck disable=SC2016  # the $1 and $@ are the stand-ins' own
printf '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) exec /usr/bin/uname "$@" ;; esac\n' >"$WORK/fakedarwin/uname"
chmod 0755 "$WORK/fakeroot/id" "$WORK/fakedarwin/uname"

SERVICE_HINT='To start Flightdeck now and at every login: flightdeck service install'
service_run() {
  # service_run <name> <env...>: install.sh piped into sh with no
  # terminal into $WORK/inst-<name>, the fake service's files in
  # $WORK/svc-<name> (kept across runs of one name, for the re-runs),
  # the managers' stand-ins first on PATH. Output in $WORK/<name>.out.
  local name="$1"; shift
  mkdir -p "$WORK/svc-$name"
  curl -fsSL "http://127.0.0.1:$PORT/install.sh" |
    no_tty env INSTALL_DIR="$WORK/inst-$name" FAKE_FLIGHTDECK_SERVICE_DIR="$WORK/svc-$name" \
      FAKE_INSTALLED_BIN="$WORK/inst-$name/flightdeck" PATH="$WORK/fakemgr:$PATH" "$@" sh >"$WORK/$name.out" 2>&1 ||
    { cat "$WORK/$name.out"; echo "FAIL: $name: the install failed"; exit 1; }
}
calls() { printf '%s' "$WORK/svc-$1/calls.log"; }
# before <file> <first> <second>: <first> is logged on an earlier line than <second>.
before() {
  local a b
  a="$(grep -nF -- "$2" "$1" | head -1 | cut -d: -f1)"
  b="$(grep -nF -- "$3" "$1" | head -1 | cut -d: -f1)"
  if [ -z "$a" ] || [ -z "$b" ] || [ "$a" -ge "$b" ]; then
    printf 'FAIL: "%s" is not logged before "%s":\n' "$2" "$3"; cat "$1"; exit 1
  fi
}

service_run svc-quiet
must "$WORK/svc-quiet.out" "$SERVICE_HINT" "no terminal: the service command is printed"
must "$(calls svc-quiet)" "service install --dry-run by $TAG (stdin 0 bytes)" "no terminal: the binary's dry run is asked"
must_not "$(calls svc-quiet)" "service install by" "no terminal: no service installed"
must_not "$WORK/svc-quiet.out" '[Y/n]' "no terminal: nothing asked"
pass "without a terminal the installer prints the service command and installs nothing"

service_run svc-yes FLIGHTDECK_SERVICE=yes
must "$(calls svc-yes)" "service install by $TAG (stdin 0 bytes)" "FLIGHTDECK_SERVICE=yes installs it, its stdin empty"
must "$WORK/svc-yes.out" 'The Flightdeck service is installed and runs: http://localhost:4100' "the service install's own output is shown"
must "$WORK/svc-yes.out" 'Next: open the address above. Flightdeck runs in the background; flightdeck service status shows it.' "the closing line says it runs"
must_not "$WORK/svc-yes.out" "run \`flightdeck\` and open the URL it prints" "a running service: not told to run flightdeck"
must_not "$WORK/svc-yes.out" "$SERVICE_HINT" "an installed service: no hint"
pass "FLIGHTDECK_SERVICE=yes installs the service without asking"

service_run svc-no FLIGHTDECK_SERVICE=no
must "$WORK/svc-no.out" "$SERVICE_HINT" "FLIGHTDECK_SERVICE=no prints the command"
must_not "$(calls svc-no)" "service install by" "FLIGHTDECK_SERVICE=no installs nothing"
pass "FLIGHTDECK_SERVICE=no installs nothing and prints the command"

service_run svc-other FLIGHTDECK_SERVICE=maybe
must "$WORK/svc-other.out" 'FLIGHTDECK_SERVICE is neither yes nor no (maybe): not starting Flightdeck in the background' "another value is reported"
must_not "$(calls svc-other)" "service install by" "another value installs nothing"
must "$WORK/svc-other.out" "$SERVICE_HINT" "another value prints the command"
pass "a FLIGHTDECK_SERVICE that is neither yes nor no is reported and read as no"

service_run svc-root FLIGHTDECK_SERVICE=yes PATH="$WORK/fakeroot:$WORK/fakemgr:$PATH"
must_not "$WORK/svc-root.out" 'flightdeck service' "as root: nothing said about the service"
if [ -s "$(calls svc-root)" ]; then echo "FAIL: as root the binary's service command ran:"; cat "$(calls svc-root)"; exit 1; fi
pass "as root nothing is asked or run (the service refuses root)"

curl -fsSL "http://127.0.0.1:$PORT/install.sh" |
  no_tty env INSTALL_DIR="$WORK/inst-svc-older" FLIGHTDECK_SERVICE=yes PATH="$WORK/fakemgr:$PATH" sh >"$WORK/svc-older.out" 2>&1 ||
  { cat "$WORK/svc-older.out"; echo "FAIL: the install with an older binary"; exit 1; }
must_not "$WORK/svc-older.out" 'service' "an older binary: nothing said about the service"
must "$WORK/svc-older.out" "run \`flightdeck\` and open the URL it prints" "an older binary installs as before"
pass "a binary that does not know the service command (an older VERSION) skips the step silently"

service_run svc-unsupported FAKE_FLIGHTDECK_SERVICE_UNSUPPORTED=1
must_not "$WORK/svc-unsupported.out" 'service' "a system that cannot run it: nothing said without FLIGHTDECK_SERVICE"
must_not "$WORK/svc-unsupported.out" '[Y/n]' "a system that cannot run it: nothing asked"
service_run svc-unsupported-yes FAKE_FLIGHTDECK_SERVICE_UNSUPPORTED=1 FLIGHTDECK_SERVICE=yes
must "$WORK/svc-unsupported-yes.out" 'Not starting Flightdeck in the background: no systemd user manager answers for this user' "FLIGHTDECK_SERVICE=yes where it cannot run: the binary's reason"
must_not "$WORK/svc-unsupported-yes.out" "$SERVICE_HINT" "where it cannot run: no hint to run the command"
pass "where the dry run exits 4 (no user service manager) nothing is offered; asked for, the binary's reason is printed"

service_run svc-check FAKE_FLIGHTDECK_SERVICE_CHECK_SAYS='another flightdeck (pid 7) runs on the data dir' FLIGHTDECK_SERVICE=yes
must "$WORK/svc-check.out" "$SERVICE_HINT (it would not start now: another flightdeck (pid 7) runs on the data dir)" "a failing dry run: the command and its reason"
must_not "$(calls svc-check)" "service install by" "a failing dry run: nothing installed"
pass "a dry run that fails otherwise (a flightdeck on the data dir) installs nothing and prints the command with the reason"

service_run svc-fails FLIGHTDECK_SERVICE=yes FAKE_FLIGHTDECK_SERVICE_INSTALL_EXIT=1
test -x "$WORK/inst-svc-fails/flightdeck"
must "$WORK/svc-fails.out" 'flightdeck service install: the service did not come up' "a failed service install: its own line"
must "$WORK/svc-fails.out" 'Starting Flightdeck in the background did not finish (see above); run it again later: flightdeck service install' "a failed service install says how to retry"
must "$WORK/svc-fails.out" "run \`flightdeck\` and open the URL it prints" "the install carries on after a failed service install"
pass "a service install that fails does not fail the install"

for answer in y '' n __no_answer__; do
  name="svc-pty-${answer:-empty}"
  mkdir -p "$WORK/svc-$name"
  out="$WORK/$name.out"
  if ! FAKE_FLIGHTDECK_SERVICE_DIR="$WORK/svc-$name" FLIGHTDECK_CONNECT_ASK_TIMEOUT=2 INSTALL_DIR="$WORK/inst-$name" PATH="$WORK/fakemgr:$PATH" \
    timeout "$((PTY_TIMEOUT_SECS + 10))" python3 "$WORK/pty_answer.py" "$answer" "$PTY_TIMEOUT_SECS" \
    sh -c "curl -fsSL http://127.0.0.1:$PORT/install.sh | sh" >"$out" 2>&1; then
    cat "$out"; echo "FAIL: the install on a terminal, service answer '$answer'"; exit 1
  fi
  must "$out" 'Start Flightdeck now and at every login? [Y/n]' "on a terminal the installer asks"
  must "$out" 'again if it stops (flightdeck service remove undoes it)' "what it does is said before the question"
  case "$answer" in
    y | '')
      must "$(calls "$name")" "service install by $TAG (stdin 0 bytes)" "answer '$answer' installs the service"
      must "$out" 'Next: open the address above. Flightdeck runs in the background' "answer '$answer': the closing line says it runs"
      ;;
    *)
      must_not "$(calls "$name")" "service install by" "answer '$answer' installs nothing"
      must "$out" "$SERVICE_HINT" "answer '$answer' prints the command"
      ;;
  esac
  if [ "$answer" = __no_answer__ ]; then
    must "$out" 'No answer in 2 seconds: not starting it.' "an unanswered question times out as no"
  fi
  pass "on a terminal, under curl | sh, the service answer '$answer' is read from /dev/tty and followed"
done

# A re-run where the service runs the installed binary: the service is
# stopped while the old binary is in place, the binary is replaced, and
# the new binary's `service restart` starts it again; nothing is offered.
service_run svc-up FLIGHTDECK_SERVICE=yes
service_run svc-up VERSION="$TAG2"
"$WORK/inst-svc-up/flightdeck" --version | grep -q "^flightdeck $TAG2"
must "$(calls svc-up)" "systemctl --user stop flightdeck.service [installed: flightdeck $TAG (linux_amd64)]" "the stop runs while the old binary is installed"
must "$(calls svc-up)" "service restart by $TAG2 (stdin 0 bytes)" "the new binary restarts the service"
before "$(calls svc-up)" 'systemctl --user stop flightdeck.service' "service restart by $TAG2"
must "$WORK/svc-up.out" 'Stopping the Flightdeck service to replace the binary it runs' "the re-run says it stops the service"
must "$WORK/svc-up.out" 'The Flightdeck service restarted and runs' "the restart's own output is shown"
must "$WORK/svc-up.out" 'Next: open the address above. Flightdeck runs in the background' "the closing line says it runs"
must_not "$(calls svc-up)" "service install by $TAG2" "a re-run installs nothing more"
must_not "$WORK/svc-up.out" '[Y/n]' "a re-run asks nothing"
pass "a re-run with the service installed stops it before the replacement and starts the new binary after (systemd)"

service_run svc-up-mac FLIGHTDECK_SERVICE=yes PATH="$WORK/fakedarwin:$WORK/fakemgr:$PATH"
service_run svc-up-mac VERSION="$TAG2" PATH="$WORK/fakedarwin:$WORK/fakemgr:$PATH"
must "$(calls svc-up-mac)" "launchctl bootout gui/$(id -u)/com.flightdeck-hq.flightdeck [installed: flightdeck $TAG (darwin_arm64)]" "macOS: the agent is booted out while the old binary is installed"
before "$(calls svc-up-mac)" 'launchctl bootout' "service restart by $TAG2"
must_not "$(calls svc-up-mac)" 'systemctl' "macOS: no systemctl"
pass "a re-run on macOS boots the agent out before the replacement and the new binary restarts it"

# The installed path with a space and a quote, written by `service status`
# in single quotes as the binary quotes it.
weird="$WORK/inst-svc up'grade"
mkdir -p "$WORK/svc-weird"
curl -fsSL "http://127.0.0.1:$PORT/install.sh" |
  no_tty env INSTALL_DIR="$weird" FLIGHTDECK_SERVICE=no FAKE_FLIGHTDECK_SERVICE_DIR="$WORK/svc-weird" PATH="$WORK/fakemgr:$PATH" sh >"$WORK/svc-weird1.out" 2>&1 ||
  { cat "$WORK/svc-weird1.out"; exit 1; }
printf "'%s' --port 4100 --data-dir /srv/fake\n" "$WORK/inst-svc up'\\''grade/flightdeck" >"$WORK/svc-weird/unit"
curl -fsSL "http://127.0.0.1:$PORT/install.sh" |
  no_tty env INSTALL_DIR="$weird" VERSION="$TAG2" FAKE_FLIGHTDECK_SERVICE_DIR="$WORK/svc-weird" FAKE_INSTALLED_BIN="$weird/flightdeck" \
    PATH="$WORK/fakemgr:$PATH" sh >"$WORK/svc-weird2.out" 2>&1 || { cat "$WORK/svc-weird2.out"; exit 1; }
must "$WORK/svc-weird/calls.log" 'systemctl --user stop flightdeck.service' "a quoted path is matched"
must "$WORK/svc-weird/calls.log" "service restart by $TAG2" "and restarted with the new binary"
pass "a service whose binary path needs quoting is recognised as this install's"

service_run svc-restart-fails FLIGHTDECK_SERVICE=yes
service_run svc-restart-fails VERSION="$TAG2" FAKE_FLIGHTDECK_SERVICE_RESTART_EXIT=1
must "$WORK/svc-restart-fails.out" 'The Flightdeck service did not start again with the new binary (see above): flightdeck service status shows why.' "a failed restart is said, with the status command"
"$WORK/inst-svc-restart-fails/flightdeck" --version | grep -q "^flightdeck $TAG2"
pass "a restart that fails after the replacement is reported, and the install succeeds"

service_run svc-stop-fails FLIGHTDECK_SERVICE=yes
service_run svc-stop-fails VERSION="$TAG2" FAKE_MANAGER_EXIT=1
must "$WORK/svc-stop-fails.out" 'The service did not stop (see above); replacing the binary all the same, and starting the service again after' "a failed stop is said"
must "$(calls svc-stop-fails)" "service restart by $TAG2" "the service is still restarted with the new binary"
pass "a stop that fails is reported, and the new binary still restarts the service"

# The new release is older than the command (a pinned VERSION): the
# manager's own start brings the service back.
service_run svc-up-older FLIGHTDECK_SERVICE=yes
service_run svc-up-older VERSION="$TAG2" FAKE_FLIGHTDECK_NO_SERVICE_IN="$TAG2"
before "$(calls svc-up-older)" 'systemctl --user stop flightdeck.service' 'systemctl --user start flightdeck.service'
must "$(calls svc-up-older)" "systemctl --user start flightdeck.service [installed: flightdeck $TAG2 (linux_amd64)]" "the manager starts it once the new binary is in place"
must "$WORK/svc-up-older.out" "Started the Flightdeck service again with $WORK/inst-svc-up-older/flightdeck." "the start is said"
pass "a new binary without the service command: the manager's own start restarts the service"

# A service that runs another binary (another install directory) is left
# running, and named.
service_run svc-elsewhere FLIGHTDECK_SERVICE=no
printf '/opt/elsewhere/flightdeck --port 4100\n' >"$WORK/svc-svc-elsewhere/unit"
service_run svc-elsewhere VERSION="$TAG2" FLIGHTDECK_SERVICE=yes
must_not "$(calls svc-elsewhere)" 'systemctl' "another binary's service is not stopped"
must_not "$(calls svc-elsewhere)" "service install by" "another binary's service is not replaced"
must "$WORK/svc-elsewhere.out" 'The Flightdeck service runs another flightdeck and keeps running it: /opt/elsewhere/flightdeck --port 4100.' "it is named"
pass "a service of another flightdeck is left as it is and named"

# A re-run with no service behaves as a first install.
service_run svc-none FLIGHTDECK_SERVICE=no
service_run svc-none VERSION="$TAG2"
must_not "$(calls svc-none)" 'systemctl' "no service: nothing stopped"
must "$WORK/svc-none.out" "$SERVICE_HINT" "no service: the command is printed again"
pass "a re-run without the service behaves as a first install"

# A re-run leaves the service as it found it: one the user had stopped
# stays stopped, on the new binary; one the manager keeps starting again
# after a failure counts as running.
for state in 'not running (inactive, dead); starts at login' 'not loaded by the service manager; starts at login'; do
  name="svc-stopped-$(printf '%s' "${state%%;*}" | tr -c '[:alnum:]' '-')"
  service_run "$name" FLIGHTDECK_SERVICE=yes
  service_run "$name" VERSION="$TAG2" FAKE_FLIGHTDECK_SERVICE_STATE="$state"
  must_not "$(calls "$name")" 'systemctl' "a stopped service ($state): not stopped or started"
  must_not "$(calls "$name")" "service restart by" "a stopped service ($state): not restarted"
  must_not "$(calls "$name")" "service install by $TAG2" "a stopped service ($state): not installed again"
  must "$WORK/$name.out" 'The Flightdeck service was stopped and stays stopped; it runs the new binary once started: flightdeck service restart starts it now.' "a stopped service: the line that says so"
  must_not "$WORK/$name.out" '[Y/n]' "a stopped service: nothing asked"
  "$WORK/inst-$name/flightdeck" --version | grep -q "^flightdeck $TAG2"
done
pass "a re-run with the service stopped replaces the binary and leaves the service stopped, saying how to start it"

service_run svc-failing FLIGHTDECK_SERVICE=yes
service_run svc-failing VERSION="$TAG2" FAKE_FLIGHTDECK_SERVICE_STATE='failed: it exited and is started again (activating, auto-restart); starts at login'
before "$(calls svc-failing)" 'systemctl --user stop flightdeck.service' "service restart by $TAG2"
pass "a service the manager keeps starting again after failures counts as running: stopped, replaced, restarted"

# FLIGHTDECK_SERVICE takes FLIGHTDECK_CONNECT's spellings: spaces and
# commas around the word are ignored, the word is lower-case.
service_run svc-spaced FLIGHTDECK_SERVICE=' yes, '
must "$(calls svc-spaced)" "service install by $TAG" "' yes, ' is yes"
service_run svc-upper FLIGHTDECK_SERVICE=YES
must "$WORK/svc-upper.out" 'FLIGHTDECK_SERVICE is neither yes nor no (YES)' "YES is reported, as FLIGHTDECK_CONNECT=ALL would not be all"
must_not "$(calls svc-upper)" "service install by" "YES installs nothing"
pass "FLIGHTDECK_SERVICE reads as FLIGHTDECK_CONNECT does: ' yes, ' is yes, YES is reported and read as no"

# Exits after the stop: the service is started again on the binary in
# place, and no staged file is left. service_run_exits <name> <status>
# <env...> is service_run for a run that must exit with <status>.
service_run_exits() {
  local name="$1" want="$2"; shift 2
  mkdir -p "$WORK/svc-$name"
  local got=0
  curl -fsSL "http://127.0.0.1:$PORT/install.sh" |
    no_tty env INSTALL_DIR="$WORK/inst-$name" FAKE_FLIGHTDECK_SERVICE_DIR="$WORK/svc-$name" \
      FAKE_INSTALLED_BIN="$WORK/inst-$name/flightdeck" PATH="$WORK/fakemgr:$PATH" "$@" sh >"$WORK/$name.out" 2>&1 || got=$?
  if [ "$got" -ne "$want" ]; then cat "$WORK/$name.out"; echo "FAIL: $name exited $got, want $want"; exit 1; fi
}
no_staged_file() {
  local left
  for left in "$1"/.flightdeck.installing.*; do
    if [ -e "$left" ]; then echo "FAIL: a staged binary is left in $1: $left"; exit 1; fi
  done
}
AGAIN='The install stopped before it finished; starting the Flightdeck service again with'

service_run svc-full FLIGHTDECK_SERVICE=yes
service_run_exits svc-full 1 VERSION="$TAG2" PATH="$WORK/fullinstall:$WORK/fakemgr:$PATH"
must "$WORK/svc-full.out" 'No space left on device' "a full disk: install(1)'s own line"
must "$WORK/svc-full.out" 'was not replaced' "a full disk: the installer says the binary was not replaced"
must "$WORK/svc-full.out" "$AGAIN $WORK/inst-svc-full/flightdeck (flightdeck $TAG (linux_amd64))" "a full disk: the service starts again on the old binary"
must "$WORK/svc-full.out" 'The Flightdeck service runs again.' "a full disk: it says the service runs"
before "$(calls svc-full)" 'systemctl --user stop flightdeck.service' "service restart by $TAG (stdin 0 bytes)"
"$WORK/inst-svc-full/flightdeck" --version | grep -q "^flightdeck $TAG "
no_staged_file "$WORK/inst-svc-full"
pass "the write of the new binary failing after the stop: the old binary stays, the service runs again on it"

service_run svc-int-stop FLIGHTDECK_SERVICE=yes
service_run_exits svc-int-stop 130 VERSION="$TAG2" FAKE_MANAGER_INT_ON_STOP=1
must "$WORK/svc-int-stop.out" "$AGAIN $WORK/inst-svc-int-stop/flightdeck (flightdeck $TAG (linux_amd64))" "Ctrl+C during the stop: the service starts again on the old binary"
must "$WORK/svc-int-stop.out" 'The Flightdeck service runs again.' "Ctrl+C during the stop: it says the service runs"
before "$(calls svc-int-stop)" 'systemctl --user stop flightdeck.service' "service restart by $TAG (stdin 0 bytes)"
"$WORK/inst-svc-int-stop/flightdeck" --version | grep -q "^flightdeck $TAG "
pass "Ctrl+C while systemctl stop waits: the service runs again on the old binary, exit 130"

service_run svc-int-wait FLIGHTDECK_SERVICE=yes PATH="$WORK/fakedarwin:$WORK/fakemgr:$PATH"
service_run_exits svc-int-wait 130 VERSION="$TAG2" FAKE_MANAGER_INT_ON_STOP=1 PATH="$WORK/fakedarwin:$WORK/fakemgr:$PATH"
must "$WORK/svc-int-wait.out" "$AGAIN $WORK/inst-svc-int-wait/flightdeck (flightdeck $TAG (darwin_arm64))" "Ctrl+C in the wait for launchd: the service starts again on the old binary"
before "$(calls svc-int-wait)" 'launchctl bootout' "service restart by $TAG (stdin 0 bytes)"
pass "Ctrl+C while the installer waits for launchd to let the agent go: the service runs again on the old binary"

service_run svc-int-after FLIGHTDECK_SERVICE=yes
service_run_exits svc-int-after 130 VERSION="$TAG2" FAKE_FLIGHTDECK_INT_ON_VERSION_OF="$TAG2" FAKE_FLIGHTDECK_INT_ONCE="$WORK/svc-int-after.once"
test -e "$WORK/svc-int-after.once"
must "$WORK/svc-int-after.out" "$AGAIN $WORK/inst-svc-int-after/flightdeck (flightdeck $TAG2 (linux_amd64))" "Ctrl+C after the replacement: the service starts again on the new binary"
must "$WORK/svc-int-after.out" 'The Flightdeck service runs again.' "Ctrl+C after the replacement: it says the service runs"
before "$(calls svc-int-after)" 'systemctl --user stop flightdeck.service' "service restart by $TAG2 (stdin 0 bytes)"
no_staged_file "$WORK/inst-svc-int-after"
pass "Ctrl+C between the replacement and the restart: the service runs again on the new binary, exit 130"

service_run svc-int-down FLIGHTDECK_SERVICE=yes
service_run_exits svc-int-down 130 VERSION="$TAG2" FAKE_MANAGER_INT_ON_STOP=1 FAKE_FLIGHTDECK_SERVICE_RESTART_EXIT=1
must "$WORK/svc-int-down.out" 'The Flightdeck service is stopped (see above): flightdeck service status says why.' "a start again that fails says the service is stopped"
pass "when starting the service again fails too, the installer says it is stopped and names flightdeck service status"

echo "INSTALL.SH TESTS OK"
