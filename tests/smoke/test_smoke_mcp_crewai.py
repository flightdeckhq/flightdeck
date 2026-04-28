"""Phase 5 MCP smoke test — CrewAI via mcpadapt. Manual; NOT in CI.

CrewAI does not ship a first-party MCP integration. The community
adapter ``mcpadapt`` (https://github.com/grll/mcpadapt) is the
production path: it wraps the official mcp SDK's ``ClientSession``
and produces native CrewAI tool objects. Because the wrap point is
``ClientSession``, the sensor's MCP interceptor sees every call —
no CrewAI-specific patching needed.

Phase 5 D5 pins ``mcpadapt`` to a known-working version in the
sensor's optional ``[mcp-crewai]`` extras (see ``sensor/pyproject.toml``).
The pin exists because mcpadapt is small, fast-moving, and could
break this smoke without a tagged release; pinning lets a future
upgrade be a deliberate change.

Run with ``make smoke-mcp-crewai``.
"""

from __future__ import annotations

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    wait_for_dev_stack,
)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    pytest.importorskip("mcp")
    pytest.importorskip("mcpadapt")
    pytest.importorskip("crewai")
    wait_for_dev_stack()


def _sensor_session():
    return make_sensor_session(flavor="smoke-mcp-crewai")


def test_mcpadapt_crewai_tool_routes_call_through_sensor() -> None:
    """``MCPAdapt`` wraps the reference server with the
    ``CrewAIAdapter`` so its tools become CrewAI ``BaseTool``
    instances. Invoking ``echo`` synchronously through the CrewAI
    interface produces an ``mcp_tool_call`` event.
    """
    import sys
    from mcp import StdioServerParameters  # type: ignore[import-untyped]
    from mcpadapt.core import MCPAdapt  # type: ignore[import-untyped]
    from mcpadapt.crewai_adapter import CrewAIAdapter  # type: ignore[import-untyped]

    sess = _sensor_session()

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
    )
    with MCPAdapt(params, CrewAIAdapter()) as tools:
        echo = next((t for t in tools if t.name == "echo"), None)
        assert echo is not None, (
            f"mcpadapt CrewAIAdapter did not expose 'echo'; got "
            f"{[t.name for t in tools]!r}"
        )
        echo.run(text="hello crewai smoke")

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
    assert (payload.get("arguments") or {}).get("text") == "hello crewai smoke"
