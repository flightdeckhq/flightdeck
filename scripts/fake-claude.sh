#!/bin/sh
# A stand-in for Claude Code's `claude` CLI, for the tests of
# `flightdeck connect` (internal/connect), of the installers
# (scripts/test-install-sh.sh) and for the install gate, whose runners
# have no Claude Code. Copy it onto PATH as `claude`.
#
# It answers the commands the Claude Code connector runs, with the
# output shapes Claude Code 2.1.325 prints, and nothing else (any other
# command exits 64). It keeps the plugin's state as files in
# $FAKE_CLAUDE_STATE, which a test may also create beforehand:
#   marketplace   the flightdeck-plugins marketplace is declared; the file
#                 may hold its source as JSON members, for example
#                 "source":"directory","path":"/src/flightdeck" (empty:
#                 "source":"github","repo":"flightdeckhq/flightdeck")
#   installed     the flightdeck plugin is installed (user scope)
#   disabled      ... and turned off
#   server        the saved server option
#   token         the saved token (Claude Code keeps it in its credential store)
# Every call appends "argv: <arguments>" to $FAKE_CLAUDE_STATE/calls.log,
# and a call that reads stdin appends "stdin: <what it read>".
#
# FAKE_CLAUDE_OLD_CLI=1 answers as Claude Code 2.1.283 does, which has no
# `plugin configure` and no --json on `plugin marketplace add`: --version
# prints 2.1.283 (unless FAKE_CLAUDE_VERSION says otherwise), `plugin
# configure --help` prints the help of `claude plugin` with exit status 0,
# `plugin marketplace add --help` names no --json, and the commands it
# lacks are refused as its argument parser refuses them, before anything
# runs: "error: unknown command 'configure'" or "error: unknown option
# '--json'" on stderr, nothing on stdout, exit status 1.
#
# Faults, as comma-separated step names (version, configure-help,
# marketplace-add-help, list, marketplace-list, marketplace-add, install,
# enable, configure-read, configure, uninstall):
#   FAKE_CLAUDE_FAIL   those steps fail as Claude Code fails: a --json
#                      result line with outcome "failed", a line on
#                      stderr, exit status 1
#   FAKE_CLAUDE_HANG   those steps never answer (they sleep
#                      FAKE_CLAUDE_HANG_SECS, default 600)
#   FAKE_CLAUDE_HANG_CHILD  those steps start a child that keeps the
#                      output open and then wait for it, as a CLI whose
#                      git clone hangs does; the child's pid goes to
#                      $FAKE_CLAUDE_STATE/child.pid
set -eu

state="${FAKE_CLAUDE_STATE:?FAKE_CLAUDE_STATE must name the stand-in state directory}"
mkdir -p "$state"
log="$state/calls.log"
{
  printf 'argv:'
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
} >>"$log"

plugin=flightdeck@flightdeck-plugins
case "$*" in
  --version) step=version ;;
  "plugin configure --help") step=configure-help ;;
  "plugin marketplace add --help") step=marketplace-add-help ;;
  "plugin list --json") step=list ;;
  "plugin marketplace list --json") step=marketplace-list ;;
  "plugin marketplace add flightdeckhq/flightdeck --json") step=marketplace-add ;;
  "plugin install $plugin --scope user --json") step=install ;;
  "plugin enable $plugin") step=enable ;;
  "plugin configure $plugin --json") step=configure-read ;;
  "plugin configure $plugin --values-stdin --json") step=configure ;;
  "plugin uninstall $plugin --scope user --json") step=uninstall ;;
  *) echo "fake claude: unexpected command: $*" >&2; exit 64 ;;
esac

listed() { case ",$1," in *",$step,"*) return 0 ;; *) return 1 ;; esac; }
if listed "${FAKE_CLAUDE_HANG:-}"; then exec sleep "${FAKE_CLAUDE_HANG_SECS:-600}"; fi
if listed "${FAKE_CLAUDE_HANG_CHILD:-}"; then
  sleep "${FAKE_CLAUDE_HANG_SECS:-600}" &
  echo "$!" >"$state/child.pid"
  wait
fi
fail() {
  printf '{"command":"%s","outcome":"failed","plugin":"%s","message":"%s"}\n' "$step" "$plugin" "$1"
  printf 'x Failed: %s\n' "$1" >&2
  exit 1
}
if listed "${FAKE_CLAUDE_FAIL:-}"; then fail "simulated $step failure"; fi

json_value() { sed -n "s/.*\"$1\" *: *\"\\([^\"]*\\)\".*/\\1/p"; }

# old: the stand-in answers as Claude Code 2.1.283. refuse WHAT: its
# argument parser's refusal of an unknown command or option.
old=""
[ -z "${FAKE_CLAUDE_OLD_CLI:-}" ] || old=1
refuse() {
  printf 'error: unknown %s\n' "$1" >&2
  exit 1
}

case "$step" in
  version)
    if [ -n "$old" ]; then
      echo "${FAKE_CLAUDE_VERSION:-2.1.283 (Claude Code)}"
    else
      echo "${FAKE_CLAUDE_VERSION:-2.1.325 (Claude Code)}"
    fi
    ;;
  configure-help)
    if [ -n "$old" ]; then
      # No configure command: the help of `claude plugin`, exit status 0.
      cat <<'HELP'
Usage: claude plugin|plugins [options] [command]

Manage Claude Code plugins

Options:
  -h, --help                           Display help for command

Commands:
  disable [options] [plugin]           Disable an enabled plugin
  enable [options] <plugin>            Enable a disabled plugin
  install|i [options] <plugin>         Install a plugin from available
                                       marketplaces (use plugin@marketplace for
                                       specific marketplace)
  list [options]                       List installed plugins
  marketplace                          Manage Claude Code marketplaces
  uninstall|remove [options] <plugin>  Uninstall an installed plugin
  update [options] <plugin>            Update a plugin to the latest version
                                       (restart required to apply)
HELP
    else
      cat <<'HELP'
Usage: claude plugin configure [options] <plugin>

Show a plugin's options and which are unset, or save values from stdin with
--values-stdin

Options:
  -h, --help      Display help for command
  --json          Output as JSON
  --values-stdin  Read option values from stdin as a JSON object of single-line
                  strings; options left out keep their values
HELP
    fi
    ;;
  marketplace-add-help)
    cat <<'HELP'
Usage: claude plugin marketplace add [options] <source>

Add a marketplace from a URL, path, or GitHub repo

Options:
  --claudeai           Add the marketplace of this name that claude.ai hosts for
                       you, by its listed name or its local name (see: claude
                       plugin marketplace list)
  -h, --help           Display help for command
HELP
    if [ -z "$old" ]; then
      cat <<'HELP'
  --json               Print one machine-readable result line as the last line
                       on stdout (same exit codes)
HELP
    fi
    cat <<'HELP'
  --scope <scope>      Where to declare the marketplace: user (default),
                       project, or local
  --sparse <paths...>  Limit checkout to specific directories via git
                       sparse-checkout (for monorepos). Example: --sparse
                       .claude-plugin plugins
HELP
    ;;
  list)
    other='{"id":"other@elsewhere","version":"1.0.0","scope":"user","enabled":true,"projectEnabled":false,"hasUserConfig":false}'
    if [ -e "$state/installed" ]; then
      enabled=true
      [ ! -e "$state/disabled" ] || enabled=false
      printf '[\n  %s,\n  {"id":"%s","version":"0.9.0","scope":"user","enabled":%s,"installPath":"%s/cache","projectEnabled":false,"hasUserConfig":true}\n]\n' \
        "$other" "$plugin" "$enabled" "$state"
    else
      printf '[\n  %s\n]\n' "$other"
    fi
    ;;
  marketplace-list)
    if [ -e "$state/marketplace" ]; then
      source_members="$(cat "$state/marketplace")"
      [ -n "$source_members" ] || source_members='"source":"github","repo":"flightdeckhq/flightdeck"'
      printf '[\n  {"name":"flightdeck-plugins",%s,"installLocation":"%s/marketplace"}\n]\n' "$source_members" "$state"
    else
      printf '[]\n'
    fi
    ;;
  marketplace-add)
    [ -z "$old" ] || refuse "option '--json'"
    : >"$state/marketplace"
    printf '{"command":"marketplace-add","outcome":"ok","marketplace":"flightdeck-plugins","message":"Cloning...\\nSuccessfully added marketplace: flightdeck-plugins (declared in user settings)"}\n'
    ;;
  install)
    [ -e "$state/marketplace" ] || fail "Plugin \\\"flightdeck\\\" not found in marketplace \\\"flightdeck-plugins\\\""
    : >"$state/installed"
    rm -f "$state/disabled"
    printf '{"command":"install","outcome":"ok","plugin":"%s","pluginId":"%s","scope":"user","message":"Successfully installed plugin: %s (scope: user)","unsetOptionCount":3}\n' \
      "$plugin" "$plugin" "$plugin"
    ;;
  enable)
    [ -e "$state/installed" ] || fail "Plugin \\\"$plugin\\\" is not installed"
    [ -e "$state/disabled" ] || fail "Plugin \\\"$plugin\\\" is already enabled"
    rm -f "$state/disabled"
    echo "Successfully enabled plugin: flightdeck (scope: user)"
    ;;
  configure-read)
    [ -z "$old" ] || refuse "command 'configure'"
    [ -e "$state/installed" ] || { echo "No installed plugin has the id \"$plugin\"." >&2; exit 1; }
    server=""
    [ ! -e "$state/server" ] || server="$(cat "$state/server")"
    configured=""
    [ -z "$server" ] || configured='"server"'
    if [ -e "$state/token" ]; then configured="${configured:+$configured,}\"token\""; fi
    printf '{\n  "pluginId": "%s",\n  "inputs": {"server": "%s", "token": "", "enforcement": "false"},\n  "configured": [%s]\n}\n' \
      "$plugin" "$server" "$configured"
    ;;
  configure)
    # Refused before stdin is read, as the parser refuses it.
    [ -z "$old" ] || refuse "command 'configure'"
    [ -e "$state/installed" ] || { echo "No installed plugin has the id \"$plugin\"." >&2; exit 1; }
    body="$(cat)"
    printf 'stdin: %s\n' "$body" >>"$log"
    saved=""
    # The server option is saved when the object has a server member, as
    # json_value's pattern reads one (an empty value is saved empty):
    # Claude Code parses the object and saves the options it names, so
    # the word "server" as another member's value is not that option.
    if printf '%s' "$body" | grep -q '"server" *: *"'; then
      printf '%s' "$body" | json_value server >"$state/server"
      saved='"server"'
    fi
    token="$(printf '%s' "$body" | json_value token)"
    # Claude Code keeps a saved token when it is given an empty one.
    if [ -n "$token" ]; then
      printf '%s' "$token" >"$state/token"
      saved="${saved:+$saved,}\"token\""
    fi
    printf '{\n  "pluginId": "%s",\n  "saved": [%s]\n}\n' "$plugin" "$saved"
    ;;
  uninstall)
    [ -e "$state/installed" ] || fail "Plugin \\\"$plugin\\\" not found in installed plugins"
    rm -f "$state/installed" "$state/disabled" "$state/server" "$state/token"
    printf '{"command":"uninstall","outcome":"ok","plugin":"%s","pluginId":"%s","scope":"user","keptData":false,"message":"Successfully uninstalled plugin: flightdeck (scope: user)"}\n' \
      "$plugin" "$plugin"
    ;;
esac
