#!/usr/bin/env bash
# Measures the README against its command budget and fails when it is
# over. The budget is the honesty rule of the single-binary work: the
# README shrinks because a user has fewer commands to run, not because
# user-facing text was moved out of it. Only contributor steps (clone,
# `make dev`, per-component commands) belong in CONTRIBUTING.md.
#
# What is counted: the commands inside fenced code blocks, attributed
# to the `## ` section the block is in (a `###` subsection belongs to
# its `## ` section; the text before the first `## ` heading is
# "(preamble)"), so a section's count is what its reader types.
#
# Which fences: every fenced block, tagged or not, except the ones
# whose language is a code or data sample (SAMPLE_LANGUAGES below). A
# fence is three or more backticks or tildes, closed by at least as
# many of the same character; it may be indented (a block in a list
# item), open on the line of a list marker, or sit in a blockquote
# (`> ` markers are stripped). A trailing carriage return is dropped
# from every line first.
#
# What a command is, inside a counted fence:
#   - A blank line and a whole-line `#` comment count as nothing. A
#     leading `$ ` or `> ` prompt is stripped first.
#   - A line ending in a backslash is joined with the next one, so a
#     command wrapped over several lines is counted once.
#   - Windows fences follow their shell (POWERSHELL_LANGUAGES and
#     CMD_LANGUAGES below). A backslash there is a path separator: it
#     neither joins lines nor escapes, so `cd C:\Users\x\` and the
#     line after it are two commands. The continuation and escape
#     character is the backtick in PowerShell and the caret in cmd.
#     cmd has no single-quoted strings, its comments are `REM` and
#     `::`, and `<<` opens no heredoc in either.
#   - Each segment separated by `&&`, `||`, `;` or a lone `&` is one
#     command: `a && b; c` is three. A pipeline (`a | b`) is one. `;;`
#     (a case arm) and the `&` of a redirection (`2>&1`, `&>`, `|&`)
#     do not separate. Separators inside single or double quotes do
#     not count, and neither does anything after an unquoted ` #`.
#   - A quote left open at the end of a line is closed there: every
#     line of a multi-line string counts, so that a stray apostrophe
#     cannot hide the lines after it.
#   - A heredoc body (`<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<-WORD`) is
#     data and is not counted, up to the line that is only WORD. The
#     command that opens the heredoc is counted.
#   - Unless a shell reads the heredoc: when the line that opens it
#     names a shell as one of its words (SHELL_WORDS below: `bash
#     <<EOF`, `sudo /bin/sh <<EOF`, `ssh host <<EOF`, `docker exec -i
#     c sh <<EOF`, `cat <<EOF | sh`), the body is what the shell runs,
#     and its lines are counted as commands by the rules above.
#
# A fence that is never closed, and a heredoc that is not terminated
# before its fence closes, would hide what follows them: both are
# errors (exit 1) that name the line they opened on.
#
# A command block must not carry a sample-language tag, where it would
# count as nothing. A line of a sample fence that starts with `$ ` or
# with a command word and a space (COMMAND_WORDS below; a word that is
# followed by `=` or `:` is a key of the sample, not a command) is an
# error (exit 1) that names the line and the tag.
#
# Known inaccuracies, neither of which a README needs to rely on:
#   - The arms of a `case` written on one line are not split at `;;`:
#     `a) one ;; b) two ;;` counts once.
#   - A closing keyword counts as a command of its own: `{ a; }`,
#     `if a; then b; fi` and `for x in 1 2; do a; done` each count one
#     more than they run. This errs towards failing.
#
# Usage: scripts/readme-budget.sh [--report] [README path]
#   Prints the per-section counts, the total and the line count.
#   Without --report it exits 1 when a budget is exceeded; with
#   --report it only prints, for a README that is known to be over
#   budget while it is being rewritten. Exit 2 is a usage error or a
#   missing file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The budgets, from the acceptance gates of the single-binary design.
#
# Quickstart: the whole first-run path is install, `flightdeck`, and one
# plugin install (the sensor path adds a pip install and a code sample,
# which is a python fence and not counted). A fourth command means a
# step crept back in.
QUICKSTART_MAX=3
# Self-hosting: TLS is one flag (`--domain`), Postgres one flag
# (`--database-url`), and Docker, Compose and Helm are one command each.
# Six covers those with one to spare for an export.
SELF_HOSTING_MAX=6
# Total: the two sections above plus the OpenTelemetry exporter settings
# (one block of exports for Claude Code, one for the frameworks) and a
# plugin re-install line. Twenty is roughly a third of what the README
# carried when the stack was seven containers compiled from source.
TOTAL_MAX=20
# Length: half of the pre-rewrite README, and only because the steps
# are gone; reference material stays in the README or moves to a page
# of its own that the README links.
LINES_MAX=300

# The section headings the per-section budgets apply to, as they appear
# after `## ` (compared case-insensitively).
QUICKSTART_HEADING="Quickstart"
SELF_HOSTING_HEADING="Self-hosting"

# The fence languages that are not counted: source code, configuration
# and data a reader copies into a file or reads, not steps typed at a
# prompt. This is a denylist on purpose. An allowlist of shell names
# counted zero for every tag it did not know (powershell, cmd, zsh,
# shell-session, no tag at all), which is the direction that flatters
# the README; with a denylist an unknown tag is counted, and the worst
# a missing entry does is fail the build until the language is added
# here in a reviewed change. `text` is deliberately absent: the README
# writes slash commands in text fences.
SAMPLE_LANGUAGES="python py pycon python3 yaml yml json jsonc json5 toml \
ini cfg conf go golang js javascript mjs cjs ts typescript tsx jsx diff \
patch mermaid sql html css scss xml hcl terraform tf dockerfile \
makefile make nginx proto protobuf graphql rust rs java kotlin c cpp \
csharp cs ruby rb php swift lua markdown md csv"

# The fence languages read with Windows syntax instead of POSIX shell
# syntax (the header has the differences). They are named because the
# two disagree about the backslash: read as a POSIX continuation, the
# trailing backslash of a Windows path joined the next command to its
# line and the pair counted once.
POWERSHELL_LANGUAGES="powershell ps1 pwsh"
CMD_LANGUAGES="cmd bat batch"

# The words that make a heredoc's body commands instead of data: a
# shell, local or remote, reads the body and runs it. Matched as whole
# words of the line that opens the heredoc, after any path, so sudo,
# env, `docker exec` and `kubectl exec` prefixes and the `| sh` form
# are covered by the shell they end in, and `install.sh` or
# `~/.ssh/config` as a file name is not a match.
SHELL_WORDS="sh bash zsh dash ksh fish ssh"

# The words that start a command in this README's subject matter:
# download and install tools, package managers, container and cluster
# clients, the shells, and Flightdeck's and Claude Code's own
# binaries. A sample-language fence whose line starts with one of
# them (or with a `$ ` prompt) is a command block under the wrong tag
# and fails the run, because the denylist above would otherwise count
# it as nothing. The list is short on purpose: it only has to catch a
# mislabelled install or run step, and every word in it is a way to
# fail a legitimate sample that begins a line with that word.
COMMAND_WORDS="curl wget docker helm kubectl pip pipx uvx uv brew npm npx \
git make sudo flightdeck claude irm iwr winget scoop choco sh bash"

# The shortest run of backticks or tildes that opens a fence; a shorter
# run is inline code or a strikethrough marker (CommonMark, fenced code
# blocks).
FENCE_MIN_LENGTH=3

usage() {
  echo "usage: scripts/readme-budget.sh [--report] [README path]" >&2
}

report=0
readme=""
have_readme=0
for arg in "$@"; do
  case "$arg" in
    --report) report=1 ;;
    -h | --help)
      # The header comment, up to the first line that is not a comment.
      awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
      exit 0
      ;;
    -*)
      echo "readme-budget: unknown option: $arg" >&2
      usage
      exit 2
      ;;
    *)
      if [ "$have_readme" -eq 1 ]; then
        echo "readme-budget: more than one README path: $readme, $arg" >&2
        usage
        exit 2
      fi
      readme="$arg"
      have_readme=1
      ;;
  esac
done
[ "$have_readme" -eq 1 ] || readme="$ROOT/README.md"
[ -f "$readme" ] || { echo "readme-budget: no such file: $readme" >&2; exit 2; }

# counts prints one "<count>\t<section>" line per section in document
# order, then "<total>\tTOTAL", and exits 1 with a message on a fence
# or a heredoc that is never closed and on a command in a sample
# fence. The rules are the ones in the
# header; the program keeps to POSIX awk (no gawk functions), and takes
# the single quote as a variable because it sits inside a quoted shell
# word.
counts() {
  awk -v samples="$SAMPLE_LANGUAGES" -v powershells="$POWERSHELL_LANGUAGES" \
    -v cmds="$CMD_LANGUAGES" -v shells="$SHELL_WORDS" \
    -v commands="$COMMAND_WORDS" -v fence_min="$FENCE_MIN_LENGTH" -v sq="'" '
    function fail(msg) {
      printf "readme-budget: %s\n", msg > "/dev/stderr"
      failed = 1
      exit 1
    }

    # Makes set[word] true for every word of a space-separated list.
    function set_of(list, set,    k, m, w) {
      m = split(list, w, /[ \t\n]+/)
      for (k = 1; k <= m; k++) { if (w[k] != "") { set[w[k]] = 1 } }
    }

    # The length of the run of character c that s starts with.
    function run(s, c,    n) {
      n = 0
      while (substr(s, n + 1, 1) == c) { n++ }
      return n
    }

    # The length of the run of character c that s ends with: an odd
    # run of the continuation character means the last one escapes the
    # newline.
    function run_back(s, c,    n, len) {
      n = 0; len = length(s)
      while (n < len && substr(s, len - n, 1) == c) { n++ }
      return n
    }

    # s without its indentation and without its leading blockquote
    # markers: all of them when max is negative, at most max otherwise.
    # The number removed is left in "markers".
    function unquote(s, max) {
      markers = 0
      sub(/^[ \t]+/, "", s)
      while ((max < 0 || markers < max) && substr(s, 1, 1) == ">") {
        s = substr(s, 2)
        sub(/^[ \t]+/, "", s)
        markers++
      }
      return s
    }

    # Whether a command line names a shell as one of its words, with
    # or without a path ("bash", "/bin/sh", "| sh", "ssh host").
    function names_shell(s,    k, m, w, t) {
      m = split(s, w, wordsep)
      for (k = 1; k <= m; k++) {
        t = w[k]
        sub(/^.*\//, "", t)
        if (t in shellword) { return 1 }
      }
      return 0
    }

    # The syntax of the fence that just opened, from its language tag.
    # esc escapes the next character outside quotes and, doubled up at
    # the end of a line, decides whether the line continues; dqesc is
    # the escape inside double quotes ("" for none).
    function set_dialect(lang) {
      if (lang in powershell) {
        esc = "`"; dqesc = "`"; singlequotes = 1; hashcomments = 1; heredocs = 0; remcomments = 0
      } else if (lang in cmd) {
        esc = "^"; dqesc = ""; singlequotes = 0; hashcomments = 0; heredocs = 0; remcomments = 1
      } else {
        esc = "\\"; dqesc = "\\"; singlequotes = 1; hashcomments = 1; heredocs = 1; remcomments = 0
      }
    }

    # Counts the commands of one logical line (continuations already
    # joined) into the current section, and queues the terminators of
    # the heredocs it opens. Inside the body of a heredoc that feeds a
    # shell no further heredoc is opened: the lines of a nested one are
    # counted as commands, which errs towards counting.
    function count_commands(s,    i, n, ch, nx, prev, q, has, segs, r, r1, fed) {
      n = length(s); q = ""; has = 0; segs = 0; prev = " "; fed = -1
      for (i = 1; i <= n; i++) {
        ch = substr(s, i, 1)
        if (q == sq) { if (ch == sq) { q = "" }; continue }
        if (q == dq) { if (dqesc != "" && ch == dqesc) { i++ } else if (ch == dq) { q = "" }; continue }
        if (ch == " " || ch == "\t") { prev = " "; continue }
        if (hashcomments && ch == "#" && prev == " ") { break }
        if (ch == esc) { i++; has = 1; prev = ch; continue }
        if ((singlequotes && ch == sq) || ch == dq) { q = ch; has = 1; prev = ch; continue }
        nx = substr(s, i + 1, 1)
        if (ch == ";") {
          if (nx == ";") { i++; prev = ch; continue }
          segs += has; has = 0; prev = " "; continue
        }
        if (ch == "&") {
          if (nx == "&") { i++; segs += has; has = 0; prev = " "; continue }
          if (prev == ">" || prev == "<" || prev == "|" || nx == ">") { prev = ch; continue }
          segs += has; has = 0; prev = " "; continue
        }
        if (ch == "|") {
          if (nx == "|") { i++; segs += has; has = 0; prev = " "; continue }
          prev = ch; continue
        }
        if (heredocs && !inbody && ch == "<" && nx == "<") {
          if (substr(s, i + 2, 1) == "<") { i += 2; has = 1; prev = ch; continue }
          r = substr(s, i + 2)
          sub(/^-/, "", r)
          sub(/^[ \t]+/, "", r)
          r1 = substr(r, 1, 1)
          if (r1 == sq || r1 == dq || r1 == "\\") { r = substr(r, 2) }
          if (match(r, /^[A-Za-z_][A-Za-z0-9_]*/)) {
            if (fed < 0) { fed = names_shell(s) }
            here[++nhere] = substr(r, 1, RLENGTH)
            hereshell[nhere] = fed
            if (nhere == 1) { hereline = NR }
          }
          i++; has = 1; prev = ch; continue
        }
        has = 1; prev = ch
      }
      segs += has
      # A line that is neither blank nor a comment is at least one
      # command, whatever it is made of.
      if (segs < 1) { segs = 1 }
      count[section] += segs
      total += segs
    }

    # Counts a command whose continuation was still open when its
    # block ended.
    function flush_joined() {
      if (joining) {
        joining = 0
        if (joined !~ /^[ \t]*$/) { count_commands(joined) }
        joined = ""
      }
    }

    # One line of a counted fence, already without its blockquote
    # markers and indentation.
    function feed(s,    t, p) {
      if (nhere > 0) {
        t = s
        sub(/[ \t]+$/, "", t)
        p = t
        sub(/^[$>][ \t]+/, "", p)
        if (t == here[herenext] || p == here[herenext]) {
          flush_joined()
          if (++herenext > nhere) { nhere = 0; herenext = 1; inbody = 0 }
          return
        }
        # The body of a heredoc is data, unless a shell reads it.
        if (!hereshell[herenext]) { return }
        inbody = 1
      }
      sub(/^[$>][ \t]+/, "", s)
      if (!joining) {
        if (s ~ /^[ \t]*$/) { return }
        if (hashcomments && s ~ /^#/) { return }
        if (remcomments && (s ~ /^::/ || s ~ /^[Rr][Ee][Mm]([ \t]|$)/)) { return }
      } else {
        s = joined s
      }
      if (run_back(s, esc) % 2 == 1) {
        joined = substr(s, 1, length(s) - 1)
        joining = 1
        return
      }
      joining = 0; joined = ""
      if (s !~ /^[ \t]*$/) { count_commands(s) }
    }

    # One line of a sample-language fence: it must not look like a
    # command, or a mislabelled command block would count as nothing.
    # A command word followed by "=" or ":" is a key of a TOML, INI or
    # YAML sample, not a command.
    function check_sample(s,    w, rest, hit) {
      hit = 0
      if (s ~ /^\$[ \t]/) {
        hit = 1; w = "$"
      } else {
        w = s
        sub(/[ \t].*$/, "", w)
        if (w in commandword) {
          rest = substr(s, length(w) + 1)
          sub(/^[ \t]+/, "", rest)
          if (rest != "" && rest !~ /^[=:]/) { hit = 1 }
        }
      }
      if (hit) {
        fail(sprintf("%s:%d: this line of a \"%s\" fence starts like a command (%s); a command block must not carry a sample-language tag, so tag it as the shell it is for (bash, powershell, text) or reword the sample", FILENAME, NR, fencelang, w))
      }
    }

    function close_fence() {
      if (counted) { flush_joined() }
      if (nhere > 0) {
        fail(sprintf("%s:%d: the heredoc <<%s opened on this line is not terminated before its code fence closes (line %d)", FILENAME, hereline, here[herenext], NR))
      }
      infence = 0; counted = 0; inbody = 0
    }

    BEGIN {
      dq = "\""
      wordsep = "[ \t|;&()<>\"`" sq "]+"
      set_of(samples, sample)
      set_of(powershells, powershell)
      set_of(cmds, cmd)
      set_of(shells, shellword)
      set_of(commands, commandword)
      section = "(preamble)"; order[++n] = section; count[section] = 0
      infence = 0; counted = 0; total = 0; nhere = 0; herenext = 1; joining = 0; inbody = 0
    }

    {
      sub(/\r$/, "")

      if (infence) {
        body = unquote($0, fencedepth)
        if (markers == fencedepth) {
          if (run(body, fencechar) >= fencelen && substr(body, run(body, fencechar) + 1) ~ /^[ \t]*$/) {
            close_fence()
          } else if (counted) {
            feed(body)
          } else {
            check_sample(body)
          }
          next
        }
        # Fewer markers than the opening line: the blockquote the fence
        # was in has ended, which closes the fence. The line itself is
        # ordinary text and is read as such below.
        close_fence()
      }

      line = unquote($0, -1)
      # A fence may open on the line of a list marker ("- ```bash").
      while (sub(/^([-*+]|[0-9]+[.)])[ \t]+/, "", line)) { }
      c = substr(line, 1, 1)
      if (c == "`" || c == "~") {
        len = run(line, c)
        info = substr(line, len + 1)
        # A backtick in the rest of the line makes it inline code, not
        # a fence (CommonMark).
        if (len >= fence_min && !(c == "`" && index(info, "`") > 0)) {
          infence = 1; fencechar = c; fencelen = len; fencedepth = markers; fenceline = NR
          sub(/^[ \t]*[{.]*/, "", info)
          split(info, words, /[ \t{},:]/)
          fencelang = tolower(words[1])
          counted = !(fencelang in sample)
          set_dialect(fencelang)
          next
        }
      }

      if ($0 ~ /^ ? ? ?##[ \t]/) {
        section = $0
        sub(/^ *##[ \t]+/, "", section)
        sub(/[ \t]+#+[ \t]*$/, "", section)
        sub(/[ \t]+$/, "", section)
        if (!(section in count)) { order[++n] = section; count[section] = 0 }
      }
    }

    END {
      if (failed) { exit 1 }
      if (infence) {
        fail(sprintf("%s:%d: the code fence opened on this line is never closed", FILENAME, fenceline))
      }
      for (i = 1; i <= n; i++) { printf "%d\t%s\n", count[order[i]], order[i] }
      printf "%d\tTOTAL\n", total
    }
  ' "$readme"
}

# The line count is awk's record count, so a last line without a
# trailing newline is a line (`wc -l` counts newline characters and
# would leave it out).
lines=$(awk 'END { print NR }' "$readme")
table="$(counts)" || exit 1
total=$(printf '%s\n' "$table" | awk -F'\t' '$2 == "TOTAL" { print $1 }')
quickstart=$(printf '%s\n' "$table" | awk -F'\t' -v h="$(printf '%s' "$QUICKSTART_HEADING" | tr '[:upper:]' '[:lower:]')" 'tolower($2) == h { print $1 }')
self_hosting=$(printf '%s\n' "$table" | awk -F'\t' -v h="$(printf '%s' "$SELF_HOSTING_HEADING" | tr '[:upper:]' '[:lower:]')" 'tolower($2) == h { print $1 }')

echo "README commands by section ($readme):"
printf '%s\n' "$table" | awk -F'\t' '$2 != "TOTAL" { printf "  %4d  %s\n", $1, $2 }'
echo
printf '  Quickstart    %s (budget %d)\n' "${quickstart:-no such section}" "$QUICKSTART_MAX"
printf '  Self-hosting  %s (budget %d)\n' "${self_hosting:-no such section}" "$SELF_HOSTING_MAX"
printf '  Total         %d (budget %d)\n' "$total" "$TOTAL_MAX"
printf '  Lines         %d (budget %d)\n' "$lines" "$LINES_MAX"

status=0
over() { echo "OVER BUDGET: $1" >&2; status=1; }
[ -n "$quickstart" ] || over "no \"## $QUICKSTART_HEADING\" section"
[ -n "$self_hosting" ] || over "no \"## $SELF_HOSTING_HEADING\" section"
[ -z "$quickstart" ] || [ "$quickstart" -le "$QUICKSTART_MAX" ] || over "$QUICKSTART_HEADING has $quickstart commands, budget $QUICKSTART_MAX"
[ -z "$self_hosting" ] || [ "$self_hosting" -le "$SELF_HOSTING_MAX" ] || over "$SELF_HOSTING_HEADING has $self_hosting commands, budget $SELF_HOSTING_MAX"
[ "$total" -le "$TOTAL_MAX" ] || over "$total commands in total, budget $TOTAL_MAX"
[ "$lines" -le "$LINES_MAX" ] || over "$lines lines, budget $LINES_MAX"

if [ "$status" -ne 0 ]; then
  if [ "$report" -eq 1 ]; then
    echo "(report mode: not failing)"
    exit 0
  fi
  echo "readme-budget: the README is over budget; move contributor steps to CONTRIBUTING.md, never user-facing content" >&2
  exit 1
fi
echo "README within budget."
