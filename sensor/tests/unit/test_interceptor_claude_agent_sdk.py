"""Unit tests for the Claude Agent SDK interceptor.

The SDK's CLI-facing ``InternalClient.process_query`` and the
``ClaudeSDKClient`` transport are replaced by fakes that yield real
SDK message objects, so the interceptor's mapping (session_start /
post_call / tool_call / session_end), its options handling and its
fail-open posture are checked without a CLI.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.agent_id import derive_agent_id
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import claude_agent_sdk as sdk_mod
from flightdeck_sensor.transport.client import ControlPlaneClient

SDK_SESSION = "7d6a4c1e-2b3f-4a5b-9c8d-0e1f2a3b4c5d"


def _sdk_or_skip() -> Any:
    if not sdk_mod._ensure_imported():
        pytest.skip("claude-agent-sdk not installed")
    return sdk_mod._sdk


class _Queue:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def enqueue(self, payload: dict[str, Any]) -> None:
        self.events.append(payload)


def _session(*, capture_prompts: bool = True) -> tuple[Session, _Queue]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_id="22222222-2222-2222-2222-222222222222",
        agent_name="sdk-host",
        user_name="tester",
        hostname="host1",
        client_type="flightdeck_sensor",
        agent_flavor="playground-sdk",
        agent_type="production",
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    queue = _Queue()
    return Session(config=config, client=client, event_queue=queue), queue  # type: ignore[arg-type]


def _messages(sdk: Any, *, api_key_source: str = "user", is_error: bool = False) -> list[Any]:
    usage = {
        "input_tokens": 10,
        "cache_read_input_tokens": 100,
        "cache_creation_input_tokens": 20,
        "cache_creation": {"ephemeral_1h_input_tokens": 20, "ephemeral_5m_input_tokens": 0},
        "output_tokens": 5,
    }
    return [
        sdk.SystemMessage(
            subtype="init",
            data={
                "session_id": SDK_SESSION,
                "model": "claude-opus-5-5",
                "claude_code_version": "2.1.316",
                "permissionMode": "default",
                "cwd": "/work",
                "apiKeySource": api_key_source,
                "mcp_servers": [{"name": "github", "status": "connected"}],
            },
        ),
        # One assistant message streamed as two blocks under one id.
        sdk.AssistantMessage(
            content=[sdk.TextBlock(text="Listing.")],
            model="claude-opus-5-5",
            message_id="msg_1",
            usage=usage,
        ),
        sdk.AssistantMessage(
            content=[sdk.ToolUseBlock(id="toolu_1", name="Bash", input={"command": "ls"})],
            model="claude-opus-5-5",
            message_id="msg_1",
            usage=usage,
            stop_reason="tool_use",
        ),
        sdk.AssistantMessage(
            content=[sdk.TextBlock(text="Done.")],
            model="claude-opus-5-5",
            message_id="msg_2",
            usage=usage,
            stop_reason="end_turn",
        ),
        sdk.ResultMessage(
            subtype="error_max_turns" if is_error else "success",
            duration_ms=900,
            duration_api_ms=800,
            is_error=is_error,
            num_turns=2,
            session_id=SDK_SESSION,
            total_cost_usd=0.01,
            errors=["max turns reached"] if is_error else None,
        ),
    ]


@pytest.fixture()
def patched(monkeypatch: pytest.MonkeyPatch) -> Any:
    """The SDK with a fake CLI behind ``query()``, patched."""
    sdk = _sdk_or_skip()
    seen: dict[str, Any] = {}

    async def fake_process_query(
        self: Any, prompt: Any, options: Any, transport: Any = None
    ) -> Any:
        seen["options"] = options
        for message in seen["messages"]:
            if isinstance(message, Exception):
                raise message
            yield message

    monkeypatch.setattr(sdk_mod._internal_client, "process_query", fake_process_query)
    sdk_mod.patch_claude_agent_sdk(quiet=True)
    yield sdk, seen
    sdk_mod.unpatch_claude_agent_sdk()


def _run_query(sdk: Any, prompt: str = "list the repo", options: Any = None) -> list[Any]:
    async def go() -> list[Any]:
        return [m async for m in sdk.query(prompt=prompt, options=options)]

    return asyncio.run(go())


def test_a_query_run_is_its_own_claude_agent_sdk_session(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, seen = patched
    session, queue = _session()
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    seen["messages"] = _messages(sdk)
    caller_options = sdk.ClaudeAgentOptions(env={"KEEP": "1"})

    yielded = _run_query(sdk, options=caller_options)

    assert len(yielded) == 5, "the caller sees every message, unchanged"
    assert caller_options.env == {"KEEP": "1"}, "the caller's options are not mutated"
    assert seen["options"].env == {"KEEP": "1", "FLIGHTDECK_SDK_OBSERVED": "1"}
    kinds = [e["event_type"] for e in queue.events]
    assert kinds == ["session_start", "post_call", "tool_call", "post_call", "session_end"]
    agent_id = str(
        derive_agent_id(
            agent_type="production",
            user="tester",
            hostname="host1",
            client_type="claude_agent_sdk",
            agent_name="sdk-host",
        )
    )
    for event in queue.events:
        assert event["session_id"] == SDK_SESSION
        assert event["client_type"] == "claude_agent_sdk"
        assert event["agent_id"] == agent_id
    start = queue.events[0]
    assert start["context"]["supports_directives"] is False
    assert start["context"]["claude_code_version"] == "2.1.316"
    assert start["context"]["mcp_servers"] == ["github"]
    assert start["capture_prompts"] is True


def test_a_streamed_assistant_message_is_one_post_call_with_its_tool_calls(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, seen = patched
    session, queue = _session()
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    seen["messages"] = _messages(sdk)
    _run_query(sdk)
    first, tool, second = queue.events[1], queue.events[2], queue.events[3]
    assert first["tokens_input"] == 130
    assert first["tokens_output"] == 5
    assert first["tokens_cache_read"] == 100
    assert first["tokens_cache_creation_1h"] == 20
    assert first["stop_reason"] == "tool_use"
    assert first["billing_mode"] == "metered"
    assert first["content"]["messages"] == [{"role": "user", "content": "list the repo"}]
    assert [b["type"] for b in first["content"]["response"]["content"]] == ["text", "tool_use"]
    assert tool["tool_name"] == "Bash"
    assert tool["originating_event_id"] == first["id"]
    assert tool["content"]["tool_input"] == {"command": "ls"}
    assert second["content"]["messages"] == [], "the prompt belongs to the first call only"
    assert second["tokens_used_session"] == 270


def test_capture_off_sends_no_content(patched: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    sdk, seen = patched
    session, queue = _session(capture_prompts=False)
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    seen["messages"] = _messages(sdk)
    _run_query(sdk)
    for event in queue.events:
        assert event["has_content"] is False
        assert event["content"] is None
    assert "list the repo" not in repr(queue.events)


def test_a_claude_login_is_a_subscription_and_a_failed_run_ends_in_error(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, seen = patched
    session, queue = _session()
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    seen["messages"] = _messages(sdk, api_key_source="none", is_error=True)
    _run_query(sdk)
    assert queue.events[1]["billing_mode"] == "subscription"
    end = queue.events[-1]
    assert end["state"] == "error"
    assert end["error"]["message"] == "max turns reached"


def test_a_run_that_stops_without_a_result_still_ends_and_the_error_reaches_the_caller(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, seen = patched
    session, queue = _session()
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    seen["messages"] = [*_messages(sdk)[:2], RuntimeError("cli exited")]
    with pytest.raises(RuntimeError, match="cli exited"):
        _run_query(sdk)
    assert [e["event_type"] for e in queue.events] == ["session_start", "post_call", "session_end"]


def test_without_a_sensor_session_the_sdk_runs_untouched(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, seen = patched
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: None)
    seen["messages"] = _messages(sdk)
    _run_query(sdk, options=None)
    assert "FLIGHTDECK_SDK_OBSERVED" not in (seen["options"].env or {})


def test_a_query_imported_before_patch_is_still_observed(monkeypatch: pytest.MonkeyPatch) -> None:
    sdk = _sdk_or_skip()
    from claude_agent_sdk import query as early_query

    seen: dict[str, Any] = {}

    async def fake_process_query(
        self: Any, prompt: Any, options: Any, transport: Any = None
    ) -> Any:
        for message in _messages(sdk):
            yield message

    monkeypatch.setattr(sdk_mod._internal_client, "process_query", fake_process_query)
    sdk_mod.patch_claude_agent_sdk(quiet=True)
    try:
        session, queue = _session()
        monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)

        async def go() -> None:
            seen["n"] = len([m async for m in early_query(prompt="hi")])

        asyncio.run(go())
    finally:
        sdk_mod.unpatch_claude_agent_sdk()
    assert seen["n"] == 5
    assert [e["event_type"] for e in queue.events][0] == "session_start"


def test_a_reporting_failure_never_reaches_the_caller(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, seen = patched
    session, _ = _session()

    def broken(payload: dict[str, Any]) -> None:
        raise OSError("queue gone")

    session.event_queue = MagicMock(enqueue=broken)
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    seen["messages"] = _messages(sdk)
    assert len(_run_query(sdk)) == 5


def test_a_client_session_spans_turns_and_ends_at_disconnect(
    patched: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sdk, _ = patched
    session, queue = _session()
    monkeypatch.setattr(sdk_mod, "_current_session", lambda: session)
    turns = [_messages(sdk), _messages(sdk)[1:]]

    async def fake_receive(self: Any) -> Any:
        for message in turns.pop(0):
            yield message

    async def fake_send(self: Any, prompt: Any, session_id: str = "default") -> None:
        return None

    async def fake_disconnect(self: Any) -> None:
        return None

    # The originals the patch wraps stand in for the transport.
    sdk_mod._originals["client.receive_messages"] = fake_receive
    sdk_mod._originals["client.query"] = fake_send
    sdk_mod._originals["client.disconnect"] = fake_disconnect
    sdk_mod.unpatch_claude_agent_sdk()
    monkeypatch.setattr(sdk.ClaudeSDKClient, "receive_messages", fake_receive)
    monkeypatch.setattr(sdk.ClaudeSDKClient, "query", fake_send)
    monkeypatch.setattr(sdk.ClaudeSDKClient, "disconnect", fake_disconnect)
    sdk_mod.patch_claude_agent_sdk(quiet=True)

    async def go() -> None:
        client = sdk.ClaudeSDKClient(options=sdk.ClaudeAgentOptions())
        assert client.options.env["FLIGHTDECK_SDK_OBSERVED"] == "1"
        await client.query("first")
        _ = [m async for m in client.receive_messages()]
        await client.query("second")
        _ = [m async for m in client.receive_messages()]
        await client.disconnect()

    asyncio.run(go())
    kinds = [e["event_type"] for e in queue.events]
    assert kinds.count("session_start") == 1
    assert kinds.count("session_end") == 1
    assert kinds[-1] == "session_end"
    calls = [e for e in queue.events if e["event_type"] == "post_call" and e["content"]["messages"]]
    assert [c["content"]["messages"][0]["content"] for c in calls] == ["first", "second"]


def test_unpatch_restores_the_sdk() -> None:
    sdk = _sdk_or_skip()
    internal = sdk_mod._internal_client
    original_process_query = internal.process_query
    original_init = sdk.ClaudeSDKClient.__init__
    sdk_mod.patch_claude_agent_sdk(quiet=True)
    sdk_mod.patch_claude_agent_sdk(quiet=True)
    assert internal.process_query is not original_process_query
    sdk_mod.unpatch_claude_agent_sdk()
    assert internal.process_query is original_process_query
    assert sdk.ClaudeSDKClient.__init__ is original_init
    assert not getattr(sdk.ClaudeSDKClient, "_flightdeck_patched", False)


def test_the_internal_query_path_exists() -> None:
    """The ``query()`` wrap depends on a private SDK method; a release
    that moves it must fail here rather than skip the interceptor."""
    _sdk_or_skip()
    assert sdk_mod._internal_client is not None
    assert hasattr(sdk_mod._internal_client, "process_query")


def test_without_the_internal_path_the_client_is_still_reported(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    sdk = _sdk_or_skip()
    monkeypatch.setattr(sdk_mod, "_internal_client", None)
    original_init = sdk.ClaudeSDKClient.__init__
    with caplog.at_level("WARNING", logger="flightdeck_sensor.interceptor.claude_agent_sdk"):
        sdk_mod.patch_claude_agent_sdk(quiet=True)
    try:
        assert "query() runs are not reported" in caplog.text
        assert sdk.ClaudeSDKClient.__init__ is not original_init
    finally:
        sdk_mod.unpatch_claude_agent_sdk()
    assert sdk.ClaudeSDKClient.__init__ is original_init
    assert "process_query" not in sdk_mod._originals
