"""Integration tests for prompt capture.

Tests content storage when capture is on/off, and GET /v1/events/:id/content.
Requires `make dev` to be running.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid

import pytest

from .conftest import (
    get_session_event_count,
    API_URL,
    INGESTION_URL,
    TOKEN,
    auth_headers,
    exec_sql,
    make_event,
    post_event,
    query_rows,
    session_exists_in_fleet,
    wait_until,
    worker_paused,
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
    rows = query_rows(
        "SELECT id FROM events "
        "WHERE session_id = :'sid'::uuid AND event_type = 'post_call'",
        sid=session_id,
    )
    return [str(row["id"]) for row in rows]


def _has_content(event_id: str) -> bool:
    """The stored event row's has_content flag."""
    (row,) = query_rows(
        "SELECT has_content FROM events WHERE id = :'eid'::uuid", eid=event_id
    )
    return bool(row["has_content"])


def test_capture_off_no_row_and_404() -> None:
    """capture=off ⇒ zero event_content rows AND GET /events/:id/content
    returns 404. Merged from
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
    assert rows == 0, f"expected 0 event_content rows when capture is off, got {rows}"

    # GET /v1/events/:id/content must 404 when there is no content row
    result = _get_event_content(event_ids[0])
    assert result is None, f"expected 404 when capture is off, got content: {result}"


def test_capture_on_writes_row_and_serves_content() -> None:
    """capture=on ⇒ exactly one event_content row AND GET
    /events/:id/content returns 200 with the original content fields.
    Merged from test_capture_on_stores_content
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
            "choices": [{"message": {"role": "assistant", "content": "Hi"}}],
        },
    }
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            tokens_total=50,
            has_content=True,
            content=content,
        )
    )
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )

    event_ids = _get_event_ids(sid)
    assert len(event_ids) > 0, f"no post_call events for session {sid}"

    rows = _query_event_content_rows(event_ids[0])
    assert rows == 1, f"expected 1 event_content row when capture is on, got {rows}"

    result = _get_event_content(event_ids[0])
    assert result is not None, (
        f"expected 200 with content, got 404 for event {event_ids[0]}"
    )
    assert result.get("provider") == "openai", (
        f"expected provider=openai, got {result.get('provider')}"
    )


def test_sensor_client_lands_an_oversized_call_with_its_tokens() -> None:
    """A post_call whose captured content is over the server's 1 MiB
    body limit, sent through the sensor's own client, lands with its
    token counts and the content cut to fit, ending in the marker."""
    from flightdeck_sensor.transport.client import ControlPlaneClient

    sid = str(uuid.uuid4())
    flavor = f"capture-big-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    prompt = "lorem ipsum <tag> & " * 110_000  # about 2.2 MB
    client = ControlPlaneClient(INGESTION_URL, TOKEN)
    client.post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            tokens_input=550_000,
            tokens_total=550_010,
            has_content=True,
            content={
                "provider": "anthropic",
                "model": "claude-sonnet-4-5",
                "system": None,
                "messages": [{"role": "user", "content": prompt}],
                "tools": None,
                "response": {"content": [{"type": "text", "text": "ok"}]},
            },
        )
    )
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"oversized post_call did not land for session {sid}",
    )
    [event_id] = _get_event_ids(sid)
    tokens = exec_sql(
        "SELECT tokens_input FROM events WHERE id = :'eid'::uuid", eid=event_id
    )
    assert tokens == "550000"
    result = _get_event_content(event_id)
    assert result is not None
    stored = result["messages"][0]["content"]
    assert stored.startswith("lorem ipsum <tag> & ")
    assert stored.endswith(f"of {len(prompt)} bytes to fit the event size limit]")
    assert result["response"] == {"content": [{"type": "text", "text": "ok"}]}


def _post_call_with_content(content: dict) -> tuple[str, str]:
    """Start a capture-on session, post one post_call carrying content,
    wait for it to be stored and return its session and event ids."""
    sid = str(uuid.uuid4())
    flavor = f"capture-content-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    post_event(
        make_event(
            sid,
            flavor,
            "post_call",
            tokens_total=50,
            has_content=True,
            content=content,
        )
    )
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )
    event_ids = _get_event_ids(sid)
    assert len(event_ids) == 1, f"expected one post_call, got {event_ids}"
    return sid, event_ids[0]


def test_content_the_database_rejects_lands_the_event_without_content() -> None:
    """Content Postgres refuses must not leave an event that claims
    content: the worker writes the event and its content in one
    transaction, and when the content row is rejected it stores the
    event alone with has_content false, so GET /events/:id/content is a
    plain 404. A content blob without a response breaks the content
    row's NOT NULL constraint; ingestion does not check the blob's
    shape, so it reaches the worker's fallback as sent.
    """
    # This relies on ingestion not validating the content blob's shape:
    # the missing "response" violates event_content.response NOT NULL
    # (SQLSTATE 23502) only at the worker. If ingestion starts validating
    # the shape, this post answers 400 and the fallback needs another way
    # in (the NUL byte that used to reach it is now replaced at
    # ingestion; the writer's own test still covers that case).
    _, eid = _post_call_with_content(
        {
            "provider": "openai",
            "model": "gpt-4o",
            "system": "be brief",
            "messages": [{"role": "user", "content": "Hello"}],
            "tools": None,
        }
    )
    assert not _has_content(eid), "event still claims content"
    assert _query_event_content_rows(eid) == 0
    assert _get_event_content(eid) is None


def test_nul_in_content_is_stored_as_the_replacement_character() -> None:
    """A NUL (U+0000) in captured content is valid JSON that Postgres
    cannot store; ingestion replaces it with U+FFFD before the event
    reaches the worker, so the content is stored, the event claims it
    and the content endpoint serves it (200). An unpaired surrogate
    escape, which Postgres refuses too, is replaced the same way.
    """
    sid = str(uuid.uuid4())
    flavor = f"capture-nul-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    # json.dumps writes U+0000 as the escape; the lone surrogate is
    # spliced in as the escape a client would send.
    event = make_event(
        sid,
        flavor,
        "post_call",
        tokens_total=50,
        has_content=True,
        content={
            "provider": "openai",
            "model": "gpt-4o",
            "system": "before\u0000after",
            "messages": [{"role": "user", "content": "Hello LONE"}],
            "tools": None,
            "response": {"choices": []},
        },
    )
    body = json.dumps(event).replace("LONE", "\\ud800")
    assert "\\u0000" in body and "\\ud800" in body
    _post_raw_event(body)
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )
    event_ids = _get_event_ids(sid)
    assert len(event_ids) == 1, f"expected one post_call, got {event_ids}"
    eid = event_ids[0]
    assert _has_content(eid), "event does not claim its content"
    assert _query_event_content_rows(eid) == 1
    result = _get_event_content(eid)
    assert result is not None, "content endpoint answered 404"
    assert result["system_prompt"] == "before\ufffdafter", result["system_prompt"]
    assert result["messages"] == [{"role": "user", "content": "Hello \ufffd"}], result["messages"]


def _post_raw_event(body: str) -> None:
    """POST /v1/events with a body as written, for escapes json.dumps
    would not produce."""
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/events",
        data=body.encode(),
        method="POST",
        headers={**auth_headers(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200, resp.status


def test_has_content_without_a_content_blob_is_stored_as_no_content() -> None:
    """An event that sets has_content but carries no content blob has
    nothing for /content to serve, so the worker stores it with
    has_content false instead of leaving it claiming content forever.
    """
    sid = str(uuid.uuid4())
    flavor = f"capture-empty-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )
    post_event(make_event(sid, flavor, "post_call", tokens_total=50, has_content=True))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call event not processed for session {sid}",
    )

    event_ids = _get_event_ids(sid)
    assert len(event_ids) == 1, f"expected one post_call, got {event_ids}"
    assert not _has_content(event_ids[0]), "event claims content it never sent"
    assert _get_event_content(event_ids[0]) is None


# Enough sessions that the worker's lanes drain a backlog of starts and
# capture-on calls together many times over.
BACKLOG_SESSIONS = 60
BACKLOG_TIMEOUT_SECS = 30.0


@pytest.mark.exclusive
def test_a_backlog_of_capture_on_sessions_keeps_every_calls_content() -> None:
    """Queue each session's session_start (capture on) and a post_call
    with content behind a paused worker, then let it drain the backlog.
    A session's events are processed in order, so each post_call finds
    its session's capture posture and keeps its content; a pool that
    processed them concurrently dropped some calls' content as if
    capture were off.
    """
    flavor = f"capture-backlog-{uuid.uuid4().hex[:6]}"
    sids = [str(uuid.uuid4()) for _ in range(BACKLOG_SESSIONS)]
    content = {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "system": None,
        "messages": [{"role": "user", "content": "backlog"}],
        "tools": None,
        "response": {"content": [{"type": "text", "text": "ok"}]},
    }
    with worker_paused():
        for sid in sids:
            post_event(make_event(sid, flavor, "session_start"))
            post_event(
                make_event(sid, flavor, "post_call", tokens_total=5, has_content=True, content=content)
            )

    def stored() -> int:
        return int(
            exec_sql(
                "SELECT COUNT(*) FROM events WHERE flavor = :'flavor' AND event_type = 'post_call'",
                flavor=flavor,
            )
            or "0"
        )

    wait_until(
        lambda: stored() == len(sids),
        timeout=BACKLOG_TIMEOUT_SECS,
        msg=f"not every post_call of {flavor} was stored",
    )
    with_content = int(
        exec_sql(
            "SELECT COUNT(*) FROM events e JOIN event_content c ON c.event_id = e.id "
            "WHERE e.flavor = :'flavor' AND e.event_type = 'post_call' AND e.has_content",
            flavor=flavor,
        )
        or "0"
    )
    assert with_content == len(sids), f"{len(sids) - with_content} of {len(sids)} calls lost their content"


@pytest.mark.exclusive
def test_content_published_before_its_session_start_keeps_its_content() -> None:
    """Queue each session's content-bearing post_call ahead of its
    session_start (capture on) behind a paused worker, then let it drain.
    This is the order a second worker replica can process them in: the
    replicas share one durable consumer, so a session's start can wait in
    one replica's lane while another holds its content. The call finds no
    capture posture, is redelivered after a second instead of landing on
    a lazily created row, and keeps its content once the start has
    stored the posture. Holds with one worker or several.
    """
    flavor = f"capture-before-start-{uuid.uuid4().hex[:6]}"
    sids = [str(uuid.uuid4()) for _ in range(BACKLOG_SESSIONS)]
    content = {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "system": None,
        "messages": [{"role": "user", "content": "before its start"}],
        "tools": None,
        "response": {"content": [{"type": "text", "text": "ok"}]},
    }
    with worker_paused():
        for sid in sids:
            post_event(
                make_event(sid, flavor, "post_call", tokens_total=5, has_content=True, content=content)
            )
        for sid in sids:
            post_event(make_event(sid, flavor, "session_start"))

    def stored() -> int:
        return int(
            exec_sql(
                "SELECT COUNT(*) FROM events WHERE flavor = :'flavor' AND event_type = 'post_call'",
                flavor=flavor,
            )
            or "0"
        )

    wait_until(
        lambda: stored() == len(sids),
        timeout=BACKLOG_TIMEOUT_SECS,
        msg=f"not every post_call of {flavor} was stored",
    )
    with_content = int(
        exec_sql(
            "SELECT COUNT(*) FROM events e JOIN event_content c ON c.event_id = e.id "
            "WHERE e.flavor = :'flavor' AND e.event_type = 'post_call' AND e.has_content",
            flavor=flavor,
        )
        or "0"
    )
    assert with_content == len(sids), f"{len(sids) - with_content} of {len(sids)} calls lost their content"
    no_posture = int(
        exec_sql(
            "SELECT COUNT(*) FROM sessions WHERE flavor = :'flavor' AND capture_prompts IS NOT TRUE",
            flavor=flavor,
        )
        or "0"
    )
    assert no_posture == 0, f"{no_posture} sessions lack the capture posture their start sent"
