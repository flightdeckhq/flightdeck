#!/usr/bin/env python3
"""Scan the npm and pip dependencies for known vulnerabilities.

CI runs this on every pull request; run it locally the same way:

    python3 scripts/vuln_scan.py

It audits the lockfiles, not installed trees, so no ``npm ci`` or
``uv sync`` is needed first. It needs ``npm`` and ``uv`` on PATH and
network access to the npm registry and PyPI; ``uvx`` fetches pip-audit
into the uv cache on first use.

What fails the scan:

- npm ``dashboard/``: an advisory of severity high or critical in any
  dependency, dev dependencies included. The dashboard ships a bundle,
  and several devDependencies end up in it or produce it (tailwindcss is
  compiled into the CSS; vite and its plugins build the bundle), so the
  dev/prod split does not mark what ships.
- npm ``plugin/``: a high or critical advisory in a production dependency
  (``npm audit --omit=dev``). The plugin runs its source files as they
  are, with no bundler, so its dev dependencies never reach a user. A
  ``plugin/package.json`` that declares dependencies without a
  ``package-lock.json`` also fails; the plugin is dependency-free today.
- pip: any advisory in the sensor's core runtime dependencies, exported
  from ``sensor/uv.lock`` without dev groups or extras. pip-audit does
  not report a severity, so every advisory counts; the core set is the
  pydantic stack ``pip install flightdeck-sensor`` pulls in. A runtime
  pin pip-audit did not audit fails too.
- An ignore entry whose ``expires`` date has passed.

What is reported without failing: npm advisories below high, and every
advisory in the full sensor lock (all extras). The sensor's provider and
framework extras are resolved by each user's own installer, so the
versions locked here are not the ones a user gets; the dev and test
extras run in development and CI only.

An advisory that cannot be fixed yet is excused in
``.github/vuln-ignore.toml``, one entry per advisory with a reason and an
expiry date.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import tomllib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
IGNORE_FILE = ROOT / ".github" / "vuln-ignore.toml"
SENSOR_DIR = ROOT / "sensor"
# Exact pip-audit release, run through ``uvx`` so CI and a local run use
# the same version without installing it into any project environment.
PIP_AUDIT_VERSION = "2.10.1"
# pip-audit's own dependencies are resolved fresh by uvx; hold them to the
# same cooldown sensor/pyproject.toml applies to the sensor's lock
# (``exclude-newer = "14 days"``), so a release published days ago, and
# possibly compromised, is not pulled into CI.
PIP_AUDIT_EXCLUDE_NEWER = "14 days"
# npm severities that fail the scan. npm's scale is
# info < low < moderate < high < critical.
GATING_NPM_SEVERITIES = frozenset({"high", "critical"})
# One npm audit, uv export or pip-audit run makes a handful of registry
# requests and normally takes seconds; this bounds a hung connection.
COMMAND_TIMEOUT_SECONDS = 120
# The whole scan runs about ten commands. Its budget stays under the CI
# job's 10-minute timeout, leaving time for checkout and tool setup, so
# a slow registry fails the scan with a message instead of the job being
# killed without one.
SCAN_BUDGET_SECONDS = 420
# Lines of a failed command's stderr quoted in the error.
STDERR_TAIL_LINES = 20
ECOSYSTEMS = frozenset({"npm", "pypi"})
IGNORE_KEYS = frozenset({"id", "ecosystem", "package", "reason", "expires"})
_GHSA_RE = re.compile(r"GHSA(-[23456789cfghjmpqrvwx]{4}){3}")
_DEPENDENCY_KEYS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)

_deadline: float | None = None


class ScanError(Exception):
    """A scan could not run, or its input is malformed."""


@dataclass(frozen=True)
class NpmPackage:
    name: str
    # True: high and critical advisories in dev dependencies fail too.
    gate_dev: bool


NPM_PACKAGES = (
    NpmPackage("dashboard", gate_dev=True),
    NpmPackage("plugin", gate_dev=False),
)


@dataclass(frozen=True)
class IgnoreEntry:
    id: str
    ecosystem: str
    package: str
    reason: str
    expires: datetime.date


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


def normalize(name: str) -> str:
    """PEP 503 name normalization: ``Foo_Bar.baz`` -> ``foo-bar-baz``."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _package_key(ecosystem: str, name: str) -> str:
    return normalize(name) if ecosystem == "pypi" else name.lower()


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
        unknown = set(raw) - IGNORE_KEYS
        if unknown:
            raise ScanError(f"{where}: unknown keys {sorted(unknown)}")
        values: dict[str, str] = {}
        for key in ("id", "ecosystem", "package", "reason"):
            value = raw.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ScanError(f"{where}: '{key}' must be a non-empty string")
            values[key] = value.strip()
        if values["ecosystem"] not in ECOSYSTEMS:
            raise ScanError(f"{where}: ecosystem must be one of {sorted(ECOSYSTEMS)}")
        expires = raw.get("expires")
        # A TOML local date (expires = 2027-01-31) parses to a date; a
        # string or a date-time is rejected so the format stays one thing.
        if not isinstance(expires, datetime.date) or isinstance(expires, datetime.datetime):
            raise ScanError(f"{where}: 'expires' must be a TOML date, e.g. expires = 2027-01-31")
        entries.append(IgnoreEntry(expires=expires, **values))
    return entries


def is_ignored(finding: Finding, ignores: list[IgnoreEntry]) -> IgnoreEntry | None:
    package = _package_key(finding.ecosystem, finding.package)
    for entry in ignores:
        if (
            entry.ecosystem == finding.ecosystem
            and _package_key(entry.ecosystem, entry.package) == package
            and entry.id in finding.ids()
        ):
            return entry
    return None


def _stderr_tail(stderr: str) -> str:
    lines = stderr.strip().splitlines()[-STDERR_TAIL_LINES:]
    return "\n".join(lines)


def parse_npm_audit(report: dict[str, Any], stderr: str = "") -> list[Finding]:
    """Turn ``npm audit --json`` output into one finding per advisory."""
    if "vulnerabilities" not in report:
        # npm's error shape is {"message": "...", "error": {...}}, where
        # the error object can be empty; the message carries the cause.
        cause = report.get("message") or report.get("error") or "no vulnerabilities key"
        raise ScanError(f"npm audit failed: {cause}\n{_stderr_tail(stderr)}".rstrip())
    findings: dict[tuple[str, str], Finding] = {}
    for entry in report["vulnerabilities"].values():
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


@dataclass
class PipAudit:
    findings: list[Finding]
    audited: set[tuple[str, str]]
    skipped: list[str]


def parse_pip_audit(report: dict[str, Any]) -> PipAudit:
    """Turn ``pip-audit -f json`` output into findings, audited pins and skips."""
    findings: dict[tuple[str, str, str], Finding] = {}
    audited: set[tuple[str, str]] = set()
    skipped: list[str] = []
    for dep in report.get("dependencies", []):
        name = normalize(str(dep.get("name", "")))
        version = str(dep.get("version", ""))
        if "skip_reason" in dep:
            skipped.append(f"{name}: {dep['skip_reason']}")
            continue
        audited.add((name, version))
        for vuln in dep.get("vulns", []):
            fixes = ", ".join(vuln.get("fix_versions", [])) or "no fix"
            findings[(name, version, str(vuln["id"]))] = Finding(
                ecosystem="pypi",
                package=name,
                version=version,
                id=str(vuln["id"]),
                aliases=tuple(str(a) for a in vuln.get("aliases", [])),
                severity="unrated",
                summary=f"fixed in: {fixes}",
            )
    return PipAudit(list(findings.values()), audited, skipped)


def parse_requirements(text: str) -> tuple[list[tuple[str, str]], list[str]]:
    """Read ``uv export`` output into ``(name, version)`` pins.

    Environment markers are dropped: pip-audit evaluates them against the
    interpreter it runs on and silently leaves out a pin whose marker does
    not match, so a Windows-only or Python-3.14-only pin would go
    unaudited. Every locked version is audited regardless of where it
    installs. Lines that are not an exact ``name==version`` pin are
    returned separately so the caller can report them as unaudited.
    """
    pins: list[tuple[str, str]] = []
    unpinned: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        # Skip blanks, comments and the indented ``# via`` annotations.
        if not line or line.startswith("#") or raw[:1].isspace():
            continue
        requirement = line.split(";", 1)[0].strip()
        name, sep, version = requirement.partition("==")
        if not sep or not name.strip() or not version.strip():
            unpinned.append(line)
            continue
        pins.append((normalize(name.strip()), version.strip()))
    return sorted(set(pins)), unpinned


def split_pins(pins: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    """Spread the pins over as few files as hold one version per package.

    pip-audit rejects a requirements file that pins one package twice, and
    the full export locks different versions for different Python
    versions (deprecated 1.3.1 below 3.12, 3.0.0 from 3.12).
    """
    by_name: dict[str, list[str]] = defaultdict(list)
    for name, version in pins:
        by_name[name].append(version)
    files: list[list[tuple[str, str]]] = []
    for name in sorted(by_name):
        for i, version in enumerate(sorted(by_name[name])):
            if i == len(files):
                files.append([])
            files[i].append((name, version))
    return files


def has_dependencies(package_json: Path) -> bool:
    data = json.loads(package_json.read_text(encoding="utf-8"))
    return any(data.get(key) for key in _DEPENDENCY_KEYS)


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    timeout: float = COMMAND_TIMEOUT_SECONDS
    if _deadline is not None:
        remaining = _deadline - time.monotonic()
        if remaining <= 0:
            raise ScanError(f"scan budget of {SCAN_BUDGET_SECONDS}s spent before {cmd[0]}")
        timeout = min(timeout, remaining)
    try:
        return subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ScanError(f"{cmd[0]} is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise ScanError(f"{' '.join(cmd)} timed out after {timeout:.0f}s") from exc


def _json_output(proc: subprocess.CompletedProcess[str], what: str) -> dict[str, Any]:
    # Both tools exit non-zero when they find something, so the exit code
    # alone does not separate a finding from a failure; the JSON does.
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ScanError(
            f"{what} produced no JSON (exit {proc.returncode}):\n{_stderr_tail(proc.stderr)}"
        ) from exc
    if not isinstance(data, dict):
        raise ScanError(f"{what} produced unexpected JSON")
    return data


def npm_audit(package_dir: Path, *, omit_dev: bool) -> list[Finding]:
    cmd = ["npm", "audit", "--json", "--package-lock-only"]
    if omit_dev:
        cmd.append("--omit=dev")
    proc = _run(cmd, package_dir)
    return parse_npm_audit(_json_output(proc, f"npm audit in {package_dir.name}"), proc.stderr)


def pip_audit_file(requirements: Path) -> PipAudit:
    cmd = [
        "uvx",
        "--exclude-newer",
        PIP_AUDIT_EXCLUDE_NEWER,
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


def pip_audit_pins(pins: list[tuple[str, str]], workdir: Path, label: str) -> PipAudit:
    """Audit every pin, one pip-audit run per file from ``split_pins``."""
    merged = PipAudit([], set(), [])
    for i, group in enumerate(split_pins(pins)):
        path = workdir / f"{label}-{i}.txt"
        path.write_text("".join(f"{n}=={v}\n" for n, v in group), encoding="utf-8")
        result = pip_audit_file(path)
        merged.findings += result.findings
        merged.audited |= result.audited
        merged.skipped += result.skipped
    return merged


def uv_export(*, runtime_only: bool) -> str:
    cmd = [
        "uv",
        "export",
        "--project",
        str(SENSOR_DIR),
        # Fails if uv.lock is out of date with pyproject.toml instead of
        # auditing a stale lock.
        "--locked",
        "--no-emit-project",
        "--no-hashes",
        "--format",
        "requirements.txt",
        "--quiet",
    ]
    cmd += ["--no-dev"] if runtime_only else ["--all-extras"]
    proc = _run(cmd, ROOT)
    if proc.returncode != 0:
        raise ScanError(f"uv export failed (exit {proc.returncode}):\n{_stderr_tail(proc.stderr)}")
    return proc.stdout


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
            self.fail(f"{label}: {finding.line()}", title="Vulnerable dependency")
        if not blocking:
            print("  no blocking advisories")

    def inform(
        self, label: str, findings: list[Finding], unaudited: list[str] | None = None
    ) -> None:
        unaudited = unaudited or []
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
        for line in unaudited:
            print(f"  not audited: {line}")
        if not shown and not unaudited:
            print("  no advisories")
        elif self.annotate:
            print(
                f"::warning title=Dependency advisories ({label})::"
                f"{len(shown)} advisories, {len(unaudited)} unaudited pins; "
                "report only, see the job log"
            )

    def fail(self, message: str, title: str = "Dependency scan") -> None:
        print(f"  FAIL: {message}")
        self.failures.append(message)
        if self.annotate:
            print(f"::error title={title}::{message}")

    def warn(self, message: str, title: str) -> None:
        print(f"note: {message}")
        if self.annotate:
            print(f"::warning title={title}::{message}")


def scan_npm(report: Report) -> None:
    for package in NPM_PACKAGES:
        package_dir = ROOT / package.name
        lockfile = package_dir / "package-lock.json"
        if not lockfile.exists():
            print(f"\n== npm {package.name}")
            if has_dependencies(package_dir / "package.json"):
                report.fail(
                    f"{package.name}/package.json declares dependencies but has no "
                    "package-lock.json to audit"
                )
            else:
                print("  no dependencies declared; nothing to audit")
            continue
        everything = npm_audit(package_dir, omit_dev=False)
        if package.gate_dev:
            gated = [f for f in everything if f.severity in GATING_NPM_SEVERITIES]
            scope = "all dependencies"
        else:
            prod = npm_audit(package_dir, omit_dev=True)
            gated = [f for f in prod if f.severity in GATING_NPM_SEVERITIES]
            scope = "production dependencies"
        report.gate(f"npm {package.name} {scope}, high and critical", gated)
        gated_ids = {(f.package, f.id) for f in gated}
        report.inform(
            f"npm {package.name}, other advisories",
            [f for f in everything if (f.package, f.id) not in gated_ids],
        )


def scan_pip(report: Report) -> None:
    runtime_pins, runtime_unpinned = parse_requirements(uv_export(runtime_only=True))
    full_pins, full_unpinned = parse_requirements(uv_export(runtime_only=False))
    with tempfile.TemporaryDirectory() as tmp:
        runtime = pip_audit_pins(runtime_pins, Path(tmp), "runtime")
        full = pip_audit_pins(full_pins, Path(tmp), "full")
    report.gate("pip sensor runtime", runtime.findings)
    # A pin pip-audit did not audit is unverified, not clean.
    runtime_gaps = sorted(f"{n}=={v}" for n, v in set(runtime_pins) - runtime.audited)
    for line in runtime_gaps + runtime_unpinned + runtime.skipped:
        report.fail(f"pip sensor runtime: not audited: {line}")
    runtime_ids = {(f.package, f.version, f.id) for f in runtime.findings}
    full_gaps = sorted(f"{n}=={v}" for n, v in set(full_pins) - full.audited)
    report.inform(
        "pip sensor extras and dev",
        [f for f in full.findings if (f.package, f.version, f.id) not in runtime_ids],
        full_gaps + full_unpinned + full.skipped,
    )


def check_expiry(report: Report, today: datetime.date) -> None:
    for entry in report.ignores:
        if entry.expires < today:
            report.fail(
                f"ignore entry {entry.id} ({entry.package}) expired on {entry.expires}; "
                "fix the dependency or re-review the entry and set a new date",
                title="Expired ignore entry",
            )


def main(today: datetime.date | None = None) -> int:
    global _deadline
    _deadline = time.monotonic() + SCAN_BUDGET_SECONDS
    try:
        report = Report(load_ignores(IGNORE_FILE))
        print("== ignore list")
        check_expiry(report, today or datetime.date.today())
        print(f"  {len(report.ignores)} entries")
        scan_npm(report)
        scan_pip(report)
    except ScanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        _deadline = None
    stale = sorted(set(report.ignores) - report.used, key=lambda e: e.id)
    if stale:
        print()
    for entry in stale:
        # Not a failure, so a dependency bump never breaks the scan, but
        # annotated on the pull request so the stale entry gets pruned.
        report.warn(
            f"ignore entry {entry.id} ({entry.package}) matched no finding; remove it",
            title="Stale ignore entry",
        )
    if report.failures:
        print(f"\n{len(report.failures)} blocking finding(s). Bump the dependency, or add an")
        print(f"entry with a reason and an expiry to {IGNORE_FILE.relative_to(ROOT)}.")
        return 1
    print("\nNo blocking advisories.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
