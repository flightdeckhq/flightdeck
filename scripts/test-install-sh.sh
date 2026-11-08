#!/usr/bin/env bash
# Tests install.sh end to end against a local HTTP server that mirrors
# the GitHub release layout (releases/latest/download/<asset> and
# releases/download/<tag>/<asset>, checksums.txt beside them), with a
# fake `flightdeck` (a shell script that prints a version) in the
# archives, so no release and no Go build is needed. CI runs it; locally:
#   scripts/test-install-sh.sh
# Needs bash, python3 (the server), curl, tar and sha256sum or shasum.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$ROOT/install.sh"
WORK="$(mktemp -d)"
FAKE="$WORK/release"
PORT="${TEST_INSTALL_PORT:-8765}"
TAG=v0.0.1-test
cleanup() {
  [[ -n "${HTTP_PID:-}" ]] && kill "$HTTP_PID" 2>/dev/null || true
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
    printf '#!/bin/sh\necho "flightdeck %s (%s)"\n' "$TAG" "$target" >"$stage/flightdeck"
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
cat "$INSTALL_SH" | INSTALL_DIR="$WORK/inst1" sh >"$WORK/out1" 2>&1 || { cat "$WORK/out1"; exit 1; }
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
# An unsupported CPU: a fake uname ahead on PATH.
mkdir -p "$WORK/fakebin"
# shellcheck disable=SC2016  # the $1 and $@ are the fake uname's own
printf '#!/bin/sh\ncase "$1" in -m) echo mips64 ;; *) exec /usr/bin/uname "$@" ;; esac\n' >"$WORK/fakebin/uname"
chmod 0755 "$WORK/fakebin/uname"
expect_fail "unsupported CPU" "unsupported CPU architecture: mips64" -- env PATH="$WORK/fakebin:$PATH" INSTALL_DIR="$WORK/inst9" sh "$INSTALL_SH"
expect_fail "unwritable INSTALL_DIR" "cannot" -- env INSTALL_DIR=/proc/flightdeck-cannot-exist sh "$INSTALL_SH"

echo "INSTALL.SH TESTS OK"
