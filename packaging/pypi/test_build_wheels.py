"""Tests for packaging/pypi/build_wheels.py and the flightdeck_cli shim.

python3 -m unittest discover -s packaging/pypi -p 'test_*.py'

(discover mode: the directory is named packaging/, which a module path
would resolve to the packaging library.) Needs Python 3.10 or later, as
the builder does.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_wheels  # noqa: E402
import flightdeck_cli  # noqa: E402

# An even second: zip timestamps have a two-second resolution.
EPOCH = (2026, 1, 2, 3, 4, 6)
MANYLINUX_X86 = "manylinux_2_17_x86_64.manylinux2014_x86_64"


class BuildWheelsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.binary = self.tmp / "flightdeck"
        self.binary.write_bytes(b"#!/bin/sh\necho flightdeck v0.9.0\n")

    def build(self, version: str = "0.9.0", goos: str = "linux", tag: str = MANYLINUX_X86) -> Path:
        return build_wheels.build_wheel(self.binary, goos, tag, version, self.tmp / "out", EPOCH)

    def test_tag_to_pep440(self) -> None:
        cases = {
            "v0.9.0": "0.9.0",
            "v1.2.3-rc.1": "1.2.3rc1",
            "v1.2.3-beta.2": "1.2.3b2",
            "v1.2.3-alpha.7": "1.2.3a7",
        }
        for tag, want in cases.items():
            with self.subTest(tag=tag):
                self.assertEqual(build_wheels.pep440_version(tag), want)

    def test_a_tag_outside_the_grammar_is_refused(self) -> None:
        bad = ("0.9.0", "v0.9", "v0.9.0-snapshot.abc", "v0.9.0-foo", "v0.9.0-rc", "v0.9.0-rc1")
        for tag in bad:
            with (
                self.subTest(tag=tag),
                self.assertRaises(SystemExit),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                build_wheels.pep440_version(tag)

    def test_every_goreleaser_target_has_platform_tags(self) -> None:
        for goos in ("linux", "darwin", "windows"):
            for goarch in ("amd64", "arm64"):
                tags = build_wheels.platform_tags(goos, goarch)
                self.assertTrue(tags, (goos, goarch))
        self.assertEqual(
            build_wheels.platform_tags("linux", "amd64"),
            (MANYLINUX_X86, "musllinux_1_1_x86_64"),
            "a static Linux binary serves glibc and musl",
        )
        self.assertIn("musllinux_1_1_aarch64", build_wheels.platform_tags("linux", "arm64"))

    def test_the_wheel_layout(self) -> None:
        path = self.build()
        self.assertEqual(path.name, f"flightdeck_cli-0.9.0-py3-none-{MANYLINUX_X86}.whl")
        with zipfile.ZipFile(path) as zf:
            self.assertEqual(
                zf.namelist(),
                [
                    "flightdeck_cli/__init__.py",
                    "flightdeck_cli/__main__.py",
                    "flightdeck_cli/bin/flightdeck",
                    "flightdeck_cli-0.9.0.dist-info/METADATA",
                    "flightdeck_cli-0.9.0.dist-info/LICENSE",
                    "flightdeck_cli-0.9.0.dist-info/WHEEL",
                    "flightdeck_cli-0.9.0.dist-info/entry_points.txt",
                    "flightdeck_cli-0.9.0.dist-info/RECORD",
                ],
            )
            binary_info = zf.getinfo("flightdeck_cli/bin/flightdeck")
            mode = binary_info.external_attr >> 16
            self.assertTrue(mode & stat.S_IXUSR, "the binary must keep its executable bit")
            self.assertEqual(mode & 0o777, build_wheels.EXEC_MODE)
            self.assertEqual(zf.read("flightdeck_cli/bin/flightdeck"), self.binary.read_bytes())
            self.assertEqual(binary_info.date_time, EPOCH)
            shim_mode = zf.getinfo("flightdeck_cli/__init__.py").external_attr >> 16
            self.assertEqual(shim_mode & 0o777, build_wheels.FILE_MODE)

            metadata = zf.read("flightdeck_cli-0.9.0.dist-info/METADATA").decode()
            first_line = f"Metadata-Version: {build_wheels.METADATA_VERSION}\n"
            self.assertTrue(metadata.startswith(first_line))
            self.assertIn("Name: flightdeck-cli\n", metadata)
            self.assertIn("Version: 0.9.0\n", metadata)
            self.assertIn("License: Apache-2.0\n", metadata)
            self.assertIn("License-File: LICENSE\n", metadata)
            self.assertIn("Requires-Python: >=3.8\n", metadata)
            self.assertIn("# flightdeck-cli", metadata, "README is the long description")

            wheel = zf.read("flightdeck_cli-0.9.0.dist-info/WHEEL").decode()
            self.assertIn("Root-Is-Purelib: false\n", wheel)
            self.assertIn(f"Tag: py3-none-{MANYLINUX_X86}\n", wheel)

            entry_points = zf.read("flightdeck_cli-0.9.0.dist-info/entry_points.txt").decode()
            self.assertIn("flightdeck = flightdeck_cli:main\n", entry_points)
            self.assertIn("flightdeck-cli = flightdeck_cli:main\n", entry_points)

    def test_the_wheel_ships_the_repository_license(self) -> None:
        path = self.build()
        with zipfile.ZipFile(path) as zf:
            shipped = zf.read("flightdeck_cli-0.9.0.dist-info/LICENSE")
        self.assertEqual(shipped, (build_wheels.ROOT / "LICENSE").read_bytes())
        self.assertIn(b"Apache License", shipped)

    def test_record_hashes_every_file(self) -> None:
        path = self.build(version="0.9.0rc1", goos="darwin", tag="macosx_11_0_arm64")
        with zipfile.ZipFile(path) as zf:
            record = zf.read("flightdeck_cli-0.9.0rc1.dist-info/RECORD").decode().splitlines()
            entries = {line.split(",")[0]: line for line in record}
            self.assertEqual(set(entries), set(zf.namelist()), "RECORD lists every file, once")
            for name in zf.namelist():
                if name.endswith("/RECORD"):
                    self.assertEqual(entries[name], f"{name},,")
                    continue
                data = zf.read(name)
                digest = (
                    base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
                )
                self.assertEqual(entries[name], f"{name},sha256={digest},{len(data)}")

    def test_two_builds_are_byte_identical(self) -> None:
        first = self.build()
        first_bytes = first.read_bytes()
        first.unlink()
        self.assertEqual(self.build().read_bytes(), first_bytes)

    def test_windows_wheel_carries_the_exe(self) -> None:
        exe = self.tmp / "flightdeck.exe"
        exe.write_bytes(b"MZ")
        path = build_wheels.build_wheel(
            exe, "windows", "win_arm64", "0.9.0", self.tmp / "out", EPOCH
        )
        self.assertEqual(path.name, "flightdeck_cli-0.9.0-py3-none-win_arm64.whl")
        with zipfile.ZipFile(path) as zf:
            self.assertIn("flightdeck_cli/bin/flightdeck.exe", zf.namelist())

    def test_an_unknown_platform_is_refused(self) -> None:
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            build_wheels.platform_tags("plan9", "amd64")

    def test_artifacts_json_paths_resolve_against_cwd_then_the_dist_parent(self) -> None:
        project = self.tmp / "project"
        dist = project / "dist"
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
        expected = [(dist / "flightdeck_linux_amd64_v1" / "flightdeck", "linux", "amd64")]
        # From the directory goreleaser ran in, the path is taken as written.
        cwd = os.getcwd()
        os.chdir(project)
        try:
            found = build_wheels.binaries_from_artifacts(Path("dist/artifacts.json"))
            self.assertEqual([(p.resolve(), o, a) for p, o, a in found], expected)
        finally:
            os.chdir(cwd)
        # From elsewhere, the parent of the dist directory is the base.
        found = build_wheels.binaries_from_artifacts(dist / "artifacts.json")
        self.assertEqual([(p.resolve(), o, a) for p, o, a in found], expected)

    def test_zip_date_time_floor_and_epoch(self) -> None:
        self.assertEqual(build_wheels.zip_date_time(0)[:3], (1980, 1, 1))
        self.assertEqual(build_wheels.zip_date_time(1767322800)[:3], (2026, 1, 2))

    def test_the_timestamp_comes_from_the_flag_then_the_env_then_git(self) -> None:
        self.assertEqual(build_wheels.resolve_epoch("1767322800", "5", "v0.9.0"), 1767322800)
        self.assertEqual(build_wheels.resolve_epoch(None, "1767322800", "v0.9.0"), 1767322800)
        with mock.patch.object(build_wheels, "commit_epoch", return_value=42) as commit:
            self.assertEqual(build_wheels.resolve_epoch(None, None, "v0.9.0"), 42)
        commit.assert_called_once_with("v0.9.0")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            build_wheels.resolve_epoch("yesterday", None, "v0.9.0")

    def test_commit_epoch_reads_git(self) -> None:
        head = int(
            subprocess.run(
                ["git", "log", "-1", "--format=%ct", "HEAD"],
                cwd=build_wheels.ROOT,
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        # A tag that does not exist falls back to HEAD.
        self.assertEqual(build_wheels.commit_epoch("v999.999.999-rc.1"), head)


class ShimTest(unittest.TestCase):
    def test_the_shim_finds_the_binary_next_to_itself(self) -> None:
        expected_name = "flightdeck.exe" if sys.platform == "win32" else "flightdeck"
        self.assertEqual(flightdeck_cli.binary_path().name, expected_name)
        self.assertEqual(flightdeck_cli.binary_path().parent.name, "bin")
        self.assertEqual(flightdeck_cli.binary_path().parent.parent, HERE / "flightdeck_cli")

    def test_a_missing_binary_exits_with_the_reinstall_hint(self) -> None:
        with (
            mock.patch.object(
                flightdeck_cli, "binary_path", return_value=Path("/nonexistent/bin/flightdeck")
            ),
            self.assertRaises(SystemExit) as caught,
        ):
            flightdeck_cli.main()
        self.assertIn("missing", str(caught.exception))
        self.assertIn("force-reinstall", str(caught.exception))

    def test_posix_execs_the_binary_with_the_arguments(self) -> None:
        binary = Path(tempfile.mkdtemp()) / "flightdeck"
        self.addCleanup(shutil.rmtree, binary.parent)
        binary.write_bytes(b"")
        with (
            mock.patch.object(sys, "platform", "linux"),
            mock.patch.object(sys, "argv", ["flightdeck", "--version"]),
            mock.patch.object(flightdeck_cli, "binary_path", return_value=binary),
            mock.patch.object(os, "execv") as execv,
        ):
            flightdeck_cli.main()
        execv.assert_called_once_with(str(binary), [str(binary), "--version"])

    def test_an_unrunnable_binary_exits_with_the_reinstall_hint(self) -> None:
        binary = Path(tempfile.mkdtemp()) / "flightdeck"
        self.addCleanup(shutil.rmtree, binary.parent)
        binary.write_bytes(b"")
        with (
            mock.patch.object(sys, "platform", "linux"),
            mock.patch.object(flightdeck_cli, "binary_path", return_value=binary),
            mock.patch.object(os, "execv", side_effect=OSError(8, "Exec format error")),
            self.assertRaises(SystemExit) as caught,
        ):
            flightdeck_cli.main()
        self.assertIn("Exec format error", str(caught.exception))
        self.assertIn("force-reinstall", str(caught.exception))

    def test_windows_runs_the_exe_as_a_child_and_returns_its_status(self) -> None:
        binary = Path(tempfile.mkdtemp()) / "flightdeck.exe"
        self.addCleanup(shutil.rmtree, binary.parent)
        binary.write_bytes(b"MZ")
        with (
            mock.patch.object(sys, "platform", "win32"),
            mock.patch.object(sys, "argv", ["flightdeck", "--listen", ":4000"]),
            mock.patch.object(flightdeck_cli, "binary_path", return_value=binary),
            mock.patch.object(subprocess, "call", return_value=3) as call,
            mock.patch("signal.signal") as sig,
            self.assertRaises(SystemExit) as caught,
        ):
            flightdeck_cli.main()
        call.assert_called_once_with([str(binary), "--listen", ":4000"])
        self.assertEqual(caught.exception.code, 3)
        sig.assert_called_once()

    def test_binary_name_follows_the_platform(self) -> None:
        with mock.patch.object(sys, "platform", "win32"):
            self.assertEqual(flightdeck_cli.binary_name(), "flightdeck.exe")
        with mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(flightdeck_cli.binary_name(), "flightdeck")


if __name__ == "__main__":
    unittest.main()
