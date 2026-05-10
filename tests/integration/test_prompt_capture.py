"""Integration tests for prompt capture.

Tests content storage when capture is on/off, and GET /v1/events/:id/content.
Requires `make dev` to be running.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid

from .conftest import (
    get_session_event_count,
    API_URL,
    auth_headers,
    exec_sql,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _get_event_content(event_id: str) -> dict | None:
    """GET /api/v1/events/:id/content. Returns None on 404."""
    try:
        req = urllib.request.Request(
            f"{API_URL}/v1/events/{event_id}/content",
            headers=auth_headers(),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _query_event_content_rows(event_id: str) -> int:
    """Query event_content table directly for row count."""
    raw = exec_sql(
        "SELECT COUNT(*) FROM event_content WHERE event_id = :'eid'::uuid",
        eid=event_id,
    )
    return int(raw or "0")


def _get_event_ids(session_id: str) -> list[str]:
    """Get event IDs for a session."""
    raw = exec_sql(
        "SELECT COALESCE(json_agg(id::text), '[]'::json) FROM events "
        "WHERE session_id = :'sid'::uuid AND event_type = 'post_call'",
        sid=session_id,
    )
    if not raw or raw == "null":
        return []
    return json.loads(raw)


def test_capture_off_no_row_and_404() -> None:
    """capture=off ⇒ zero event_content rows AND GET /events/:id/content
    returns 404. Phase 4.5 audit Task 1: merged from
    test_capture_off_no_event_content_row + test_get_content_returns_404_when_off
    -- both tested the capture-off path with the same setup.
    """
    sid = str(uuid.uuid4())
    flavor = f"capture-off-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )

    # Post event without content (capture off)
    post_event(make_event(sid, flavor, "post_call", tokens_total=100))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )

    event_ids = _get_event_ids(sid)
    assert len(event_ids) > 0, f"no events found for session {sid}"

    rows = _query_event_content_rows(event_ids[0])
    assert rows == 0, (
        f"expected 0 event_content rows when capture is off, got {rows}"
    )

    # GET /v1/events/:id/content must 404 when there is no content row
    result = _get_event_content(event_ids[0])
    assert result is None, (
        f"expected 404 when capture is off, got content: {result}"
    )


def test_capture_on_writes_row_and_serves_content() -> None:
    """capture=on ⇒ exactly one event_content row AND GET
    /events/:id/content returns 200 with the original content fields.
    Phase 4.5 audit Task 1: merged from test_capture_on_stores_content
    + test_get_content_endpoint_returns_200 -- both tested the
    capture-on path with the same setup, the second one only added
    the GET round-trip on top.
    """
    sid = str(uuid.uuid4())
    flavor = f"capture-on-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )

    content = {
        "provider": "openai",
        "model": "gpt-4o",
        "system": None,
        "messages": [{"role": "user", "content": "Hello"}],
        "tools": None,
        "response": {
            "choices": [
                {"message": {"role": "assistant", "content": "Hi"}}
            ],
        },
    }
    post_event(make_event(
        sid, flavor, "post_call",
        tokens_total=50,
        has_content=True,
        content=content,
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )

    event_ids = _get_event_ids(sid)
    assert len(event_ids) > 0, f"no post_call events for session {sid}"

    rows = _query_event_content_rows(event_ids[0])
    assert rows == 1, (
        f"expected 1 event_content row when capture is on, got {rows}"
    )

    result = _get_event_content(event_ids[0])
    assert result is not None, (
        f"expected 200 with content, got 404 for event {event_ids[0]}"
    )
    assert result.get("provider") == "openai", (
        f"expected provider=openai, got {result.get('provider')}"
    )
