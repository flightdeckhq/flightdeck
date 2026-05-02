"""D126 § 6 cross-agent message-capture integration tests.

Wire-seeded: hand-crafts sub-agent ``session_start`` / ``session_end``
event payloads, POSTs them through the real ingestion API, and
asserts they round-trip through NATS + worker + Postgres + the
Query API with the correct routing for both the inline and the
overflow paths.

Covers:

* **IT-XAGENT-1** — Inline path. Body ≤ 8 KiB rides on
  ``payload.incoming_message`` / ``payload.outgoing_message`` JSONB
  via the worker's BuildEventExtra projection. ``has_content=false``
  on the events row; no event_content row written;
  ``GET /v1/events/{id}/content`` returns 404.
* **IT-XAGENT-2** — Overflow path. Body > 8 KiB rides through the
  existing D119 event_content path with
  ``provider="flightdeck-subagent"`` discriminator. The wire stub on
  the payload field carries
  ``{has_content, content_bytes, captured_at}`` so the dashboard can
  render a size-aware "load full message" affordance before
  fetching. ``GET /v1/events/{id}/content`` returns the full body
  (round-trip byte-identical).
* **IT-XAGENT-3** — Capture-off. Sensor / plugin would drop the
  body at the boundary; this test simulates the capture-off shape
  by emitting an event with neither ``incoming_message`` nor
  ``payload.content``, and asserts no ``event_content`` row exists.

Methodology mirrors ``test_mcp_events.py`` IT-MCP-3 (``has_content``
+ overflow content round-trip) — the plumbing that makes the MCP
overflow path work is the same plumbing that makes the sub-agent
overflow path work, by design (D126 § 6 explicitly reuses the D119
contract).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def _wait_for_event_count(session_id: str, want: int, timeout: float = 10.0) -> None:
    wait_until(
        lambda: get_session_event_count(session_id) >= want,
        timeout=timeout,
        msg=f"expected >= {want} events for session {session_id}",
    )


def _fetch_session_events(session_id: str) -> list[dict[str, Any]]:
    detail = get_session_detail(session_id)
    return detail.get("events", [])


def _fetch_event_content(event_id: str) -> dict[str, Any] | None:
    """Fetch /v1/events/{id}/content; return the parsed body or
    None when the API returns 404.
    """
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers(),
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())  # type: ignore[no-any-return]
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def _post_subagent_session_start(
    *,
    parent_session_id: str,
    child_session_id: str,
    flavor: str,
    agent_role: str,
    incoming_message: dict[str, Any] | None = None,
    has_content: bool = False,
    content: dict[str, Any] | None = None,
) -> None:
    """Hand-craft and POST a sub-agent session_start payload. Mirrors
    the wire shape produced by sensor / plugin emit_subagent_session_start
    so the worker sees the same envelope it would see in production.
    """
    payload = make_event(
        child_session_id, flavor, "session_start",
        parent_session_id=parent_session_id,
        agent_role=agent_role,
    )
    if incoming_message is not None:
        payload["incoming_message"] = incoming_message
    if has_content:
        payload["has_content"] = True
        payload["content"] = content
    post_event(payload)


def _post_subagent_session_end(
    *,
    parent_session_id: str,
    child_session_id: str,
    flavor: str,
    agent_role: str,
    outgoing_message: dict[str, Any] | None = None,
    has_content: bool = False,
    content: dict[str, Any] | None = None,
) -> None:
    payload = make_event(
        child_session_id, flavor, "session_end",
        parent_session_id=parent_session_id,
        agent_role=agent_role,
    )
    if outgoing_message is not None:
        payload["outgoing_message"] = outgoing_message
    if has_content:
        payload["has_content"] = True
        payload["content"] = content
    post_event(payload)


# ----------------------------------------------------------------------
# IT-XAGENT-1 — inline path
# ----------------------------------------------------------------------


def test_inline_subagent_message_roundtrips_via_events_payload() -> None:
    """Body ≤ 8 KiB rides on events.payload via BuildEventExtra. The
    listing row carries ``has_content=false``; no event_content row
    is written; GET /v1/events/{id}/content returns 404.
    """
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())
    flavor = f"test-xagent-inline-{uuid.uuid4().hex[:6]}"

    # Parent session_start so the FK on the child resolves directly
    # rather than through UpsertParentStub (which has its own
    # coverage in workers tests).
    post_event(make_event(parent_sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(parent_sid),
        timeout=10,
        msg=f"parent session {parent_sid} did not appear",
    )

    inline_body = "a CrewAI task description that fits comfortably in 8 KiB"
    _post_subagent_session_start(
        parent_session_id=parent_sid,
        child_session_id=child_sid,
        flavor=flavor,
        agent_role="Researcher",
        incoming_message={
            "body": inline_body,
            "captured_at": "2026-05-02T20:00:00Z",
        },
    )
    wait_until(
        lambda: session_exists_in_fleet(child_sid),
        timeout=10,
        msg=f"child session {child_sid} did not appear",
    )
    _wait_for_event_count(child_sid, 1)

    events = _fetch_session_events(child_sid)
    assert len(events) == 1
    ss = events[0]
    assert ss["event_type"] == "session_start"
    assert ss["has_content"] is False, (
        f"inline path: has_content must stay false; got event={ss!r}"
    )
    payload = ss.get("payload") or {}
    assert payload.get("parent_session_id") == parent_sid
    assert payload.get("agent_role") == "Researcher"
    incoming = payload.get("incoming_message") or {}
    assert incoming.get("body") == inline_body, (
        f"inline body did not round-trip: got {incoming!r}"
    )
    assert "has_content" not in incoming, (
        "inline stub form must not carry has_content"
    )

    # Rule 37: capture is enabled but the body lives inline, so
    # /v1/events/{id}/content has no row to return — 404 is the
    # right "no event_content for this event" response.
    assert _fetch_event_content(ss["id"]) is None


# ----------------------------------------------------------------------
# IT-XAGENT-2 — overflow path
# ----------------------------------------------------------------------


def test_overflow_subagent_message_roundtrips_via_event_content() -> None:
    """Body > 8 KiB rides through event_content via the existing
    D119 path. The listing row carries ``has_content=true``; the
    payload field becomes a stub
    ``{has_content, content_bytes, captured_at}``;
    GET /v1/events/{id}/content returns the full body
    (byte-identical) wrapped in the PromptContent envelope with
    ``provider="flightdeck-subagent"``.
    """
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())
    flavor = f"test-xagent-overflow-{uuid.uuid4().hex[:6]}"

    post_event(make_event(parent_sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(parent_sid),
        timeout=10,
        msg=f"parent session {parent_sid} did not appear",
    )

    # 9 KiB of repeated text — comfortably over the 8 KiB inline
    # threshold but well under the 2 MiB hard cap.
    big_body = "x" * (9 * 1024)
    captured_at = "2026-05-02T20:00:00Z"
    body_bytes = len(json.dumps(big_body).encode("utf-8"))

    _post_subagent_session_start(
        parent_session_id=parent_sid,
        child_session_id=child_sid,
        flavor=flavor,
        agent_role="Researcher",
        incoming_message={
            "has_content": True,
            "content_bytes": body_bytes,
            "captured_at": captured_at,
        },
        has_content=True,
        content={
            "provider": "flightdeck-subagent",
            "model": "",
            "system": None,
            "messages": [],
            "tools": None,
            "response": {
                "direction": "incoming",
                "body": big_body,
                "captured_at": captured_at,
            },
            "input": None,
        },
    )
    wait_until(
        lambda: session_exists_in_fleet(child_sid),
        timeout=10,
        msg=f"child session {child_sid} did not appear",
    )
    _wait_for_event_count(child_sid, 1)

    events = _fetch_session_events(child_sid)
    assert len(events) == 1
    ss = events[0]
    assert ss["event_type"] == "session_start"
    assert ss["has_content"] is True, (
        f"overflow path: has_content must be true to drive the "
        f"InsertEventContent path; got event={ss!r}"
    )
    payload = ss.get("payload") or {}
    stub = payload.get("incoming_message") or {}
    assert stub.get("has_content") is True
    assert stub.get("content_bytes") == body_bytes
    assert stub.get("captured_at") == captured_at
    assert "body" not in stub, (
        "overflow stub must not carry body — it lives in event_content"
    )

    # /v1/events/{id}/content returns the PromptContent envelope.
    content = _fetch_event_content(ss["id"])
    assert content is not None, (
        "overflow path: event_content row should exist for has_content=true"
    )
    assert content.get("provider") == "flightdeck-subagent", (
        f"discriminator must let the dashboard pick the sub-agent renderer; "
        f"got {content!r}"
    )
    response = content.get("response") or {}
    assert response.get("direction") == "incoming"
    assert response.get("body") == big_body, (
        "captured body did not round-trip byte-identically through event_content"
    )


def test_overflow_outgoing_message_carries_outgoing_direction() -> None:
    """Same overflow path on session_end: response.direction tags
    the body as outgoing so the dashboard's MESSAGES sub-section
    labels it correctly.
    """
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())
    flavor = f"test-xagent-out-{uuid.uuid4().hex[:6]}"

    post_event(make_event(parent_sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(parent_sid),
        timeout=10,
        msg=f"parent session {parent_sid} did not appear",
    )
    # Child session_start so the session row exists before
    # session_end arrives.
    _post_subagent_session_start(
        parent_session_id=parent_sid,
        child_session_id=child_sid,
        flavor=flavor,
        agent_role="Researcher",
    )
    wait_until(
        lambda: session_exists_in_fleet(child_sid),
        timeout=10,
        msg=f"child session {child_sid} did not appear",
    )

    big_body = "y" * (9 * 1024)
    captured_at = "2026-05-02T20:00:01Z"
    body_bytes = len(json.dumps(big_body).encode("utf-8"))
    _post_subagent_session_end(
        parent_session_id=parent_sid,
        child_session_id=child_sid,
        flavor=flavor,
        agent_role="Researcher",
        outgoing_message={
            "has_content": True,
            "content_bytes": body_bytes,
            "captured_at": captured_at,
        },
        has_content=True,
        content={
            "provider": "flightdeck-subagent",
            "model": "",
            "system": None,
            "messages": [],
            "tools": None,
            "response": {
                "direction": "outgoing",
                "body": big_body,
                "captured_at": captured_at,
            },
            "input": None,
        },
    )
    _wait_for_event_count(child_sid, 2)

    events = _fetch_session_events(child_sid)
    se = next(e for e in events if e["event_type"] == "session_end")
    assert se["has_content"] is True
    content = _fetch_event_content(se["id"])
    assert content is not None
    response = content.get("response") or {}
    assert response.get("direction") == "outgoing"
    assert response.get("body") == big_body


# ----------------------------------------------------------------------
# IT-XAGENT-3 — capture-off
# ----------------------------------------------------------------------


def test_capture_off_subagent_message_lands_with_no_event_content() -> None:
    """Sensor / plugin with ``capture_prompts=False`` drop the body
    at the boundary; the wire shape carries no
    ``incoming_message`` / ``outgoing_message`` and no
    ``payload.content``. Confirm the worker accepts the lean
    session_start cleanly + no event_content row is written.
    """
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())
    flavor = f"test-xagent-off-{uuid.uuid4().hex[:6]}"

    post_event(make_event(parent_sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(parent_sid),
        timeout=10,
        msg=f"parent session {parent_sid} did not appear",
    )

    _post_subagent_session_start(
        parent_session_id=parent_sid,
        child_session_id=child_sid,
        flavor=flavor,
        agent_role="Researcher",
        # incoming_message intentionally None — capture-off shape.
    )
    wait_until(
        lambda: session_exists_in_fleet(child_sid),
        timeout=10,
        msg=f"child session {child_sid} did not appear",
    )
    _wait_for_event_count(child_sid, 1)

    events = _fetch_session_events(child_sid)
    ss = events[0]
    assert ss["has_content"] is False
    payload = ss.get("payload") or {}
    # parent_session_id + agent_role still land — those aren't
    # gated on capture_prompts.
    assert payload.get("parent_session_id") == parent_sid
    assert payload.get("agent_role") == "Researcher"
    assert "incoming_message" not in payload, (
        f"capture-off must drop incoming_message; got payload={payload!r}"
    )

    assert _fetch_event_content(ss["id"]) is None
