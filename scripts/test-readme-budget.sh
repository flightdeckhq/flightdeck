#!/usr/bin/env bash
# Self-test of scripts/readme-budget.sh on fixture READMEs.
#
# The budgets: a README within budget passes and its counts are the
# expected ones; one over the Quickstart budget, one over the
# Self-hosting budget, one over the total, one over the line budget and
# one missing a budgeted section each fail and name the reason;
# --report prints the same counts and exits 0 on an over-budget file.
#
# The counting rule, one fixture per clause of the script's header:
# every fence counts unless its language is a sample (powershell, zsh,
# cmd, an untagged fence, tilde fences, a fence in a blockquote or a
# list item, CRLF line endings); a chained line counts once per
# segment, a pipeline once, a wrapped command once; separators inside
# quotes and heredoc bodies do not count; a `###` subsection counts
# into its `## ` section. A fence or a heredoc left open, an unknown
# option and a second path are errors.
#
# Every count asserted here is non-zero except where a zero is the
# point, so a counter that returns 0 for everything fails this test.
#
# Usage: scripts/test-readme-budget.sh   (CI runs it in the
# marketplace-schema job, "Repo scripts and manifests")
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

# rule <count> <description>: reads the body of a Quickstart section on
# stdin, measures a README made of it and asserts the section's count.
# It runs in report mode, because a rule fixture may be over budget and
# only its count is under test.
rule() {
  local want="$1" what="$2" rc=0
  {
    echo "## Quickstart"
    echo
    cat
    echo
    echo "## Self-hosting"
  } >"$work/rule.md"
  "$BUDGET" --report "$work/rule.md" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && grep -Eq -- "^  Quickstart +$want \(budget" "$work/out"; then
    echo "ok: $what (counts $want)"
  else
    fail "$what: exit $rc, want a Quickstart count of $want:"
    sed 's/^/    /' "$work/out" >&2
  fi
}

# rule_error <pattern> <description>: as rule, for a body the script
# must refuse to measure: exit 1 and a message matching the pattern,
# in report mode as well, since a count that cannot be trusted is not
# a report.
rule_error() {
  local pattern="$1" what="$2" rc=0
  {
    echo "## Quickstart"
    echo
    cat
  } >"$work/rule.md"
  "$BUDGET" --report "$work/rule.md" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -eq 1 ] && grep -Eq -- "$pattern" "$work/out"; then
    echo "ok: $what (exit 1)"
  else
    fail "$what: exit $rc, want 1 and '$pattern':"
    sed 's/^/    /' "$work/out" >&2
  fi
}

# ---------------------------------------------------------------------
# The budgets.
# ---------------------------------------------------------------------

# A README within budget. Quickstart: 3 commands (bash, text and an
# indented sh fence in a list); the python fence, the comment and the
# blank line are not counted. Self-hosting: 4 (console and bash fences;
# the yaml fence is not counted). Preamble: 0.
cat >"$work/good.md" <<'FIXTURE'
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
FIXTURE

expect 0 "a README within budget passes" "$work/good.md"
expect_output '^ +3 +Quickstart$' "Quickstart counts 3 (bash, text and an indented sh fence; python, comments and blanks excluded)"
expect_output '^ +4 +Self-hosting$' "Self-hosting counts 4 (console and bash; yaml excluded)"
expect_output '^ +0 +\(preamble\)$' "the preamble's yaml fence is not counted"
expect_output 'Total +7 \(budget' "the total is 7"
expect_output 'README within budget' "the verdict is printed"

# Over the Quickstart budget: one bash fence with four commands.
cat >"$work/quickstart.md" <<'FIXTURE'
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
FIXTURE
expect 1 "four Quickstart commands fail" "$work/quickstart.md"
expect_output 'OVER BUDGET: Quickstart has 4 commands, budget 3' "the failure names Quickstart and the counts"
expect 0 "--report prints the same file without failing" --report "$work/quickstart.md"
expect_output 'report mode: not failing' "--report says so"

# Over the Self-hosting budget: seven commands, the last two chained on
# one line, so a line count of six would have let it through.
cat >"$work/selfhosting.md" <<'FIXTURE'
## Quickstart

```bash
flightdeck
```

## Self-hosting

```bash
flightdeck --domain example.com
flightdeck --database-url postgres://u:p@h/db
docker run example
docker compose up -d
helm install example
export FLIGHTDECK_TOKEN=ftd_example && flightdeck status
```
FIXTURE
expect 1 "seven Self-hosting commands fail" "$work/selfhosting.md"
expect_output 'OVER BUDGET: Self-hosting has 7 commands, budget 6' "the failure names Self-hosting and the counts"

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
expect_output 'OVER BUDGET: 21 commands in total, budget 20' "the failure names the total"

# Over the line budget with no commands at all.
{
  echo "## Quickstart"
  echo "## Self-hosting"
  for i in $(seq 1 299); do echo "line $i"; done
} >"$work/long.md"
expect 1 "301 lines fail" "$work/long.md"
expect_output 'OVER BUDGET: 301 lines, budget 300' "the failure names the line count"

# The same 301 lines with no newline after the last one: the last line
# is still a line. Counting newline characters would see 300 and pass.
{
  echo "## Quickstart"
  echo "## Self-hosting"
  for i in $(seq 1 298); do echo "line $i"; done
  printf 'line 299'
} >"$work/long-no-newline.md"
expect 1 "301 lines fail without a trailing newline" "$work/long-no-newline.md"
expect_output 'OVER BUDGET: 301 lines, budget 300' "the last line counts without its newline"

# A README without a budgeted section fails: the budget cannot be
# measured, and a renamed heading must not pass silently.
cat >"$work/nosection.md" <<'FIXTURE'
## Try it

```bash
flightdeck
```
FIXTURE
expect 1 "a README without the budgeted sections fails" "$work/nosection.md"
expect_output 'no "## Quickstart" section' "the failure names the missing section"

# The section heading is matched case-insensitively and a fence with
# attributes after the language still counts.
cat >"$work/case.md" <<'FIXTURE'
## QUICKSTART

```bash {.copy}
flightdeck
```

## Self-Hosting

```shell
flightdeck --domain example.com
```
FIXTURE
expect 0 "headings match case-insensitively and a fence with attributes counts" "$work/case.md"
expect_output 'Quickstart +1 \(budget' "QUICKSTART is read as Quickstart"
expect_output 'Self-hosting +1 \(budget' "Self-Hosting is read as Self-hosting"

# A `###` subsection is part of its `## ` section: its commands count
# against that section's budget and it gets no row of its own.
cat >"$work/subsection.md" <<'FIXTURE'
## Quickstart

```bash
flightdeck
```

### Coding agents

```text
/plugin install example
```

### Production agents

```bash
pip install example
```

## Self-hosting

### Docker

```bash
docker run example
```
FIXTURE
expect 0 "subsections count into their section" "$work/subsection.md"
expect_output '^ +3 +Quickstart$' "Quickstart counts the commands of its two subsections (3)"
expect_output '^ +1 +Self-hosting$' "Self-hosting counts the command of its subsection (1)"
if grep -Eq 'Coding agents|Production agents|Docker' "$work/out"; then
  fail "a ### subsection got a row of its own:"
  sed 's/^/    /' "$work/out" >&2
else
  echo "ok: a ### subsection has no row of its own"
fi

# ---------------------------------------------------------------------
# Which fences count.
# ---------------------------------------------------------------------

rule 1 "a powershell fence counts" <<'FIXTURE'
```powershell
irm https://example.invalid/install.ps1 | iex
```
FIXTURE

rule 1 "an untagged fence counts" <<'FIXTURE'
```
flightdeck
```
FIXTURE

rule 1 "a zsh fence counts" <<'FIXTURE'
```zsh
flightdeck
```
FIXTURE

rule 4 "ps1, cmd, shell-session and unknown tags count" <<'FIXTURE'
```ps1
flightdeck.exe
```

```cmd
flightdeck.exe
```

```shell-session
$ flightdeck
```

```some-future-shell
flightdeck
```
FIXTURE

rule 1 "a tilde fence counts" <<'FIXTURE'
~~~bash
flightdeck
~~~
FIXTURE

# A fence closes on its own character only: the backticks inside a
# tilde fence are content.
rule 2 "a tilde fence is not closed by backticks" <<'FIXTURE'
~~~
```
flightdeck
~~~
FIXTURE

# A fence closes on a run at least as long as the one that opened it:
# the three-backtick lines inside a four-backtick fence are content.
rule 3 "a four-backtick fence is not closed by three" <<'FIXTURE'
````bash
```
flightdeck
```
````
FIXTURE

rule 2 "a fence in a blockquote counts" <<'FIXTURE'
> A note:
>
> ```bash
> flightdeck
> flightdeck status
> ```
FIXTURE

rule 2 "a fence that opens on a list marker's line counts" <<'FIXTURE'
- ```bash
  flightdeck
  ```
1. ```bash
   flightdeck status
   ```
FIXTURE

# The end of a blockquote closes a fence left open inside it, as it
# does when the page is rendered, so the text after it is not counted
# and the next fence opens normally.
rule 2 "a blockquote that ends closes its fence" <<'FIXTURE'
> ```bash
> flightdeck
This paragraph is outside the quote.

```bash
flightdeck status
```
FIXTURE

rule 1 "inline code written with three backticks is not a fence" <<'FIXTURE'
Run ```flightdeck``` and then:
```bash
flightdeck status
```
FIXTURE

# No sample language counts, whatever its body looks like. This is the
# one fixture whose expected count is zero.
rule 0 "sample-language fences are not counted" <<'FIXTURE'
```python
import flightdeck_sensor; flightdeck_sensor.init()
```

```YAML
run: make dev && make test
```

```json
{"cmd": "a && b; c"}
```

```toml
cmd = "a && b"
```

```go
x := a && b
```

```diff
+ make dev && make test
```

```dockerfile
RUN make dev && make test
```

```sql
SELECT 1; SELECT 2;
```
FIXTURE

# CRLF line endings: the fences still open and close, the headings are
# still found (the run is not in report mode, so a missing section
# would fail it) and the counts are the same as with LF.
awk '{ printf "%s\r\n", $0 }' >"$work/crlf.md" <<'FIXTURE'
## Quickstart

```bash
flightdeck
flightdeck status && flightdeck stop
```

## Self-hosting

```bash
helm install example \
  --set a=b
```
FIXTURE
if [ "$(tr -d '\r' <"$work/crlf.md" | wc -c)" -eq "$(wc -c <"$work/crlf.md")" ]; then
  fail "the CRLF fixture has no carriage returns"
fi
expect 0 "a README with CRLF line endings is measured" "$work/crlf.md"
expect_output '^ +3 +Quickstart$' "CRLF: Quickstart counts 3"
expect_output '^ +1 +Self-hosting$' "CRLF: a wrapped command counts 1"

# ---------------------------------------------------------------------
# What a command is.
# ---------------------------------------------------------------------

rule 6 "&&, || and ; each separate commands" <<'FIXTURE'
```bash
make build && make install && make check; make clean
test -f config.yaml || touch config.yaml
```
FIXTURE

rule 3 "a lone & separates commands and a trailing one does not add one" <<'FIXTURE'
```bash
flightdeck & flightdeck status
flightdeck &
```
FIXTURE

rule 2 "separators inside quotes are not split" <<'FIXTURE'
```bash
echo "one; two && three || four" 'five; six & seven'
sh -c 'make build && make install'
```
FIXTURE

rule 3 "a pipeline is one command, and the & of a redirection is not a separator" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh
flightdeck 2>&1 | tee flightdeck.log
flightdeck &>flightdeck.log
```
FIXTURE

rule 1 ";; is not a separator" <<'FIXTURE'
```bash
case "$1" in start) flightdeck ;; esac
```
FIXTURE

rule 2 "a trailing comment hides the separators after it, and # inside a word does not start one" <<'FIXTURE'
```bash
flightdeck   # then: flightdeck status; flightdeck stop
open http://localhost:4000/#/fleet
```
FIXTURE

rule 1 "a command wrapped with backslashes counts once" <<'FIXTURE'
```bash
helm install flightdeck helm/ \
  --namespace flightdeck --create-namespace \
  --set api.corsOrigin="https://flightdeck.example.com"
```
FIXTURE

rule 3 "the segments of a wrapped line are counted after joining" <<'FIXTURE'
```bash
git clone https://example.invalid/repo \
  && cd repo \
  && make dev
```
FIXTURE

rule 2 "prompts are stripped, on continuation lines as well" <<'FIXTURE'
```console
$ flightdeck \
>   --domain example.com
$ flightdeck status
```
FIXTURE

# Heredoc bodies are data. Four commands open or follow the heredocs;
# none of the body lines counts, chained or not.
{
  cat <<'FIXTURE'
```bash
cat >config.yaml <<EOF
server: http://localhost:4000
note: make dev && make test; make clean
EOF
cat >notes.txt <<'END_NOTES'
one; two
END_NOTES
FIXTURE
  printf 'cat >indented.txt <<-"TABBED"\n\tthree && four\n\tTABBED\n'
  cat <<'FIXTURE'
flightdeck
```
FIXTURE
} >"$work/heredoc-body.md"
rule 4 "heredoc bodies are not counted (<<WORD, <<'WORD', <<-\"WORD\")" <"$work/heredoc-body.md"

rule 2 "a here-string is not a heredoc" <<'FIXTURE'
```bash
grep flightdeck <<<"$processes"
flightdeck
```
FIXTURE

# A multi-line quoted string is counted line by line: a quote left
# open is closed at the end of its line, so an apostrophe in a text
# fence cannot swallow the commands after it.
rule 2 "an open quote does not hide the next line" <<'FIXTURE'
```text
/plugin install example   (don't skip this)
/reload-plugins
```
FIXTURE

# ---------------------------------------------------------------------
# What is refused.
# ---------------------------------------------------------------------

# The fence opens on line 5 of the fixture (the rule helpers put the
# heading and a blank line first).
rule_error 'rule\.md:5: the code fence opened on this line is never closed' "an unclosed fence is an error that names its line" <<'FIXTURE'
Text.

```bash
flightdeck
FIXTURE

rule_error 'rule\.md:4: the heredoc <<EOF opened on this line is not terminated' "a heredoc left open at the end of its fence is an error" <<'FIXTURE'
```bash
cat >config.yaml <<EOF
server: http://localhost:4000
```
FIXTURE

expect 2 "an unknown option is exit 2" --verbose "$work/good.md"
expect_output 'unknown option: --verbose' "the failure names the option"
expect_output '^usage: scripts/readme-budget.sh' "and prints the usage line"

expect 2 "a second path is exit 2" "$work/good.md" "$work/case.md"
expect_output 'more than one README path' "the failure says so"
expect_output '^usage: scripts/readme-budget.sh' "and prints the usage line"

expect 2 "a missing file is exit 2" "$work/does-not-exist.md"

expect 0 "--help exits 0" --help
expect_output '^Usage: scripts/readme-budget.sh' "and prints the header"

if [ "$status" -ne 0 ]; then
  echo "readme-budget self-test FAILED" >&2
  exit 1
fi
echo "readme-budget self-test OK"
