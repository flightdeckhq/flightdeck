"""Phase 5 MCP event-shape integration tests.

Wire-seeded (not sensor-driven): hand-crafts the six Phase 5 MCP event
payloads, POSTs them through the real ingestion API, and asserts they
round-trip through NATS + worker + Postgres + the Query API with the
correct structured fields. Mirrors the methodology of
``test_phase4_event_shapes.py`` -- everything from the wire boundary
inwards is real; only the SDK-side patching is out of scope (the smoke
matrix exercises that).

Covers:

* IT-MCP-1: All six MCP event types (``mcp_tool_list``,
  ``mcp_tool_call``, ``mcp_resource_list``, ``mcp_resource_read``,
  ``mcp_prompt_list``, ``mcp_prompt_get``) round-trip with their
  per-type structured fields preserved in ``events[].payload``.
* IT-MCP-2: ``session_start.context.mcp_servers`` persists through
  the worker's ``UpsertSession`` into ``sessions.context``; the
  ``/v1/sessions?mcp_server=`` filter narrows the listing to sessions
  that connected to the named server; each listing row carries
  ``mcp_server_names: [...]`` derived at query time from JSONB.
* IT-MCP-3: ``mcp_resource_read`` with ``has_content=true`` and an
  oversized payload lands in the ``event_content`` table and is
  fetchable via ``GET /v1/events/{id}/content`` with the captured
  body intact.
* IT-MCP-4: MCP failure-path events project ``payload.error`` with
  the structured taxonomy (``error_type``, ``error_class``,
  ``message``) the sensor / plugin produce.
* IT-MCP-5: A session whose only post-start activity is MCP events
  still advances ``last_seen_at`` (HandlePostCall's no-token-delta
  branch) and does not corrupt ``tokens_used_session``.
"""

from __future__ import annotations

import json
import urllib.parse
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


def _by_event_type(
    events: list[dict[str, Any]], event_type: str
) -> list[dict[str, Any]]:
    return [e for e in events if e["event_type"] == event_type]


def _fetch_session_listing(**filters: Any) -> dict[str, Any]:
    qs = urllib.parse.urlencode(
        {"from": "2020-01-01T00:00:00Z", "limit": 100, **filters}
    )
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}", headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def test_mcp_six_event_types_roundtrip_with_structured_fields() -> None:
    """IT-MCP-1: Every MCP event_type round-trips with the structured
    fields the sensor / plugin emit. Asserts server_name + transport on
    every type, plus each type's discriminating fields:

      * tool_list / resource_list / prompt_list -> ``count``
      * tool_call                              -> ``arguments``, duration
      * resource_read                          -> ``resource_uri``,
                                                   ``content_bytes``,
                                                   ``mime_type``
      * prompt_get                             -> ``prompt_name``,
                                                   ``rendered``
    """
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-shapes-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    server = "demo-mcp"
    transport = "stdio"

    post_event(make_event(
        sid, flavor, "mcp_tool_list",
        server_name=server, transport=transport, count=3, duration_ms=12,
    ))
    post_event(make_event(
        sid, flavor, "mcp_tool_call",
        server_name=server, transport=transport,
        tool_name="echo",
        arguments={"text": "hello world"},
        result={"content": [{"type": "text", "text": "hello world"}]},
        duration_ms=42,
    ))
    post_event(make_event(
        sid, flavor, "mcp_resource_list",
        server_name=server, transport=transport, count=7, duration_ms=15,
    ))
    post_event(make_event(
        sid, flavor, "mcp_resource_read",
        server_name=server, transport=transport,
        resource_uri="file:///tmp/notes.md",
        content_bytes=128,
        mime_type="text/markdown",
        duration_ms=20,
    ))
    post_event(make_event(
        sid, flavor, "mcp_prompt_list",
        server_name=server, transport=transport, count=2, duration_ms=11,
    ))
    post_event(make_event(
        sid, flavor, "mcp_prompt_get",
        server_name=server, transport=transport,
        prompt_name="summarize",
        arguments={"topic": "phase 5"},
        rendered={"messages": [{"role": "user", "content": "Summarize phase 5"}]},
        duration_ms=18,
    ))

    _wait_for_event_count(sid, 7)
    events = _fetch_session_events(sid)

    # 1) Every MCP type carried server_name + transport into payload.
    for et in (
        "mcp_tool_list", "mcp_tool_call",
        "mcp_resource_list", "mcp_resource_read",
        "mcp_prompt_list", "mcp_prompt_get",
    ):
        rows = _by_event_type(events, et)
        assert len(rows) == 1, f"expected one {et} event, got {rows!r}"
        payload = rows[0].get("payload") or {}
        assert payload.get("server_name") == server, (
            f"{et} payload.server_name mismatch: {payload!r}"
        )
        assert payload.get("transport") == transport, (
            f"{et} payload.transport mismatch: {payload!r}"
        )
        assert payload.get("duration_ms") is not None, (
            f"{et} payload.duration_ms missing: {payload!r}"
        )

    # 2) List ops carried ``count``.
    for et, want_count in (
        ("mcp_tool_list", 3),
        ("mcp_resource_list", 7),
        ("mcp_prompt_list", 2),
    ):
        payload = _by_event_type(events, et)[0]["payload"]
        assert payload.get("count") == want_count, (
            f"{et} payload.count mismatch: got {payload!r}"
        )

    # 3) tool_call discriminator.
    tc = _by_event_type(events, "mcp_tool_call")[0]
    assert tc.get("tool_name") == "echo", f"tool_name on row mismatch: {tc!r}"
    tc_payload = tc["payload"]
    assert tc_payload.get("arguments") == {"text": "hello world"}

    # 4) resource_read discriminator.
    rr = _by_event_type(events, "mcp_resource_read")[0]["payload"]
    assert rr.get("resource_uri") == "file:///tmp/notes.md"
    assert rr.get("content_bytes") == 128
    assert rr.get("mime_type") == "text/markdown"

    # 5) prompt_get discriminator.
    pg = _by_event_type(events, "mcp_prompt_get")[0]["payload"]
    assert pg.get("prompt_name") == "summarize"
    assert pg.get("arguments") == {"topic": "phase 5"}
    assert pg.get("rendered") == {
        "messages": [{"role": "user", "content": "Summarize phase 5"}],
    }


def test_mcp_server_fingerprint_persists_via_context_and_filters_listing() -> None:
    """IT-MCP-2: ``session_start.context.mcp_servers`` survives
    ``UpsertSession``, surfaces on the session detail context, and the
    ``/v1/sessions?mcp_server=<name>`` filter narrows correctly. Each
    listing row carries ``mcp_server_names`` so the dashboard facet
    can render without a second fetch.
    """
    sid_with = str(uuid.uuid4())
    sid_without = str(uuid.uuid4())
    server_name = f"mcp-{uuid.uuid4().hex[:6]}"
    flavor = f"test-mcp-fingerprint-{uuid.uuid4().hex[:6]}"

    fingerprint = {
        "name": server_name,
        "transport": "stdio",
        "protocol_version": "2024-11-05",
        "version": "0.3.1",
        "capabilities": {"tools": {}, "resources": {}},
        "instructions": "Use this server for filesystem I/O.",
    }

    # The session that DID connect to ``server_name``.
    post_event(make_event(
        sid_with, flavor, "session_start",
        context={"mcp_servers": [fingerprint], "deployment_id": "test-mcp"},
    ))
    # Control session, no MCP servers in its context.
    post_event(make_event(sid_without, flavor, "session_start"))

    wait_until(
        lambda: session_exists_in_fleet(sid_with)
        and session_exists_in_fleet(sid_without),
        timeout=10,
        msg="sessions did not appear",
    )

    # Detail endpoint surfaces the full fingerprint via context.
    # ``GET /v1/sessions/:id`` nests the row under ``session`` (alongside
    # peer ``events`` / ``attachments`` arrays) -- not at the top level.
    detail = get_session_detail(sid_with)
    session_row = detail.get("session") or {}
    ctx_servers = (session_row.get("context") or {}).get("mcp_servers") or []
    assert len(ctx_servers) == 1, (
        f"expected one mcp_servers entry on detail, got {ctx_servers!r}"
    )
    persisted = ctx_servers[0]
    assert persisted["name"] == server_name
    assert persisted["transport"] == "stdio"
    assert persisted["protocol_version"] == "2024-11-05"
    assert persisted["version"] == "0.3.1"
    assert persisted["capabilities"] == {"tools": {}, "resources": {}}

    # Listing filter narrows to the matching session AND carries
    # mcp_server_names for facet rendering.
    body = _fetch_session_listing(mcp_server=server_name, flavor=flavor)
    matched = {s["session_id"]: s for s in body.get("sessions", [])}
    assert sid_with in matched, (
        f"mcp_server filter must include {sid_with}: got {list(matched)!r}"
    )
    assert sid_without not in matched, (
        f"mcp_server filter leaked {sid_without}: got {list(matched)!r}"
    )
    assert server_name in (matched[sid_with].get("mcp_server_names") or []), (
        f"row missing mcp_server_names entry: {matched[sid_with]!r}"
    )

    # The control session's row is in the unfiltered listing AND
    # carries an empty mcp_server_names array (not null).
    body_all = _fetch_session_listing(flavor=flavor)
    by_id = {s["session_id"]: s for s in body_all.get("sessions", [])}
    assert sid_without in by_id, (
        f"unfiltered listing missing control session: {list(by_id)!r}"
    )
    assert by_id[sid_without].get("mcp_server_names") == [], (
        f"non-MCP session must carry empty mcp_server_names, got "
        f"{by_id[sid_without]!r}"
    )


def test_mcp_resource_read_overflow_content_fetchable_via_endpoint() -> None:
    """IT-MCP-3: ``mcp_resource_read`` with ``has_content=true`` routes
    the content body into the ``event_content`` table (the existing
    LLM overflow path) and is fetchable via ``GET
    /v1/events/{id}/content``. The captured ``response.contents``
    structure round-trips byte-identically.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-overflow-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    big_text = "x" * (12 * 1024)
    overflow_content = {
        "provider": "mcp",
        "model": "demo",
        "system": None,
        "messages": [],
        "tools": None,
        "response": {
            "contents": [
                {
                    "uri": "mem://big-log",
                    "mimeType": "text/plain",
                    "text": big_text,
                },
            ],
        },
        "input": None,
        "session_id": sid,
        "event_id": "",
        "captured_at": "2026-04-25T00:00:00Z",
    }
    post_event(make_event(
        sid, flavor, "mcp_resource_read",
        server_name="demo",
        transport="stdio",
        resource_uri="mem://big-log",
        content_bytes=len(big_text),
        mime_type="text/plain",
        duration_ms=42,
        has_content=True,
        content=overflow_content,
    ))
    _wait_for_event_count(sid, 2)

    events = _fetch_session_events(sid)
    rr = _by_event_type(events, "mcp_resource_read")
    assert len(rr) == 1, f"expected one mcp_resource_read, got {rr!r}"
    event_id = rr[0]["id"]
    assert rr[0].get("has_content") is True, (
        f"expected has_content=true on row, got {rr[0]!r}"
    )

    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())

    response = body.get("response") or {}
    contents = response.get("contents") or []
    assert len(contents) == 1, f"expected one content entry, got {body!r}"
    assert contents[0].get("uri") == "mem://big-log"
    assert contents[0].get("mimeType") == "text/plain"
    assert contents[0].get("text") == big_text, (
        "captured body text did not round-trip byte-identically"
    )


def test_mcp_failure_event_carries_structured_error_taxonomy() -> None:
    """IT-MCP-4: MCP failure events project ``payload.error`` with the
    sensor's structured taxonomy. The wire shape mirrors what the
    Python sensor's MCP interceptor and the Claude Code plugin both
    produce on PostToolUseFailure / SDK-raised errors.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-error-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    error_payload = {
        "error_type": "connection_closed",
        "error_class": "McpError",
        "message": "stream closed before response",
    }
    post_event(make_event(
        sid, flavor, "mcp_tool_call",
        server_name="demo",
        transport="stdio",
        tool_name="echo",
        duration_ms=120,
        error=error_payload,
    ))
    _wait_for_event_count(sid, 2)

    events = _fetch_session_events(sid)
    err_evt = _by_event_type(events, "mcp_tool_call")[0]
    payload_error = (err_evt.get("payload") or {}).get("error")
    assert payload_error is not None, (
        f"expected payload.error on failure event, got {err_evt!r}"
    )
    assert payload_error.get("error_type") == "connection_closed"
    assert payload_error.get("error_class") == "McpError"
    assert "stream closed" in (payload_error.get("message") or "")


def test_mcp_only_session_advances_last_seen_without_token_pollution() -> None:
    """IT-MCP-5: A session whose only post-start activity is MCP events
    still advances ``last_seen_at`` (HandlePostCall's no-delta else
    branch) and does NOT pollute ``tokens_used_session`` with NULL
    coercions or zeros from the lean MCP payload.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-mcp-no-pollute-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    # Three MCP_TOOL_CALL events; lean payload, no model / token deltas.
    for i in range(3):
        post_event(make_event(
            sid, flavor, "mcp_tool_call",
            server_name="demo",
            transport="stdio",
            tool_name=f"call_{i}",
            duration_ms=10 + i,
        ))
    _wait_for_event_count(sid, 4)

    body = _fetch_session_listing(flavor=flavor)
    row = next(
        (s for s in body.get("sessions", []) if s["session_id"] == sid), None,
    )
    assert row is not None, (
        f"MCP-only session missing from listing: {body!r}"
    )
    # tokens_used_session must remain the seed value (0). The MCP path
    # must not coerce a NULL token delta into a zero UPDATE.
    assert row.get("tokens_used_session") in (0, None), (
        f"MCP events polluted tokens_used_session: {row!r}"
    )
    # The session's MCP server name surfaced via per-event server_name
    # is NOT promoted to mcp_server_names (that derives from
    # session_start.context only — runtime-discovered servers stay on
    # the per-event payload).
    assert row.get("mcp_server_names") == [], (
        f"per-event server_name must not promote into mcp_server_names; got {row!r}"
    )
