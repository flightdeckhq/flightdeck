"""Seed one run with more events than one ``GET /v1/events`` page holds,
through the ingestion API, for the event deep-link spec (T146).

The run gets a ``session_start``, ``count`` tool calls half a second
apart ending a minute ago, and last, dated now, one tool call named
``needle``: the run's newest event, which a lookup that read only the
run's oldest 2,000 events never reached. Events go up on a small thread
pool, so 2,100 of them take seconds. Prints the session id.

Usage: seed_long_run.py <needle tool name> [count]
"""

from __future__ import annotations

import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tests.shared.fixtures import make_event, post_event  # noqa: E402

AGENT_NAME = "e2e-test-long-run"
FLAVOR = "e2e-long-run"
# Spacing between the bulk calls, and the gap before the needle.
STEP_SEC = 0.5
NEEDLE_LEAD_SEC = 60.0
# Enough parallel posts to seed 2,100 events in seconds without
# swamping the dev stack's ingestion.
POST_WORKERS = 16


def iso(t: float) -> str:
    """An ISO timestamp with milliseconds."""
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t))
        + f".{int(t * 1000) % 1000:03d}Z"
    )


def main() -> None:
    needle = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 2100
    sid = str(uuid.uuid4())
    identity = {
        "agent_type": "production",
        "client_type": "flightdeck_sensor",
        "user": "e2e-runner",
        "hostname": "e2e-host-long-run",
        "agent_name": AGENT_NAME,
    }
    now = time.time()
    first = now - NEEDLE_LEAD_SEC - count * STEP_SEC
    post_event(
        make_event(sid, FLAVOR, "session_start", timestamp=iso(first - 1), **identity)
    )

    def call(i: int) -> None:
        post_event(
            make_event(
                sid,
                FLAVOR,
                "tool_call",
                tool_name="e2e-long-run-step",
                timestamp=iso(first + i * STEP_SEC),
                **identity,
            )
        )

    with ThreadPoolExecutor(max_workers=POST_WORKERS) as pool:
        list(pool.map(call, range(count)))
    post_event(
        make_event(
            sid, FLAVOR, "tool_call", tool_name=needle, timestamp=iso(now), **identity
        )
    )
    print(sid)


if __name__ == "__main__":
    main()
