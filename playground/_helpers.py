"""Playground helpers -- three functions.

Anything beyond init_sensor / assert_event_landed / print_result
stops being a playground and starts becoming a framework.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Any

import flightdeck_sensor


def init_sensor(
    session_id: str,
    *,
    flavor: str,
    agent_type: str = "coding",
    capture_prompts: bool = True,
    **overrides: Any,
) -> None:
    """flightdeck_sensor.init() with playground defaults.

    Required keyword-only ``flavor`` -- every playground script must
    declare a meaningful agent identity (CLAUDE.md rule 40a / sub-rule
    A). No default here because "one size fits all" would re-introduce
    the ``flavor="unknown"`` failure mode this signature exists to
    prevent. Convention: ``playground-<script-name>``.

    ``agent_type`` defaults to ``"coding"`` -- playground scripts are
    developer-facing smoke, matching the D114 vocabulary for
    developer-driven sessions. Override only if the script is
    exercising a non-coding persona on purpose.

    ``capture_prompts`` defaults to ``True`` (sub-rule B). Playground
    is the highest-fidelity smoke surface; it exists to demonstrate
    what the sensor can see, not to validate a minimal happy path.
    ``09_capture.py`` overrides this to exercise the on/off matrix
    explicitly -- otherwise every script captures maximally.

    ``flavor`` propagates via the ``AGENT_FLAVOR`` env var so the
    wire-level ``flavor`` column on sessions carries the playground
    script's intent. ``agent_type`` is passed as a kwarg directly to
    ``flightdeck_sensor.init``.

    Env overrides: FLIGHTDECK_SERVER (default http://localhost:4000/ingest),
    FLIGHTDECK_TOKEN (default tok_dev), FLIGHTDECK_API_URL (derived).

    KI20: the sensor's ``init()`` now normalises a plugin-style
    ``FLIGHTDECK_SERVER`` (no ``/ingest`` suffix) on its own, so this
    helper no longer needs to. We still compute ``api_url`` by replacing
    ``/ingest`` with ``/api`` for the default case so the
    ``assert_event_landed`` caller in this module has a base URL to
    hit without another env-var override.
    """
    server = os.environ.get("FLIGHTDECK_SERVER", "http://localhost:4000/ingest")
    api_url = os.environ.get("FLIGHTDECK_API_URL") or (
        server.rstrip("/").replace("/ingest", "/api")
        if "/ingest" in server
        else server.rstrip("/") + "/api"
    )

    # Wire-level ``flavor`` column propagation. Sensor reads
    # AGENT_FLAVOR from env; setting it explicitly guarantees the
    # helper's flavor wins even if a caller has stale values in
    # their shell.
    os.environ["AGENT_FLAVOR"] = flavor

    flightdeck_sensor.init(
        server=server,
        token=os.environ.get("FLIGHTDECK_TOKEN", "tok_dev"),
        api_url=api_url,
        session_id=session_id,
        capture_prompts=capture_prompts,
        agent_type=agent_type,
        quiet=True,
        **overrides,
    )


def assert_event_landed(session_id: str, event_type: str, timeout: float = 5.0,
                        model_contains: str | None = None) -> None:
    """Poll GET /api/v1/sessions/{id} until *event_type* appears.

    When *model_contains* is given, also require that at least one
    matching event's `model` field contains that substring -- use this
    to tie the assertion to a specific provider call rather than any
    event of the requested type.
    """
    api = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
    tok = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
    req = urllib.request.Request(f"{api}/v1/sessions/{session_id}",
        headers={"Authorization": f"Bearer {tok}"})
    deadline = time.monotonic() + timeout
    seen_types: set[str] = set()
    seen_models: set[str] = set()
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(req, timeout=2) as r:
                events = json.loads(r.read()).get("events", [])
            seen_types = {e["event_type"] for e in events}
            matches = [e for e in events if e.get("event_type") == event_type]
            seen_models = {e.get("model") or "" for e in matches}
            if event_type in seen_types and (
                model_contains is None
                or any(model_contains in (e.get("model") or "") for e in matches)
            ):
                return
        except Exception:
            pass
        time.sleep(0.3)
    detail = (f"with model containing {model_contains!r} (saw models {sorted(seen_models)})"
              if model_contains else f"(saw {sorted(seen_types) or 'nothing'})")
    raise AssertionError(
        f"event_type {event_type!r} never arrived for session {session_id} "
        f"within {timeout}s {detail}. Is the stack running at {api}?")


def print_result(label: str, passed: bool, duration_ms: int, details: str = "") -> None:
    """Standard result line: '  PASS  <label>  (1240ms)  <details>'."""
    tag = "PASS" if passed else "FAIL"
    print(f"  {tag}  {label}  ({duration_ms}ms){'  ' + details if details else ''}")
