"""Integration tests for runtime context round-trip.

The sensor collects a runtime ``context`` dict (os, hostname,
python_version, git_*, orchestration, frameworks ...) at ``init()``
time and attaches it to the ``session_start`` event payload. The
control plane stores it once in ``sessions.context`` (JSONB) and
exposes it via:

  * ``GET /v1/sessions/{id}``  -> session.context
  * ``GET /v1/sessions``       -> session-list-item.context

These tests POST a synthetic context (the conftest's
``DEFAULT_TEST_CONTEXT`` is auto-attached to every ``session_start``)
and verify that both endpoints return it intact. Requires
``make dev`` to be running.
"""

from __future__ import annotations

import json
import urllib.request
import uuid

from .conftest import (
    API_URL,
    DEFAULT_TEST_CONTEXT,
    auth_headers,
    get_session_detail,
    make_event,
    post_event,
    wait_for_session_in_fleet,
    wait_until,
)


def _get_session_from_list(session_id: str) -> dict | None:
    """Fetch a single session from the paginated /v1/sessions list."""
    url = f"{API_URL}/v1/sessions?session_id={session_id}&limit=10"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())
    for s in data.get("sessions", []):
        if s.get("session_id") == session_id:
            return s  # type: ignore[no-any-return]
    return None


def test_context_round_trips_via_session_detail() -> None:
    """POST session_start with context -> GET /v1/sessions/{id} returns it."""
    sid = str(uuid.uuid4())
    flavor = f"test-ctx-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    detail = get_session_detail(sid)
    ctx = detail.get("session", {}).get("context") or {}
    for key, expected in DEFAULT_TEST_CONTEXT.items():
        assert ctx.get(key) == expected, (
            f"session detail context[{key}]: expected {expected!r}, "
            f"got {ctx.get(key)!r} (full ctx={ctx})"
        )


def test_context_round_trips_via_sessions_list() -> None:
    """POST session_start with context -> GET /v1/sessions includes it."""
    sid = str(uuid.uuid4())
    flavor = f"test-ctx-list-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    item: dict | None = None

    def _found() -> bool:
        nonlocal item
        item = _get_session_from_list(sid)
        return item is not None and bool(item.get("context"))

    wait_until(
        _found,
        timeout=10,
        msg=f"session {sid} did not appear in /v1/sessions with context",
    )

    assert item is not None
    ctx = item.get("context") or {}
    for key in ("os", "hostname", "python_version", "git_branch", "orchestration"):
        assert ctx.get(key) == DEFAULT_TEST_CONTEXT[key], (
            f"sessions-list context[{key}]: expected "
            f"{DEFAULT_TEST_CONTEXT[key]!r}, got {ctx.get(key)!r}"
        )


def test_context_not_overwritten_by_later_event() -> None:
    """Later events in the same session must not change sessions.context.

    ARCHITECTURE.md guarantees the control plane stores context once
    on session_start and never updates it on conflict. Verify that a
    second session_start with a different context payload leaves the
    original intact.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ctx-immut-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # Second session_start with a deliberately different context.
    other = dict(DEFAULT_TEST_CONTEXT)
    other["hostname"] = "should-be-ignored"
    other["os"] = "Plan9"
    post_event(make_event(sid, flavor, "session_start", context=other))

    # Give the worker a moment to (not) update.
    def _has_original() -> bool:
        ctx = get_session_detail(sid).get("session", {}).get("context") or {}
        return ctx.get("hostname") == DEFAULT_TEST_CONTEXT["hostname"]

    wait_until(
        _has_original,
        timeout=5,
        msg="original context was overwritten by later session_start",
    )

    ctx = get_session_detail(sid).get("session", {}).get("context") or {}
    assert ctx.get("os") == DEFAULT_TEST_CONTEXT["os"], (
        f"context.os should not have been overwritten, got {ctx.get('os')!r}"
    )
