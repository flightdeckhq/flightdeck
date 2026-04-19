"""Run every playground example as an isolated subprocess.

Each `NN_*.py` executes in its own Python process so one file's import
failure cannot poison the others. stdout / stderr stream through in
real time; a summary table prints at the end.

Usage: python playground/run_all.py
Exit: 0 iff every file returned 0 (PASS) or 2 (SKIP).
"""
from __future__ import annotations

import glob
import os
import subprocess
import sys
import time

SKIP_RC = 2  # each example exits 2 when its framework package is missing


def _tag(rc: int) -> str:
    return {0: "PASS", SKIP_RC: "SKIP"}.get(rc, "FAIL")


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    files = sorted(glob.glob(os.path.join(here, "[0-9]*.py")))
    if not files:
        print("no playground files found", file=sys.stderr)
        return 1

    rows: list[tuple[str, int, float, str]] = []
    for path in files:
        name = os.path.basename(path)
        print(f"\n=== {name} ===", flush=True)
        t0 = time.monotonic()
        try:
            rc = subprocess.call([sys.executable, path], cwd=here, timeout=60)
            reason = ""
        except subprocess.TimeoutExpired:
            rc, reason = 124, "timeout after 60s"
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
