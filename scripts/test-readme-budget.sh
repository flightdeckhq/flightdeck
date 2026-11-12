#!/usr/bin/env bash
# Self-test of scripts/readme-budget.sh on fixture READMEs.
#
# The budgets: a README within budget passes and its counts are the
# expected ones; one over the Connect budget, one over the Self-hosting
# budget, one over the total, one over the line budget and one missing
# a budgeted section each fail and name the reason; --report prints the
# same counts and exits 0 on an over-budget file.
#
# The install block: a second line, a chained command, a comment, a
# prompt and a second visible install block each fail; so does an
# install section whose only block is folded. The channels folded in a
# <details> under the block do not break the install budget and do
# count toward the total; <details open> is not folded; a <details>
# left open is an error.
#
# The counting rule, one fixture per clause of the script's header:
# every fence counts unless its language is a sample (powershell, zsh,
# cmd, an untagged fence, tilde fences, a fence in a blockquote or a
# list item, CRLF line endings); a chained line counts once per
# segment, a pipeline once, a wrapped command once; separators inside
# quotes and heredoc bodies do not count, except the body of a heredoc
# that a shell reads; cmd and PowerShell fences continue on a caret
# and a backtick and never on a backslash; a `###` subsection counts
# into its `## ` section. A fence or a heredoc left open, a command in
# a sample-language fence, an unknown option and a second path are
# errors.
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

# expect_no_output <pattern> <description>: the last run's output does
# not contain the pattern.
expect_no_output() {
  if grep -Eq -- "$1" "$work/out"; then
    fail "$2: output has '$1':"
    sed 's/^/    /' "$work/out" >&2
  else
    echo "ok: $2"
  fi
}

# rule <count> <description>: reads the body of a section on stdin,
# measures a README made of it and asserts the section's count (the
# first column of its row; the second is the folded part). It runs in
# report mode, because a rule fixture has no budgeted section and only
# its count is under test.
rule() {
  local want="$1" what="$2" rc=0
  {
    echo "## Rules"
    echo
    cat
    echo
    echo "## Self-hosting"
  } >"$work/rule.md"
  "$BUDGET" --report "$work/rule.md" >"$work/out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && grep -Eq -- "^ +$want +[0-9]+ +Rules$" "$work/out"; then
    echo "ok: $what (counts $want)"
  else
    fail "$what: exit $rc, want a count of $want for the Rules section:"
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
    echo "## Rules"
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

# install_readme <file>: writes a README whose Connect and Self-hosting
# sections are within budget around the Install section read on stdin,
# so that a fixture's verdict is its install section's alone. Connect
# has 3 commands and Self-hosting 1.
install_readme() {
  {
    echo "# Fixture"
    echo
    echo "## Install"
    echo
    cat
    echo
    cat <<'FIXTURE'
## Connect your agents

```text
/plugin marketplace add example/example
/plugin install example@example
```

```bash
pip install example
```

## Self-hosting

```bash
flightdeck --domain example.com
```
FIXTURE
  } >"$1"
}

# ---------------------------------------------------------------------
# The budgets.
# ---------------------------------------------------------------------

# A README within budget. Install: the block (1 command on one line),
# the start command, and four channels folded in a <details>, so 6 of
# which 4 folded and 2 visible. Connect your agents: 3 (a text fence
# and a bash fence; the python fence is not counted). Self-hosting: 4
# (console and bash fences, one in a list item; the yaml fence, the
# comment and the blank line are not counted). Preamble: 0.
cat >"$work/good.md" <<'FIXTURE'
# Fixture

Some text before the first section.

```yaml
not: counted
```

## Install

Install with one command:

```bash
curl -fsSL https://example.invalid/install.sh | sh
```

Then start it:

```bash
flightdeck
```

<details>
<summary>Homebrew, pip, Docker, Windows</summary>

```bash
brew install example/tap/flightdeck
pipx install example-cli
docker run -p 127.0.0.1:4000:4000 example/flightdeck
```

```powershell
irm https://example.invalid/install.ps1 | iex
```

</details>

## Connect your agents

```text
/plugin marketplace add example/example
/plugin install example@example
```

```bash
pip install example
```

```python
import flightdeck_sensor
flightdeck_sensor.init()
```

## Self-hosting

```console
flightdeck --domain example.com
flightdeck --database-url postgres://u:p@h/db
```

```yaml
image: not/counted
```

- A list item with its own fence:

  ```sh
  # a comment does not count

  docker run example
  helm install example
  ```

## License

Apache 2.0.
FIXTURE

expect 0 "a README within budget passes" "$work/good.md"
expect_output '^ +6 +4 +Install$' "Install counts 6, of which 4 folded in <details>"
expect_output '^ +3 +0 +Connect your agents$' "Connect your agents counts 3 (text and bash; python excluded)"
expect_output '^ +4 +0 +Self-hosting$' "Self-hosting counts 4 (console and an indented sh fence; yaml, comments and blanks excluded)"
expect_output '^ +0 +0 +\(preamble\)$' "the preamble's yaml fence is not counted"
expect_output 'Install block +1 \(exactly 1' "the install block holds 1 command"
expect_output 'Install, visible +2 \(budget' "Install shows 2 commands: the folded channels are not visible"
expect_output 'Total +13 \(budget' "the total is 13: the folded channels count toward it"
expect_output 'README within budget' "the verdict is printed"

# ---------------------------------------------------------------------
# The install block.
# ---------------------------------------------------------------------

# A second command on a second line of the install block.
install_readme "$work/install-second-line.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh
brew install example/tap/flightdeck
```
FIXTURE
expect 1 "a second command in the install block fails" "$work/install-second-line.md"
expect_output 'OVER BUDGET: the install block \(line 5\) has 2 commands, must be exactly 1' "the failure names the block, its line and the counts"
expect_output 'OVER BUDGET: the install block \(line 5\) has 2 lines, must be exactly one' "and that the block is not one line"
expect 0 "--report prints the same file without failing" --report "$work/install-second-line.md"
expect_output 'report mode: not failing' "--report says so"

# A second command chained onto the one line: the block is one line
# and still two commands.
install_readme "$work/install-chained.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh && flightdeck
```
FIXTURE
expect 1 "a command chained onto the install command fails" "$work/install-chained.md"
expect_output 'OVER BUDGET: the install block \(line 5\) has 2 commands, must be exactly 1' "the failure counts the chained command"
expect_no_output 'has [0-9]+ lines, must be exactly one' "the block is one line, so only the command count fails"

# One command, with a comment above it: the count is right and the
# block is still not the single line the README promises.
install_readme "$work/install-comment.md" <<'FIXTURE'
```bash
# Linux and macOS
curl -fsSL https://example.invalid/install.sh | sh
```
FIXTURE
expect 1 "a comment in the install block fails" "$work/install-comment.md"
expect_output 'OVER BUDGET: the install block \(line 5\) has 2 lines, must be exactly one' "the failure names the line count"
expect_no_output 'commands, must be exactly' "the block has one command, so only the line count fails"

install_readme "$work/install-blank.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh

```
FIXTURE
expect 1 "a blank line in the install block fails" "$work/install-blank.md"
expect_output 'OVER BUDGET: the install block \(line 5\) has 2 lines, must be exactly one' "the failure names the line count"

install_readme "$work/install-prompt.md" <<'FIXTURE'
```console
$ curl -fsSL https://example.invalid/install.sh | sh
```
FIXTURE
expect 1 "a prompt in the install block fails" "$work/install-prompt.md"
expect_output 'OVER BUDGET: the install block \(line 5\) starts with a prompt' "the failure names the prompt"

# An install block with nothing to run: the number is exact, not a
# ceiling.
install_readme "$work/install-empty.md" <<'FIXTURE'
```bash
# see the release page
```
FIXTURE
expect 1 "an install block with no command fails" "$work/install-empty.md"
expect_output 'OVER BUDGET: the install block \(line 5\) has 0 commands, must be exactly 1' "the failure names the count of 0"

# A second visible install block: the first block is the one line it
# must be, and the section shows three commands.
install_readme "$work/install-second-block.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh
```

Or with Homebrew:

```bash
brew install example/tap/flightdeck
```

Then start it:

```bash
flightdeck
```
FIXTURE
expect 1 "a second visible install block fails" "$work/install-second-block.md"
expect_output 'OVER BUDGET: Install shows 3 commands outside <details>, budget 2' "the failure names the visible count"
expect_output 'Install block +1 \(exactly 1' "the first block itself holds 1 command"

# The same channels folded in a <details>: within the install budget,
# and counted in the section and the total. The <details> carries
# attributes and sits in mixed case; the tag mentioned in inline code
# on the line before it folds nothing.
install_readme "$work/install-folded.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh
```

```bash
flightdeck
```

The other channels sit in a `<details>` element:

<Details name="channels">
<summary>Homebrew, pip, Docker, Windows</summary>

```bash
brew install example/tap/flightdeck
pipx install example-cli
uvx example-cli
docker run example/flightdeck
```

```powershell
irm https://example.invalid/install.ps1 | iex
```

</DETAILS>
FIXTURE
expect 0 "channels folded in <details> do not break the install budget" "$work/install-folded.md"
expect_output '^ +7 +5 +Install$' "Install counts 7, of which 5 folded"
expect_output 'Install, visible +2 \(budget' "Install shows 2"
expect_output 'Total +11 \(budget' "the folded channels count toward the total (11)"

# Folded commands count toward the total: 2 visible and 12 folded in
# Install, 3 in Connect and 4 in Self-hosting are 21.
{
  echo "## Install"
  echo
  echo '```bash'
  echo "curl -fsSL https://example.invalid/install.sh | sh"
  echo '```'
  echo
  echo '```bash'
  echo "flightdeck"
  echo '```'
  echo
  echo "<details><summary>Other channels</summary>"
  echo
  echo '```bash'
  for i in $(seq 1 12); do echo "install-channel-$i"; done
  echo '```'
  echo
  echo "</details>"
  echo
  echo "## Connect your agents"
  echo
  echo '```bash'
  for i in 1 2 3; do echo "connect-$i"; done
  echo '```'
  echo
  echo "## Self-hosting"
  echo
  echo '```bash'
  for i in 1 2 3 4; do echo "flightdeck --flag-$i"; done
  echo '```'
} >"$work/folded-total.md"
expect 1 "folded commands that take the total over budget fail" "$work/folded-total.md"
expect_output 'OVER BUDGET: 21 commands in total, budget 20' "the failure names the total"
expect_output 'Install, visible +2 \(budget' "while the install section still shows 2"
expect_no_output 'OVER BUDGET: Install' "and the install budget itself holds"

# <details open> is rendered unfolded: its commands are visible.
install_readme "$work/install-details-open.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh
```

```bash
flightdeck
```

<details open>
<summary>Homebrew</summary>

```bash
brew install example/tap/flightdeck
```

</details>
FIXTURE
expect 1 "<details open> does not fold its commands" "$work/install-details-open.md"
expect_output 'OVER BUDGET: Install shows 3 commands outside <details>, budget 2' "the failure counts the open block as visible"
expect_output '^ +3 +0 +Install$' "and none of the 3 as folded"

# An open element inside a collapsed one is still folded away.
install_readme "$work/install-nested.md" <<'FIXTURE'
```bash
curl -fsSL https://example.invalid/install.sh | sh
```

```bash
flightdeck
```

<details>
<summary>Other channels</summary>
<details open>
<summary>Homebrew</summary>

```bash
brew install example/tap/flightdeck
```

</details>

```bash
pipx install example-cli
```

</details>
FIXTURE
expect 0 "an open <details> inside a collapsed one stays folded" "$work/install-nested.md"
expect_output '^ +4 +2 +Install$' "Install counts 4, of which 2 folded"

# The install command itself must be visible: a section whose only
# block is folded has no install block.
install_readme "$work/install-hidden.md" <<'FIXTURE'
<details>
<summary>Install</summary>

```bash
curl -fsSL https://example.invalid/install.sh | sh
```

</details>
FIXTURE
expect 1 "an install command folded in <details> fails" "$work/install-hidden.md"
expect_output 'OVER BUDGET: Install has no command block outside <details>' "the failure says the block must be visible"
expect_output 'Install block +none' "and the summary shows no install block"

# A <details> left open would fold everything after it. Refused, in
# report mode as well; the tag is on line 4 of the fixture.
rule_error 'rule\.md:4: the <details> opened on this line is never closed' "an unclosed <details> is an error that names its line" <<'FIXTURE'
Text.
<details>
<summary>Folded</summary>

```bash
flightdeck
```
FIXTURE

# A tag inside a fence is content, not a tag: nothing is folded and
# nothing is left open.
rule 2 "a <details> inside a fence folds nothing" <<'FIXTURE'
```html
<details>
```

```bash
flightdeck
flightdeck status
```
FIXTURE

# ---------------------------------------------------------------------
# The other budgets.
# ---------------------------------------------------------------------

# Over the Connect budget: a fourth command, an export.
cat >"$work/connect.md" <<'FIXTURE'
## Install

```bash
curl -fsSL https://example.invalid/install.sh | sh
```

## Connect your agents

```text
/plugin marketplace add example/example
/plugin install example@example
```

```bash
pip install example
export FLIGHTDECK_SERVER=http://localhost:4000/ingest
```

## Self-hosting

```bash
flightdeck --domain example.com
```
FIXTURE
expect 1 "four Connect commands fail" "$work/connect.md"
expect_output 'OVER BUDGET: Connect your agents has 4 commands, budget 3' "the failure names the section and the counts"

# Over the Self-hosting budget: seven commands, the last two chained on
# one line, so a line count of six would have let it through.
cat >"$work/selfhosting.md" <<'FIXTURE'
## Install

```bash
curl -fsSL https://example.invalid/install.sh | sh
```

## Connect your agents

```bash
pip install example
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
# commands, 18 of them in a section with no budget of its own.
{
  echo "## Install"
  echo
  echo '```bash'
  echo "curl -fsSL https://example.invalid/install.sh | sh"
  echo '```'
  echo
  echo "## Connect your agents"
  echo
  echo '```bash'
  echo "pip install example"
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
  for i in $(seq 1 18); do echo "export VAR_$i=$i"; done
  echo '```'
} >"$work/total.md"
expect 1 "21 commands in total fail" "$work/total.md"
expect_output 'OVER BUDGET: 21 commands in total, budget 20' "the failure names the total"

# skeleton: the three budgeted sections with one command each, 17
# lines, for the fixtures below that are about something else.
skeleton() {
  cat <<'FIXTURE'
## Install

```bash
curl -fsSL https://example.invalid/install.sh | sh
```

## Connect your agents

```bash
pip install example
```

## Self-hosting

```bash
flightdeck --domain example.com
```
FIXTURE
}

# Over the line budget: the skeleton's 17 lines and 284 more.
{
  skeleton
  for i in $(seq 1 284); do echo "line $i"; done
} >"$work/long.md"
expect 1 "301 lines fail" "$work/long.md"
expect_output 'OVER BUDGET: 301 lines, budget 300' "the failure names the line count"

# The same 301 lines with no newline after the last one: the last line
# is still a line. Counting newline characters would see 300 and pass.
{
  skeleton
  for i in $(seq 1 283); do echo "line $i"; done
  printf 'line 284'
} >"$work/long-no-newline.md"
expect 1 "301 lines fail without a trailing newline" "$work/long-no-newline.md"
expect_output 'OVER BUDGET: 301 lines, budget 300' "the last line counts without its newline"

# One line fewer is within budget.
{
  skeleton
  for i in $(seq 1 283); do echo "line $i"; done
} >"$work/long-enough.md"
expect 0 "300 lines pass" "$work/long-enough.md"

# A README without a budgeted section fails: the budget cannot be
# measured, and a renamed heading must not pass silently.
cat >"$work/nosection.md" <<'FIXTURE'
## Try it

```bash
flightdeck
```
FIXTURE
expect 1 "a README without the budgeted sections fails" "$work/nosection.md"
expect_output 'no "## Install" section' "the failure names the missing Install section"
expect_output 'no "## Connect your agents" section' "and the missing Connect section"
expect_output 'no "## Self-hosting" section' "and the missing Self-hosting section"

# The section heading is matched case-insensitively and a fence with
# attributes after the language still counts.
cat >"$work/case.md" <<'FIXTURE'
## INSTALL

```bash {.copy}
flightdeck
```

## Connect Your Agents

```bash
pip install example
```

## Self-Hosting

```shell
flightdeck --domain example.com
```
FIXTURE
expect 0 "headings match case-insensitively and a fence with attributes counts" "$work/case.md"
expect_output 'Install block +1 \(exactly' "INSTALL is read as Install, and its block is found"
expect_output 'Connect your agents +1 \(budget' "Connect Your Agents is read as Connect your agents"
expect_output 'Self-hosting +1 \(budget' "Self-Hosting is read as Self-hosting"

# A `###` subsection is part of its `## ` section: its commands count
# against that section's budget and it gets no row of its own.
cat >"$work/subsection.md" <<'FIXTURE'
## Install

```bash
flightdeck
```

## Connect your agents

### Claude Code

```text
/plugin marketplace add example/example
/plugin install example@example
```

### Python agents

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
expect_output '^ +3 +0 +Connect your agents$' "Connect your agents counts the commands of its two subsections (3)"
expect_output '^ +1 +0 +Self-hosting$' "Self-hosting counts the command of its subsection (1)"
expect_no_output 'Claude Code|Python agents|Docker' "a ### subsection has no row of its own"

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
## Install

```bash
flightdeck
```

## Connect your agents

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
expect_output '^ +3 +0 +Connect your agents$' "CRLF: Connect your agents counts 3"
expect_output '^ +1 +0 +Self-hosting$' "CRLF: a wrapped command counts 1"
expect_output 'Install block +1 \(exactly' "CRLF: the install block is one line"

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

# A heredoc that a shell reads is a script, not data: its lines are
# commands. Each fixture counts the line that opens the heredoc and
# the commands of its body.
rule 4 "the body of a heredoc fed to a shell is counted" <<'FIXTURE'
```bash
bash <<EOF
make build
make install && make check
EOF
```
FIXTURE

# Nine: four opening lines, and bodies of one, two, one and one. The
# shell is found behind ssh, a container exec, a pipe and sudo/env
# with a path.
rule 9 "remote, contained, piped and prefixed shells are shells" <<'FIXTURE'
```bash
ssh ops@example.invalid <<'EOF'
flightdeck status
EOF
docker exec -i flightdeck sh <<EOF
flightdeck stop; flightdeck start
EOF
cat <<EOF | sudo sh
flightdeck status
EOF
sudo env FLIGHTDECK_PORT=4000 /bin/bash <<EOF
flightdeck
EOF
```
FIXTURE

# Two: the opening line and one wrapped command. The comment and the
# blank line of the body count as nothing, as they do outside it.
rule 2 "a shell heredoc's body follows the same rules" <<'FIXTURE'
```bash
bash <<EOF
# a comment

helm install example \
  --set a=b
EOF
```
FIXTURE

# A file name that contains a shell's name is not a shell: these three
# write files and their bodies stay data.
rule 3 "a heredoc written to a file is still data" <<'FIXTURE'
```bash
cat <<EOF > config.yaml
note: make dev && make test
EOF
cat > install.sh <<EOF
make dev; make test
EOF
tee ~/.ssh/config <<EOF
Host example; make dev
EOF
```
FIXTURE

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
# Windows fences.
# ---------------------------------------------------------------------

# A trailing backslash is the end of a path, not a continuation.
rule 2 "a trailing backslash does not join lines in a cmd fence" <<'FIXTURE'
```cmd
cd C:\Users\example\
flightdeck.exe
```
FIXTURE

rule 2 "nor in a powershell fence" <<'FIXTURE'
```powershell
cd C:\Users\example\
flightdeck.exe
```
FIXTURE

# Nor is it an escape: the separator after it still separates.
rule 2 "a backslash does not escape a separator in a powershell fence" <<'FIXTURE'
```pwsh
cd C:\Users\example\; flightdeck.exe
```
FIXTURE

rule 1 "a backtick continues a PowerShell command" <<'FIXTURE'
```powershell
Invoke-WebRequest https://example.invalid/flightdeck.zip `
  -OutFile flightdeck.zip
```
FIXTURE

rule 1 "a caret continues a cmd command" <<'FIXTURE'
```cmd
flightdeck.exe ^
  --domain example.com
```
FIXTURE

# Three: REM and :: lines are comments, and an apostrophe is not a
# quote in cmd, so the & after it separates.
rule 3 "cmd comments and apostrophes" <<'FIXTURE'
```bat
REM start the server & nothing else
:: another comment
flightdeck.exe
echo don't close this window & flightdeck.exe status
```
FIXTURE

# ---------------------------------------------------------------------
# Samples must be samples.
# ---------------------------------------------------------------------

# Each of these has one real command next to its sample, so the count
# asserted is 1: the sample is not counted and does not fail the run.
rule 1 "a JSON sample passes" <<'FIXTURE'
```json
{
  "server": "http://localhost:4000",
  "install": "curl -fsSL https://example.invalid/install.sh | sh"
}
```

```bash
flightdeck
```
FIXTURE

rule 1 "a python sample with a command word inside a line passes" <<'FIXTURE'
```python
client = docker.from_env()  # docker run is what this replaces
subprocess.run(["git", "status"])
```

```bash
flightdeck
```
FIXTURE

rule 1 "a key named like a command is not a command" <<'FIXTURE'
```toml
uv = { index = "example" }
make = "gnu"
```

```yaml
docker: true
pip:
  - example
```

```bash
flightdeck
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

# A command block under a sample-language tag would count as nothing,
# so it is refused. The command is on line 4 of each fixture.
rule_error 'rule\.md:4: this line of a "json" fence starts like a command \(curl\)' "a command in a json fence is an error that names the line and the tag" <<'FIXTURE'
```json
curl -fsSL https://example.invalid/install.sh | sh
```
FIXTURE

rule_error 'rule\.md:4: this line of a "ini" fence starts like a command \(\$\)' "a prompt in a sample fence is an error" <<'FIXTURE'
```ini
$ flightdeck --domain example.com
```
FIXTURE

rule_error 'rule\.md:4: this line of a "md" fence starts like a command \(flightdeck\)' "an indented command in a sample fence is an error" <<'FIXTURE'
- ```md
  flightdeck --domain example.com
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
