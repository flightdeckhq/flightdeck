#!/usr/bin/env python3
"""Builds the flightdeck-cli wheels: one per platform, each carrying a binary.

    python3 packaging/pypi/build_wheels.py --artifacts dist/artifacts.json \\
        --tag v0.9.0 --out packaging/pypi/dist
    python3 packaging/pypi/build_wheels.py --binary ./bin/flightdeck \\
        --platform linux/amd64 --tag v0.9.0 --out /tmp/wheels

The wheel is written directly with ``zipfile``: it holds the shim
package (``flightdeck_cli/__init__.py``, ``__main__.py``), the binary at
``flightdeck_cli/bin/flightdeck[.exe]`` with its executable bit, and the
``.dist-info`` (METADATA from README.md, WHEEL, entry_points.txt,
RECORD). No build backend is involved because there is nothing to
build: the binary is prebuilt by goreleaser, and ``wheel``'s tag
handling would have to be overridden for every platform anyway. The
tag is ``py3-none-<platform>``: any Python 3, no ABI, one platform.

The release workflow runs it on goreleaser's ``artifacts.json`` after
the binaries are built and hands the output directory to
pypa/gh-action-pypi-publish. ``--binary`` builds one wheel from one
file, for a local check.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DISTRIBUTION = "flightdeck-cli"
PACKAGE = "flightdeck_cli"

# goreleaser's (goos, goarch) to the wheel's platform tag. The binary is
# static (CGO_ENABLED=0), so the manylinux floor is the oldest tag pip
# still accepts from PyPI rather than a glibc it links; the macOS floor is
# the oldest release the Go toolchain supports.
PLATFORM_TAGS: dict[tuple[str, str], str] = {
    ("linux", "amd64"): "manylinux_2_17_x86_64.manylinux2014_x86_64",
    ("linux", "arm64"): "manylinux_2_17_aarch64.manylinux2014_aarch64",
    ("darwin", "amd64"): "macosx_11_0_x86_64",
    ("darwin", "arm64"): "macosx_11_0_arm64",
    ("windows", "amd64"): "win_amd64",
    ("windows", "arm64"): "win_arm64",
}

# A release tag: vX.Y.Z, optionally with a pre-release suffix such as
# -rc.1 or -beta.2, which PEP 440 writes as 0.9.0rc1 / 0.9.0b2.
TAG_RE = re.compile(r"^v(?P<base>\d+\.\d+\.\d+)(?:-(?P<kind>alpha|beta|rc|a|b)\.?(?P<n>\d+))?$")
PRE_KINDS = {"alpha": "a", "a": "a", "beta": "b", "b": "b", "rc": "rc"}


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
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    fields = [
        ("Metadata-Version", "2.1"),
        ("Name", DISTRIBUTION),
        ("Version", version),
        (
            "Summary",
            "Flightdeck: fleet observability and control for AI coding agents, as one binary",
        ),
        ("Home-page", "https://github.com/flightdeckhq/flightdeck"),
        ("Author", "Flightdeck"),
        ("License", "Apache-2.0"),
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
    return (
        "Wheel-Version: 1.0\n"
        f"Generator: {DISTRIBUTION} build_wheels.py\n"
        "Root-Is-Purelib: false\n"
        f"Tag: py3-none-{platform_tag}\n"
    )


ENTRY_POINTS = f"[console_scripts]\nflightdeck = {PACKAGE}:main\nflightdeck-cli = {PACKAGE}:main\n"


def record_hash(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_wheel(
    binary: Path, goos: str, goarch: str, version: str, out: Path, date_time: tuple[int, ...]
) -> Path:
    """Write one wheel and return its path."""
    try:
        platform_tag = PLATFORM_TAGS[(goos, goarch)]
    except KeyError:
        sys.exit(f"no wheel platform tag for {goos}/{goarch}")
    out.mkdir(parents=True, exist_ok=True)
    name = f"{PACKAGE}-{version}-py3-none-{platform_tag}.whl"
    dist_info = f"{PACKAGE}-{version}.dist-info"
    binary_name = "flightdeck.exe" if goos == "windows" else "flightdeck"
    path = out / name

    files: list[tuple[str, bytes, int]] = [
        (f"{PACKAGE}/__init__.py", (HERE / PACKAGE / "__init__.py").read_bytes(), 0o644),
        (f"{PACKAGE}/__main__.py", (HERE / PACKAGE / "__main__.py").read_bytes(), 0o644),
        (f"{PACKAGE}/bin/{binary_name}", binary.read_bytes(), 0o755),
        (f"{dist_info}/METADATA", metadata(version).encode("utf-8"), 0o644),
        (f"{dist_info}/WHEEL", wheel_metadata(platform_tag).encode("utf-8"), 0o644),
        (f"{dist_info}/entry_points.txt", ENTRY_POINTS.encode("utf-8"), 0o644),
    ]
    record_lines = []
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, data, mode in files:
            info = zipfile.ZipInfo(arcname, date_time=date_time)  # type: ignore[arg-type]
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | mode) << 16
            zf.writestr(info, data)
            record_lines.append(f"{arcname},{record_hash(data)},{len(data)}")
        record_lines.append(f"{dist_info}/RECORD,,")
        info = zipfile.ZipInfo(f"{dist_info}/RECORD", date_time=date_time)  # type: ignore[arg-type]
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        zf.writestr(info, ("\n".join(record_lines) + "\n").encode("utf-8"))
    return path


def binaries_from_artifacts(artifacts_json: Path) -> list[tuple[Path, str, str]]:
    """(path, goos, goarch) of every binary goreleaser recorded."""
    data = json.loads(artifacts_json.read_text(encoding="utf-8"))
    found = []
    for artifact in data:
        if artifact.get("type") != "Binary":
            continue
        path = Path(artifact["path"])
        if not path.is_absolute():
            path = artifacts_json.parent.parent / path
        found.append((path, artifact["goos"], artifact["goarch"]))
    if not found:
        sys.exit(f"{artifacts_json} lists no Binary artifacts")
    return found


def zip_date_time(source_date_epoch: str | None) -> tuple[int, ...]:
    """A reproducible timestamp: SOURCE_DATE_EPOCH when set, else now (zip needs >= 1980)."""
    epoch = int(source_date_epoch) if source_date_epoch else int(time.time())
    return time.gmtime(max(epoch, 315532800))[:6]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tag", required=True, help="the release tag, vX.Y.Z or vX.Y.Z-rc.N")
    parser.add_argument("--out", required=True, type=Path, help="directory for the wheels")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--artifacts", type=Path, help="goreleaser's dist/artifacts.json: one wheel per binary"
    )
    source.add_argument("--binary", type=Path, help="one binary (with --platform)")
    parser.add_argument("--platform", help="goos/goarch of --binary, for example linux/amd64")
    parser.add_argument(
        "--source-date-epoch",
        default=None,
        help="timestamp for the zip entries (default: $SOURCE_DATE_EPOCH or now)",
    )
    args = parser.parse_args()

    version = pep440_version(args.tag)
    date_time = zip_date_time(args.source_date_epoch or os.environ.get("SOURCE_DATE_EPOCH"))
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
        path = build_wheel(binary, goos, goarch, version, args.out, date_time)
        print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
