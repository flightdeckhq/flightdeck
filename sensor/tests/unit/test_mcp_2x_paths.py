"""The MCP interceptor against mcp 2.x's own connection paths.

mcp 2.x adds a high-level ``Client`` that builds its ``ClientSession``
over a dispatcher (no marked stream pair) and installs every handshake
result through ``ClientSession.adopt`` (``initialize()``, the
``server/discover`` probe of ``mode="auto"``). These tests drive a real
in-process server through those paths. They skip on mcp 1.x, which has
neither.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import mcp as mcp_interceptor
from flightdeck_sensor.transport.client import ControlPlaneClient

mcp = pytest.importorskip("mcp")
if not hasattr(getattr(mcp, "Client", None), "_build_session"):
    pytest.skip("mcp 1.x has no Client / adopt handshake", allow_module_level=True)


def _session() -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok-test",
        agent_flavor="test-mcp-2x",
        agent_type="production",
        capture_prompts=False,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    session.event_queue = MagicMock()  # type: ignore[assignment]
    return session


def _events(session: Session) -> list[dict[str, Any]]:
    return [call.args[0] for call in session.event_queue.enqueue.call_args_list]  # type: ignore[attr-defined]


def _server() -> Any:
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("probe-server")

    @server.tool()
    def echo(text: str) -> str:
        return text

    return server


@pytest.fixture()
def patched(monkeypatch: pytest.MonkeyPatch) -> Any:
    session = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    mcp_interceptor.patch_mcp_classes(quiet=True)
    try:
        yield session
    finally:
        mcp_interceptor.unpatch_mcp_classes(quiet=True)


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_client_handshake_records_the_server_identity(patched: Session, mode: str) -> None:
    """Both handshake modes go through adopt; the fingerprint and the
    per-call server name are recorded either way."""
    async with mcp.Client(_server(), mode=mode) as client:
        await client.call_tool("echo", {"text": "hi"})

    events = _events(patched)
    attached = [e for e in events if e["event_type"] == "mcp_server_attached"]
    assert len(attached) == 1
    assert attached[0]["server_name"] == "probe-server"
    (call,) = [e for e in events if e["event_type"] == "mcp_tool_call"]
    assert call["tool_name"] == "echo"
    assert call["server_name"] == "probe-server"
    assert [f.name for f in patched._mcp_servers] == ["probe-server"]


async def test_build_session_stamps_the_client_target() -> None:
    """A Client built over a URL or stdio parameters stamps transport and
    URL onto the session it builds; an in-process target stamps nothing."""
    from mcp.client.stdio import StdioServerParameters

    built = MagicMock()

    async def orig_build_session(self: Any, exit_stack: Any) -> Any:
        return built

    wrapped = mcp_interceptor._make_build_session_wrapper(orig_build_session)
    client = MagicMock()
    client.server = StdioServerParameters(command="uvx", args=["mcp-server-git"])
    assert await wrapped(client, None) is built
    assert built._flightdeck_mcp_transport == "stdio"
    assert built._flightdeck_mcp_server_url == "uvx mcp-server-git"


def test_unpatch_restores_adopt_and_build_session() -> None:
    from mcp.client.client import Client
    from mcp.client.session import ClientSession

    original_adopt = ClientSession.adopt
    original_build = Client._build_session
    mcp_interceptor.patch_mcp_classes(quiet=True)
    try:
        assert ClientSession.adopt is not original_adopt
        assert Client._build_session is not original_build
    finally:
        mcp_interceptor.unpatch_mcp_classes(quiet=True)
    assert ClientSession.adopt is original_adopt
    assert Client._build_session is original_build


async def test_client_given_a_transport_keeps_the_stream_markers(patched: Session) -> None:
    """mcp.Client handed a transport wraps the marked streams in a
    dispatcher; the session it builds still carries the transport and URL
    the patched transport recorded, so policy can resolve the server."""
    import anyio
    from mcp.shared.jsonrpc_dispatcher import JSONRPCDispatcher

    send, receive = anyio.create_memory_object_stream[Any](1)
    receive._flightdeck_transport = "stdio"  # type: ignore[attr-defined]
    receive._flightdeck_server_url = "uvx mcp-server-git"  # type: ignore[attr-defined]
    try:
        from mcp.client.session import ClientSession

        session = ClientSession(dispatcher=JSONRPCDispatcher(receive, send))
        assert session._flightdeck_mcp_transport == "stdio"  # type: ignore[attr-defined]
        assert session._flightdeck_mcp_server_url == "uvx mcp-server-git"  # type: ignore[attr-defined]
    finally:
        await send.aclose()
        await receive.aclose()
