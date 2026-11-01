"""Tests for scripts/vuln_scan.py.

python3 -m unittest scripts/test_vuln_scan.py

The scanner's subprocess calls are replaced with canned npm audit and
pip-audit output, so these tests make no network requests.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import vuln_scan


def npm_report(*advisories: dict[str, str]) -> dict[str, object]:
    """An ``npm audit --json`` report holding the given advisories."""
    vulnerabilities: dict[str, object] = {}
    for adv in advisories:
        vulnerabilities[adv["name"]] = {
            "name": adv["name"],
            "via": [
                {
                    "source": 1,
                    "name": adv["name"],
                    "title": adv.get("title", "a flaw"),
                    "url": f"https://github.com/advisories/{adv['ghsa']}",
                    "severity": adv["severity"],
                    "range": "<2.0.0",
                },
                # A transitive ``via`` names another package by string.
                "some-parent",
            ],
        }
    return {"auditReportVersion": 2, "vulnerabilities": vulnerabilities}


def pip_report(*deps: dict[str, object]) -> dict[str, object]:
    return {"dependencies": list(deps), "fixes": []}


HIGH = {"name": "lodash", "ghsa": "GHSA-29mw-wpgm-hmr9", "severity": "high"}
CRITICAL = {"name": "shell-quote", "ghsa": "GHSA-g4rg-993r-mgx7", "severity": "critical"}
MODERATE = {"name": "minimatch", "ghsa": "GHSA-g3hv-75wg-m249", "severity": "moderate"}
PIP_VULN: dict[str, object] = {
    "name": "pydantic",
    "version": "1.10.0",
    "vulns": [
        {
            "id": "PYSEC-2024-1",
            "aliases": ["GHSA-mr82-8j83-vxmv", "CVE-2024-3772"],
            "fix_versions": ["1.10.13"],
        }
    ],
}


def write_ignores(text: str) -> Path:
    handle = tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False)
    handle.write(text)
    handle.close()
    return Path(handle.name)


class LoadIgnoresTest(unittest.TestCase):
    def test_missing_file_means_no_ignores(self) -> None:
        self.assertEqual(vuln_scan.load_ignores(Path("/nonexistent/x.toml")), [])

    def test_shipped_file_is_valid(self) -> None:
        vuln_scan.load_ignores(vuln_scan.IGNORE_FILE)

    def test_reads_entries(self) -> None:
        path = write_ignores(
            '[[ignore]]\nid = "GHSA-29mw-wpgm-hmr9"\necosystem = "npm"\n'
            'package = "lodash"\nreason = "no fix yet"\n'
        )
        (entry,) = vuln_scan.load_ignores(path)
        self.assertEqual(entry.id, "GHSA-29mw-wpgm-hmr9")
        self.assertEqual(entry.reason, "no fix yet")

    def test_rejects_entry_without_reason(self) -> None:
        for reason_line in ("", 'reason = ""\n', 'reason = "   "\n'):
            path = write_ignores(
                f'[[ignore]]\nid = "X"\necosystem = "npm"\npackage = "p"\n{reason_line}'
            )
            with self.assertRaisesRegex(vuln_scan.ScanError, "reason"):
                vuln_scan.load_ignores(path)

    def test_rejects_unknown_ecosystem_and_keys(self) -> None:
        path = write_ignores(
            '[[ignore]]\nid = "X"\necosystem = "cargo"\npackage = "p"\nreason = "r"\n'
        )
        with self.assertRaisesRegex(vuln_scan.ScanError, "ecosystem"):
            vuln_scan.load_ignores(path)
        path = write_ignores(
            '[[ignore]]\nid = "X"\necosystem = "npm"\npackage = "p"\nreason = "r"\nuntil = "x"\n'
        )
        with self.assertRaisesRegex(vuln_scan.ScanError, "unknown keys"):
            vuln_scan.load_ignores(path)

    def test_rejects_malformed_toml(self) -> None:
        with self.assertRaises(vuln_scan.ScanError):
            vuln_scan.load_ignores(write_ignores("[[ignore]\n"))


class ParseTest(unittest.TestCase):
    def test_npm_one_finding_per_advisory(self) -> None:
        findings = vuln_scan.parse_npm_audit(npm_report(HIGH, MODERATE))
        self.assertEqual(
            [(f.package, f.id, f.severity) for f in findings],
            [("lodash", HIGH["ghsa"], "high"), ("minimatch", MODERATE["ghsa"], "moderate")],
        )

    def test_npm_error_report_raises(self) -> None:
        with self.assertRaisesRegex(vuln_scan.ScanError, "ENOLOCK"):
            vuln_scan.parse_npm_audit({"error": {"code": "ENOLOCK"}})

    def test_pip_findings_dedupe_and_skips(self) -> None:
        report = pip_report(
            PIP_VULN,
            PIP_VULN,
            {"name": "local-pkg", "skip_reason": "not on PyPI"},
        )
        findings, skipped = vuln_scan.parse_pip_audit(report)
        self.assertEqual(len(findings), 1)
        self.assertEqual(
            findings[0].ids(), {"PYSEC-2024-1", "GHSA-mr82-8j83-vxmv", "CVE-2024-3772"}
        )
        self.assertEqual(skipped, ["local-pkg: not on PyPI"])


class IgnoreMatchTest(unittest.TestCase):
    def test_matches_alias_package_and_ecosystem(self) -> None:
        (finding,), _ = vuln_scan.parse_pip_audit(pip_report(PIP_VULN))
        entry = vuln_scan.IgnoreEntry("CVE-2024-3772", "pypi", "Pydantic", "r")
        self.assertIs(vuln_scan.is_ignored(finding, [entry]), entry)
        wrong_pkg = vuln_scan.IgnoreEntry("CVE-2024-3772", "pypi", "other", "r")
        wrong_eco = vuln_scan.IgnoreEntry("CVE-2024-3772", "npm", "pydantic", "r")
        self.assertIsNone(vuln_scan.is_ignored(finding, [wrong_pkg, wrong_eco]))


class ScanTest(unittest.TestCase):
    """Runs ``main`` with the external commands replaced."""

    def setUp(self) -> None:
        self.npm_prod = npm_report()
        self.npm_all = npm_report()
        self.pip_runtime = pip_report()
        self.pip_full = pip_report()
        self.ignore_text = ""
        self.plugin_package = {"name": "flightdeck-plugin", "private": True}

    def fake_run(self, cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
        if cmd[0] == "npm":
            report = self.npm_prod if "--omit=dev" in cmd else self.npm_all
            return subprocess.CompletedProcess(cmd, 1, json.dumps(report), "")
        if cmd[:2] == ["uv", "export"]:
            out = Path(cmd[cmd.index("--output-file") + 1])
            out.write_text("runtime\n" if "--no-dev" in cmd else "full\n")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if cmd[0] == "uvx":
            req = Path(cmd[cmd.index("--requirement") + 1]).read_text()
            report = self.pip_runtime if req == "runtime\n" else self.pip_full
            return subprocess.CompletedProcess(cmd, 1, json.dumps(report), "")
        raise AssertionError(f"unexpected command {cmd}")

    def run_main(self) -> tuple[int, str]:
        root = Path(tempfile.mkdtemp())
        (root / "dashboard").mkdir()
        (root / "dashboard" / "package-lock.json").write_text("{}")
        (root / "plugin").mkdir()
        (root / "plugin" / "package.json").write_text(json.dumps(self.plugin_package))
        ignore_file = root / "vuln-ignore.toml"
        ignore_file.write_text(self.ignore_text)
        out = io.StringIO()
        with (
            mock.patch.object(vuln_scan, "ROOT", root),
            mock.patch.object(vuln_scan, "IGNORE_FILE", ignore_file),
            mock.patch.object(vuln_scan, "_run", side_effect=self.fake_run),
            mock.patch.dict("os.environ", {"GITHUB_ACTIONS": ""}),
            redirect_stdout(out),
        ):
            code = vuln_scan.main()
        return code, out.getvalue()

    def test_clean_scan_passes(self) -> None:
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("no dependencies declared", out)

    def test_high_and_critical_production_npm_fail(self) -> None:
        for adv in (HIGH, CRITICAL):
            self.npm_prod = self.npm_all = npm_report(adv)
            code, out = self.run_main()
            self.assertEqual(code, 1, out)
            self.assertIn(f"FAIL: {adv['name']}", out)

    def test_moderate_production_and_dev_only_high_npm_pass(self) -> None:
        self.npm_prod = npm_report(MODERATE)
        self.npm_all = npm_report(MODERATE, HIGH)
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn(HIGH["ghsa"], out.split("(report only)")[1])

    def test_ignored_advisory_passes_with_reason(self) -> None:
        self.npm_prod = self.npm_all = npm_report(HIGH)
        self.ignore_text = (
            f'[[ignore]]\nid = "{HIGH["ghsa"]}"\necosystem = "npm"\n'
            'package = "lodash"\nreason = "no fixed release"\n'
        )
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("reason: no fixed release", out)

    def test_stale_ignore_entry_is_noted_not_failed(self) -> None:
        self.ignore_text = (
            '[[ignore]]\nid = "GHSA-gone"\necosystem = "npm"\npackage = "x"\nreason = "r"\n'
        )
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("ignore entry GHSA-gone (x) matched no finding", out)

    def test_plugin_dependencies_without_lockfile_fail(self) -> None:
        self.plugin_package["dependencies"] = {"left-pad": "^1.0.0"}
        code, out = self.run_main()
        self.assertEqual(code, 1, out)
        self.assertIn("plugin/package.json declares dependencies", out)

    def test_any_sensor_runtime_advisory_fails(self) -> None:
        self.pip_runtime = self.pip_full = pip_report(PIP_VULN)
        code, out = self.run_main()
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL: pydantic@1.10.0 PYSEC-2024-1", out)

    def test_unaudited_sensor_runtime_package_fails(self) -> None:
        self.pip_runtime = pip_report({"name": "x", "skip_reason": "not on PyPI"})
        code, out = self.run_main()
        self.assertEqual(code, 1, out)
        self.assertIn("not audited", out)

    def test_sensor_extras_advisory_is_report_only(self) -> None:
        self.pip_full = pip_report(PIP_VULN)
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("pydantic@1.10.0", out.split("pip sensor extras and dev")[1])

    def test_tool_failure_is_an_error_not_a_pass(self) -> None:
        def broken(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(cmd, 1, "", "npm ERR! network")

        with mock.patch.object(vuln_scan, "_run", side_effect=broken):
            with self.assertRaisesRegex(vuln_scan.ScanError, "network"):
                vuln_scan.npm_audit(Path("."), omit_dev=True)


if __name__ == "__main__":
    unittest.main()
