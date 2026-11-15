#!/bin/sh
# Installs the flightdeck binary from a GitHub release.
#
#   curl -fsSL https://flightdeck-hq.com/install.sh | sh
#
# The project's site serves a copy of this file (docs/install.sh, which
# CI keeps identical to install.sh on the repository's main branch). If
# the site is unreachable, the repository serves the same script:
# https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.sh
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
# fetched over TLS, from the project's site or from the repository, and
# is not signed; read it before piping it to sh.
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
#   FLIGHTDECK_CONNECT      which coding agents to connect to Flightdeck once the
#                           binary is installed, without asking: agent ids
#                           separated by commas (claude-code), all (every agent
#                           found that is not connected yet) or none. Unset, the
#                           script asks on the terminal for each agent it finds,
#                           and prints the command to run instead when there is
#                           no terminal. Connecting runs `flightdeck connect`; a
#                           connect that fails never fails the install. An agent
#                           too old to connect is never connected: the script
#                           says to update it first.
#   FLIGHTDECK_CONNECT_ASK_TIMEOUT  seconds the connect question waits for an
#                           answer (default 60; no answer is a no). Only
#                           scripts/test-install-sh.sh sets it, to shorten a
#                           run that leaves the question unanswered.
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
      fail "on Windows, run install.ps1 (irm https://flightdeck-hq.com/install.ps1 | iex) or download the .zip from ${REPO_URL}/releases" ;;
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

# ---- coding agents ------------------------------------------------------
#
# The binary knows which coding agents it can connect and how
# (`flightdeck connect`); this script only asks. `flightdeck connect
# --detected` prints one line per agent found on this machine: its id,
# connected, not-connected or outdated (found, too old to connect), and
# its name, separated by tabs. This script is fetched fresh for every
# install, so it is never older than the binary it installs; a binary
# older than it (pinned with VERSION) prints only connected and
# not-connected, which it reads as before.

TAB="$(printf '\t')"
# The lines printed after the install's own next step.
CONNECT_HINTS=""
# Set when the binary answers `connect --detected`; an older release,
# pinned with VERSION, does not know the command.
CONNECT_KNOWN=""
CONNECT_FOUND=""

# A person can answer when /dev/tty opens: under `curl | sh` stdin is
# the script itself, so the question and the answer go through the
# terminal, and with no terminal (CI, a pipe from cron) nothing is asked.
can_ask() {
  (: </dev/tty >/dev/tty) 2>/dev/null && in_foreground
}

# in_foreground: this shell's process group is the terminal's foreground
# group. An install sent to the background (`curl ... | sh &`) would be
# stopped by the terminal as soon as it read from it, so it asks nothing.
# Where ps cannot tell (BusyBox's has no tpgid), the question is asked
# and its timeout bounds it.
in_foreground() {
  pgid="$(ps -o pgid= -p "$$" 2>/dev/null)" || return 0
  tpgid="$(ps -o tpgid= -p "$$" 2>/dev/null)" || return 0
  pgid="${pgid##* }"
  tpgid="${tpgid##* }"
  [ -z "$pgid" ] || [ -z "$tpgid" ] || [ "$pgid" = "$tpgid" ]
}

# How long the question waits for an answer. A person at the terminal
# answers in seconds; an install left running in a window nobody watches
# is not held for ever, and no answer is a no. The test shortens it with
# FLIGHTDECK_CONNECT_ASK_TIMEOUT (digits only; anything else is ignored).
ASK_TIMEOUT_SECS=60
case "${FLIGHTDECK_CONNECT_ASK_TIMEOUT:-}" in
  '' | *[!0-9]*) ;;
  *) ASK_TIMEOUT_SECS="$FLIGHTDECK_CONNECT_ASK_TIMEOUT" ;;
esac
# `flightdeck connect <id> --dry-run` exits with this status when the plan
# needs a person's yes on a terminal (a caution, such as a plugin from a
# marketplace other than this repository's): the installer does not ask
# then, since its connect passes --yes, which refuses such a plan.
CONNECT_NEEDS_CONFIRMATION=4
# `flightdeck connect <id>` exits with this status when the agent is too
# old for it: running it again fails the same way until the agent is
# updated, so the script says to update it, not to try again later.
CONNECT_OUTDATED=5

# ask_yes QUESTION: yes for an empty answer, y or yes; anything else, end
# of input, or no answer within ASK_TIMEOUT_SECS, is no. POSIX read has
# no timeout, so the answer is read by a background reader that is
# killed when the time is up.
ask_yes() {
  printf '%s [Y/n] ' "$1" >/dev/tty
  answer_file="${tmp}/connect-answer"
  rm -f "$answer_file"
  (IFS= read -r line </dev/tty && printf '%s' "$line" >"$answer_file") &
  reader=$!
  waited=0
  while kill -0 "$reader" 2>/dev/null; do
    if [ "$waited" -ge "$ASK_TIMEOUT_SECS" ]; then
      kill -KILL "$reader" 2>/dev/null || true
      printf '\nNo answer in %s seconds: not connecting.\n' "$ASK_TIMEOUT_SECS" >/dev/tty
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$reader" 2>/dev/null || true
  if [ ! -f "$answer_file" ]; then
    printf '\n' >/dev/tty
    return 1
  fi
  answer="$(cat "$answer_file")"
  case "$answer" in
    '' | [Yy] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# agent_id WORD: WORD has the form of an agent id (lower-case letters,
# digits and -), the only form that is passed on to the binary.
agent_id() {
  case "$1" in
    '' | *[!a-z0-9-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# hint NAME ID keeps the line that tells how to connect an agent later.
hint() {
  CONNECT_HINTS="${CONNECT_HINTS}To connect $1: flightdeck connect $2
"
}

# outdated_hint NAME ID keeps that line for an agent too old to connect:
# it is updated first. The binary's `flightdeck connect` says how.
outdated_hint() {
  CONNECT_HINTS="${CONNECT_HINTS}To connect $1: update it (this version is too old for flightdeck connect), then run flightdeck connect $2
"
}

# connect_one BIN ID NAME runs the connect. Its stdin is /dev/null, so
# nothing it starts can read the rest of a piped script, and its failure
# is reported, never fatal: the binary is installed either way.
connect_one() {
  if "$1" connect "$2" --yes </dev/null; then
    return 0
  else
    connect_status=$?
  fi
  if [ "$connect_status" -eq "$CONNECT_OUTDATED" ]; then
    info "Connecting $3 needs a newer $3 (see above): update it, then run flightdeck connect $2"
    return 0
  fi
  info "Connecting $3 did not finish (see above); run it again later: flightdeck connect $2"
}

# name_of ID prints the agent's name from the detected lines, else ID.
name_of() {
  found_name="$1"
  while IFS="$TAB" read -r line_id _ line_name _; do
    if [ "$line_id" = "$1" ] && [ -n "$line_name" ]; then found_name="$line_name"; fi
  done <<DETECTED
$detected
DETECTED
  printf '%s' "$found_name"
}

# state_of ID prints the agent's state from the detected lines, "" when
# it has none.
state_of() {
  found_state=""
  while IFS="$TAB" read -r line_id line_state _; do
    if [ "$line_id" = "$1" ]; then found_state="$line_state"; fi
  done <<DETECTED
$detected
DETECTED
  printf '%s' "$found_state"
}

# connect_agents BIN offers to connect each agent found, or connects
# the ones FLIGHTDECK_CONNECT names.
connect_agents() {
  detected="$("$1" connect --detected </dev/null 2>/dev/null)" || return 0
  CONNECT_KNOWN=1
  # The value's words, separated by commas or spaces, joined by commas:
  # " claude-code, other " is claude-code,other and " all " is all.
  choice=""
  old_ifs="$IFS"
  IFS=', '
  set -f
  for word in ${FLIGHTDECK_CONNECT:-}; do
    choice="${choice:+$choice,}$word"
  done
  set +f
  IFS="$old_ifs"
  case "$choice" in
    '' | all | none) ;;
    *)
      old_ifs="$IFS"
      IFS=,
      set -f
      for id in $choice; do
        IFS="$old_ifs"
        [ -n "$id" ] || continue
        CONNECT_FOUND=1
        # Named or not, an agent too old to connect is not connected.
        if agent_id "$id" && [ "$(state_of "$id")" = outdated ]; then
          outdated_hint "$(name_of "$id")" "$id"
          continue
        fi
        info ""
        if ! agent_id "$id"; then
          info "FLIGHTDECK_CONNECT names something that is not an agent id (lower-case letters, digits and -); skipped it"
          continue
        fi
        connect_one "$1" "$id" "$(name_of "$id")"
      done
      set +f
      IFS="$old_ifs"
      return 0
      ;;
  esac
  [ -n "$detected" ] || return 0
  asked=""
  while IFS="$TAB" read -r id state name _; do
    agent_id "$id" || continue
    CONNECT_FOUND=1
    if [ "$state" = connected ]; then
      info ""
      info "$name is already connected to Flightdeck."
      continue
    fi
    # Too old to connect: nothing to plan or ask, whatever the choice.
    if [ "$state" = outdated ]; then
      outdated_hint "$name" "$id"
      continue
    fi
    case "$choice" in
      all)
        info ""
        connect_one "$1" "$id" "$name"
        ;;
      none) hint "$name" "$id" ;;
      *)
        if [ -z "$asked" ]; then
          if can_ask; then asked=yes; else asked=no; fi
        fi
        if [ "$asked" = yes ]; then
          info ""
          # What connecting changes and what the agent's integration then
          # records, in the binary's words, before the question; when the
          # binary cannot say (it printed why), nothing is asked.
          if "$1" connect "$id" --dry-run </dev/null; then
            plan_status=0
          else
            plan_status=$?
          fi
          if [ "$plan_status" -eq "$CONNECT_NEEDS_CONFIRMATION" ]; then
            info "Connecting $name needs your own yes (see the caution above): run flightdeck connect $id yourself, which shows it and asks."
            continue
          fi
          if [ "$plan_status" -eq 0 ] && ask_yes "Connect $name to Flightdeck?"; then
            connect_one "$1" "$id" "$name"
            continue
          fi
        fi
        hint "$name" "$id"
        ;;
    esac
  done <<DETECTED
$detected
DETECTED
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
  connect_agents "${dir}/${BINARY}"
  if on_path "$dir"; then
    info ""
    info "Next: run \`flightdeck\` and open the URL it prints."
  else
    info ""
    info "${dir} is not on your PATH. Add it (for example in ~/.profile):"
    info "  export PATH=\"${dir}:\$PATH\""
    info "Then run \`flightdeck\` and open the URL it prints."
  fi
  if [ -n "$CONNECT_HINTS" ]; then
    printf '%s' "$CONNECT_HINTS"
  elif [ -n "$CONNECT_KNOWN" ] && [ -z "$CONNECT_FOUND" ]; then
    info "To connect a coding agent later: flightdeck connect (it lists the agents it can connect)"
  fi
}

main "$@"
