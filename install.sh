#!/bin/sh
# Installs the flightdeck binary from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.sh | sh
#
# Detects the operating system and CPU, downloads the matching release
# archive and the release's checksums.txt, verifies the archive, and
# installs `flightdeck` into /usr/local/bin when that is writable by this
# user, else into ~/.local/bin. No sudo is run; a directory this user
# cannot write to is reported, not forced.
#
# Overrides, as environment variables:
#   VERSION                 a release tag (v1.2.3); default: the latest release
#   INSTALL_DIR             where the binary goes; default: /usr/local/bin or ~/.local/bin
#   FLIGHTDECK_RELEASE_URL  the repository URL the release assets hang off
#                           (default https://github.com/flightdeckhq/flightdeck);
#                           a local server with the same layout tests this script
#
# POSIX sh: it runs under dash, bash, zsh and BusyBox ash. Windows users
# run install.ps1 instead (or download the .zip from the release page).
set -eu

REPO_URL="${FLIGHTDECK_RELEASE_URL:-https://github.com/flightdeckhq/flightdeck}"
BINARY="flightdeck"

info() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# ---- platform ---------------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "on Windows, run install.ps1 (irm https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.ps1 | iex) or download the .zip from ${REPO_URL}/releases" ;;
    *) fail "unsupported operating system: $(uname -s) (releases cover Linux, macOS and Windows)" ;;
  esac
}

detect_arch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported CPU architecture: $arch (releases cover amd64 and arm64)" ;;
  esac
  # A shell running under Rosetta on Apple silicon reports x86_64; the
  # native binary is the right one.
  if [ "$arch" = amd64 ] && [ "$(uname -s)" = Darwin ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  echo "$arch"
}

# ---- download and verify ----------------------------------------------

fetch() {
  # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "neither curl nor wget is installed"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else
    fail "no sha256sum, shasum or openssl to verify the download"
  fi
}

# ---- install location -------------------------------------------------

choose_install_dir() {
  if [ -n "${INSTALL_DIR:-}" ]; then
    echo "$INSTALL_DIR"
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    echo /usr/local/bin
  else
    echo "${HOME}/.local/bin"
  fi
}

on_path() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- main ---------------------------------------------------------------

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="${BINARY}_${os}_${arch}.tar.gz"

  if [ -n "${VERSION:-}" ]; then
    case "$VERSION" in
      v*) ;;
      *) VERSION="v${VERSION}" ;;
    esac
    base="${REPO_URL}/releases/download/${VERSION}"
    info "Installing flightdeck ${VERSION} for ${os}/${arch}"
  else
    base="${REPO_URL}/releases/latest/download"
    info "Installing the latest flightdeck release for ${os}/${arch}"
  fi

  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t flightdeck)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  info "Downloading ${base}/${asset}"
  fetch "${base}/${asset}" "${tmp}/${asset}"
  fetch "${base}/checksums.txt" "${tmp}/checksums.txt"

  expected="$(grep " ${asset}\$" "${tmp}/checksums.txt" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "checksums.txt has no entry for ${asset}"
  actual="$(sha256_of "${tmp}/${asset}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
  info "Checksum verified"

  tar -xzf "${tmp}/${asset}" -C "$tmp" "$BINARY"

  dir="$(choose_install_dir)"
  mkdir -p "$dir" 2>/dev/null || fail "cannot create ${dir}; set INSTALL_DIR to a directory you can write to"
  [ -w "$dir" ] || fail "cannot write to ${dir}; set INSTALL_DIR to a directory you can write to"
  # install(1) copies and sets the mode in one step; the fallback keeps
  # the script working on a system without it.
  if command -v install >/dev/null 2>&1; then
    install -m 0755 "${tmp}/${BINARY}" "${dir}/${BINARY}"
  else
    cp "${tmp}/${BINARY}" "${dir}/${BINARY}" && chmod 0755 "${dir}/${BINARY}"
  fi

  info "Installed $("${dir}/${BINARY}" --version) to ${dir}/${BINARY}"
  # Under GitHub Actions, later steps find the binary without a PATH edit.
  if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$dir" >>"$GITHUB_PATH"
  fi
  if on_path "$dir"; then
    info ""
    info "Next: run \`flightdeck\` and open the URL it prints."
  else
    info ""
    info "${dir} is not on your PATH. Add it (for example in ~/.profile):"
    info "  export PATH=\"${dir}:\$PATH\""
    info "Then run \`flightdeck\` and open the URL it prints."
  fi
}

main "$@"
