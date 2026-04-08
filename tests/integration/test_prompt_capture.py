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
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _get_event_content(event_id: str) -> dict | None:
    """GET /api/v1/events/:id/content. Returns None on 404."""
    try:
        req = urllib.request.Request(f"{API_URL}/v1/events/{event_id}/content")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _query_event_content_rows(event_id: str) -> int:
    """Query event_content table directly for row count."""
    import subprocess
    sql = f"SELECT COUNT(*) FROM event_content WHERE event_id = '{event_id}'::uuid"
    result = subprocess.run(
        ["docker", "exec", "docker-postgres-1", "psql", "-U", "flightdeck",
         "-d", "flightdeck", "-t", "-c", sql],
        capture_output=True, text=True, timeout=10,
    )
    return int(result.stdout.strip() or "0")


def _get_event_ids(session_id: str) -> list[str]:
    """Get event IDs for a session."""
    import subprocess
    sql = (
        f"SELECT COALESCE(json_agg(id::text), '[]'::json) FROM events "
        f"WHERE session_id = '{session_id}'::uuid AND event_type = 'post_call'"
    )
    result = subprocess.run(
        ["docker", "exec", "docker-postgres-1", "psql", "-U", "flightdeck",
         "-d", "flightdeck", "-t", "-c", sql],
        capture_output=True, text=True, timeout=10,
    )
    raw = result.stdout.strip()
    if not raw or raw == "null":
        return []
    return json.loads(raw)


def test_capture_off_no_event_content_row() -> None:
    """When capture is off, no rows in event_content table."""
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


def test_capture_on_stores_content() -> None:
    """When capture is on, event_content row is created."""
    sid = str(uuid.uuid4())
    flavor = f"capture-on-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )

    # Post event with content
    content = {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "system": "You are helpful",
        "messages": [{"role": "user", "content": "Hello"}],
        "tools": None,
        "response": {"model": "claude-sonnet-4-6", "content": [{"text": "Hi"}]},
    }
    post_event(make_event(
        sid, flavor, "post_call",
        tokens_total=100,
        has_content=True,
        content=content,
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )

    event_ids = _get_event_ids(sid)
    post_call_ids = event_ids
    assert len(post_call_ids) > 0, f"no post_call events for session {sid}"

    # Check event_content table
    rows = _query_event_content_rows(post_call_ids[0])
    assert rows == 1, (
        f"expected 1 event_content row when capture is on, got {rows}"
    )


def test_get_content_endpoint_returns_200() -> None:
    """GET /v1/events/:id/content returns 200 when content exists."""
    sid = str(uuid.uuid4())
    flavor = f"capture-get-{uuid.uuid4().hex[:6]}"

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
        "response": {"choices": [{"message": {"role": "assistant", "content": "Hi"}}]},
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

    result = _get_event_content(event_ids[0])
    assert result is not None, (
        f"expected 200 with content, got 404 for event {event_ids[0]}"
    )
    assert result.get("provider") == "openai", (
        f"expected provider=openai, got {result.get('provider')}"
    )


def test_get_content_returns_404_when_off() -> None:
    """GET /v1/events/:id/content returns 404 when no content."""
    sid = str(uuid.uuid4())
    flavor = f"capture-404-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )

    # Post event without content
    post_event(make_event(sid, flavor, "post_call", tokens_total=50))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )

    event_ids = _get_event_ids(sid)
    assert len(event_ids) > 0, f"no post_call events for session {sid}"

    result = _get_event_content(event_ids[0])
    assert result is None, (
        f"expected 404 when capture is off, got content: {result}"
    )
