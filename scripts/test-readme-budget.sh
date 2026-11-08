#!/usr/bin/env bash
# Self-test of scripts/readme-budget.sh on fixture READMEs: a README
# within budget passes and its counts are the expected ones; one over
# the Quickstart budget, one over the total, one over the line budget
# and one missing a budgeted section each fail and name the reason;
# --report prints the same counts and exits 0 on the over-budget file.
# The fixtures pin the counting rule: bash, sh, shell, console and text
# fences count, python and yaml fences do not, blank and comment lines
# inside a fence do not, and an indented fence inside a list item does.
#
# Usage: scripts/test-readme-budget.sh   (CI runs it in the scripts job)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUDGET="$ROOT/scripts/readme-budget.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

status=0
fail() { echo "FAIL: $1" >&2; status=1; }

# expect <rc> <description> <args...>: runs the budget script and
# compares its exit code; the output is kept in $work/out for the
# content checks below.
expect() {
  local want="$1" what="$2" rc=0
  shift 2
  "$BUDGET" "$@" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -ne "$want" ]; then
    fail "$what: exit $rc, want $want"
    sed 's/^/    /' "$work/out" >&2
  else
    echo "ok: $what (exit $rc)"
  fi
}

# expect_output <pattern> <description>: the last run's output contains
# the pattern (grep -E).
expect_output() {
  if grep -Eq -- "$1" "$work/out"; then
    echo "ok: $2"
  else
    fail "$2: output lacks '$1':"
    sed 's/^/    /' "$work/out" >&2
  fi
}

# A README within budget. Quickstart: 3 counted lines (bash, text and
# an indented sh fence in a list); the python fence, the comment and the
# blank line are not counted. Self-hosting: 4 (console and bash fences;
# the yaml fence is not counted). Preamble: 0.
cat >"$work/good.md" <<'EOF'
# Fixture

Some text before the first section.

```yaml
not: counted
```

## Quickstart

```bash
curl -fsSL https://example.invalid/install.sh | sh
```

```text
/plugin install example
```

- A list item with its own fence:

  ```sh
  # a comment does not count

  flightdeck
  ```

```python
import flightdeck_sensor
flightdeck_sensor.init(server="http://localhost:4000/ingest", token="tok_dev")
```

## Self-hosting

```console
flightdeck --domain example.com
flightdeck --database-url postgres://u:p@h/db
```

```yaml
image: not/counted
```

```bash
docker run example
helm install example
```

## License

Apache 2.0.
EOF

expect 0 "a README within budget passes" "$work/good.md"
expect_output '^ +3 +Quickstart$' "Quickstart counts 3 (bash, text and an indented sh fence; python, comments and blanks excluded)"
expect_output '^ +4 +Self-hosting$' "Self-hosting counts 4 (console and bash; yaml excluded)"
expect_output '^ +0 +\(preamble\)$' "the preamble's yaml fence is not counted"
expect_output 'Total +7 \(budget' "the total is 7"
expect_output 'README within budget' "the verdict is printed"

# Over the Quickstart budget: one bash fence with four commands.
cat >"$work/quickstart.md" <<'EOF'
## Quickstart

```bash
git clone https://example.invalid/repo
cd repo
make dev
open http://localhost:4000
```

## Self-hosting

```bash
flightdeck --domain example.com
```
EOF
expect 1 "four Quickstart commands fail" "$work/quickstart.md"
expect_output 'OVER BUDGET: Quickstart has 4 command lines, budget 3' "the failure names Quickstart and the counts"
expect 0 "--report prints the same file without failing" --report "$work/quickstart.md"
expect_output 'report mode: not failing' "--report says so"

# Over the total budget while every section is within its own: 21
# commands spread over sections with no per-section budget.
{
  echo "## Quickstart"
  echo
  echo '```bash'
  echo "flightdeck"
  echo '```'
  echo
  echo "## Self-hosting"
  echo
  echo '```bash'
  echo "flightdeck --domain example.com"
  echo '```'
  echo
  echo "## Exporters"
  echo
  echo '```bash'
  for i in $(seq 1 19); do echo "export VAR_$i=$i"; done
  echo '```'
} >"$work/total.md"
expect 1 "21 commands in total fail" "$work/total.md"
expect_output 'OVER BUDGET: 21 command lines in total, budget 20' "the failure names the total"

# Over the line budget with no commands at all.
{
  echo "## Quickstart"
  echo "## Self-hosting"
  for i in $(seq 1 299); do echo "line $i"; done
} >"$work/long.md"
expect 1 "301 lines fail" "$work/long.md"
expect_output 'OVER BUDGET: 301 lines, budget 300' "the failure names the line count"

# A README without a budgeted section fails: the budget cannot be
# measured, and a renamed heading must not pass silently.
cat >"$work/nosection.md" <<'EOF'
## Try it

```bash
flightdeck
```
EOF
expect 1 "a README without the budgeted sections fails" "$work/nosection.md"
expect_output 'no "## Quickstart" section' "the failure names the missing section"

# The section heading is matched case-insensitively and a fence with
# attributes after the language still counts.
cat >"$work/case.md" <<'EOF'
## QUICKSTART

```bash {.copy}
flightdeck
```

## Self-Hosting

```shell
flightdeck --domain example.com
```
EOF
expect 0 "headings match case-insensitively and a fence with attributes counts" "$work/case.md"
expect_output 'Quickstart +1 \(budget' "QUICKSTART is read as Quickstart"
expect_output 'Self-hosting +1 \(budget' "Self-Hosting is read as Self-hosting"

expect 2 "a missing file is exit 2" "$work/does-not-exist.md"

if [ "$status" -ne 0 ]; then
  echo "readme-budget self-test FAILED" >&2
  exit 1
fi
echo "readme-budget self-test OK"
