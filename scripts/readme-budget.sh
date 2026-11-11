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
#
# A fence that is never closed, and a heredoc that is not terminated
# before its fence closes, would hide what follows them: both are
# errors (exit 1) that name the line they opened on.
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
# or a heredoc that is never closed. The rules are the ones in the
# header; the program keeps to POSIX awk (no gawk functions), and takes
# the single quote as a variable because it sits inside a quoted shell
# word.
counts() {
  awk -v samples="$SAMPLE_LANGUAGES" -v fence_min="$FENCE_MIN_LENGTH" -v sq="'" '
    function fail(msg) {
      printf "readme-budget: %s\n", msg > "/dev/stderr"
      failed = 1
      exit 1
    }

    # The length of the run of character c that s starts with.
    function run(s, c,    n) {
      n = 0
      while (substr(s, n + 1, 1) == c) { n++ }
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

    # Counts the commands of one logical line (continuations already
    # joined) into the current section, and queues the terminators of
    # the heredocs it opens.
    function count_commands(s,    i, n, ch, nx, prev, q, has, segs, r, r1) {
      n = length(s); q = ""; has = 0; segs = 0; prev = " "
      for (i = 1; i <= n; i++) {
        ch = substr(s, i, 1)
        if (q == sq) { if (ch == sq) { q = "" }; continue }
        if (q == dq) { if (ch == "\\") { i++ } else if (ch == dq) { q = "" }; continue }
        if (ch == " " || ch == "\t") { prev = " "; continue }
        if (ch == "#" && prev == " ") { break }
        if (ch == "\\") { i++; has = 1; prev = ch; continue }
        if (ch == sq || ch == dq) { q = ch; has = 1; prev = ch; continue }
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
        if (ch == "<" && nx == "<") {
          if (substr(s, i + 2, 1) == "<") { i += 2; has = 1; prev = ch; continue }
          r = substr(s, i + 2)
          sub(/^-/, "", r)
          sub(/^[ \t]+/, "", r)
          r1 = substr(r, 1, 1)
          if (r1 == sq || r1 == dq || r1 == "\\") { r = substr(r, 2) }
          if (match(r, /^[A-Za-z_][A-Za-z0-9_]*/)) {
            here[++nhere] = substr(r, 1, RLENGTH)
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

    # One line of a counted fence, already without its blockquote
    # markers and indentation.
    function feed(s,    t) {
      if (nhere > 0) {
        sub(/[ \t]+$/, "", s)
        t = s
        sub(/^[$>][ \t]+/, "", t)
        if (s == here[herenext] || t == here[herenext]) {
          if (++herenext > nhere) { nhere = 0; herenext = 1 }
        }
        return
      }
      sub(/^[$>][ \t]+/, "", s)
      if (!joining) {
        if (s ~ /^[ \t]*$/ || s ~ /^#/) { return }
      } else {
        s = joined s
      }
      if (run_back(s) % 2 == 1) {
        joined = substr(s, 1, length(s) - 1)
        joining = 1
        return
      }
      joining = 0; joined = ""
      if (s !~ /^[ \t]*$/) { count_commands(s) }
    }

    # The number of backslashes s ends with: an odd number means the
    # last one escapes the newline.
    function run_back(s,    n, len) {
      n = 0; len = length(s)
      while (n < len && substr(s, len - n, 1) == "\\") { n++ }
      return n
    }

    function close_fence() {
      if (counted && joining) {
        joining = 0
        if (joined !~ /^[ \t]*$/) { count_commands(joined) }
        joined = ""
      }
      if (nhere > 0) {
        fail(sprintf("%s:%d: the heredoc <<%s opened on this line is not terminated before its code fence closes (line %d)", FILENAME, hereline, here[herenext], NR))
      }
      infence = 0; counted = 0
    }

    BEGIN {
      dq = "\""
      nsamples = split(samples, words, /[ \t\n]+/)
      for (i = 1; i <= nsamples; i++) { if (words[i] != "") { sample[words[i]] = 1 } }
      section = "(preamble)"; order[++n] = section; count[section] = 0
      infence = 0; counted = 0; total = 0; nhere = 0; herenext = 1; joining = 0
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
          counted = !(tolower(words[1]) in sample)
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
