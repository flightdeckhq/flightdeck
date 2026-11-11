#!/usr/bin/env python3
"""Builds the flightdeck-cli wheels: one per platform, each carrying a binary.

    python3 packaging/pypi/build_wheels.py --artifacts dist/artifacts.json \\
        --tag v0.9.0 --out packaging/pypi/dist
    python3 packaging/pypi/build_wheels.py --binary ./bin/flightdeck \\
        --platform linux/amd64 --tag v0.9.0 --out /tmp/wheels

The wheel is written directly with ``zipfile``: it holds the shim
package (``flightdeck_cli/__init__.py``, ``__main__.py``), the binary at
``flightdeck_cli/bin/flightdeck[.exe]`` with its executable bit, and the
``.dist-info`` (METADATA from README.md, LICENSE, WHEEL,
entry_points.txt, RECORD). No build backend is involved because there is
nothing to build: the binary is prebuilt by goreleaser, and ``wheel``'s
tag handling would have to be overridden for every platform anyway. The
tag is ``py3-none-<platform>``: any Python 3, no ABI, one platform. A
Linux binary gets a manylinux and a musllinux wheel (it is static, so
it runs on Alpine too).

Two builds of the same inputs are byte-identical: the zip entries carry
one timestamp, ``--source-date-epoch``, then ``$SOURCE_DATE_EPOCH``,
then the commit time of the tag (or of HEAD when the tag is not in the
checkout), never the clock.

The release workflow runs it on goreleaser's ``artifacts.json`` after
the binaries are built and hands the output directory to
pypa/gh-action-pypi-publish. ``--binary`` builds one wheel from one
file, for a local check. This script needs Python 3.10 or later; the
shim it packages runs on 3.8 or later.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DISTRIBUTION = "flightdeck-cli"
PACKAGE = "flightdeck_cli"

# Core metadata version written to METADATA. 2.1 is the oldest that
# carries Description-Content-Type and License-File, and every installer
# and index in use reads it; nothing here needs a newer field.
METADATA_VERSION = "2.1"

# The zip format stores timestamps as MS-DOS dates, which start on
# 1980-01-01; an earlier SOURCE_DATE_EPOCH (0 is common in build
# systems) is clamped to that floor instead of failing.
ZIP_EPOCH_FLOOR = 315532800

# Mode bits of the wheel's entries, stored in the zip's external
# attributes so the binary comes out executable: a plain file, and an
# executable, both readable by everyone.
FILE_MODE = 0o644
EXEC_MODE = 0o755

# The size printed per wheel; decimal megabytes, as PyPI shows them.
BYTES_PER_MB = 1_000_000

# goreleaser's (goos, goarch) to the wheel platform tags, one wheel per
# tag. The binary is static (CGO_ENABLED=0), so the manylinux floor is
# the oldest tag pip still accepts from PyPI rather than a glibc it
# links, the musllinux tag serves Alpine from the same binary, and the
# macOS floor is the oldest release the Go toolchain supports.
PLATFORM_TAGS: dict[tuple[str, str], tuple[str, ...]] = {
    ("linux", "amd64"): (
        "manylinux_2_17_x86_64.manylinux2014_x86_64",
        "musllinux_1_1_x86_64",
    ),
    ("linux", "arm64"): (
        "manylinux_2_17_aarch64.manylinux2014_aarch64",
        "musllinux_1_1_aarch64",
    ),
    ("darwin", "amd64"): ("macosx_11_0_x86_64",),
    ("darwin", "arm64"): ("macosx_11_0_arm64",),
    ("windows", "amd64"): ("win_amd64",),
    ("windows", "arm64"): ("win_arm64",),
}

# A release tag: vX.Y.Z, optionally with a pre-release suffix -alpha.N,
# -beta.N or -rc.N, which PEP 440 writes as 0.9.0a1 / 0.9.0b2 / 0.9.0rc1.
# scripts/version.py accepts the same grammar for the release workflow's
# tag guard; scripts/test_version.py pins that the two agree.
TAG_RE = re.compile(r"^v(?P<base>\d+\.\d+\.\d+)(?:-(?P<kind>alpha|beta|rc)\.(?P<n>\d+))?$")
PRE_KINDS = {"alpha": "a", "beta": "b", "rc": "rc"}


def pep440_version(tag: str) -> str:
    """The PEP 440 version of a release tag (v0.9.0 -> 0.9.0, v0.9.0-rc.1 -> 0.9.0rc1)."""
    m = TAG_RE.match(tag)
    if not m:
        sys.exit(
            f"{tag!r} is not a release tag this package can version "
            "(vX.Y.Z, or vX.Y.Z-rc.N / -beta.N / -alpha.N)"
        )
    version = m.group("base")
    if m.group("kind"):
        version += PRE_KINDS[m.group("kind")] + m.group("n")
    return version


def metadata(version: str) -> str:
    """The METADATA file: core metadata headers, then README.md as the long description."""
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    fields = [
        ("Metadata-Version", METADATA_VERSION),
        ("Name", DISTRIBUTION),
        ("Version", version),
        (
            "Summary",
            "Flightdeck: fleet observability and control for AI coding agents, as one binary",
        ),
        ("Home-page", "https://github.com/flightdeckhq/flightdeck"),
        ("Author", "Flightdeck"),
        ("License", "Apache-2.0"),
        ("License-File", "LICENSE"),
        ("Project-URL", "Source, https://github.com/flightdeckhq/flightdeck"),
        (
            "Project-URL",
            "Changelog, https://github.com/flightdeckhq/flightdeck/blob/main/CHANGELOG.md",
        ),
        ("Project-URL", "Issues, https://github.com/flightdeckhq/flightdeck/issues"),
        ("Classifier", "Development Status :: 4 - Beta"),
        ("Classifier", "Environment :: Console"),
        ("Classifier", "Intended Audience :: Developers"),
        ("Classifier", "License :: OSI Approved :: Apache Software License"),
        ("Classifier", "Operating System :: POSIX :: Linux"),
        ("Classifier", "Operating System :: MacOS"),
        ("Classifier", "Operating System :: Microsoft :: Windows"),
        ("Classifier", "Programming Language :: Python :: 3"),
        ("Classifier", "Topic :: Software Development :: Debuggers"),
        ("Classifier", "Topic :: System :: Monitoring"),
        ("Requires-Python", ">=3.8"),
        ("Description-Content-Type", "text/markdown"),
    ]
    head = "\n".join(f"{k}: {v}" for k, v in fields)
    return f"{head}\n\n{readme}"


def wheel_metadata(platform_tag: str) -> str:
    """The WHEEL file: a platform wheel (not purelib) for any Python 3 and this one platform."""
    return (
        "Wheel-Version: 1.0\n"
        f"Generator: {DISTRIBUTION} build_wheels.py\n"
        "Root-Is-Purelib: false\n"
        f"Tag: py3-none-{platform_tag}\n"
    )


ENTRY_POINTS = f"[console_scripts]\nflightdeck = {PACKAGE}:main\nflightdeck-cli = {PACKAGE}:main\n"


def record_hash(data: bytes) -> str:
    """A RECORD hash field: sha256 of the bytes, urlsafe base64 without padding."""
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def platform_tags(goos: str, goarch: str) -> tuple[str, ...]:
    """The wheel platform tags a goreleaser target maps to."""
    try:
        return PLATFORM_TAGS[(goos, goarch)]
    except KeyError:
        sys.exit(f"no wheel platform tag for {goos}/{goarch}")


def build_wheel(
    binary: Path,
    goos: str,
    platform_tag: str,
    version: str,
    out: Path,
    date_time: tuple[int, ...],
) -> Path:
    """Write one wheel for one platform tag and return its path."""
    out.mkdir(parents=True, exist_ok=True)
    name = f"{PACKAGE}-{version}-py3-none-{platform_tag}.whl"
    dist_info = f"{PACKAGE}-{version}.dist-info"
    binary_name = "flightdeck.exe" if goos == "windows" else "flightdeck"
    path = out / name

    files: list[tuple[str, bytes, int]] = [
        (f"{PACKAGE}/__init__.py", (HERE / PACKAGE / "__init__.py").read_bytes(), FILE_MODE),
        (f"{PACKAGE}/__main__.py", (HERE / PACKAGE / "__main__.py").read_bytes(), FILE_MODE),
        (f"{PACKAGE}/bin/{binary_name}", binary.read_bytes(), EXEC_MODE),
        (f"{dist_info}/METADATA", metadata(version).encode("utf-8"), FILE_MODE),
        (f"{dist_info}/LICENSE", (ROOT / "LICENSE").read_bytes(), FILE_MODE),
        (f"{dist_info}/WHEEL", wheel_metadata(platform_tag).encode("utf-8"), FILE_MODE),
        (f"{dist_info}/entry_points.txt", ENTRY_POINTS.encode("utf-8"), FILE_MODE),
    ]

    def entry(arcname: str, mode: int) -> zipfile.ZipInfo:
        info = zipfile.ZipInfo(arcname, date_time=date_time)  # type: ignore[arg-type]
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (stat.S_IFREG | mode) << 16
        return info

    record_lines = []
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, data, mode in files:
            zf.writestr(entry(arcname, mode), data)
            record_lines.append(f"{arcname},{record_hash(data)},{len(data)}")
        record_lines.append(f"{dist_info}/RECORD,,")
        zf.writestr(
            entry(f"{dist_info}/RECORD", FILE_MODE),
            ("\n".join(record_lines) + "\n").encode("utf-8"),
        )
    return path


def binaries_from_artifacts(artifacts_json: Path) -> list[tuple[Path, str, str]]:
    """(path, goos, goarch) of every binary goreleaser recorded in artifacts.json.

    goreleaser writes each path relative to the directory it ran in
    (``dist/flightdeck_linux_amd64_v1/flightdeck``), so a relative path
    is resolved against the current directory first; when that file is
    absent (the artifacts were moved, or the script runs from
    elsewhere), against the parent of the ``dist`` directory that holds
    artifacts.json, which is the usual layout.
    """
    data = json.loads(artifacts_json.read_text(encoding="utf-8"))
    found = []
    for artifact in data:
        if artifact.get("type") != "Binary":
            continue
        path = Path(artifact["path"])
        if not path.is_absolute() and not path.is_file():
            fallback = artifacts_json.resolve().parent.parent / path
            if fallback.is_file():
                path = fallback
        found.append((path, artifact["goos"], artifact["goarch"]))
    if not found:
        sys.exit(f"{artifacts_json} lists no Binary artifacts")
    return found


def commit_epoch(tag: str) -> int:
    """The commit time of the tag, or of HEAD when the tag is not in the checkout."""
    for ref in (tag, "HEAD"):
        try:
            out = subprocess.run(
                ["git", "log", "-1", "--format=%ct", ref],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            continue
        if out.isdigit():
            return int(out)
    sys.exit(
        "cannot read a commit time from git for the zip timestamps; "
        "pass --source-date-epoch or set SOURCE_DATE_EPOCH"
    )


def resolve_epoch(flag: str | None, env: str | None, tag: str) -> int:
    """The build timestamp: the flag, else SOURCE_DATE_EPOCH, else the tag's commit time."""
    for value in (flag, env):
        if value:
            if not value.isdigit():
                sys.exit(f"timestamp must be seconds since the epoch, got {value!r}")
            return int(value)
    return commit_epoch(tag)


def zip_date_time(epoch: int) -> tuple[int, ...]:
    """The zip entry timestamp for a Unix time, clamped to the zip format's floor."""
    return time.gmtime(max(epoch, ZIP_EPOCH_FLOOR))[:6]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tag", required=True, help="the release tag, vX.Y.Z or vX.Y.Z-rc.N")
    parser.add_argument("--out", required=True, type=Path, help="directory for the wheels")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--artifacts",
        type=Path,
        help="goreleaser's dist/artifacts.json: one wheel per binary and platform tag",
    )
    source.add_argument("--binary", type=Path, help="one binary (with --platform)")
    parser.add_argument("--platform", help="goos/goarch of --binary, for example linux/amd64")
    parser.add_argument(
        "--source-date-epoch",
        default=None,
        help="timestamp of the zip entries "
        "(default: $SOURCE_DATE_EPOCH, else the tag's commit time)",
    )
    args = parser.parse_args()

    version = pep440_version(args.tag)
    date_time = zip_date_time(
        resolve_epoch(args.source_date_epoch, os.environ.get("SOURCE_DATE_EPOCH"), args.tag)
    )
    if args.binary:
        if not args.platform or "/" not in args.platform:
            parser.error("--binary needs --platform goos/goarch")
        goos, goarch = args.platform.split("/", 1)
        targets = [(args.binary, goos, goarch)]
    else:
        targets = binaries_from_artifacts(args.artifacts)

    for binary, goos, goarch in targets:
        if not binary.is_file():
            sys.exit(f"binary not found: {binary}")
        for platform_tag in platform_tags(goos, goarch):
            path = build_wheel(binary, goos, platform_tag, version, args.out, date_time)
            print(f"wrote {path} ({path.stat().st_size / BYTES_PER_MB:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
