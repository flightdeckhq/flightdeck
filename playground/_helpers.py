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


def init_sensor(session_id: str, **overrides: Any) -> None:
    """flightdeck_sensor.init() with playground defaults.

    Env overrides: FLIGHTDECK_SERVER (default http://localhost:4000/ingest),
    FLIGHTDECK_TOKEN (default tok_dev), FLIGHTDECK_API_URL (derived).
    A plugin-style FLIGHTDECK_SERVER (no /ingest suffix) is normalised
    so the Claude Code plugin's env doesn't break the sensor.
    """
    server = os.environ.get("FLIGHTDECK_SERVER", "http://localhost:4000/ingest")
    if "/ingest" not in server:
        server = server.rstrip("/") + "/ingest"
        os.environ["FLIGHTDECK_SERVER"] = server
    api_url = os.environ.get("FLIGHTDECK_API_URL") or server.replace("/ingest", "/api")
    flightdeck_sensor.init(
        server=server, token=os.environ.get("FLIGHTDECK_TOKEN", "tok_dev"),
        api_url=api_url, session_id=session_id, quiet=True, **overrides,
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
