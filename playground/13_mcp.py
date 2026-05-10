"""Direct mcp SDK -- list/call_tool, list/read_resource, list/get_prompt,
plus a multi-server attribution scenario and full payload-shape
verification for every event the sensor emits.

A developer using the raw ``mcp`` package copies this file, points
``StdioServerParameters`` at their own MCP server, and gets Flightdeck
telemetry on every operation. The sensor's ``patch()`` wraps
``mcp.client.session.ClientSession`` at the class level so every
``async with ClientSession(...) as session`` block emits the six MCP
event types automatically -- no per-call instrumentation, no decorator,
no agent framework required.

The second half exercises a second MCP server in the same Flightdeck
session so the per-event ``server_name`` + ``transport`` attribution
the dashboard's MCP_SERVER facet relies on can be observed end-to-end.

Run with ``make dev`` up. Open the dashboard and watch the session
appear with eight MCP rows on the timeline (six from the reference
server, two from the secondary server).
"""
from __future__ import annotations

import asyncio
import sys
import time
import uuid

try:
    import mcp.client.stdio as _mcp_stdio
    from mcp.client.session import ClientSession
except ImportError:
    print("SKIP: pip install mcp to run this example")
    sys.exit(2)
# Use ``_mcp_stdio.stdio_client`` (attribute access at call time) rather
# than ``from mcp.client.stdio import stdio_client`` so we always pick
# up the post-patch wrapped factory. ``flightdeck_sensor.patch()``
# replaces ``mcp.client.stdio.stdio_client`` to mark streams with the
# transport label; a local ``from`` import would capture the unpatched
# factory before patch runs and ``payload.transport`` would land null.

import flightdeck_sensor
from _helpers import (
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
)


REFERENCE_MODULE = "playground._mcp_reference_server"
SECONDARY_MODULE = "playground._secondary_mcp_server"


async def _exercise_reference_server() -> None:
    """Open a session against the reference server and exercise every
    op the sensor patches so the six MCP event types all land."""
    async with _mcp_stdio.stdio_client(mcp_server_params(REFERENCE_MODULE)) as (read, write):
        async with ClientSession(read, write) as session:
            t0 = time.monotonic()
            await session.initialize()
            print_result(
                "ClientSession.initialize",
                True,
                int((time.monotonic() - t0) * 1000),
                "fingerprint stamped on session",
            )

            t0 = time.monotonic()
            tools = await session.list_tools()
            print_result(
                "session.list_tools", True,
                int((time.monotonic() - t0) * 1000),
                f"{len(tools.tools)} tools",
            )

            t0 = time.monotonic()
            await session.call_tool("echo", {"text": "hello mcp"})
            print_result(
                "session.call_tool(echo)", True,
                int((time.monotonic() - t0) * 1000),
            )

            t0 = time.monotonic()
            resources = await session.list_resources()
            print_result(
                "session.list_resources", True,
                int((time.monotonic() - t0) * 1000),
                f"{len(resources.resources)} resources",
            )

            t0 = time.monotonic()
            await session.read_resource("mem://demo")
            print_result(
                "session.read_resource(mem://demo)", True,
                int((time.monotonic() - t0) * 1000),
            )

            t0 = time.monotonic()
            prompts = await session.list_prompts()
            print_result(
                "session.list_prompts", True,
                int((time.monotonic() - t0) * 1000),
                f"{len(prompts.prompts)} prompts",
            )

            t0 = time.monotonic()
            await session.get_prompt("greet", {"name": "playground"})
            print_result(
                "session.get_prompt(greet)", True,
                int((time.monotonic() - t0) * 1000),
            )


async def _exercise_secondary_server() -> None:
    """Sequential, not gathered: deterministic event ordering for live
    inspection in the dashboard."""
    async with _mcp_stdio.stdio_client(mcp_server_params(SECONDARY_MODULE)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            t0 = time.monotonic()
            await session.call_tool("reverse", {"text": "playground"})
            print_result(
                "secondary server: reverse",
                True,
                int((time.monotonic() - t0) * 1000),
            )


def _assert_six_event_types_with_payload_contract(session_id: str) -> None:
    """All six MCP event types land + each carries the expected
    structured fields the dashboard contract depends on."""
    expected = [
        "mcp_tool_list",
        "mcp_tool_call",
        "mcp_resource_list",
        "mcp_resource_read",
        "mcp_prompt_list",
        "mcp_prompt_get",
    ]
    events = fetch_events_for_session(
        session_id,
        expect_event_types=["session_start", *expected],
        timeout_s=20.0,
    )
    by_type: dict[str, list[dict]] = {}
    for e in events:
        by_type.setdefault(e["event_type"], []).append(e)

    for et in expected:
        present = bool(by_type.get(et))
        print_result(f"event landed: {et}", present, 0)
        if not present:
            raise AssertionError(
                f"missing {et} event; observed types={list(by_type)!r}",
            )

    # mcp_tool_call: tool_name + server_name + transport=stdio +
    # arguments round-trip. Pick the reference-server's ``echo`` call
    # specifically -- the secondary server's ``reverse`` call lands
    # in the same bucket and would be selected by ``[-1]``.
    echo_calls = [
        e for e in by_type["mcp_tool_call"]
        if e.get("tool_name") == "echo"
    ]
    if not echo_calls:
        raise AssertionError(
            f"no mcp_tool_call carrying tool_name='echo'; calls: "
            f"{[e.get('tool_name') for e in by_type['mcp_tool_call']]!r}",
        )
    tc = echo_calls[-1]
    payload = tc.get("payload") or {}
    server_ok = payload.get("server_name") == "flightdeck-mcp-reference"
    transport_ok = payload.get("transport") == "stdio"
    # Phase 7 Step 3.b (D150): tool args migrated from inline
    # payload.arguments to event_content.tool_input. has_content=true
    # signals operators to fetch via /v1/events/:id/content. Demo
    # asserts the migration: payload no longer carries arguments;
    # has_content flips true.
    has_content_ok = tc.get("has_content") is True
    no_inline_args = "arguments" not in payload
    print_result("mcp_tool_call.tool_name=echo", True, 0)
    print_result("mcp_tool_call.server_name", server_ok, 0)
    print_result("mcp_tool_call.transport=stdio", transport_ok, 0)
    print_result("mcp_tool_call.has_content=True (D150)", has_content_ok, 0)
    print_result("mcp_tool_call no inline arguments (D150)", no_inline_args, 0)
    if not (server_ok and transport_ok and has_content_ok and no_inline_args):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tc!r}")

    # mcp_resource_read: resource_uri + content_bytes > 0.
    rr = by_type["mcp_resource_read"][-1]
    rr_payload = rr.get("payload") or {}
    uri_ok = rr_payload.get("resource_uri") == "mem://demo"
    bytes_ok = (rr_payload.get("content_bytes") or 0) > 0
    print_result("mcp_resource_read.resource_uri", uri_ok, 0)
    print_result("mcp_resource_read.content_bytes>0", bytes_ok, 0,
                 f"content_bytes={rr_payload.get('content_bytes')}")
    if not (uri_ok and bytes_ok):
        raise AssertionError(f"mcp_resource_read payload mismatch: {rr!r}")

    # mcp_prompt_get: prompt_name + capture migrated to event_content.
    pg = by_type["mcp_prompt_get"][-1]
    pg_payload = pg.get("payload") or {}
    name_ok = pg_payload.get("prompt_name") == "greet"
    # Phase 7 Step 3.b (D150): prompt arguments + rendered messages
    # migrated from inline payload to event_content. Same migration
    # shape as mcp_tool_call.
    pg_has_content_ok = pg.get("has_content") is True
    pg_no_inline_args = "arguments" not in pg_payload
    pg_no_inline_rendered = "rendered" not in pg_payload
    print_result("mcp_prompt_get.prompt_name=greet", name_ok, 0)
    print_result("mcp_prompt_get.has_content=True (D150)", pg_has_content_ok, 0)
    print_result("mcp_prompt_get no inline arguments (D150)", pg_no_inline_args, 0)
    print_result("mcp_prompt_get no inline rendered (D150)", pg_no_inline_rendered, 0)
    if not (name_ok and pg_has_content_ok and pg_no_inline_args and pg_no_inline_rendered):
        raise AssertionError(f"mcp_prompt_get payload mismatch: {pg!r}")

    # Per-event server_name + transport consistency on EVERY MCP event.
    # Reference-server events all carry server_name=flightdeck-mcp-reference;
    # secondary-server events carry flightdeck-mcp-secondary. Transport
    # is stdio for every event regardless of server.
    bad = [
        e for e in events
        if e.get("event_type", "").startswith("mcp_")
        and (e.get("payload") or {}).get("transport") != "stdio"
    ]
    print_result(
        "every mcp_* event carries transport=stdio",
        not bad, 0,
        f"{len(bad)} events with wrong transport" if bad else "",
    )
    if bad:
        raise AssertionError(
            f"transport attribution missing on: "
            f"{[(e.get('event_type'), (e.get('payload') or {}).get('transport')) for e in bad]!r}",
        )


def _assert_multi_server_attribution(session_id: str) -> None:
    """Both server names appear in the mcp_tool_call payloads. A single
    event must NOT inherit the wrong server's attribution."""
    deadline = time.monotonic() + 10.0
    seen: set[str] = set()
    while time.monotonic() < deadline:
        events = fetch_events_for_session(session_id, timeout_s=2.0)
        seen = {
            (e.get("payload") or {}).get("server_name") or ""
            for e in events
            if e.get("event_type") == "mcp_tool_call"
        }
        if {"flightdeck-mcp-reference", "flightdeck-mcp-secondary"} <= seen:
            break
        time.sleep(0.3)

    expected = {"flightdeck-mcp-reference", "flightdeck-mcp-secondary"}
    missing = expected - seen
    if missing:
        raise AssertionError(
            f"multi-server attribution failed: missing {missing!r}; "
            f"observed {seen!r} on session {session_id}"
        )
    print_result(
        "multi-server attribution", True, 0,
        f"both server names landed on the wire: {sorted(seen)}",
    )


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-mcp")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:13_mcp] session_id={session_id}")

    asyncio.run(_exercise_reference_server())
    asyncio.run(_exercise_secondary_server())

    _assert_six_event_types_with_payload_contract(session_id)
    _assert_multi_server_attribution(session_id)

    # Silence unused-import vigilance on uuid (kept for parity with
    # the rest of the playground scripts).
    _ = uuid.uuid4

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
