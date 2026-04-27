"""Unit tests for the Phase 5 MCP interceptor.

Coverage discipline (Phase 5 Direction A):
    Floor ~20 tests. The mcp SDK is async-only, so there is no sync /
    async doubling that would otherwise pad the count. Every patched
    operation gets one happy-path test, one capture_prompts gate test,
    and one error-path test. Plus fingerprint-capture, multi-server,
    transport-detection, and patch idempotency.

Test strategy:
    Most tests exercise the wrapper factories
    (``_make_async_wrapper`` / ``_make_initialize_wrapper``) directly
    against a fake bound-method receiver. This decouples the assertions
    from real ClientSession instantiation. A handful of integration-
    style tests call ``patch_mcp_classes`` / ``unpatch_mcp_classes``
    end-to-end to verify the patch wiring on the real
    ``mcp.client.session.ClientSession`` class.

    No real network or subprocess. ``mcp`` is installed via the dev
    extra (see pyproject.toml). Tests skip cleanly if the import is
    unavailable so a partial dev install never explodes.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import (
    EventType,
    MCPServerFingerprint,
    SensorConfig,
)
from flightdeck_sensor.interceptor import mcp as mcp_interceptor
from flightdeck_sensor.interceptor.mcp import (
    _PATCH_TABLE,
    _classify_mcp_error,
    _emit_prompt_get,
    _emit_prompt_list,
    _emit_resource_list,
    _emit_resource_read,
    _emit_tool_call,
    _emit_tool_list,
    _make_async_wrapper,
    _make_init_wrapper,
    _make_initialize_wrapper,
    patch_mcp_classes,
    unpatch_mcp_classes,
)
from flightdeck_sensor.transport.client import ControlPlaneClient

pytestmark = pytest.mark.skipif(
    not mcp_interceptor._MCP_AVAILABLE,
    reason="mcp package not installed in test environment",
)


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


def _make_sensor_session(*, capture_prompts: bool = False) -> Session:
    """Construct a sensor Session with a mock control-plane client.

    The session's ``event_queue`` is replaced with a MagicMock so tests
    can assert on the exact ``enqueue`` payloads without spinning up a
    real ControlPlaneClient.
    """
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok-test",
        agent_flavor="test-mcp",
        agent_type="production",
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    session.event_queue = MagicMock()  # type: ignore[assignment]
    return session


@pytest.fixture()
def install_session(monkeypatch: pytest.MonkeyPatch) -> Session:
    """Install a sensor Session as the active flightdeck-sensor singleton.

    Mirrors the pattern in ``test_patch.py`` -- monkeypatches the module
    global so ``mcp_interceptor._current_session()`` returns our test
    session. Restored automatically at test end.
    """
    import flightdeck_sensor

    session = _make_sensor_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    return session


@pytest.fixture()
def install_capturing_session(
    monkeypatch: pytest.MonkeyPatch,
) -> Session:
    """Same as install_session but with capture_prompts=True."""
    import flightdeck_sensor

    session = _make_sensor_session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    return session


def _bound_receiver(
    server_name: str = "demo-server",
    transport: str | None = "stdio",
) -> SimpleNamespace:
    """Construct a fake ``self`` with the sensor's stashed attributes."""
    return SimpleNamespace(
        _flightdeck_mcp_server_name=server_name,
        _flightdeck_mcp_transport=transport,
    )


def _last_enqueue(session: Session) -> dict[str, Any]:
    """Return the most recent payload passed to event_queue.enqueue."""
    enqueue = session.event_queue.enqueue  # type: ignore[attr-defined]
    assert enqueue.called, "expected event_queue.enqueue to be called"
    return enqueue.call_args[0][0]


# ---------------------------------------------------------------------
# Patch-table structural commitment (Phase 5 addition E)
# ---------------------------------------------------------------------


def test_patch_table_lists_six_phase_five_event_types() -> None:
    """Phase 5 D2(a): exactly six MCP event types are emitted.

    Adding a future plumbing op (complete / ping / progress / logging /
    roots) is one entry in _PATCH_TABLE plus one _emit_* function. If
    a future PR expands this set without an explicit Phase 6+ scope
    decision, this test starts failing as a structural reminder.
    """
    expected = {
        "list_tools": EventType.MCP_TOOL_LIST,
        "call_tool": EventType.MCP_TOOL_CALL,
        "list_resources": EventType.MCP_RESOURCE_LIST,
        "read_resource": EventType.MCP_RESOURCE_READ,
        "list_prompts": EventType.MCP_PROMPT_LIST,
        "get_prompt": EventType.MCP_PROMPT_GET,
    }
    actual = {name: et for name, (et, _) in _PATCH_TABLE.items()}
    assert actual == expected


# ---------------------------------------------------------------------
# Tool call -- the headline operation
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_tool_emits_event_with_server_attribution(
    install_session: Session,
) -> None:
    async def fake_orig(self: Any, name: str, arguments: Any = None) -> Any:
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text="hello")],
        )

    wrapped = _make_async_wrapper(
        "call_tool",
        fake_orig,
        EventType.MCP_TOOL_CALL,
        _emit_tool_call,
    )
    receiver = _bound_receiver(server_name="demo-server", transport="stdio")

    result = await wrapped(receiver, "echo", {"msg": "hi"})

    assert result is not None
    payload = _last_enqueue(install_session)
    assert payload["event_type"] == "mcp_tool_call"
    assert payload["server_name"] == "demo-server"
    assert payload["transport"] == "stdio"
    assert payload["tool_name"] == "echo"
    assert isinstance(payload["duration_ms"], int)
    # capture_prompts=False: arguments and result must NOT appear.
    assert "arguments" not in payload
    assert "result" not in payload


@pytest.mark.asyncio
async def test_call_tool_with_capture_prompts_includes_arguments_and_result(
    install_capturing_session: Session,
) -> None:
    fake_result = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="42")],
        isError=False,
    )

    async def fake_orig(self: Any, name: str, arguments: Any = None) -> Any:
        # Stub model_dump so _model_to_dict returns a dict.
        fake_result.model_dump = lambda mode="json": {  # type: ignore[attr-defined]
            "content": [{"type": "text", "text": "42"}],
            "isError": False,
        }
        return fake_result

    wrapped = _make_async_wrapper(
        "call_tool",
        fake_orig,
        EventType.MCP_TOOL_CALL,
        _emit_tool_call,
    )
    receiver = _bound_receiver()
    await wrapped(receiver, "add", {"a": 1, "b": 41})

    payload = _last_enqueue(install_capturing_session)
    assert payload["arguments"] == {"a": 1, "b": 41}
    assert payload["result"] == {
        "content": [{"type": "text", "text": "42"}],
        "isError": False,
    }


@pytest.mark.asyncio
async def test_call_tool_error_path_emits_structured_error_and_reraises(
    install_session: Session,
) -> None:
    """Phase 5: failure path lands an event AND re-raises."""
    from mcp.shared.exceptions import McpError
    from mcp.types import ErrorData

    async def fake_orig(self: Any, name: str, arguments: Any = None) -> Any:
        raise McpError(ErrorData(code=-32602, message="bad arg"))

    wrapped = _make_async_wrapper(
        "call_tool",
        fake_orig,
        EventType.MCP_TOOL_CALL,
        _emit_tool_call,
    )
    receiver = _bound_receiver()

    with pytest.raises(McpError):
        await wrapped(receiver, "broken", {})

    payload = _last_enqueue(install_session)
    assert payload["event_type"] == "mcp_tool_call"
    assert payload["error"]["error_type"] == "invalid_params"
    assert payload["error"]["code"] == -32602
    assert payload["error"]["message"] == "bad arg"
    assert "result" not in payload


@pytest.mark.asyncio
async def test_no_active_session_calls_orig_directly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sensor inactive: wrapper must fall straight through."""
    import flightdeck_sensor

    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    called_with: dict[str, Any] = {}

    async def fake_orig(self: Any, name: str, arguments: Any = None) -> str:
        called_with["name"] = name
        return "ok"

    wrapped = _make_async_wrapper(
        "call_tool",
        fake_orig,
        EventType.MCP_TOOL_CALL,
        _emit_tool_call,
    )
    result = await wrapped(SimpleNamespace(), "echo")
    assert result == "ok"
    assert called_with == {"name": "echo"}


# ---------------------------------------------------------------------
# List operations -- count only, no item names
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_tools_emits_count_not_names(install_session: Session) -> None:
    async def fake_orig(self: Any, *args: Any, **kwargs: Any) -> Any:
        return SimpleNamespace(
            tools=[
                SimpleNamespace(name="echo"),
                SimpleNamespace(name="add"),
                SimpleNamespace(name="multiply"),
            ],
        )

    wrapped = _make_async_wrapper(
        "list_tools",
        fake_orig,
        EventType.MCP_TOOL_LIST,
        _emit_tool_list,
    )
    await wrapped(_bound_receiver())

    payload = _last_enqueue(install_session)
    assert payload["event_type"] == "mcp_tool_list"
    assert payload["count"] == 3
    # Item names must NOT be in the payload (every individual call
    # emits its own MCP_TOOL_CALL with the name).
    flat = str(payload)
    assert "echo" not in flat
    assert "multiply" not in flat


@pytest.mark.asyncio
async def test_list_resources_emits_count(install_session: Session) -> None:
    async def fake_orig(self: Any, *args: Any, **kwargs: Any) -> Any:
        return SimpleNamespace(
            resources=[SimpleNamespace(uri="mem://a")],
        )

    wrapped = _make_async_wrapper(
        "list_resources",
        fake_orig,
        EventType.MCP_RESOURCE_LIST,
        _emit_resource_list,
    )
    await wrapped(_bound_receiver())
    assert _last_enqueue(install_session)["count"] == 1


@pytest.mark.asyncio
async def test_list_prompts_emits_count(install_session: Session) -> None:
    async def fake_orig(self: Any, *args: Any, **kwargs: Any) -> Any:
        return SimpleNamespace(
            prompts=[SimpleNamespace(name="greet"), SimpleNamespace(name="thank")],
        )

    wrapped = _make_async_wrapper(
        "list_prompts",
        fake_orig,
        EventType.MCP_PROMPT_LIST,
        _emit_prompt_list,
    )
    await wrapped(_bound_receiver())
    assert _last_enqueue(install_session)["count"] == 2


# ---------------------------------------------------------------------
# Resource read -- content_bytes always, content gated
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_resource_emits_uri_and_content_bytes_when_capture_off(
    install_session: Session,
) -> None:
    text_piece = SimpleNamespace(text="abc", blob=None, mimeType="text/plain")

    async def fake_orig(self: Any, uri: Any) -> Any:
        return SimpleNamespace(contents=[text_piece])

    wrapped = _make_async_wrapper(
        "read_resource",
        fake_orig,
        EventType.MCP_RESOURCE_READ,
        _emit_resource_read,
    )
    await wrapped(_bound_receiver(), "mem://demo")

    payload = _last_enqueue(install_session)
    assert payload["resource_uri"] == "mem://demo"
    assert payload["content_bytes"] == 3  # len("abc".encode("utf-8"))
    # mime_type and content are MCP-only fields gated by capture_prompts.
    # Phase 5 lean payload: when capture is off the wrapper does NOT
    # add either field, and the base payload no longer carries the
    # legacy LLM ``content`` placeholder for MCP events.
    assert "mime_type" not in payload
    assert "content" not in payload


@pytest.mark.asyncio
async def test_read_resource_capture_on_includes_mime_and_content(
    install_capturing_session: Session,
) -> None:
    text_piece = SimpleNamespace(text="abc", blob=None, mimeType="text/markdown")
    fake_result = SimpleNamespace(contents=[text_piece])
    fake_result.model_dump = lambda mode="json": {  # type: ignore[attr-defined]
        "contents": [{"text": "abc", "mimeType": "text/markdown"}],
    }

    async def fake_orig(self: Any, uri: Any) -> Any:
        return fake_result

    wrapped = _make_async_wrapper(
        "read_resource",
        fake_orig,
        EventType.MCP_RESOURCE_READ,
        _emit_resource_read,
    )
    await wrapped(_bound_receiver(), "mem://demo")

    payload = _last_enqueue(install_capturing_session)
    assert payload["mime_type"] == "text/markdown"
    assert payload["content"]["contents"][0]["text"] == "abc"


@pytest.mark.asyncio
async def test_read_resource_blob_content_bytes_decodes_base64(
    install_session: Session,
) -> None:
    """``BlobResourceContents.blob`` is base64; size is the decoded length."""
    import base64

    raw = b"\x00\x01\x02\x03\x04"
    encoded = base64.b64encode(raw).decode()
    blob_piece = SimpleNamespace(text=None, blob=encoded, mimeType="application/octet-stream")

    async def fake_orig(self: Any, uri: Any) -> Any:
        return SimpleNamespace(contents=[blob_piece])

    wrapped = _make_async_wrapper(
        "read_resource",
        fake_orig,
        EventType.MCP_RESOURCE_READ,
        _emit_resource_read,
    )
    await wrapped(_bound_receiver(), "mem://blob")

    assert _last_enqueue(install_session)["content_bytes"] == 5


# ---------------------------------------------------------------------
# Get prompt -- name + (gated) arguments + rendered messages
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_prompt_emits_prompt_name_capture_off(
    install_session: Session,
) -> None:
    async def fake_orig(self: Any, name: str, arguments: Any = None) -> Any:
        return SimpleNamespace(messages=[])

    wrapped = _make_async_wrapper(
        "get_prompt",
        fake_orig,
        EventType.MCP_PROMPT_GET,
        _emit_prompt_get,
    )
    await wrapped(_bound_receiver(), "greet", {"name": "Ada"})

    payload = _last_enqueue(install_session)
    assert payload["prompt_name"] == "greet"
    assert "arguments" not in payload
    assert "rendered" not in payload


@pytest.mark.asyncio
async def test_get_prompt_capture_on_includes_arguments_and_rendered(
    install_capturing_session: Session,
) -> None:
    msg1 = SimpleNamespace(role="user", content="hi")
    msg1.model_dump = lambda mode="json": {"role": "user", "content": "hi"}  # type: ignore[attr-defined]
    msg2 = SimpleNamespace(role="assistant", content="hello Ada")
    msg2.model_dump = lambda mode="json": {  # type: ignore[attr-defined]
        "role": "assistant",
        "content": "hello Ada",
    }

    async def fake_orig(self: Any, name: str, arguments: Any = None) -> Any:
        return SimpleNamespace(messages=[msg1, msg2])

    wrapped = _make_async_wrapper(
        "get_prompt",
        fake_orig,
        EventType.MCP_PROMPT_GET,
        _emit_prompt_get,
    )
    await wrapped(_bound_receiver(), "greet", {"name": "Ada"})

    payload = _last_enqueue(install_capturing_session)
    assert payload["arguments"] == {"name": "Ada"}
    assert payload["rendered"] == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello Ada"},
    ]


# ---------------------------------------------------------------------
# Initialize -- fingerprint capture, no event emit
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_initialize_records_server_fingerprint_and_does_not_emit(
    install_session: Session,
) -> None:
    fake_caps = SimpleNamespace()
    fake_caps.model_dump = lambda mode="json": {  # type: ignore[attr-defined]
        "tools": {"listChanged": True},
        "resources": None,
        "prompts": None,
    }
    fake_init_result = SimpleNamespace(
        serverInfo=SimpleNamespace(name="demo-server", version="1.0.0"),
        capabilities=fake_caps,
        protocolVersion="2025-03-26",
        instructions="Test server.",
    )

    async def fake_orig(self: Any) -> Any:
        return fake_init_result

    wrapped = _make_initialize_wrapper(fake_orig)
    receiver = _bound_receiver(server_name=None, transport="stdio")  # type: ignore[arg-type]

    result = await wrapped(receiver)

    assert result is fake_init_result
    # Initialize emits no event itself.
    install_session.event_queue.enqueue.assert_not_called()  # type: ignore[attr-defined]
    # But the fingerprint lands on the session.
    assert len(install_session._mcp_servers) == 1
    fp = install_session._mcp_servers[0]
    assert fp.name == "demo-server"
    assert fp.version == "1.0.0"
    assert fp.transport == "stdio"
    assert fp.protocol_version == "2025-03-26"
    assert fp.capabilities == {
        "tools": {"listChanged": True},
        "resources": None,
        "prompts": None,
    }
    assert fp.instructions == "Test server."
    # And the per-instance attribute is stashed for downstream events.
    assert receiver._flightdeck_mcp_server_name == "demo-server"


def test_session_records_mcp_server_dedup_by_name_transport() -> None:
    session = _make_sensor_session()
    fp1 = MCPServerFingerprint(
        name="demo",
        transport="stdio",
        protocol_version="2025-03-26",
        version="1.0.0",
    )
    fp2 = MCPServerFingerprint(
        name="demo",
        transport="stdio",
        protocol_version="2025-03-26",
        version="1.0.1",
    )
    fp3 = MCPServerFingerprint(
        name="demo",
        transport="sse",
        protocol_version="2025-03-26",
        version="1.0.0",
    )
    session.record_mcp_server(fp1)
    session.record_mcp_server(fp2)  # dedup -- same name + transport as fp1
    session.record_mcp_server(fp3)  # different transport -- distinct entry
    assert len(session._mcp_servers) == 2
    assert session._mcp_servers[0].version == "1.0.0"  # original wins on dedup
    assert session._mcp_servers[1].transport == "sse"


def test_session_start_payload_includes_mcp_servers_in_context() -> None:
    """Servers recorded before session_start land in context.mcp_servers."""
    session = _make_sensor_session()
    session.record_mcp_server(
        MCPServerFingerprint(
            name="demo",
            transport="stdio",
            protocol_version="2025-03-26",
            version="1.0.0",
        ),
    )
    payload = session._build_payload(EventType.SESSION_START)
    assert "context" in payload
    assert payload["context"]["mcp_servers"] == [
        {
            "name": "demo",
            "transport": "stdio",
            "protocol_version": "2025-03-26",
            "version": "1.0.0",
            "capabilities": {},
            "instructions": None,
        },
    ]


def test_session_start_payload_carries_int_protocol_version_unchanged() -> None:
    """Phase 5 override: don't stringify SDK ``protocolVersion`` (str | int)."""
    session = _make_sensor_session()
    session.record_mcp_server(
        MCPServerFingerprint(
            name="future",
            transport="stdio",
            protocol_version=42,  # integer protocol version, future SDK shape
            version="9.9.9",
        ),
    )
    payload = session._build_payload(EventType.SESSION_START)
    fingerprint = payload["context"]["mcp_servers"][0]
    assert fingerprint["protocol_version"] == 42
    assert isinstance(fingerprint["protocol_version"], int)


def test_mcp_event_payload_omits_llm_baseline_fields() -> None:
    """Phase 5 lean MCP payload (override 2).

    MCP events must NOT carry the LLM-baseline columns that are perpetually
    null for MCP traffic. This test is the structural floor: any future
    edit to ``Session._build_payload`` that re-adds an LLM column to MCP
    events fails this test as a deliberate reminder of override 2.
    """
    session = _make_sensor_session()
    payload = session._build_payload(
        EventType.MCP_TOOL_CALL,
        server_name="x",
        transport="stdio",
        tool_name="echo",
        duration_ms=10,
    )
    forbidden = {
        "model",
        "tokens_input",
        "tokens_output",
        "tokens_total",
        "tokens_cache_read",
        "tokens_cache_creation",
        "latency_ms",
        "tool_input",
        "tool_result",
        "has_content",
        "content",
    }
    leaked = forbidden & payload.keys()
    assert leaked == set(), (
        f"MCP payload leaked LLM-baseline fields: {sorted(leaked)}. "
        "See Phase 5 override 2 — MCP events must not carry LLM-shape "
        "columns. Re-tag MCP-specific extras explicitly if needed."
    )
    # Common fields that DO carry through to MCP events.
    for required in (
        "session_id",
        "agent_id",
        "agent_name",
        "agent_type",
        "client_type",
        "user",
        "hostname",
        "host",
        "event_type",
        "framework",
        "tokens_used_session",
        "token_limit_session",
        "timestamp",
    ):
        assert required in payload, f"MCP payload missing required field: {required}"


def test_non_mcp_event_payload_still_carries_llm_baseline() -> None:
    """The lean refactor must NOT remove LLM fields from non-MCP events."""
    session = _make_sensor_session()
    payload = session._build_payload(EventType.POST_CALL)
    for required in (
        "model",
        "tokens_input",
        "tokens_output",
        "tokens_total",
        "tokens_cache_read",
        "tokens_cache_creation",
        "latency_ms",
        "tool_name",
        "tool_input",
        "tool_result",
        "has_content",
        "content",
    ):
        assert required in payload, (
            f"Non-MCP event lost LLM-baseline field {required!r}. "
            "The lean refactor was supposed to branch on event_type, "
            "not strip these fields globally."
        )


def test_post_call_payload_does_not_include_mcp_servers_context() -> None:
    """Per-event payloads stay lean -- mcp_servers ships only on session_start."""
    session = _make_sensor_session()
    session.record_mcp_server(
        MCPServerFingerprint(
            name="demo",
            transport="stdio",
            protocol_version="2025-03-26",
            version="1.0.0",
        ),
    )
    payload = session._build_payload(EventType.POST_CALL)
    assert "context" not in payload


# ---------------------------------------------------------------------
# Transport detection via stream marker
# ---------------------------------------------------------------------


def test_init_wrapper_copies_transport_marker_from_read_stream() -> None:
    """ClientSession.__init__ wrapper reads the marker off read_stream."""
    captured: dict[str, Any] = {}

    def fake_orig_init(self: Any, *args: Any, **kwargs: Any) -> None:
        captured["args"] = args

    wrapped_init = _make_init_wrapper(fake_orig_init)
    read_stream = SimpleNamespace()
    setattr(read_stream, mcp_interceptor._TRANSPORT_MARKER, "http")
    write_stream = SimpleNamespace()

    receiver = SimpleNamespace()
    wrapped_init(receiver, read_stream, write_stream)

    assert getattr(receiver, mcp_interceptor._INSTANCE_TRANSPORT_ATTR) == "http"


def test_init_wrapper_unmarked_stream_yields_none_transport() -> None:
    """Manually-constructed streams (no marker) leave transport unset."""

    def fake_orig_init(self: Any, *args: Any, **kwargs: Any) -> None:
        pass

    wrapped_init = _make_init_wrapper(fake_orig_init)
    read_stream = SimpleNamespace()  # no marker
    write_stream = SimpleNamespace()

    receiver = SimpleNamespace()
    wrapped_init(receiver, read_stream, write_stream)

    assert not hasattr(receiver, mcp_interceptor._INSTANCE_TRANSPORT_ATTR)


# ---------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------


def test_classify_mcp_error_handles_jsonrpc_codes() -> None:
    from mcp.shared.exceptions import McpError
    from mcp.types import ErrorData

    err = McpError(ErrorData(code=-32602, message="bad params"))
    classified = _classify_mcp_error(err)
    assert classified["error_type"] == "invalid_params"
    assert classified["code"] == -32602
    assert classified["message"] == "bad params"
    assert classified["error_class"] == "McpError"


def test_classify_mcp_error_handles_timeout() -> None:
    classified = _classify_mcp_error(TimeoutError("slow"))
    assert classified["error_type"] == "timeout"
    assert classified["error_class"] == "TimeoutError"


def test_classify_mcp_error_falls_back_to_other() -> None:
    classified = _classify_mcp_error(RuntimeError("boom"))
    assert classified["error_type"] == "other"
    assert classified["error_class"] == "RuntimeError"


# ---------------------------------------------------------------------
# Patch / unpatch wiring (integration-ish, against real ClientSession)
# ---------------------------------------------------------------------


def test_patch_mcp_classes_idempotent() -> None:
    """Second call must not double-wrap. Unpatch must restore the original."""
    from mcp.client.session import ClientSession

    orig_call_tool = ClientSession.call_tool

    patch_mcp_classes(quiet=True)
    once_patched = ClientSession.call_tool
    assert once_patched is not orig_call_tool

    patch_mcp_classes(quiet=True)  # second call -- no-op
    twice_patched = ClientSession.call_tool
    assert twice_patched is once_patched

    unpatch_mcp_classes(quiet=True)
    assert ClientSession.call_tool is orig_call_tool


def test_unpatch_without_patch_is_noop() -> None:
    """Symmetry guard -- mirror litellm interceptor's idempotent unpatch."""
    unpatch_mcp_classes(quiet=True)
    unpatch_mcp_classes(quiet=True)


def test_patch_unpatch_cycle_restores_every_method() -> None:
    """All 6 patched ops + initialize + __init__ round-trip cleanly."""
    from mcp.client.session import ClientSession

    originals = {
        name: getattr(ClientSession, name)
        for name in ("__init__", "initialize", *_PATCH_TABLE.keys())
    }

    patch_mcp_classes(quiet=True)
    unpatch_mcp_classes(quiet=True)

    for name, orig in originals.items():
        assert getattr(ClientSession, name) is orig, f"unpatch did not restore ClientSession.{name}"
