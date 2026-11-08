"""Tests for packaging/pypi/build_wheels.py.

python3 -m unittest packaging/pypi/test_build_wheels.py
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import shutil
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_wheels

# An even second: zip timestamps have a two-second resolution.
EPOCH = (2026, 1, 2, 3, 4, 6)


class BuildWheelsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.binary = self.tmp / "flightdeck"
        self.binary.write_bytes(b"#!/bin/sh\necho flightdeck v0.9.0\n")

    def test_tag_to_pep440(self) -> None:
        cases = {
            "v0.9.0": "0.9.0",
            "v1.2.3-rc.1": "1.2.3rc1",
            "v1.2.3-rc1": "1.2.3rc1",
            "v1.2.3-beta.2": "1.2.3b2",
            "v1.2.3-alpha.7": "1.2.3a7",
        }
        for tag, want in cases.items():
            with self.subTest(tag=tag):
                self.assertEqual(build_wheels.pep440_version(tag), want)

    def test_a_tag_pep440_cannot_express_is_refused(self) -> None:
        for tag in ("0.9.0", "v0.9", "v0.9.0-snapshot.abc", "v0.9.0-dry.3"):
            with (
                self.subTest(tag=tag),
                self.assertRaises(SystemExit),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                build_wheels.pep440_version(tag)

    def test_every_goreleaser_target_has_a_platform_tag(self) -> None:
        for goos in ("linux", "darwin", "windows"):
            for goarch in ("amd64", "arm64"):
                self.assertIn((goos, goarch), build_wheels.PLATFORM_TAGS)

    def test_the_wheel_layout(self) -> None:
        path = build_wheels.build_wheel(
            self.binary, "linux", "amd64", "0.9.0", self.tmp / "out", EPOCH
        )
        self.assertEqual(
            path.name,
            "flightdeck_cli-0.9.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        )
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            self.assertEqual(
                names,
                [
                    "flightdeck_cli/__init__.py",
                    "flightdeck_cli/__main__.py",
                    "flightdeck_cli/bin/flightdeck",
                    "flightdeck_cli-0.9.0.dist-info/METADATA",
                    "flightdeck_cli-0.9.0.dist-info/WHEEL",
                    "flightdeck_cli-0.9.0.dist-info/entry_points.txt",
                    "flightdeck_cli-0.9.0.dist-info/RECORD",
                ],
            )
            binary_info = zf.getinfo("flightdeck_cli/bin/flightdeck")
            mode = binary_info.external_attr >> 16
            self.assertTrue(mode & stat.S_IXUSR, "the binary must keep its executable bit")
            self.assertEqual(zf.read("flightdeck_cli/bin/flightdeck"), self.binary.read_bytes())
            self.assertEqual(binary_info.date_time, EPOCH)

            metadata = zf.read("flightdeck_cli-0.9.0.dist-info/METADATA").decode()
            self.assertIn("Name: flightdeck-cli\n", metadata)
            self.assertIn("Version: 0.9.0\n", metadata)
            self.assertIn("Requires-Python: >=3.8\n", metadata)
            self.assertIn("# flightdeck-cli", metadata, "README is the long description")

            wheel = zf.read("flightdeck_cli-0.9.0.dist-info/WHEEL").decode()
            self.assertIn("Root-Is-Purelib: false\n", wheel)
            self.assertIn("Tag: py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64\n", wheel)

            entry_points = zf.read("flightdeck_cli-0.9.0.dist-info/entry_points.txt").decode()
            self.assertIn("flightdeck = flightdeck_cli:main\n", entry_points)
            self.assertIn("flightdeck-cli = flightdeck_cli:main\n", entry_points)

    def test_record_hashes_every_file(self) -> None:
        path = build_wheels.build_wheel(
            self.binary, "darwin", "arm64", "0.9.0rc1", self.tmp / "out", EPOCH
        )
        with zipfile.ZipFile(path) as zf:
            record = zf.read("flightdeck_cli-0.9.0rc1.dist-info/RECORD").decode().splitlines()
            entries = {line.split(",")[0]: line for line in record}
            for name in zf.namelist():
                self.assertIn(name, entries)
                if name.endswith("/RECORD"):
                    self.assertEqual(entries[name], f"{name},,")
                    continue
                data = zf.read(name)
                digest = (
                    base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
                )
                self.assertEqual(entries[name], f"{name},sha256={digest},{len(data)}")

    def test_windows_wheel_carries_the_exe(self) -> None:
        exe = self.tmp / "flightdeck.exe"
        exe.write_bytes(b"MZ")
        path = build_wheels.build_wheel(exe, "windows", "arm64", "0.9.0", self.tmp / "out", EPOCH)
        self.assertEqual(path.name, "flightdeck_cli-0.9.0-py3-none-win_arm64.whl")
        with zipfile.ZipFile(path) as zf:
            self.assertIn("flightdeck_cli/bin/flightdeck.exe", zf.namelist())

    def test_an_unknown_platform_is_refused(self) -> None:
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            build_wheels.build_wheel(
                self.binary, "plan9", "amd64", "0.9.0", self.tmp / "out", EPOCH
            )

    def test_artifacts_json_lists_the_binaries(self) -> None:
        dist = self.tmp / "dist"
        (dist / "flightdeck_linux_amd64_v1").mkdir(parents=True)
        (dist / "flightdeck_linux_amd64_v1" / "flightdeck").write_bytes(b"x")
        (dist / "artifacts.json").write_text(
            json.dumps(
                [
                    {"type": "Metadata", "path": "dist/metadata.json"},
                    {
                        "type": "Binary",
                        "goos": "linux",
                        "goarch": "amd64",
                        "path": "dist/flightdeck_linux_amd64_v1/flightdeck",
                    },
                    {
                        "type": "Archive",
                        "goos": "linux",
                        "goarch": "amd64",
                        "path": "dist/flightdeck_linux_amd64.tar.gz",
                    },
                ]
            )
        )
        found = build_wheels.binaries_from_artifacts(dist / "artifacts.json")
        self.assertEqual(
            found, [(dist / "flightdeck_linux_amd64_v1" / "flightdeck", "linux", "amd64")]
        )

    def test_the_shim_finds_the_binary_next_to_itself(self) -> None:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import flightdeck_cli

        expected_name = "flightdeck.exe" if sys.platform == "win32" else "flightdeck"
        self.assertEqual(flightdeck_cli.binary_path().name, expected_name)
        self.assertEqual(flightdeck_cli.binary_path().parent.name, "bin")

    def test_zip_date_time_floor_and_epoch(self) -> None:
        self.assertEqual(build_wheels.zip_date_time("0")[:3], (1980, 1, 1))
        self.assertEqual(build_wheels.zip_date_time("1767322800")[:3], (2026, 1, 2))


if __name__ == "__main__":
    unittest.main()
