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


def test_non_session_start_event_populates_context_when_session_start_was_empty() -> None:
    """A later event's context fills in sessions.context when session_start
    arrived with an empty dict.

    Plugin repro: Claude Code was started before ``make dev``. The
    plugin's SessionStart hook POSTed a session_start with the full
    runtime context but the stack was down, so the POST failed; the
    plugin's on-disk ``started-*.txt`` marker was written anyway so no
    retry ever happens. The user's first UserPromptSubmit lands later
    once the stack is up -- pre-fix that event carried no context and
    the session row stayed with NULL context forever.

    Fix path exercised here:
      1. POST session_start with ``context={}`` to mimic the (very
         different) case where collectContext returned empty but the
         POST itself succeeded. The row now has context=``{}`` (the
         "I tried, there was nothing" sentinel).
      2. POST a pre_call carrying real context. handleSessionGuard
         calls UpgradeSessionContext; NULLIF treats ``{}`` as enrichable
         and the COALESCE promotes the pre_call's context onto the row.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ctx-upgrade-{uuid.uuid4().hex[:6]}"

    # Step 1: session_start with an explicitly empty context.
    post_event(make_event(sid, flavor, "session_start", context={}))
    wait_for_session_in_fleet(sid, timeout=5.0)

    # Step 2: non-session_start event carrying real context.
    real_ctx = dict(DEFAULT_TEST_CONTEXT)
    real_ctx["hostname"] = "Omri-PC"
    real_ctx["os"] = "Windows"
    post_event(make_event(sid, flavor, "pre_call", context=real_ctx))

    def _has_real_context() -> bool:
        ctx = get_session_detail(sid).get("session", {}).get("context") or {}
        return ctx.get("hostname") == "Omri-PC" and ctx.get("os") == "Windows"

    wait_until(
        _has_real_context,
        timeout=10,
        msg=f"pre_call context never upgraded empty session_start context for {sid}",
    )

    ctx = get_session_detail(sid).get("session", {}).get("context") or {}
    assert ctx.get("hostname") == "Omri-PC", (
        f"expected hostname='Omri-PC' after upgrade, got {ctx.get('hostname')!r}"
    )
    assert ctx.get("os") == "Windows", (
        f"expected os='Windows' after upgrade, got {ctx.get('os')!r}"
    )


def test_non_session_start_event_populates_context_on_lazy_created_session() -> None:
    """An event on a never-before-seen session_id that carries context
    gets context on the lazy-created row.

    This is the live-production repro: the plugin's session_start POST
    failed (e.g. connection refused at startup), the on-disk dedup
    marker blocks a retry, and the first event that actually reaches
    the server is a pre_call or tool_call. D106 lazy-creates the row
    with context=NULL; UpgradeSessionContext then promotes the event's
    context onto that fresh row.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-ctx-lazy-{uuid.uuid4().hex[:6]}"

    ctx_on_wire = dict(DEFAULT_TEST_CONTEXT)
    ctx_on_wire["hostname"] = "Omri-PC"
    ctx_on_wire["os"] = "Windows"

    # No session_start. First event is a pre_call carrying context.
    post_event(make_event(sid, flavor, "pre_call", context=ctx_on_wire))
    wait_for_session_in_fleet(sid, timeout=10.0)

    def _has_context() -> bool:
        ctx = get_session_detail(sid).get("session", {}).get("context") or {}
        return ctx.get("hostname") == "Omri-PC"

    wait_until(
        _has_context,
        timeout=10,
        msg=f"lazy-created session {sid} never picked up pre_call context",
    )

    ctx = get_session_detail(sid).get("session", {}).get("context") or {}
    assert ctx.get("os") == "Windows", (
        f"expected os='Windows' on lazy-created row after upgrade, got {ctx.get('os')!r}"
    )
