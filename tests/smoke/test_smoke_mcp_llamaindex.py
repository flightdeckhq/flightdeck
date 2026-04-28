"""Phase 5 MCP smoke test — LlamaIndex via llama-index-tools-mcp.
Manual; NOT in CI.

LlamaIndex's MCP integration ships as ``llama-index-tools-mcp``
which provides a ``BasicMCPClient`` (stdio + sse + http transports)
and a ``McpToolSpec`` that converts MCP tools into LlamaIndex
``FunctionTool`` instances. Underneath both call the official mcp
SDK's ``ClientSession``, so the sensor's interceptor sees every
call.

Run with ``make smoke-mcp-llamaindex``.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    wait_for_dev_stack,
)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    pytest.importorskip("mcp")
    pytest.importorskip("llama_index.tools.mcp")
    wait_for_dev_stack()


def _sensor_session():
    return make_sensor_session(flavor="smoke-mcp-llamaindex")


def test_llamaindex_mcp_tool_routes_call_through_sensor() -> None:
    """Convert the reference server's tools into LlamaIndex
    FunctionTools via ``McpToolSpec``, invoke ``echo``, and assert
    the sensor saw the call.
    """
    import sys
    from llama_index.tools.mcp import (  # type: ignore[import-untyped]
        BasicMCPClient,
        McpToolSpec,
    )

    sess = _sensor_session()

    async def run() -> None:
        client = BasicMCPClient(
            command_or_url=sys.executable,
            args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
        )
        spec = McpToolSpec(client=client)
        tools = await spec.to_tool_list_async()
        echo = next((t for t in tools if t.metadata.name == "echo"), None)
        assert echo is not None, (
            f"llama-index-tools-mcp did not expose 'echo'; got "
            f"{[t.metadata.name for t in tools]!r}"
        )
        await echo.acall(text="hello llamaindex smoke")

    asyncio.run(run())

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    assert tcs, f"no mcp_tool_call observed; events={events!r}"
    payload = tcs[-1].get("payload") or {}
    assert tcs[-1].get("tool_name") == "echo"
    assert payload.get("server_name") == "flightdeck-mcp-reference"
    assert (payload.get("arguments") or {}).get("text") == "hello llamaindex smoke"
