"""Shared smoke-test helpers.

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
* :func:`fetch_events_for_session` -- poll the query API's
  ``/v1/events`` endpoint for events written against the test's
  session and return them parsed. Used by smoke tests to assert that
  the expected event shape actually landed on the wire, not just
  in the sensor's queue.
* :func:`make_sensor_session` -- canonical sensor bootstrap. Wraps
  ``flightdeck_sensor.init`` + ``patch`` with the per-smoke flavor
  threaded through ``AGENT_FLAVOR`` so the wire-level ``flavor``
  column reflects which framework run this is. Without ``patch()``,
  raw SDK constructors return clients whose method descriptors are
  NOT routed through the sensor and no events get emitted -- the
  smoke would PASS the SDK call and FAIL the
  ``fetch_events_for_session`` assertion silently.
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


def make_sensor_session(
    *,
    flavor: str,
    agent_type: str = "production",
    capture_prompts: bool = True,
):
    """Initialise the sensor + class-level patch the SDKs, return the
    live ``Session``. The flavor is threaded via ``AGENT_FLAVOR`` so
    ``sessions.flavor`` on the wire matches the smoke target's name
    (e.g. ``smoke-anthropic``) regardless of any stale env var the
    operator's shell might carry in.

    Wraps ``flightdeck_sensor.init`` + ``flightdeck_sensor.patch`` so
    every sensor-level setting needed for a smoke run lives in one
    place. Without ``patch()``, raw ``anthropic.Anthropic`` /
    ``openai.OpenAI`` constructors return clients whose ``.messages``
    / ``.chat`` descriptors are NOT routed through the sensor and no
    events get emitted -- the smoke would PASS the SDK call and FAIL
    the ``fetch_events_for_session`` assertion silently.

    Calls ``teardown()`` first so each smoke test gets a fresh
    session_id. Without the teardown, ``init()``'s
    ``if _session is not None: return`` short-circuit means the
    second test in a module reuses the first test's session — every
    test ends up asserting against the same session_id and the
    drained events from the previous test pollute the assertion.
    """
    import flightdeck_sensor as fd
    fd.teardown()
    os.environ["AGENT_FLAVOR"] = flavor
    fd.init(
        server=INGESTION_URL,
        token=API_TOKEN,
        agent_type=agent_type,
        capture_prompts=capture_prompts,
        quiet=True,
    )
    fd.patch(quiet=True)
    return fd._session  # type: ignore[attr-defined]


def mcp_reference_server_params():
    """Return ``StdioServerParameters`` for the in-tree reference MCP
    server (``tests/smoke/fixtures/mcp_reference_server.py``). Smoke
    tests across every framework spawn this same server over stdio
    so the dashboard's fixture-freeze contract and the wire schema
    stay aligned across languages — what the bare-SDK smoke sees is
    what the per-framework smokes also see, modulo each framework's
    adapter glue.

    Imports the mcp SDK lazily so smoke files for non-Python
    frameworks that don't import mcp directly still load on a clean
    venv (each test will skip via ``require_env`` or
    ``pytest.importorskip`` before reaching this helper).
    """
    import sys
    from mcp import StdioServerParameters
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
    )


def fetch_events_for_session(
    session_id: str,
    *,
    timeout_s: float = 15.0,
    poll_s: float = 0.5,
    expect_event_types: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Poll ``/v1/events?session_id=<uuid>`` until the expected events
    are visible.

    Returns the full events list once every type in
    ``expect_event_types`` is present (default: ``["session_start"]``
    — sensor's first emission), or whatever was observed by
    ``timeout_s``. Smoke tests pass higher-bar lists like
    ``["session_start", "post_call"]`` to wait for the streaming
    drain reconciliation event before asserting on its payload.

    Pre-fix the helper omitted ``from`` (the API marks ``from`` as
    required and 400s without it; the helper silently treated the
    400 as "no events yet" and returned []), and returned on the
    first non-empty read so callers that needed a specific
    event_type would race the drain on streaming tests. Both
    fixes shipped together.
    """
    if httpx is None:  # pragma: no cover
        return []
    expect = set(expect_event_types or ["session_start"])
    deadline = time.monotonic() + timeout_s
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        r = httpx.get(
            f"{API_URL}/v1/events",
            params={
                "session_id": session_id,
                "from": "2020-01-01T00:00:00Z",
                "limit": 100,
            },
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            timeout=5.0,
        )
        if r.status_code == 200:
            last = r.json().get("events", [])
            seen = {e.get("event_type") for e in last}
            if expect.issubset(seen):
                return last
        time.sleep(poll_s)
    return last
