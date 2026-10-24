#!/usr/bin/env python3
"""The single source of Flightdeck's release version.

The root ``VERSION`` file holds it (``0.6.0``, no leading ``v``). Every
other file that carries the version gets it from here:

    python3 scripts/version.py set 0.6.0      # write it everywhere
    python3 scripts/version.py check          # every location matches VERSION
    python3 scripts/version.py check --tag v0.6.0   # ... and VERSION matches the tag
    python3 scripts/version.py changelog 0.6.0      # "## Unreleased" -> "## v0.6.0 -- <date>"

``check`` runs in CI and in the release workflow, so a location that
drifts (or a new copy nobody added here) fails the build instead of
shipping a mismatched release.
"""

from __future__ import annotations

import argparse
import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / "VERSION"

# A release version: X.Y.Z. Pre-releases are not supported yet: the sensor
# needs the PEP 440 form (0.6.0rc1) and the Helm chart the SemVer form
# (0.6.0-rc1), so one string cannot serve every location.
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")

# (path, pattern, expected matches). Each pattern's ``v`` group is the
# version text; set() replaces exactly that span. The expected count
# guards against a pattern that silently stops matching, or a second
# copy appearing that this table does not know about.
LOCATIONS: list[tuple[str, str, int]] = [
    ("sensor/pyproject.toml", r'(?m)^version = "(?P<v>[^"]+)"', 1),
    # uv.lock records the project's own version; CI's `uv sync --locked`
    # fails when it differs from pyproject.toml.
    ("sensor/uv.lock", r'(?m)^name = "flightdeck-sensor"\nversion = "(?P<v>[^"]+)"', 1),
    ("plugin/.claude-plugin/plugin.json", r'(?m)^  "version": "(?P<v>[^"]+)"', 1),
    ("plugin/package.json", r'(?m)^  "version": "(?P<v>[^"]+)"', 1),
    (".claude-plugin/marketplace.json", r'(?m)^      "version": "(?P<v>[^"]+)"', 1),
    (".claude-plugin/marketplace.json", r'"ref": "v(?P<v>[^"]+)"', 1),
    ("helm/Chart.yaml", r"(?m)^version: (?P<v>\S+)$", 1),
    ("helm/Chart.yaml", r'(?m)^appVersion: "(?P<v>[^"]+)"$', 1),
    ("helm/values.yaml", r'(?m)^  tag: "v(?P<v>[^"]+)"$', 1),
    ("README.md", r"The chart is at `version` (?P<v>[^ ]+) with", 1),
    ("README.md", r"with `appVersion` (?P<v>[^;]+);", 1),
    ("README.md", r"the default `image\.tag` is `v(?P<v>[^`]+)`", 1),
    ("README.md", r"\| `image\.tag` \| `v(?P<v>[^`]+)` \|", 1),
    ("api/cmd/main.go", r"(?m)^// @version\s+(?P<v>\S+)$", 1),
    ("api/docs/docs.go", r'Version:\s+"(?P<v>[^"]+)",', 1),
    ("api/docs/swagger.json", r'(?s)"info": \{.*?"version": "(?P<v>[^"]+)"', 1),
    ("api/docs/swagger.yaml", r"(?m)^info:\n(?:  .*\n)*?  version: (?P<v>\S+)$", 1),
    ("ingestion/cmd/main.go", r"(?m)^// @version\s+(?P<v>\S+)$", 1),
    ("ingestion/docs/docs.go", r'Version:\s+"(?P<v>[^"]+)",', 1),
    ("ingestion/docs/swagger.json", r'(?s)"info": \{.*?"version": "(?P<v>[^"]+)"', 1),
    (
        "ingestion/docs/swagger.yaml",
        r"(?m)^info:\n(?:  .*\n)*?  version: (?P<v>\S+)$",
        1,
    ),
]


def read_version() -> str:
    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not VERSION_RE.match(version):
        sys.exit(f"VERSION holds {version!r}, which is not a release version (X.Y.Z)")
    return version


def found_versions(path: str, pattern: str) -> list[str]:
    text = (ROOT / path).read_text(encoding="utf-8")
    return [m.group("v") for m in re.finditer(pattern, text)]


def check(tag: str | None) -> int:
    version = read_version()
    problems: list[str] = []
    if tag is not None and tag != f"v{version}":
        problems.append(
            f"tag {tag} does not match VERSION {version} (expected v{version})"
        )
    changelog_text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if tag is not None and f"\n## v{version} — " not in changelog_text:
        problems.append(f"CHANGELOG.md has no dated '## v{version} — ' section")
    for path, pattern, expected in LOCATIONS:
        found = found_versions(path, pattern)
        if len(found) != expected:
            problems.append(
                f"{path}: expected {expected} version match(es), found {len(found)}"
            )
        problems.extend(
            f"{path}: has {v}, VERSION is {version}" for v in found if v != version
        )
    if problems:
        print("Version check failed:", *problems, sep="\n  ", file=sys.stderr)
        print("Run: python3 scripts/version.py set <version>", file=sys.stderr)
        return 1
    print(f"All {len(LOCATIONS)} version locations match VERSION {version}.")
    return 0


def set_version(version: str) -> int:
    if not VERSION_RE.match(version):
        sys.exit(f"{version!r} is not a release version (X.Y.Z, no leading v)")
    VERSION_FILE.write_text(version + "\n", encoding="utf-8")
    for path, pattern, expected in LOCATIONS:
        file = ROOT / path
        text = file.read_text(encoding="utf-8")
        matches = list(re.finditer(pattern, text))
        if len(matches) != expected:
            sys.exit(
                f"{path}: expected {expected} version match(es), found {len(matches)}"
            )
        # Replace from the end so earlier spans keep their offsets.
        for m in reversed(matches):
            text = text[: m.start("v")] + version + text[m.end("v") :]
        file.write_text(text, encoding="utf-8")
    return check(None)


def changelog(version: str) -> int:
    path = ROOT / "CHANGELOG.md"
    text = path.read_text(encoding="utf-8")
    heading = "## Unreleased"
    if text.count(f"\n{heading}\n") != 1:
        sys.exit(f"CHANGELOG.md: expected exactly one '{heading}' heading")
    today = datetime.datetime.now(datetime.UTC).date().isoformat()
    text = text.replace(
        f"\n{heading}\n", f"\n{heading}\n\n## v{version} — {today}\n", 1
    )
    path.write_text(text, encoding="utf-8")
    print(f"CHANGELOG.md: the Unreleased entries are now under v{version} — {today}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_set = sub.add_parser("set", help="write a version into every location")
    p_set.add_argument("version")
    p_check = sub.add_parser("check", help="fail if any location differs from VERSION")
    p_check.add_argument(
        "--tag", help="also require VERSION to match this tag (vX.Y.Z)"
    )
    p_log = sub.add_parser("changelog", help="date the Unreleased CHANGELOG section")
    p_log.add_argument("version")
    args = parser.parse_args()
    if args.command == "set":
        return set_version(args.version)
    if args.command == "check":
        return check(args.tag)
    return changelog(args.version)


if __name__ == "__main__":
    sys.exit(main())
