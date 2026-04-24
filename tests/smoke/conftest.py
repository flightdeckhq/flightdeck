"""Shared Phase 4 smoke-test helpers.

Every per-framework file expects the local dev stack to be running --
these tests talk to real providers but POST their events back to the
dev control plane so the sensor's end-to-end flow is exercised (sensor
→ ingestion → NATS → worker → Postgres → /v1/events).

The helpers here cover:

* :func:`require_env` -- skip cleanly when an API key is missing so
  ``make smoke-all`` never fails on a box that happens to have only
  some keys loaded.
* :func:`wait_for_dev_stack` -- block until ``/health`` returns 200 on
  both ingestion and api ports. Mirrors the helper the integration
  suite uses so smoke tests fail fast on a cold stack.
* :func:`fetch_latest_events_for_session` -- poll the query API's
  ``/v1/events`` endpoint for events written against the test's
  session and return them parsed. Used by smoke tests to assert that
  the Phase 4 event shape actually landed on the wire, not just
  in the sensor's queue.
"""

from __future__ import annotations

import os
import time
from typing import Any

import pytest

try:
    import httpx  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover -- smoke tests always install httpx
    httpx = None  # type: ignore[assignment]


INGESTION_URL = os.environ.get("FLIGHTDECK_INGESTION_URL", "http://localhost:4000/ingest")
API_URL = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
API_TOKEN = os.environ.get("FLIGHTDECK_API_TOKEN", "tok_dev")


def require_env(*names: str) -> None:
    """Skip the calling test when any of the listed env vars is unset.

    Smoke tests get a clean "skipped" state so ``make smoke-all``
    continues on a box that has only some provider keys configured.
    The skip message lists every missing name so the operator can see
    the full gap in one run.
    """
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        pytest.skip(
            f"smoke test requires env vars: {', '.join(missing)}. "
            f"Set them before running ``make smoke-*``.",
        )


def wait_for_dev_stack(timeout_s: float = 30.0) -> None:
    """Block until ingestion + api ``/health`` both return 200.

    The smoke targets depend on ``make dev``; if the stack isn't up
    the test hangs uninformatively while the sensor retries its POST.
    Explicit probe with a bounded timeout keeps the failure mode
    loud.
    """
    if httpx is None:  # pragma: no cover
        pytest.skip("httpx not installed; smoke tests require it")
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            r1 = httpx.get(f"{INGESTION_URL}/health", timeout=2.0)
            r2 = httpx.get(f"{API_URL}/health", timeout=2.0)
            if r1.status_code == 200 and r2.status_code == 200:
                return
        except Exception as exc:  # pragma: no cover
            last_err = exc
        time.sleep(0.5)
    raise RuntimeError(
        f"dev stack not ready within {timeout_s}s; is ``make dev`` running? "
        f"Last error: {last_err!r}",
    )


def fetch_events_for_session(
    session_id: str, *, timeout_s: float = 10.0, poll_s: float = 0.5,
) -> list[dict[str, Any]]:
    """Poll ``/v1/events?session_id=<uuid>`` until events are visible.

    Returns the full events list at the first non-empty read, or an
    empty list after ``timeout_s``. Smoke tests use this to assert
    that the Phase 4 event_type / error / streaming sub-objects
    actually round-tripped through ingestion → worker → Postgres.
    """
    if httpx is None:  # pragma: no cover
        return []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        r = httpx.get(
            f"{API_URL}/v1/events",
            params={"session_id": session_id, "limit": 100},
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            timeout=5.0,
        )
        if r.status_code == 200:
            events = r.json().get("events", [])
            if events:
                return events
        time.sleep(poll_s)
    return []
