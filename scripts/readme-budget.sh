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
# The install block. The README's promise is that installing is one
# command, so the first counted fence of the `## Install` section that
# is not folded away (below) must be exactly one line holding exactly
# one command: no second line, no command chained onto it, no comment,
# no blank line and no `$ ` prompt. The section may show one more
# command outside that block, and that command must be the one that
# starts the binary: `flightdeck`, alone or followed by flags
# (`flightdeck --listen 127.0.0.1:4100`), whatever its fence is tagged.
# A second install command therefore fails the run wherever it is put:
# in the block, chained onto its line, or in another visible block
# (`brew install ...` under a bash fence, `irm ... | iex` under a
# powershell one).
#
# Folded commands. A fence inside a collapsed `<details>` element is
# counted like any other: it adds to its section's count and to the
# total, so alternatives folded under one line still cost budget. It
# does not add to the section's visible count, which is what the
# install budget limits: the other install channels sit in a
# `<details>` under the install block. What counts as folded is what
# GitHub renders folded:
#   - `<details open>` is rendered unfolded, in any spelling of the
#     attribute (`OPEN`, `open=""`, `open="open"`), so its fences are
#     visible; so are those of a tag that does not close on its own
#     line, whose attributes cannot be read.
#   - A collapsed element inside an open one is folded, and an open
#     one inside a collapsed one is folded with it. A fence after an
#     element has closed is outside it, however short the element was.
#   - An element with an empty `<summary>`, or with none, is still
#     folded.
#   - A tag inside an HTML comment (`<!-- <details> -->`, on one line
#     or over several) is not a tag, and neither is one inside inline
#     code, one written `\<details>`, or one on a line indented four
#     columns or more (an indented code block; inside a nested list
#     this errs towards counting the fences as visible).
# The tags are read on lines outside fences, in any letter case. A
# `<details>` that is never closed would fold everything after it: it
# is an error (exit 1) that names the line it opened on.
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
# Known inaccuracies, none of which a README needs to rely on:
#   - Only fenced blocks are counted. A command written as inline code
#     in a sentence or a table cell, or in a `<pre>` element, is not:
#     a step a reader types belongs in a fence.
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
# The install block: one command, because "one command, and that's it"
# is what the README says about installing. The number is exact, not a
# ceiling: an install block with no command in it fails as well.
INSTALL_BLOCK_COMMANDS=1
# Install, visible: the install command and `flightdeck` to start it.
# The other channels (Homebrew, pip, Docker, Windows) are folded in a
# `<details>` and count toward the total only. A third visible command
# means a step crept back into the first-run path.
INSTALL_VISIBLE_MAX=2
# Connect your agents: the plugin's three REPL lines (add the
# marketplace, install, reload) and one pip install (the sensor's two
# lines of Python are a python fence and not counted). A fifth command
# means a step crept back in.
CONNECT_MAX=4
# Self-hosting: TLS is one flag (`--domain`), Postgres one flag
# (`--database-url`), Docker, Compose and Helm are one command each,
# and Compose and Helm read their files from a clone, which is the
# sixth. Nothing is spare: a seventh command means a step crept in.
SELF_HOSTING_MAX=6
# Total: the three sections above plus the install channels folded
# under the install block, with a few to spare. Twenty is roughly a
# third of what the README carried when the stack was seven containers
# compiled from source.
TOTAL_MAX=20
# Length: half of the pre-rewrite README, and only because the steps
# are gone; reference material stays in the README or moves to a page
# of its own that the README links.
LINES_MAX=300

# The section headings the per-section budgets apply to, as they appear
# after `## ` (compared case-insensitively).
INSTALL_HEADING="Install"
# The only command the install section may show besides the install
# block: the binary's own name, with or without `.exe`, alone or
# followed by flags. An extended regular expression, matched against
# the whole command; it reaches awk through -v, which reads backslash
# escapes, so the dot is written as a bracket expression and \t is a
# tab by the time awk compiles it.
RUN_COMMAND_RE='^flightdeck([.]exe)?([ \t]+-.*)?$'
CONNECT_HEADING="Connect your agents"
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

# lower <text>: the text in lower case, for the case-insensitive heading
# comparisons.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# counts prints one "S\t<count>\t<folded>\t<section>" line per section
# in document order (folded is the part of the count inside a collapsed
# <details>), then "T\t<total>", then, when the install section has a
# visible counted fence, "B\t<commands>\t<lines>\t<prompts>\t<line>"
# for the first one: its commands, its lines of any kind, how many of
# them start with a prompt, and the line it opens on; and, when the
# install section shows a command outside that block that is not the
# run command, "O\t<count>\t<line>\t<command>" for the first such
# command. It exits 1 with a
# message on a fence, a heredoc or a <details> that is never closed and
# on a command in a sample fence. The rules are the ones in the header;
# the program keeps to POSIX awk (no gawk functions), and takes the
# single quote as a variable because it sits inside a quoted shell
# word.
counts() {
  awk -v samples="$SAMPLE_LANGUAGES" -v powershells="$POWERSHELL_LANGUAGES" \
    -v cmds="$CMD_LANGUAGES" -v shells="$SHELL_WORDS" \
    -v commands="$COMMAND_WORDS" -v fence_min="$FENCE_MIN_LENGTH" \
    -v install="$(lower "$INSTALL_HEADING")" -v runre="$RUN_COMMAND_RE" -v sq="'" '
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
    function count_commands(s,    i, n, ch, nx, prev, q, has, segs, r, r1, fed, cut, cmd) {
      n = length(s); q = ""; has = 0; segs = 0; prev = " "; fed = -1; cut = n + 1
      for (i = 1; i <= n; i++) {
        ch = substr(s, i, 1)
        if (q == sq) { if (ch == sq) { q = "" }; continue }
        if (q == dq) { if (dqesc != "" && ch == dqesc) { i++ } else if (ch == dq) { q = "" }; continue }
        if (ch == " " || ch == "\t") { prev = " "; continue }
        if (hashcomments && ch == "#" && prev == " ") { cut = i; break }
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
      if (fencefolded) { folded[section] += segs }
      if (inblock) { blockcommands += segs }
      # A visible command of the install section outside the install
      # block must be the run command, and nothing chained onto it.
      if (inrun) {
        cmd = substr(s, 1, cut - 1)
        sub(/^[ \t]+/, "", cmd); sub(/[ \t]+$/, "", cmd)
        if (segs != 1 || cmd !~ runre) {
          if (++others == 1) { otherline = NR; othercmd = substr(cmd, 1, 60) }
        }
      }
    }

    # s without its HTML comments. A comment may run over several
    # lines: incomment carries the open state to the next one.
    function strip_comments(s,    out, i, j) {
      out = ""
      while (1) {
        if (incomment) {
          j = index(s, "-->")
          if (j == 0) { return out }
          s = substr(s, j + 3); incomment = 0
        }
        i = index(s, "<!--")
        if (i == 0) { return out s }
        out = out substr(s, 1, i - 1)
        s = substr(s, i + 4); incomment = 1
      }
    }

    # Reads the <details> and </details> tags of a line outside fences
    # into the stack of open elements: dfold[k] says whether the k-th
    # open element is collapsed, nfolded how many are. Inline code and
    # an escaped "<" are dropped first, so a tag that is only mentioned
    # does not count.
    function scan_details(s,    i, j, c, gt, tag) {
      gsub(/`[^`]*`/, "", s)
      gsub(/\\</, "", s)
      s = tolower(s)
      while (1) {
        i = index(s, "<details"); j = index(s, "</details")
        if (i == 0 && j == 0) { return }
        if (j > 0 && (i == 0 || j < i)) {
          if (ndetails > 0) { nfolded -= dfold[ndetails]; ndetails-- }
          s = substr(s, j + 9)
          continue
        }
        c = substr(s, i + 8, 1)
        if (c == ">" || c == " " || c == "\t" || c == "/" || c == "") {
          gt = index(substr(s, i), ">")
          tag = (gt > 0) ? substr(s, i, gt) : ""
          ndetails++
          # Collapsed unless it carries the open attribute; a tag that
          # does not end on this line is taken as open, which errs
          # towards counting its fences as visible.
          dfold[ndetails] = (gt > 0 && tag !~ /[ \t]open([ \t=\/>]|$)/) ? 1 : 0
          nfolded += dfold[ndetails]
          if (ndetails == 1) { detailsline = NR }
        }
        s = substr(s, i + 8)
      }
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
      infence = 0; counted = 0; inbody = 0; inblock = 0; fencefolded = 0; inrun = 0
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
      folded[section] = 0
      infence = 0; counted = 0; total = 0; nhere = 0; herenext = 1; joining = 0; inbody = 0
      ndetails = 0; nfolded = 0; fencefolded = 0
      blockseen = 0; inblock = 0; blockcommands = 0; blocklines = 0; blockprompts = 0
      incomment = 0; inrun = 0; others = 0
    }

    {
      sub(/\r$/, "")

      if (infence) {
        body = unquote($0, fencedepth)
        if (markers == fencedepth) {
          if (run(body, fencechar) >= fencelen && substr(body, run(body, fencechar) + 1) ~ /^[ \t]*$/) {
            close_fence()
          } else if (counted) {
            if (inblock) {
              blocklines++
              if (body ~ /^[$>][ \t]/) { blockprompts++ }
            }
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
          fencefolded = (nfolded > 0)
          # The install block: the first counted fence of the install
          # section that is not folded.
          if (counted && !fencefolded && !blockseen && tolower(section) == install) {
            blockseen = 1; inblock = 1; blockline = NR
          }
          inrun = (counted && !fencefolded && !inblock && tolower(section) == install)
          next
        }
      }

      # Comments are tracked on every line, so one that opens on an
      # indented line still closes; tags are not read on a line that
      # is an indented code block.
      plain = strip_comments($0)
      if ($0 !~ /^(    |\t)/) { scan_details(plain) }

      if ($0 ~ /^ ? ? ?##[ \t]/) {
        section = $0
        sub(/^ *##[ \t]+/, "", section)
        sub(/[ \t]+#+[ \t]*$/, "", section)
        sub(/[ \t]+$/, "", section)
        if (!(section in count)) { order[++n] = section; count[section] = 0; folded[section] = 0 }
      }
    }

    END {
      if (failed) { exit 1 }
      if (infence) {
        fail(sprintf("%s:%d: the code fence opened on this line is never closed", FILENAME, fenceline))
      }
      if (ndetails > 0) {
        fail(sprintf("%s:%d: the <details> opened on this line is never closed", FILENAME, detailsline))
      }
      for (i = 1; i <= n; i++) { printf "S\t%d\t%d\t%s\n", count[order[i]], folded[order[i]], order[i] }
      printf "T\t%d\n", total
      if (blockseen) { printf "B\t%d\t%d\t%d\t%d\n", blockcommands, blocklines, blockprompts, blockline }
      if (others > 0) { printf "O\t%d\t%d\t%s\n", others, otherline, othercmd }
    }
  ' "$readme"
}

# The line count is awk's record count, so a last line without a
# trailing newline is a line (`wc -l` counts newline characters and
# would leave it out).
lines=$(awk 'END { print NR }' "$readme")
table="$(counts)" || exit 1
total=$(printf '%s\n' "$table" | awk -F'\t' '$1 == "T" { print $2 }')

# section_count <heading> <field>: the count (field 2) or the folded
# count (field 3) of a section, compared case-insensitively and summed
# over headings that differ only in case; empty when there is no such
# section.
section_count() {
  printf '%s\n' "$table" | awk -F'\t' -v h="$(lower "$1")" -v f="$2" \
    '$1 == "S" && tolower($4) == h { sum += $f; found = 1 } END { if (found) print sum }'
}
install=$(section_count "$INSTALL_HEADING" 2)
install_folded=$(section_count "$INSTALL_HEADING" 3)
connect=$(section_count "$CONNECT_HEADING" 2)
self_hosting=$(section_count "$SELF_HOSTING_HEADING" 2)
install_visible=""
[ -z "$install" ] || install_visible=$((install - install_folded))
# The install block's row: commands, lines, prompts and where it opens.
block=$(printf '%s\n' "$table" | awk -F'\t' '$1 == "B" { print $2, $3, $4, $5 }')
block_commands=""
block_lines=""
block_prompts=""
block_at=""
if [ -n "$block" ]; then
  read -r block_commands block_lines block_prompts block_at <<<"$block"
fi

# The first visible command of the install section that is neither the
# install block nor the run command, if there is one.
other=$(printf '%s\n' "$table" | awk -F'\t' '$1 == "O" { print $2 "\t" $3 "\t" $4 }')
other_count=0
other_at=""
other_command=""
if [ -n "$other" ]; then
  IFS=$'\t' read -r other_count other_at other_command <<<"$other"
fi

echo "README commands by section ($readme):"
echo "  total  folded  section"
printf '%s\n' "$table" | awk -F'\t' '$1 == "S" { printf "  %5d  %6d  %s\n", $2, $3, $4 }'
echo
echo "  (folded: inside a collapsed <details>; counted in the section and the total, not in what the section shows)"
echo
printf '  Install block        %s (exactly %d, on one line)\n' "${block_commands:-none}" "$INSTALL_BLOCK_COMMANDS"
printf '  Install, visible     %s (budget %d)\n' "${install_visible:-no such section}" "$INSTALL_VISIBLE_MAX"
printf '  Install, other       %d (exactly 0: beside the install block only "flightdeck" may show)\n' "$other_count"
printf '  Connect your agents  %s (budget %d)\n' "${connect:-no such section}" "$CONNECT_MAX"
printf '  Self-hosting         %s (budget %d)\n' "${self_hosting:-no such section}" "$SELF_HOSTING_MAX"
printf '  Total                %d (budget %d)\n' "$total" "$TOTAL_MAX"
printf '  Lines                %d (budget %d)\n' "$lines" "$LINES_MAX"

status=0
over() { echo "OVER BUDGET: $1" >&2; status=1; }
[ -n "$install" ] || over "no \"## $INSTALL_HEADING\" section"
[ -n "$connect" ] || over "no \"## $CONNECT_HEADING\" section"
[ -n "$self_hosting" ] || over "no \"## $SELF_HOSTING_HEADING\" section"
if [ -n "$install" ] && [ -z "$block" ]; then
  over "$INSTALL_HEADING has no command block outside <details>: the install command must be visible"
fi
if [ -n "$block" ]; then
  [ "$block_commands" -eq "$INSTALL_BLOCK_COMMANDS" ] || over "the install block (line $block_at) has $block_commands commands, must be exactly $INSTALL_BLOCK_COMMANDS: the other install channels belong in the <details> under it"
  [ "$block_lines" -eq 1 ] || over "the install block (line $block_at) has $block_lines lines, must be exactly one: no comment, no blank line, no second command"
  [ "$block_prompts" -eq 0 ] || over "the install block (line $block_at) starts with a prompt; show the command alone"
fi
[ "$other_count" -eq 0 ] || over "$INSTALL_HEADING shows a command that is neither the install command nor \"flightdeck\" (line $other_at: $other_command): another way to install belongs in the <details> under the install block"
[ -z "$install_visible" ] || [ "$install_visible" -le "$INSTALL_VISIBLE_MAX" ] || over "$INSTALL_HEADING shows $install_visible commands outside <details>, budget $INSTALL_VISIBLE_MAX"
[ -z "$connect" ] || [ "$connect" -le "$CONNECT_MAX" ] || over "$CONNECT_HEADING has $connect commands, budget $CONNECT_MAX"
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
