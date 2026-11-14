#!/usr/bin/env python3
"""Extracts one release's section of CHANGELOG.md as the GitHub release notes.

    python3 scripts/release_notes.py v0.9.0            # the "## v0.9.0 — <date>" section
    python3 scripts/release_notes.py v0.9.0-rc.1       # a dry run: v0.9.0's section once dated
    python3 scripts/release_notes.py v0.9.0 -o notes.md

The release workflow writes the result to a file and hands it to
goreleaser (--release-notes), so the GitHub release reads what the
CHANGELOG says instead of a generated commit list. A pre-release tag
(any -suffix) is a dry run of the release it names: its notes are that
release's section once the release PR has dated it (the dry run that
RELEASING.md runs before the final tag comes after that PR, whose
version bump the tag guard requires), and the Unreleased entries before
then. The section's body is written as it is in the CHANGELOG, without
its heading.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"

# vX.Y.Z, with an optional pre-release suffix after a hyphen (v1.2.3-rc.1).
TAG_RE = re.compile(r"^v(?P<base>\d+\.\d+\.\d+)(?P<pre>-[0-9A-Za-z.]+)?$")


def section_heading(tag: str, text: str = "") -> str:
    """The CHANGELOG heading the tag's notes live under, without the date.

    A release tag reads its own dated section. A pre-release tag reads the
    section of the release it is a dry run of when ``text`` (the
    CHANGELOG) has dated it, and the Unreleased section otherwise.
    """
    m = TAG_RE.match(tag)
    if not m:
        sys.exit(f"{tag!r} is not a release tag (vX.Y.Z or vX.Y.Z-<pre-release>)")
    dated = f"## v{m.group('base')} —"
    if m.group("pre") and not any(line.startswith(dated) for line in text.splitlines()):
        return "## Unreleased"
    return dated


def extract(text: str, tag: str) -> str:
    """The body of the tag's section: from its heading to the next '## '."""
    heading = section_heading(tag, text)
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(heading)), None)
    if start is None:
        sys.exit(f"CHANGELOG.md has no '{heading}' section for {tag}")
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    body = "\n".join(lines[start + 1 : end]).strip("\n")
    if not body.strip():
        sys.exit(f"the '{heading}' section of CHANGELOG.md is empty")
    return body + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("tag", help="the release tag, vX.Y.Z or vX.Y.Z-rc.1")
    parser.add_argument("-o", "--output", help="write here instead of stdout")
    args = parser.parse_args()
    notes = extract(CHANGELOG.read_text(encoding="utf-8"), args.tag)
    if args.output:
        Path(args.output).write_text(notes, encoding="utf-8")
    else:
        sys.stdout.write(notes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
