#!/bin/sh
# Installs the flightdeck binary from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.sh | sh
#
# Detects the operating system and CPU, downloads the matching release
# archive and the release's checksums.txt, verifies the archive against
# it, and installs `flightdeck` into /usr/local/bin when that is writable
# by this user, else into ~/.local/bin. No sudo is run; a directory this
# user cannot write to is reported, not forced.
#
# What is and is not verified: the archive's SHA-256 is checked against
# checksums.txt, which guards against a corrupt or truncated download.
# checksums.txt itself is signed by the release workflow with Sigstore
# (keyless, cosign; the bundle is checksums.txt.sigstore.json next to
# it). When `cosign` is installed, this script verifies that signature
# and refuses a release whose checksums were not produced by this
# repository's release workflow. Without cosign the signature is NOT
# checked, and the download is trusted as far as TLS to github.com is:
# install cosign (https://docs.sigstore.dev/cosign/system_config/installation/)
# before running this script to close that gap. This script is itself
# fetched over TLS from the repository; read it before piping it to sh.
#
# Overrides, as environment variables:
#   VERSION                 a release tag (v1.2.3); default: the latest release
#   INSTALL_DIR             where the binary goes; default: /usr/local/bin or ~/.local/bin
#   FLIGHTDECK_RELEASE_URL  the repository URL the release assets hang off
#                           (default https://github.com/flightdeckhq/flightdeck);
#                           a local server with the same layout tests this script.
#                           Downloads are HTTPS only, except from localhost; the
#                           signature is checked only for the default URL, since
#                           it names this repository's workflow as the signer.
#   FLIGHTDECK_RELEASE_SIGNED_URL  one more URL whose checksums.txt the signature
#                           check applies to. The default repository URL is
#                           always checked; this adds a URL, it never removes
#                           one. Only scripts/test-install-sh.sh sets it, to run
#                           the cosign path against its local server with a fake
#                           cosign.
#
# POSIX sh: it runs under dash, bash, zsh and BusyBox ash. Windows users
# run install.ps1 instead (or download the .zip from the release page).
set -eu

DEFAULT_REPO_URL="https://github.com/flightdeckhq/flightdeck"
REPO_URL="${FLIGHTDECK_RELEASE_URL:-$DEFAULT_REPO_URL}"
SIGNED_URL="${FLIGHTDECK_RELEASE_SIGNED_URL:-$DEFAULT_REPO_URL}"
BINARY="flightdeck"
# The signer of checksums.txt: this repository's release workflow,
# through GitHub's OIDC issuer. Any workflow file of the repository is
# accepted so a renamed workflow does not break older installs.
SIGNER_IDENTITY_RE='^https://github\.com/flightdeckhq/flightdeck/\.github/workflows/.+@refs/tags/v.+$'
SIGNER_ISSUER="https://token.actions.githubusercontent.com"

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

# Plain HTTP is accepted from this machine only (a local test server);
# everything else must be HTTPS, and the clients are told so, so a
# redirect cannot downgrade the connection either. The authority of an
# http:// URL is parsed, not pattern-matched: `http://localhost:x@evil`
# names evil with user info, so any `@` is refused, and the host must be
# exactly localhost, 127.0.0.1 or [::1], with an all-digit port at most.
check_scheme() {
  case "$REPO_URL" in
    https://*) return 0 ;;
    http://*) ;;
    *) fail "FLIGHTDECK_RELEASE_URL must be https:// (or http://localhost for a local test server): $REPO_URL" ;;
  esac
  authority="${REPO_URL#http://}"
  authority="${authority%%/*}"
  case "$authority" in
    *@* | *\?* | *\#*) fail "FLIGHTDECK_RELEASE_URL: plain HTTP is allowed for localhost only, and its authority may not carry user info: $REPO_URL" ;;
  esac
  case "$authority" in
    \[*) host="${authority%%\]*}]"; rest="${authority#*\]}" ;;
    *) host="${authority%%:*}"; rest="${authority#"$host"}" ;;
  esac
  case "$host" in
    localhost | 127.0.0.1 | '[::1]') ;;
    *) fail "FLIGHTDECK_RELEASE_URL must be https:// (plain HTTP is allowed for localhost, 127.0.0.1 or [::1] only): $REPO_URL" ;;
  esac
  case "$rest" in
    '') ;;
    :*) port="${rest#:}"
        case "$port" in
          '' | *[!0-9]*) fail "FLIGHTDECK_RELEASE_URL: the port must be digits: $REPO_URL" ;;
        esac ;;
    *) fail "FLIGHTDECK_RELEASE_URL: unexpected authority: $REPO_URL" ;;
  esac
}

fetch() {
  # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then
    # --proto-redir: a redirect from the local test server may not land
    # on plain HTTP elsewhere either.
    case "$1" in
      https://*) curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 -o "$2" "$1" ;;
      *) curl -fsSL --proto '=http,https' --proto-redir '=https' --retry 3 -o "$2" "$1" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in
      https://*) wget -q --https-only -O "$2" "$1" ;;
      *) wget -q -O "$2" "$1" ;;
    esac
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

# verify_checksums_signature BASE DIR checks checksums.txt against its
# Sigstore bundle when cosign is available and the release comes from
# the default repository (the only signer the identity names). The check
# is skipped only for a release URL that is not the default one, so the
# test hook FLIGHTDECK_RELEASE_SIGNED_URL can add a URL to verify and
# cannot take verification away from the real repository.
verify_checksums_signature() {
  if [ "$REPO_URL" != "$DEFAULT_REPO_URL" ] && [ "$REPO_URL" != "$SIGNED_URL" ]; then
    info "Signature of checksums.txt not checked: FLIGHTDECK_RELEASE_URL is not the flightdeckhq/flightdeck release"
    return 0
  fi
  if ! command -v cosign >/dev/null 2>&1; then
    info "Signature of checksums.txt not checked: cosign is not installed (see the header of install.sh)"
    return 0
  fi
  fetch "$1/checksums.txt.sigstore.json" "$2/checksums.txt.sigstore.json"
  cosign verify-blob --bundle "$2/checksums.txt.sigstore.json" \
    --certificate-identity-regexp "$SIGNER_IDENTITY_RE" \
    --certificate-oidc-issuer "$SIGNER_ISSUER" \
    "$2/checksums.txt" >/dev/null 2>&1 ||
    fail "checksums.txt is not signed by the flightdeckhq/flightdeck release workflow; refusing to install"
  info "Signature of checksums.txt verified (Sigstore)"
}

# ---- install location -------------------------------------------------

choose_install_dir() {
  if [ -n "${INSTALL_DIR:-}" ]; then
    echo "$INSTALL_DIR"
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    echo /usr/local/bin
  elif [ -n "${HOME:-}" ]; then
    echo "${HOME}/.local/bin"
  else
    fail "/usr/local/bin is not writable and HOME is unset; set INSTALL_DIR"
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
  check_scheme
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
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  info "Downloading ${base}/${asset}"
  fetch "${base}/${asset}" "${tmp}/${asset}"
  fetch "${base}/checksums.txt" "${tmp}/checksums.txt"
  verify_checksums_signature "$base" "$tmp"

  expected="$(grep -F " ${asset}" "${tmp}/checksums.txt" | grep " ${asset}\$" | cut -d' ' -f1)"
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
