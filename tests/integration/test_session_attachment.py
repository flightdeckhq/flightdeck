"""Integration tests for D094 session attachment.

Covers the full end-to-end loop: sensor-facing POST /v1/events
envelope, Postgres state under session_attachments, worker
re-processing of session_start on a terminal row, and the
GET /v1/sessions/:id response shape consumers rely on.

Requires the live stack (`make dev`).
"""

from __future__ import annotations

import logging
import uuid

import pytest

from .conftest import (
    get_session_detail,
    make_event,
    post_event,
    wait_for_state,
    wait_until,
)


def _new_session_id() -> str:
    """Produce a unique UUID v4 per test call."""
    return str(uuid.uuid4())


def _start(session_id: str, flavor: str) -> dict:
    """POST a session_start event and return the envelope."""
    return post_event(make_event(session_id, flavor, "session_start"))


def _end(session_id: str, flavor: str) -> None:
    post_event(make_event(session_id, flavor, "session_end"))


def test_session_attachment_new() -> None:
    """First session_start for a brand-new UUID returns attached=false
    and the session exists as active. No session_attachments rows."""
    sid = _new_session_id()
    flavor = "attach-new-flavor"

    resp = _start(sid, flavor)
    assert resp["attached"] is False

    detail = wait_for_state(sid, "active", timeout=10.0)
    assert detail["session"]["state"] == "active"
    # attachments field is present and empty for a fresh session.
    assert detail.get("attachments") == []


def test_session_attachment_reattach() -> None:
    """After session_end, re-posting session_start with the same UUID
    returns attached=true, session_attachments has one row, and the
    session state is back to active."""
    sid = _new_session_id()
    flavor = "attach-reattach-flavor"

    # First run.
    resp1 = _start(sid, flavor)
    assert resp1["attached"] is False
    wait_for_state(sid, "active", timeout=10.0)

    # Close it and wait for the worker to commit closed.
    _end(sid, flavor)
    wait_for_state(sid, "closed", timeout=10.0)

    # Re-attach.
    resp2 = _start(sid, flavor)
    assert resp2["attached"] is True

    # State must flip back to active (ingestion-side revive).
    detail = wait_for_state(sid, "active", timeout=10.0)
    assert len(detail["attachments"]) == 1, (
        f"expected 1 attachment row, got {detail['attachments']}"
    )


def test_session_attachment_multiple() -> None:
    """Three start/end cycles → two attachment rows (the first start
    is the initial create, not an attach). Timestamps are chronological
    and all surface through the API."""
    sid = _new_session_id()
    flavor = "attach-multi-flavor"

    # Three executions: create + attach + attach.
    _start(sid, flavor)
    wait_for_state(sid, "active", timeout=10.0)
    _end(sid, flavor)
    wait_for_state(sid, "closed", timeout=10.0)

    resp2 = _start(sid, flavor)
    assert resp2["attached"] is True
    wait_for_state(sid, "active", timeout=10.0)
    _end(sid, flavor)
    wait_for_state(sid, "closed", timeout=10.0)

    resp3 = _start(sid, flavor)
    assert resp3["attached"] is True
    wait_for_state(sid, "active", timeout=10.0)

    # Poll until both attachment rows are visible -- ingestion writes
    # synchronously but there's still a small DB visibility window.
    def _two_attachments() -> bool:
        detail = get_session_detail(sid)
        return len(detail.get("attachments", [])) == 2

    wait_until(
        _two_attachments,
        timeout=5.0,
        msg=f"expected 2 attachments for {sid}",
    )

    detail = get_session_detail(sid)
    attachments = detail["attachments"]
    assert len(attachments) == 2
    # Chronological: first attachment strictly before second.
    assert attachments[0] < attachments[1], attachments


def test_session_attachment_invalid_uuid_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Sensor init() with a non-UUID session_id must emit the
    invalid-UUID warning and fall back to auto-generation rather
    than try to post the bad string.

    Runs in-process (same as the sensor unit tests) -- it never hits
    the live stack because it exercises a pure sensor-side guard. The
    test sits under tests/integration/ to colocate it with the other
    attachment tests so the `-k attachment` selector picks up every
    piece of D094 coverage at once.
    """
    import flightdeck_sensor

    flightdeck_sensor.teardown()
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        try:
            flightdeck_sensor.init(
                server="http://127.0.0.1:1",
                token="tok",
                session_id="not-a-uuid",
                quiet=True,
            )
            assert flightdeck_sensor._session is not None
            fallback_sid = flightdeck_sensor._session.config.session_id
        finally:
            flightdeck_sensor.teardown()

    # Warning text must match D094 exactly.
    assert any(
        "Custom session_id 'not-a-uuid' is not a valid UUID" in r.message
        for r in caplog.records
    )
    # Fallback must be a valid UUID (not the bad string).
    uuid.UUID(fallback_sid)
    assert fallback_sid != "not-a-uuid"
    # And it must not briefly hold the bad string in between: the
    # warning branch zeroes resolved_session_id before the factory
    # runs, so the only possible final value is the generated UUID.
    # Re-scan log to ensure the "Custom session_id provided" line
    # did NOT fire for the bad string.
    assert not any(
        "Custom session_id provided: 'not-a-uuid'" in r.message
        for r in caplog.records
    )


# Avoid leaving stale docker state: every test above opens and closes
# session rows explicitly. `tests/integration/conftest.py::_session_lifecycle`
# still posts a best-effort session_end for any session_id seen, so
# the _end() calls above are idempotent.
