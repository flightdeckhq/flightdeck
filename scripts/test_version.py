"""Tests for scripts/version.py, run against a copy of the real files.

python3 -m unittest scripts/test_version.py
"""

from __future__ import annotations

import contextlib
import io
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import version


class VersionScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        paths = {path for path, _, _ in version.LOCATIONS} | {"VERSION", "CHANGELOG.md"}
        for rel in paths:
            dest = self.tmp / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(version.ROOT / rel, dest)
        self._root, self._file = version.ROOT, version.VERSION_FILE
        version.ROOT, version.VERSION_FILE = self.tmp, self.tmp / "VERSION"
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        version.ROOT, version.VERSION_FILE = self._root, self._file

    def run_quiet(self, fn, *args):  # type: ignore[no-untyped-def]
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            return fn(*args)

    def test_the_repository_is_consistent(self) -> None:
        self.assertEqual(self.run_quiet(version.check, None), 0)

    def test_set_writes_every_location(self) -> None:
        self.assertEqual(self.run_quiet(version.set_version, "9.8.7"), 0)
        self.assertEqual((self.tmp / "VERSION").read_text().strip(), "9.8.7")
        for path, pattern, _ in version.LOCATIONS:
            self.assertEqual(
                set(version.found_versions(path, pattern)), {"9.8.7"}, path
            )
        marketplace = (self.tmp / ".claude-plugin/marketplace.json").read_text()
        self.assertIn('"ref": "v9.8.7"', marketplace)
        self.assertIn('tag: "v9.8.7"', (self.tmp / "helm/values.yaml").read_text())

    def test_check_catches_a_drifted_location(self) -> None:
        chart = self.tmp / "helm/Chart.yaml"
        chart.write_text(
            chart.read_text().replace('appVersion: "', 'appVersion: "0.0.1-', 1)
        )
        self.assertEqual(self.run_quiet(version.check, None), 1)

    def test_check_with_a_tag_requires_it_to_match_and_a_dated_changelog(self) -> None:
        current = (self.tmp / "VERSION").read_text().strip()
        # The repository's CHANGELOG already has a dated section for the
        # current release.
        self.assertEqual(self.run_quiet(version.check, f"v{current}"), 0)
        self.assertEqual(self.run_quiet(version.check, "v99.0.0"), 1)
        # A bump without the dated section is refused at tag time.
        self.assertEqual(self.run_quiet(version.set_version, "9.8.7"), 0)
        self.assertEqual(self.run_quiet(version.check, "v9.8.7"), 1)
        self.assertEqual(self.run_quiet(version.changelog, "9.8.7"), 0)
        self.assertEqual(self.run_quiet(version.check, "v9.8.7"), 0)

    def test_set_rejects_a_non_release_version(self) -> None:
        for bad in ("v1.2.3", "1.2.3rc1", "1.2"):
            with self.assertRaises(SystemExit, msg=bad):
                self.run_quiet(version.set_version, bad)

    def test_changelog_dates_the_unreleased_section(self) -> None:
        self.assertEqual(self.run_quiet(version.changelog, "9.8.7"), 0)
        text = (self.tmp / "CHANGELOG.md").read_text()
        self.assertEqual(text.count("\n## Unreleased\n"), 1)
        self.assertLess(text.index("## Unreleased"), text.index("## v9.8.7 — "))


if __name__ == "__main__":
    unittest.main()
