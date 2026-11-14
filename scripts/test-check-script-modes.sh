#!/usr/bin/env bash
# Self-test of scripts/check-script-modes.sh on fixture repositories: a
# script run by its path from the Makefile or a workflow must be
# committed executable; one handed to an interpreter or a tool need not
# be; and the repository itself passes.
#
# Usage: scripts/test-check-script-modes.sh   (CI runs it in the scripts job)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-script-modes.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

status=0
fail() { echo "FAIL: $1" >&2; status=1; }

# fixture: a new repository in $work/repo with an empty Makefile and
# workflow. The modes are set in the index, as the check reads them.
fixture() {
  rm -rf "$work/repo"
  mkdir -p "$work/repo/scripts" "$work/repo/.github/workflows"
  git -C "$work/repo" init -q
  git -C "$work/repo" config core.fileMode false
  printf 'all:\n' >"$work/repo/Makefile"
  printf 'jobs:\n  a:\n    steps:\n' >"$work/repo/.github/workflows/ci.yml"
}

# script <path> <+x|-x> [first line]: a tracked file with that mode.
script() {
  local path="$1" bit="$2" first="${3:-#!/usr/bin/env bash}"
  printf '%s\necho hi\n' "$first" >"$work/repo/$path"
  git -C "$work/repo" add -- "$path"
  git -C "$work/repo" update-index "--chmod=$bit" -- "$path"
}

make_line() { printf '\t%s\n' "$1" >>"$work/repo/Makefile"; }
workflow_line() { printf '      %s\n' "$1" >>"$work/repo/.github/workflows/ci.yml"; }

# expect <rc> <description> [text the output must carry]
expect() {
  local want="$1" what="$2" needle="${3:-}" rc=0
  git -C "$work/repo" add -- Makefile .github/workflows/ci.yml
  CHECK_ROOT="$work/repo" "$CHECK" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    fail "$what: exit $rc, want $want"
    sed 's/^/    /' "$work/out" >&2
  elif [ -n "$needle" ] && ! grep -qF -- "$needle" "$work/out"; then
    fail "$what: the output does not carry '$needle'"
    sed 's/^/    /' "$work/out" >&2
  else
    echo "ok: $what (exit $rc)"
  fi
}

fixture
script scripts/a.sh +x
make_line './scripts/a.sh prep v1.2.3'
expect 0 "an executable script run from the Makefile" "1 scripts run by path"

fixture
script scripts/a.sh -x
make_line './scripts/a.sh prep v1.2.3'
expect 1 "a 100644 script run from the Makefile" "scripts/a.sh is run by its path"

fixture
script scripts/b.sh -x
workflow_line '- run: scripts/b.sh run 127.0.0.1:4000'
expect 1 "a 100644 script in a workflow's run: key" "scripts/b.sh"

fixture
script scripts/b.sh -x
workflow_line '- run: |'
workflow_line '    GATE_EXPECT_DATABASE=Postgres scripts/b.sh run'
expect 1 "a 100644 script after an environment prefix" "scripts/b.sh"

fixture
script scripts/b.sh -x
workflow_line '- run: |'
workflow_line '    scripts/other.sh && scripts/b.sh'
expect 1 "a 100644 script after &&" "scripts/b.sh"

fixture
script scripts/b.sh -x
make_line '@if ! scripts/b.sh; then echo no; fi'
expect 1 "a 100644 script after if !" "scripts/b.sh"

fixture
script scripts/c.py -x '#!/usr/bin/env python3'
script scripts/d.sh -x
make_line 'python3 scripts/c.py check'
workflow_line '- run: shellcheck scripts/d.sh'
workflow_line '- run: bash scripts/d.sh'
expect 0 "100644 scripts handed to an interpreter or a tool" "0 scripts run by path"

fixture
script scripts/e.txt -x 'not a script'
make_line './scripts/e.txt'
expect 0 "a tracked file with no shebang"

fixture
script scripts/a.sh -x
workflow_line '# scripts/a.sh is described in a comment'
expect 0 "a script named only in a comment"

fixture
script scripts/c.py -x '#!/usr/bin/env python3'
workflow_line '- run: |'
workflow_line "    ruff check --config x.toml scripts/other.py \\"
workflow_line '      scripts/c.py scripts/test_c.py'
expect 0 "a 100644 script named on a continuation line, an argument"

fixture
script scripts/b.sh -x
workflow_line '- run: |'
workflow_line "    FOO=1 \\"
workflow_line '      scripts/b.sh run'
expect 1 "a 100644 script run after a continued environment prefix" "scripts/b.sh"

fixture
script scripts/b.sh -x
workflow_line '- run: |'
workflow_line "    # a comment that ends in a backslash \\"
workflow_line '    scripts/b.sh run'
expect 1 "a 100644 script run on the line after a comment that ends in a backslash" "scripts/b.sh"

fixture
script scripts/b.sh -x
make_line "@echo the Makefile ends in a continuation \\"
printf -- '- run: scripts/b.sh run\n' >"$work/repo/.github/workflows/ci.yml"
expect 1 "a 100644 script on a file's first line after a file that ends in a backslash" "scripts/b.sh"

fixture
script scripts/a.sh -x
workflow_line '- name: Gate (scripts/a.sh binary)'
workflow_line '  if: matrix.channel == 1 || scripts/a.sh'
expect 0 "a script named in a step's name and condition"

rc=0
"$CHECK" >"$work/out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then
  fail "the repository itself: exit $rc"
  sed 's/^/    /' "$work/out" >&2
else
  echo "ok: the repository itself ($(cat "$work/out"))"
fi

if [ "$status" -ne 0 ]; then
  echo "check-script-modes self-test FAILED" >&2
  exit 1
fi
echo "check-script-modes self-test passed"
