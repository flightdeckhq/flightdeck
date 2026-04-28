"""Phase 5 MCP smoke test — direct ``mcp`` SDK. Manual; NOT in CI.

Bootstraps the in-tree reference MCP server over stdio, drives every
operation the sensor's MCP interceptor patches (``initialize``,
``list_tools``, ``call_tool``, ``list_resources``, ``read_resource``,
``list_prompts``, ``get_prompt``), and asserts the corresponding
``mcp_*`` event types land in ``/v1/events`` carrying the structured
fields the dashboard contract depends on.

Why a direct-SDK smoke test even though every framework adapter
ultimately routes through ``ClientSession`` (which is what the sensor
patches): a real provider SDK release can change the ``InitializeResult``
shape, the ``CallToolResult.content`` envelope, or surface new error
classes. Mocked unit tests pin those against fixtures and won't notice
SDK drift. Rule 40d's "real exercise the patch surface" bar is what this
file enforces.

Run with ``make smoke-mcp-python``.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    mcp_reference_server_params,
    wait_for_dev_stack,
)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    pytest.importorskip("mcp")
    wait_for_dev_stack()


def _sensor_session():
    return make_sensor_session(flavor="smoke-mcp-python")


def _drive_reference_server() -> None:
    """Open a ClientSession against the reference server and exercise
    every patched op. Runs entirely synchronously from the smoke test's
    perspective via ``asyncio.run``; the sensor's interceptor patches
    async ``ClientSession`` methods directly so this is the natural
    call shape.
    """
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    async def run() -> None:
        params = mcp_reference_server_params()
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.list_tools()
                await session.call_tool("echo", {"text": "hello smoke"})
                await session.list_resources()
                await session.read_resource("mem://demo")
                await session.list_prompts()
                await session.get_prompt("greet", {"name": "smoke"})

    asyncio.run(run())


def test_mcp_reference_server_emits_all_six_event_types() -> None:
    """The full MCP coverage matrix — every op the sensor patches
    fires its corresponding event_type and reaches the wire.
    """
    sess = _sensor_session()
    _drive_reference_server()

    expected = [
        "mcp_tool_list",
        "mcp_tool_call",
        "mcp_resource_list",
        "mcp_resource_read",
        "mcp_prompt_list",
        "mcp_prompt_get",
    ]
    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["session_start", *expected],
        timeout_s=20.0,
    )

    by_type: dict[str, list[dict]] = {}
    for e in events:
        by_type.setdefault(e["event_type"], []).append(e)

    for et in expected:
        assert by_type.get(et), f"missing {et} event; observed types={list(by_type)!r}"

    # MCP_TOOL_CALL carries the tool_name + structured arguments.
    tc = by_type["mcp_tool_call"][-1]
    assert tc.get("tool_name") == "echo", f"tool_name mismatch: {tc!r}"
    payload = tc.get("payload") or {}
    assert payload.get("server_name") == "flightdeck-mcp-reference"
    assert payload.get("transport") == "stdio"
    assert (payload.get("arguments") or {}).get("text") == "hello smoke"

    # MCP_RESOURCE_READ carries resource_uri + content_bytes.
    rr = by_type["mcp_resource_read"][-1]
    rr_payload = rr.get("payload") or {}
    assert rr_payload.get("resource_uri") == "mem://demo"
    assert (rr_payload.get("content_bytes") or 0) > 0

    # MCP_PROMPT_GET carries prompt_name + arguments.
    pg = by_type["mcp_prompt_get"][-1]
    pg_payload = pg.get("payload") or {}
    assert pg_payload.get("prompt_name") == "greet"
    assert (pg_payload.get("arguments") or {}).get("name") == "smoke"


def test_mcp_per_event_server_name_attribution_is_consistent() -> None:
    """Every MCP event the reference run produces carries the same
    ``server_name`` + ``transport`` attribution in its payload. The
    sensor's ``record_mcp_server`` only lands on
    ``session_start.context.mcp_servers`` when MCP init happens
    BEFORE ``flightdeck_sensor.init()`` (the worker's UpsertSession
    writes context once on conflict and never updates) — typical
    agent scripts init flightdeck first, so per-event attribution
    via ``server_name`` is the authoritative real-time signal. This
    test pins that signal.
    """
    sess = _sensor_session()
    _drive_reference_server()

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["session_start", "mcp_tool_list", "mcp_tool_call"],
        timeout_s=20.0,
    )
    mcp_events = [e for e in events if e["event_type"].startswith("mcp_")]
    assert mcp_events, f"no MCP events observed; events={events!r}"
    for e in mcp_events:
        payload = e.get("payload") or {}
        assert payload.get("server_name") == "flightdeck-mcp-reference", (
            f"server_name mismatch on {e['event_type']}: {payload!r}"
        )
        assert payload.get("transport") == "stdio", (
            f"transport mismatch on {e['event_type']}: {payload!r}"
        )
