#!/usr/bin/env bash
# Checks the compose project every compose file in the repo renders as.
#
# Compose derives a project's name from the directory of its first file
# when nothing names it, and every compose file here is in docker/, so
# an unnamed one becomes project `docker`: the contributor dev stack's
# project, whose `docker_postgres_data` volume is a contributor's
# database. A `down -v` on such a file would delete it. So each file
# must render under the name listed here, only the dev stack's own file
# may render as `docker`, and a compose file that is not listed fails
# the check until it is.
#
# Usage: scripts/check-compose-projects.sh
# Needs the docker CLI with the compose plugin; no daemon, no network.
set -euo pipefail

cd "$(dirname "$0")/.."

# The project the dev stack's file is meant to render as
# (scripts/dev-stack.sh passes the same name with -p).
DEV_PROJECT=docker

FAILED=0
bad() {
  printf 'compose projects: %s\n' "$*" >&2
  FAILED=1
}

# rendered <file>...: the project name of the files layered in order,
# empty when they do not render.
rendered() {
  local -a args=()
  local f
  for f in "$@"; do args+=(-f "$f"); done
  # The Postgres overlay requires a password to render at all.
  POSTGRES_PASSWORD=check docker compose "${args[@]}" config 2>/dev/null | sed -n 's/^name: //p' || true
}

# expect <project> <file>...
expect() {
  local want="$1" got
  shift
  got="$(rendered "$@")"
  if [ "$got" != "$want" ]; then
    bad "$* renders as project '${got:-<does not render>}', want '$want'"
  fi
}

expect flightdeck docker/docker-compose.yml
expect flightdeck docker/docker-compose.yml docker/docker-compose.postgres.yml
expect flightdeck-split docker/docker-compose.split.yml
expect "$DEV_PROJECT" docker/docker-compose.dev.yml

# The Postgres overlay is not a stack by itself: alone it must not
# render, and never as the dev stack's project.
alone="$(rendered docker/docker-compose.postgres.yml)"
if [ -n "$alone" ]; then
  bad "docker/docker-compose.postgres.yml renders alone, as project '$alone': it is an overlay of docker-compose.yml"
fi

LISTED="docker/docker-compose.yml docker/docker-compose.postgres.yml docker/docker-compose.split.yml docker/docker-compose.dev.yml"
while IFS= read -r file; do
  case " $LISTED " in
    *" $file "*) ;;
    *) bad "$file is a compose file this check does not know: add it here with the project it must render as" ;;
  esac
done < <(git ls-files | grep -E '(^|/)(docker-)?compose[^/]*\.ya?ml$' || true)

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "compose projects: ok (only docker/docker-compose.dev.yml renders as '$DEV_PROJECT')"
