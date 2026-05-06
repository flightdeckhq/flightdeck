"""Run every playground example as an isolated subprocess.

Each `NN_*.py` (and the `policy_demo_*.py` set) executes in its own
Python process so one file's import failure cannot poison the others.
stdout / stderr stream through in real time; a summary table prints
at the end.

Usage::

    make playground-all
    # equivalent: ./sensor/.venv/bin/python playground/run_all.py

Exit: 0 iff every file returned 0 (PASS) or 2 (SKIP).
"""

from __future__ import annotations

import glob
import os
import subprocess
import sys
import time

# Python-version gate. The project bound is 3.10–3.13 (sensor/pyproject
# .toml requires-python = ">=3.10,<3.14"). crewai 1.x metadata bars
# 3.14, so a run on the wrong interpreter would silently SKIP every
# crewai-touching demo and mask real coverage gaps -- the failure mode
# D124 was filed to eliminate. Refuse to run instead of producing a
# misleading green matrix.
if sys.version_info < (3, 10) or sys.version_info >= (3, 14):
    print(
        f"FAIL: playground requires Python 3.10–3.13 (found "
        f"{sys.version_info.major}.{sys.version_info.minor}). "
        "Use ./sensor/.venv/bin/python or run via 'make playground-all'.",
        file=sys.stderr,
    )
    sys.exit(1)


SKIP_RC = 2  # each example exits 2 when its framework / API key is missing


def _tag(rc: int) -> str:
    return {0: "PASS", SKIP_RC: "SKIP"}.get(rc, "FAIL")


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    # Numbered framework demos run first (01..15), then the policy
    # demo set. Both globs are sorted independently so the summary
    # table reads in stable order across runs.
    numbered = sorted(glob.glob(os.path.join(here, "[0-9]*.py")))
    policies = sorted(glob.glob(os.path.join(here, "policy_demo_*.py")))
    files = numbered + policies
    if not files:
        print("no playground files found", file=sys.stderr)
        return 1

    rows: list[tuple[str, int, float, str]] = []
    for path in files:
        name = os.path.basename(path)
        # Per-script subprocess timeout. 60s covers single-call
        # demos comfortably; the D126 multi-agent demos
        # (16_subagents_crewai, 17_subagents_langgraph) make
        # multiple sequential real-API calls and routinely run
        # 30–90s end-to-end (network jitter, model warm-up,
        # post-call drain). 180s caps them while still flagging a
        # genuinely stuck run loud and early.
        if (
            "subagents" in name
            or "mcp_policy_langchain" in name
            or "mcp_policy_llamaindex" in name
        ):
            timeout_s = 180
        else:
            timeout_s = 60
        print(f"\n=== {name} ===", flush=True)
        t0 = time.monotonic()
        try:
            rc = subprocess.call([sys.executable, path], cwd=here, timeout=timeout_s)
            reason = ""
        except subprocess.TimeoutExpired:
            rc, reason = 124, f"timeout after {timeout_s}s"
        rows.append((name, rc, time.monotonic() - t0, reason))

    print("\nplayground summary\n------------------")
    passes = skips = fails = 0
    for name, rc, dt, reason in rows:
        tag = _tag(rc)
        note = f" ({reason or f'exit {rc}'})" if tag == "FAIL" else ""
        print(f"  {name:<28} {tag}   {dt:>4.1f}s{note}")
        passes += tag == "PASS"
        skips += tag == "SKIP"
        fails += tag == "FAIL"
    print(f"\n{len(rows)} files: {passes} PASS {skips} SKIP {fails} FAIL")
    print(f"total runtime: {sum(dt for _, _, dt, _ in rows):.1f}s")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
