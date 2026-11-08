#!/usr/bin/env bash
# Measures the README against its command budget and fails when it is
# over. The budget is the honesty rule of the single-binary work: the
# README shrinks because a user has fewer commands to run, not because
# user-facing text was moved out of it. Only contributor steps (clone,
# `make dev`, per-component commands) belong in CONTRIBUTING.md.
#
# What is counted: every non-blank line that is not a whole-line comment
# inside a fenced code block whose info string is bash, sh, shell,
# console or text, the fences the README writes commands in. Python,
# YAML and other fences are code samples, not steps, and are not
# counted. Lines are attributed to the `## ` section they appear in
# (the text before the first `## ` heading is "(preamble)"), so a
# section's count is what a reader of that section types.
#
# Usage: scripts/readme-budget.sh [--report] [README path]
#   Prints the per-section counts, the total and the line count.
#   Without --report it exits 1 when a budget is exceeded; with
#   --report it only prints, for a README that is known to be over
#   budget while it is being rewritten.
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

report=0
readme=""
for arg in "$@"; do
  case "$arg" in
    --report) report=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) readme="$arg" ;;
  esac
done
readme="${readme:-$ROOT/README.md}"
[ -f "$readme" ] || { echo "readme-budget: no such file: $readme" >&2; exit 2; }

# counts prints one "<count>\t<section>" line per section in document
# order, then "<total>\tTOTAL". Fences are matched on their opening
# line's info string; a fence closes at the next line that is only
# backticks (after optional indentation, so a block inside a list item
# counts as well).
counts() {
  awk '
    function flush() { if (section != "") { printf "%d\t%s\n", count[section], section } }
    BEGIN { section = "(preamble)"; order[++n] = section; count[section] = 0; infence = 0; counted = 0 }
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      if (infence) {
        if (line ~ /^```+[ \t]*$/) { infence = 0; counted = 0; next }
        if (counted && line !~ /^[ \t]*$/ && line !~ /^#/) { count[section]++; total++ }
        next
      }
      if (line ~ /^```/) {
        infence = 1
        info = line
        sub(/^```+[ \t]*/, "", info)
        split(info, words, /[ \t{,]/)
        lang = tolower(words[1])
        counted = (lang == "bash" || lang == "sh" || lang == "shell" || lang == "console" || lang == "text")
        next
      }
      if ($0 ~ /^## /) {
        section = $0
        sub(/^## +/, "", section)
        sub(/[ \t]+$/, "", section)
        if (!(section in count)) { order[++n] = section; count[section] = 0 }
      }
    }
    END {
      for (i = 1; i <= n; i++) { printf "%d\t%s\n", count[order[i]], order[i] }
      printf "%d\tTOTAL\n", total
    }
  ' "$readme"
}

lines=$(wc -l <"$readme" | tr -d ' ')
table="$(counts)"
total=$(printf '%s\n' "$table" | awk -F'\t' '$2 == "TOTAL" { print $1 }')
quickstart=$(printf '%s\n' "$table" | awk -F'\t' -v h="$(printf '%s' "$QUICKSTART_HEADING" | tr '[:upper:]' '[:lower:]')" 'tolower($2) == h { print $1 }')
self_hosting=$(printf '%s\n' "$table" | awk -F'\t' -v h="$(printf '%s' "$SELF_HOSTING_HEADING" | tr '[:upper:]' '[:lower:]')" 'tolower($2) == h { print $1 }')

echo "README command lines by section ($readme):"
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
[ -z "$quickstart" ] || [ "$quickstart" -le "$QUICKSTART_MAX" ] || over "$QUICKSTART_HEADING has $quickstart command lines, budget $QUICKSTART_MAX"
[ -z "$self_hosting" ] || [ "$self_hosting" -le "$SELF_HOSTING_MAX" ] || over "$SELF_HOSTING_HEADING has $self_hosting command lines, budget $SELF_HOSTING_MAX"
[ "$total" -le "$TOTAL_MAX" ] || over "$total command lines in total, budget $TOTAL_MAX"
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
