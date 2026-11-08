"""Tests for scripts/release_notes.py.

python3 -m unittest scripts/test_release_notes.py
"""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import release_notes

CHANGELOG = """# Changelog

All notable changes are documented here.

## Unreleased

### Added

- Something not released yet.

## v0.9.0 — 2026-11-20

### Added

- **One binary.** It runs everything.

### Fixed

- A bug.

## v0.8.0 — 2026-10-31

### Added

- Older things.
"""


class ReleaseNotesTest(unittest.TestCase):
    def test_a_release_tag_reads_its_dated_section(self) -> None:
        notes = release_notes.extract(CHANGELOG, "v0.9.0")
        self.assertTrue(notes.startswith("### Added"))
        self.assertIn("**One binary.**", notes)
        self.assertIn("- A bug.", notes)
        self.assertNotIn("Older things", notes)
        self.assertNotIn("not released yet", notes)
        self.assertNotIn("## v0.9.0", notes)
        self.assertTrue(notes.endswith("- A bug.\n"))

    def test_a_pre_release_tag_reads_the_unreleased_section(self) -> None:
        notes = release_notes.extract(CHANGELOG, "v0.9.0-rc.1")
        self.assertIn("not released yet", notes)
        self.assertNotIn("One binary", notes)

    def test_the_last_section_runs_to_the_end_of_the_file(self) -> None:
        notes = release_notes.extract(CHANGELOG, "v0.8.0")
        self.assertEqual(notes, "### Added\n\n- Older things.\n")

    def test_a_missing_section_fails(self) -> None:
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            release_notes.extract(CHANGELOG, "v0.7.0")

    def test_an_empty_unreleased_section_fails(self) -> None:
        text = CHANGELOG.replace("### Added\n\n- Something not released yet.\n\n## v0.9.0", "## v0.9.0")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            release_notes.extract(text, "v0.9.0-rc.1")

    def test_a_malformed_tag_fails(self) -> None:
        for tag in ("0.9.0", "v0.9", "v0.9.0rc1", "latest"):
            with self.subTest(tag=tag), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                release_notes.section_heading(tag)

    def test_the_repository_changelog_has_a_section_for_the_latest_release(self) -> None:
        text = release_notes.CHANGELOG.read_text(encoding="utf-8")
        version = (release_notes.ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertTrue(release_notes.extract(text, f"v{version}").strip())


if __name__ == "__main__":
    unittest.main()
