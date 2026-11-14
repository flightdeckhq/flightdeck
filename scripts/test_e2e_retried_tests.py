"""Tests for scripts/e2e_retried_tests.py.

python3 -m unittest scripts/test_e2e_retried_tests.py
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_retried_tests


def test_entry(status: str, project: str = "neon-dark", message: str = "") -> dict:
    results = [{"status": "passed"}]
    if status in ("flaky", "unexpected"):
        failed = {"status": "failed", "error": {"message": message}}
        results = [failed, {"status": "passed" if status == "flaky" else "failed"}]
    return {"status": status, "projectName": project, "results": results}


def spec(title: str, *tests: dict, line: int = 31) -> dict:
    return {"title": title, "file": "T137-glyphs.spec.ts", "line": line, "tests": list(tests)}


def report(*specs: dict, nested: bool = True) -> dict:
    inner = {"title": "T137 — Runs started together", "specs": list(specs)}
    top = (
        {"title": "T137-glyphs.spec.ts", "specs": [], "suites": [inner]}
        if nested
        else {
            "title": "T137-glyphs.spec.ts",
            "specs": list(specs),
        }
    )
    return {"suites": [top]}


class RetriedTests(unittest.TestCase):
    def test_a_test_that_failed_then_passed_is_listed_with_its_suite_path(self):
        found = e2e_retried_tests.retried_tests(
            report(
                spec(
                    "every glyph has a tooltip",
                    test_entry("flaky", message="Error: not found\n  at x"),
                )
            )
        )
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].file, "T137-glyphs.spec.ts")
        self.assertEqual(found[0].line, 31)
        self.assertEqual(found[0].title, "T137 — Runs started together › every glyph has a tooltip")
        self.assertEqual(found[0].project, "neon-dark")
        self.assertEqual(found[0].error, "Error: not found")

    def test_passed_skipped_and_failed_tests_are_not_listed(self):
        found = e2e_retried_tests.retried_tests(
            report(
                spec("a", test_entry("expected")),
                spec("b", test_entry("skipped")),
                spec("c", test_entry("unexpected", message="Error: still failing")),
            )
        )
        self.assertEqual(found, [])

    def test_each_project_of_a_spec_counts_on_its_own(self):
        found = e2e_retried_tests.retried_tests(
            report(
                spec(
                    "a",
                    test_entry("flaky", "neon-dark", "Error: one"),
                    test_entry("flaky", "clean-light", "Error: two"),
                    test_entry("expected", "admin-ops-dark"),
                ),
                nested=False,
            )
        )
        self.assertEqual(
            [(t.project, t.title) for t in found], [("neon-dark", "a"), ("clean-light", "a")]
        )

    def test_the_error_loses_its_colour_codes_and_is_cut(self):
        message = (
            "\x1b[2mexpect(\x1b[22m\x1b[31mlocator\x1b[39m).toContainText() failed " + "x" * 400
        )
        found = e2e_retried_tests.retried_tests(
            report(spec("a", test_entry("flaky", message=message)))
        )
        self.assertTrue(found[0].error.startswith("expect(locator).toContainText() failed"))
        self.assertEqual(len(found[0].error), e2e_retried_tests.ERROR_CHARS)
        self.assertNotIn("\x1b", found[0].error)

    def test_the_annotation_escapes_what_a_workflow_command_would_read(self):
        test = e2e_retried_tests.Retried("a.spec.ts", 7, "100% done", "neon-dark", "Error: a\nb")
        line = e2e_retried_tests.annotation(test)
        self.assertTrue(line.startswith("::warning title=E2E test passed only on a retry::"))
        self.assertIn("[neon-dark] a.spec.ts:7 › 100%25 done: Error: a%0Ab", line)

    def test_the_summary_says_so_when_nothing_was_retried(self):
        self.assertEqual(e2e_retried_tests.summary([], 2), "### E2E: no test needed a retry\n")

    def test_the_summary_is_a_table_with_pipes_escaped(self):
        test = e2e_retried_tests.Retried("a.spec.ts", 7, "left | right", "clean-light", "Error: x")
        text = e2e_retried_tests.summary([test], 2)
        self.assertIn("### E2E: 1 test passed only on a retry", text)
        self.assertIn("| `a.spec.ts` | left \\| right | clean-light | Error: x |", text)
        self.assertNotIn("fails the job", text)


class Main(unittest.TestCase):
    def run_main(self, data: dict, *extra: str) -> tuple[int, str, str, str]:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            summary_path = Path(tmp) / "summary.md"
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = e2e_retried_tests.main([str(path), "--summary", str(summary_path), *extra])
            summary = summary_path.read_text(encoding="utf-8") if summary_path.exists() else ""
            return code, out.getvalue(), err.getvalue(), summary

    def flaky(self, count: int) -> dict:
        return report(
            *[spec(f"t{i}", test_entry("flaky", message=f"Error: {i}")) for i in range(count)]
        )

    def test_none_retried_passes_and_says_so(self):
        code, out, _, summary = self.run_main(
            report(spec("a", test_entry("expected"))), "--max", "2"
        )
        self.assertEqual(code, 0)
        self.assertIn("0 test(s) passed only on a retry", out)
        self.assertNotIn("::warning", out)
        self.assertIn("no test needed a retry", summary)

    def test_up_to_the_limit_warns_and_passes(self):
        code, out, _, summary = self.run_main(self.flaky(2), "--max", "2")
        self.assertEqual(code, 0)
        self.assertEqual(out.count("::warning title="), 2)
        self.assertIn("2 tests passed only on a retry", summary)

    def test_more_than_the_limit_fails(self):
        code, out, err, summary = self.run_main(self.flaky(3), "--max", "2")
        self.assertEqual(code, 1)
        self.assertEqual(out.count("::warning title="), 3)
        self.assertIn("more than the 2 allowed", err)
        self.assertIn("More than 2 in one run fails the job", summary)

    def test_without_a_limit_it_only_reports(self):
        code, out, _, _ = self.run_main(self.flaky(5))
        self.assertEqual(code, 0)
        self.assertEqual(out.count("::warning title="), 5)

    def test_a_missing_report_is_an_error_of_its_own(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = e2e_retried_tests.main(["/nonexistent/report.json"])
        self.assertEqual(code, 2)
        self.assertIn("cannot read", err.getvalue())


if __name__ == "__main__":
    unittest.main()
