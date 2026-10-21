"""OpenAI Responses-API event shapes, wire-seeded (not sensor-driven).

Hand-crafts the payloads the sensor emits for the Responses API --
a ``tool_call`` for a hosted tool item (``web_search_call``) with its
captured input, a ``post_call`` carrying the request id read off a parsed
object, and a ``post_call`` carrying a prompt-cache read -- POSTs them
through the real ingestion API, and asserts they round-trip through
NATS + worker + Postgres onto ``/v1/sessions/:id`` and
``/v1/events/:id/content``.

Mock-free: everything from the wire boundary inwards is real. The
provider SDK itself is the playground's job (``playground/02_direct_openai.py``).
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

# What the sensor's capture envelope for an LLM-side tool_call looks like
# (``_build_tool_capture_content`` with ``provider`` overridden to "llm").
WEB_SEARCH_INPUT = {"type": "search", "query": "eiffel tower completion year"}


def _tool_capture_content(session_id: str, model: str) -> dict[str, Any]:
    return {
        "system": None,
        "messages": [],
        "tools": None,
        "response": {},
        "input": None,
        "tool_input": WEB_SEARCH_INPUT,
        "tool_output": None,
        "provider": "llm",
        "model": model,
        "session_id": session_id,
        "event_id": "",
        "captured_at": "2026-10-21T07:00:00+00:00",
    }


def _get_event_content(event_id: str) -> dict[str, Any] | None:
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


def _start_session(sid: str, flavor: str) -> None:
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )


def _events(sid: str) -> list[dict[str, Any]]:
    return get_session_detail(sid).get("events", [])


def test_responses_hosted_tool_call_lands_with_name_and_captured_input() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-openai-responses-tool-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)

    post_event(make_event(
        sid, flavor, "post_call",
        model="gpt-4o-mini",
        tokens_input=58, tokens_output=10, tokens_total=68,
        tokens_cache_read=0, tokens_cache_creation=0,
        latency_ms=1500,
        provider_metadata={"request_id": "req_parsed_object_1"},
    ))
    post_event(make_event(
        sid, flavor, "tool_call",
        model="gpt-4o-mini",
        tool_name="web_search_call",
        has_content=True,
        content=_tool_capture_content(sid, "gpt-4o-mini"),
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 3,
        timeout=10,
        msg=f"post_call + tool_call not processed for session {sid}",
    )

    events = _events(sid)
    tool_call = next((e for e in events if e["event_type"] == "tool_call"), None)
    assert tool_call is not None, f"no tool_call event in {events!r}"
    assert tool_call["tool_name"] == "web_search_call"
    assert tool_call["has_content"] is True

    post_call = next((e for e in events if e["event_type"] == "post_call"), None)
    assert post_call is not None, f"no post_call event in {events!r}"
    assert post_call["payload"]["provider_metadata"]["request_id"] == "req_parsed_object_1"
    assert post_call["tokens_input"] == 58
    assert post_call["tokens_output"] == 10

    # The content row trails the event row; poll until it is served.
    captured: dict[str, Any] = {}

    def _content_served() -> bool:
        body = _get_event_content(tool_call["id"])
        if body is None:
            return False
        captured.update(body)
        return True

    wait_until(
        _content_served,
        timeout=10,
        msg=f"tool_call content never served for event {tool_call['id']}",
    )
    assert captured["tool_input"] == WEB_SEARCH_INPUT
    assert captured.get("tool_output") in (None, {}, "")


def test_post_call_prompt_cache_hit_lands_as_cache_read_tokens() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-openai-cache-read-{uuid.uuid4().hex[:6]}"
    _start_session(sid, flavor)

    post_event(make_event(
        sid, flavor, "post_call",
        model="gpt-4o-mini",
        tokens_input=3094, tokens_output=1, tokens_total=3095,
        tokens_cache_read=3072, tokens_cache_creation=0,
        latency_ms=660,
        provider_metadata={"request_id": "req_cache_hit_1"},
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg=f"post_call not processed for session {sid}",
    )

    post_call = next((e for e in _events(sid) if e["event_type"] == "post_call"), None)
    assert post_call is not None
    assert post_call["tokens_input"] == 3094
    assert post_call["tokens_output"] == 1
    assert post_call["tokens_cache_read"] == 3072
    assert post_call["tokens_cache_creation"] == 0
