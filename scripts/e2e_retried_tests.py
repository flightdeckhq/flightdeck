#!/usr/bin/env python3
"""Lists the browser tests that passed only on a retry, from a Playwright JSON report.

    python3 scripts/e2e_retried_tests.py report.json
    python3 scripts/e2e_retried_tests.py report.json --summary "$GITHUB_STEP_SUMMARY" --max 2

CI retries a failed browser test once. A test that fails and then
passes leaves the E2E check green and nothing else says it happened,
so such tests went unseen: over 105 runs, 21 had one. This script reads
the merged report (`playwright merge-reports --reporter html,json`),
prints one GitHub warning annotation per such test, writes a table of
them to the job summary, and exits 1 when there are more than --max of
them. A test whose retry failed too is not counted here: the run is
red for it already.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# The status the JSON reporter gives a test that failed and then passed.
RETRIED_STATUS = "flaky"
# The terminal colour codes Playwright puts in its error messages.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
# The longest first line of an error an annotation and a table cell
# carry: enough for the assertion and its locator, short enough to read
# in the checks list.
ERROR_CHARS = 200


@dataclass(frozen=True)
class Retried:
    file: str
    line: int | None
    title: str
    project: str
    error: str


def first_error_line(test: dict[str, Any]) -> str:
    """The first line of the first failed attempt's error, without colour codes."""
    for result in test.get("results", []):
        messages = [result.get("error") or {}] + list(result.get("errors") or [])
        for error in messages:
            message = ANSI_RE.sub("", error.get("message") or "")
            for line in message.splitlines():
                if line.strip():
                    return line.strip()[:ERROR_CHARS]
    return ""


def retried_tests(report: dict[str, Any]) -> list[Retried]:
    """Every test of the report that passed only on a retry, in report order."""
    found: list[Retried] = []

    def walk(suite: dict[str, Any], path: list[str]) -> None:
        for spec in suite.get("specs", []):
            title = " › ".join([*path, spec.get("title", "")])
            for test in spec.get("tests", []):
                if test.get("status") == RETRIED_STATUS:
                    found.append(
                        Retried(
                            file=spec.get("file", ""),
                            line=spec.get("line"),
                            title=title,
                            project=test.get("projectName", ""),
                            error=first_error_line(test),
                        )
                    )
        for child in suite.get("suites", []):
            walk(child, [*path, child.get("title", "")])

    # A top-level suite is a spec file; its title is the file name,
    # which the row carries already.
    for suite in report.get("suites", []):
        walk(suite, [])
    return found


def annotation(test: Retried) -> str:
    """A GitHub warning annotation for one test."""

    def escape(text: str) -> str:
        return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")

    where = f"{test.file}:{test.line}" if test.line else test.file
    detail = f"[{test.project}] {where} › {test.title}"
    if test.error:
        detail += f": {test.error}"
    return f"::warning title=E2E test passed only on a retry::{escape(detail)}"


def summary(tests: list[Retried], limit: int | None) -> str:
    """The job summary: what was retried, and what it means."""
    if not tests:
        return "### E2E: no test needed a retry\n"

    def cell(text: str) -> str:
        return text.replace("|", "\\|").replace("\n", " ")

    count = len(tests)
    lines = [
        f"### E2E: {count} test{'s' if count != 1 else ''} passed only on a retry",
        "",
        "CI retries a failed browser test once, so the check is green, but each of these"
        " failed its first attempt. A test that does this is fixed, not retried"
        " (dashboard/CLAUDE.md, rule 40c.1). The first attempt's trace is in the"
        " `playwright-report` artifact.",
        "",
        "| Spec | Test | Project | First attempt |",
        "|---|---|---|---|",
    ]
    for test in tests:
        row = [f"`{cell(test.file)}`", cell(test.title), cell(test.project), cell(test.error)]
        lines.append("| " + " | ".join(row) + " |")
    if limit is not None and count > limit:
        lines += [
            "",
            f"More than {limit} in one run fails the job: that many is not one unlucky test.",
        ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", type=Path, help="the merged Playwright JSON report")
    parser.add_argument(
        "--summary", type=Path, help="append the table to this file (the job summary)"
    )
    parser.add_argument(
        "--max", type=int, dest="limit", help="exit 1 when more tests than this were retried"
    )
    args = parser.parse_args(argv)

    try:
        report = json.loads(args.report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"e2e_retried_tests: cannot read {args.report}: {err}", file=sys.stderr)
        return 2
    tests = retried_tests(report)
    for test in tests:
        print(annotation(test))
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as fh:
            fh.write(summary(tests, args.limit))
    print(f"{len(tests)} test(s) passed only on a retry")
    if args.limit is not None and len(tests) > args.limit:
        print(
            f"e2e_retried_tests: {len(tests)} tests passed only on a retry, "
            f"more than the {args.limit} allowed",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
