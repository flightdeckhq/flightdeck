#!/usr/bin/env python3
"""Scan the npm and pip dependencies for known vulnerabilities.

CI runs this on every pull request; run it locally the same way:

    python3 scripts/vuln_scan.py

It audits the lockfiles, not installed trees, so no ``npm ci`` or
``uv sync`` is needed first. It needs ``npm`` and ``uv`` on PATH and
network access to the npm registry and PyPI.

What fails the scan (the dependencies that ship):

- npm: an advisory of severity high or critical in a production
  dependency of ``dashboard/`` (``npm audit --omit=dev``). The dashboard
  image serves the production bundle, which is built from these.
- npm: a package under ``plugin/`` that declares dependencies but has no
  ``package-lock.json`` to audit. The plugin is dependency-free today.
- pip: any advisory in the sensor's core runtime dependencies, exported
  from ``sensor/uv.lock`` without dev groups or extras. pip-audit does
  not report a severity, so every advisory counts; the core set is the
  pydantic stack ``pip install flightdeck-sensor`` pulls in.

What is reported without failing: npm dev dependencies at any severity,
and every advisory in the full sensor lock (all extras). Those versions
run in development and CI only. The sensor's provider and framework
extras are resolved by each user's own installer, so the versions locked
here are not the ones a user gets.

An advisory that cannot be fixed yet is excused in
``.github/vuln-ignore.toml``, one entry per advisory with a reason.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
IGNORE_FILE = ROOT / ".github" / "vuln-ignore.toml"
NPM_PACKAGES = ("dashboard", "plugin")
SENSOR_DIR = ROOT / "sensor"
# Exact pip-audit release, run through ``uvx`` so CI and a local run use
# the same version without installing it into any project environment.
PIP_AUDIT_VERSION = "2.10.1"
# npm severities that fail the scan for a production dependency. npm's
# scale is info < low < moderate < high < critical.
GATING_NPM_SEVERITIES = frozenset({"high", "critical"})
# npm audit and pip-audit each make a handful of registry requests; this
# bounds a hung connection without cutting off a slow but working one.
COMMAND_TIMEOUT_SECONDS = 300
ECOSYSTEMS = frozenset({"npm", "pypi"})
_GHSA_RE = re.compile(r"GHSA(-[23456789cfghjmpqrvwx]{4}){3}")
_DEPENDENCY_KEYS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)


class ScanError(Exception):
    """A scan could not run, or its input is malformed."""


@dataclass(frozen=True)
class IgnoreEntry:
    id: str
    ecosystem: str
    package: str
    reason: str


@dataclass(frozen=True)
class Finding:
    ecosystem: str
    package: str
    version: str
    id: str
    aliases: tuple[str, ...]
    severity: str
    summary: str

    def ids(self) -> set[str]:
        return {self.id, *self.aliases}

    def line(self) -> str:
        alias = f" ({', '.join(self.aliases)})" if self.aliases else ""
        version = f"@{self.version}" if self.version else ""
        return f"{self.package}{version} {self.id}{alias} [{self.severity}] {self.summary}"


def load_ignores(path: Path) -> list[IgnoreEntry]:
    """Read and validate the ignore list. A missing file means no ignores."""
    if not path.exists():
        return []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise ScanError(f"{path}: {exc}") from exc
    entries: list[IgnoreEntry] = []
    for i, raw in enumerate(data.get("ignore", [])):
        where = f"{path.name} ignore[{i}]"
        if not isinstance(raw, dict):
            raise ScanError(f"{where}: must be a table")
        unknown = set(raw) - {"id", "ecosystem", "package", "reason"}
        if unknown:
            raise ScanError(f"{where}: unknown keys {sorted(unknown)}")
        values = {}
        for key in ("id", "ecosystem", "package", "reason"):
            value = raw.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ScanError(f"{where}: '{key}' must be a non-empty string")
            values[key] = value.strip()
        if values["ecosystem"] not in ECOSYSTEMS:
            raise ScanError(f"{where}: ecosystem must be one of {sorted(ECOSYSTEMS)}")
        entries.append(IgnoreEntry(**values))
    return entries


def is_ignored(finding: Finding, ignores: list[IgnoreEntry]) -> IgnoreEntry | None:
    for entry in ignores:
        if (
            entry.ecosystem == finding.ecosystem
            and entry.package.lower() == finding.package.lower()
            and entry.id in finding.ids()
        ):
            return entry
    return None


def parse_npm_audit(report: dict[str, Any]) -> list[Finding]:
    """Turn ``npm audit --json`` output into one finding per advisory."""
    if "error" in report:
        raise ScanError(f"npm audit failed: {report['error']}")
    findings: dict[tuple[str, str], Finding] = {}
    for entry in report.get("vulnerabilities", {}).values():
        for via in entry.get("via", []):
            # A string ``via`` names another vulnerable package; only the
            # dict form carries the advisory itself.
            if not isinstance(via, dict):
                continue
            url = str(via.get("url", ""))
            match = _GHSA_RE.search(url)
            advisory = match.group(0) if match else f"npm-{via.get('source')}"
            package = str(via.get("name", ""))
            findings[(package, advisory)] = Finding(
                ecosystem="npm",
                package=package,
                version=str(via.get("range", "")),
                id=advisory,
                aliases=(),
                severity=str(via.get("severity", "unknown")),
                summary=str(via.get("title", "")),
            )
    return sorted(findings.values(), key=lambda f: (f.package, f.id))


def parse_pip_audit(report: dict[str, Any]) -> tuple[list[Finding], list[str]]:
    """Turn ``pip-audit -f json`` output into findings plus skipped packages."""
    # A requirements export can list one package more than once, under
    # different environment markers; keep each advisory once.
    findings: dict[tuple[str, str, str], Finding] = {}
    skipped: list[str] = []
    for dep in report.get("dependencies", []):
        if "skip_reason" in dep:
            skipped.append(f"{dep.get('name')}: {dep['skip_reason']}")
            continue
        for vuln in dep.get("vulns", []):
            fixes = ", ".join(vuln.get("fix_versions", [])) or "no fix"
            key = (str(dep["name"]), str(dep.get("version", "")), str(vuln["id"]))
            findings[key] = Finding(
                ecosystem="pypi",
                package=str(dep["name"]),
                version=str(dep.get("version", "")),
                id=str(vuln["id"]),
                aliases=tuple(str(a) for a in vuln.get("aliases", [])),
                severity="unrated",
                summary=f"fixed in: {fixes}",
            )
    return list(findings.values()), skipped


def has_dependencies(package_json: Path) -> bool:
    data = json.loads(package_json.read_text(encoding="utf-8"))
    return any(data.get(key) for key in _DEPENDENCY_KEYS)


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ScanError(f"{cmd[0]} is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise ScanError(f"{' '.join(cmd)} timed out") from exc


def _json_output(proc: subprocess.CompletedProcess[str], what: str) -> dict[str, Any]:
    # Both tools exit non-zero when they find something, so the exit code
    # alone does not separate a finding from a failure; the JSON does.
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ScanError(f"{what} produced no JSON:\n{proc.stderr.strip()}") from exc
    if not isinstance(data, dict):
        raise ScanError(f"{what} produced unexpected JSON")
    return data


def npm_audit(package_dir: Path, *, omit_dev: bool) -> list[Finding]:
    cmd = ["npm", "audit", "--json", "--package-lock-only"]
    if omit_dev:
        cmd.append("--omit=dev")
    return parse_npm_audit(_json_output(_run(cmd, package_dir), f"npm audit in {package_dir.name}"))


def pip_audit(requirements: Path) -> tuple[list[Finding], list[str]]:
    cmd = [
        "uvx",
        "--from",
        f"pip-audit=={PIP_AUDIT_VERSION}",
        "pip-audit",
        "--requirement",
        str(requirements),
        # Audit the pinned list as written: no resolver, no virtualenv.
        "--disable-pip",
        "--no-deps",
        "--progress-spinner",
        "off",
        "--format",
        "json",
    ]
    return parse_pip_audit(_json_output(_run(cmd, ROOT), "pip-audit"))


def uv_export(dest: Path, *, runtime_only: bool) -> None:
    cmd = [
        "uv",
        "export",
        "--project",
        str(SENSOR_DIR),
        "--frozen",
        "--no-emit-project",
        "--no-hashes",
        "--format",
        "requirements.txt",
        "--quiet",
        "--output-file",
        str(dest),
    ]
    cmd += ["--no-dev"] if runtime_only else ["--all-extras"]
    proc = _run(cmd, ROOT)
    if proc.returncode != 0:
        raise ScanError(f"uv export failed:\n{proc.stderr.strip()}")


class Report:
    """Collects gating findings, report-only findings and notes."""

    def __init__(self, ignores: list[IgnoreEntry]) -> None:
        self.ignores = ignores
        self.used: set[IgnoreEntry] = set()
        self.failures: list[str] = []
        self.annotate = os.environ.get("GITHUB_ACTIONS") == "true"

    def gate(self, label: str, findings: list[Finding]) -> None:
        print(f"\n== {label} (gating)")
        blocking = 0
        for finding in findings:
            entry = is_ignored(finding, self.ignores)
            if entry:
                self.used.add(entry)
                print(f"  ignored: {finding.line()}\n           reason: {entry.reason}")
                continue
            blocking += 1
            print(f"  FAIL: {finding.line()}")
            self.failures.append(f"{label}: {finding.line()}")
            if self.annotate:
                print(f"::error title=Vulnerable dependency ({label})::{finding.line()}")
        if not blocking:
            print("  no blocking advisories")

    def inform(self, label: str, findings: list[Finding]) -> None:
        print(f"\n== {label} (report only)")
        shown = []
        for finding in findings:
            entry = is_ignored(finding, self.ignores)
            if entry:
                self.used.add(entry)
            else:
                shown.append(finding)
        for finding in shown:
            print(f"  {finding.line()}")
        if not shown:
            print("  no advisories")
        elif self.annotate:
            print(
                f"::warning title=Dependency advisories ({label})::"
                f"{len(shown)} advisories, report only; see the job log"
            )

    def fail(self, message: str) -> None:
        print(f"  FAIL: {message}")
        self.failures.append(message)


def scan_npm(report: Report) -> None:
    for name in NPM_PACKAGES:
        package_dir = ROOT / name
        lockfile = package_dir / "package-lock.json"
        if not lockfile.exists():
            print(f"\n== npm {name}")
            if has_dependencies(package_dir / "package.json"):
                report.fail(
                    f"{name}/package.json declares dependencies but has no package-lock.json"
                )
            else:
                print("  no dependencies declared; nothing to audit")
            continue
        prod = npm_audit(package_dir, omit_dev=True)
        report.gate(
            f"npm {name} production",
            [f for f in prod if f.severity in GATING_NPM_SEVERITIES],
        )
        prod_ids = {(f.package, f.id) for f in prod}
        everything = npm_audit(package_dir, omit_dev=False)
        report.inform(
            f"npm {name} dev-only and below-high",
            [
                f
                for f in everything
                if (f.package, f.id) not in prod_ids or f.severity not in GATING_NPM_SEVERITIES
            ],
        )


def scan_pip(report: Report) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        runtime = Path(tmp) / "runtime.txt"
        full = Path(tmp) / "full.txt"
        uv_export(runtime, runtime_only=True)
        uv_export(full, runtime_only=False)
        findings, skipped = pip_audit(runtime)
        report.gate("pip sensor runtime", findings)
        if skipped:
            # A package pip-audit could not look up is unverified, not clean.
            for line in skipped:
                report.fail(f"pip sensor runtime: not audited: {line}")
        full_findings, _ = pip_audit(full)
        runtime_ids = {(f.package, f.id) for f in findings}
        report.inform(
            "pip sensor extras and dev",
            [f for f in full_findings if (f.package, f.id) not in runtime_ids],
        )


def main() -> int:
    try:
        report = Report(load_ignores(IGNORE_FILE))
        scan_npm(report)
        scan_pip(report)
    except ScanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for entry in sorted(set(report.ignores) - report.used, key=lambda e: e.id):
        # Not a failure, so a dependency bump never breaks the scan; the
        # entry is stale and should be pruned.
        print(f"\nnote: ignore entry {entry.id} ({entry.package}) matched no finding; remove it")
    if report.failures:
        print(f"\n{len(report.failures)} blocking finding(s). Bump the dependency, or add an")
        print(f"entry with a reason to {IGNORE_FILE.relative_to(ROOT)}.")
        return 1
    print("\nNo blocking advisories.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
