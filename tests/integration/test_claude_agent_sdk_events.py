"""A Claude Agent SDK run observed by the REAL sensor lands as its own
``claude_agent_sdk`` session on the dev stack.

The SDK talks to a Claude Code CLI subprocess over its own control
protocol, so the CLI-facing ``InternalClient.process_query`` is the one
thing replaced: the fake
yields real SDK message objects (``SystemMessage`` init, streamed
``AssistantMessage`` blocks, ``ResultMessage``) exactly as the SDK
parses them from the CLI. Everything from the interceptor to Postgres
runs for real.
"""

from __future__ import annotations

import asyncio
import os
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

import flightdeck_sensor
from flightdeck_sensor.interceptor import claude_agent_sdk as sdk_mod

from .conftest import (
    API_URL,
    INGESTION_URL,
    TOKEN,
    auth_headers,
    delete_flavor_data,
    post_directive,
    wait_until,
)
from .test_sensor_e2e import (
    _force_reset_sensor,
    _psql_json,
    _query_events_for_flavor,
)

claude_agent_sdk = pytest.importorskip("claude_agent_sdk")

PROMPT = "list the repository"


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    _force_reset_sensor()
    yield
    _force_reset_sensor()


@pytest.fixture
def unique_flavor() -> Iterator[str]:
    flavor = f"e2e-sdk-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        delete_flavor_data(flavor)


def _messages(sdk_session: str) -> list[Any]:
    sdk = claude_agent_sdk
    usage = {
        "input_tokens": 12,
        "cache_read_input_tokens": 300,
        "cache_creation_input_tokens": 40,
        "cache_creation": {
            "ephemeral_1h_input_tokens": 40,
            "ephemeral_5m_input_tokens": 0,
        },
        "output_tokens": 9,
    }
    return [
        sdk.SystemMessage(
            subtype="init",
            data={
                "session_id": sdk_session,
                "model": "claude-sonnet-4-6",
                "claude_code_version": "2.1.316",
                "permissionMode": "default",
                "cwd": "/work",
                "apiKeySource": "none",
                "mcp_servers": [],
            },
        ),
        sdk.AssistantMessage(
            content=[sdk.TextBlock(text="Listing the files.")],
            model="claude-sonnet-4-6",
            message_id="msg_it_1",
            usage=usage,
        ),
        sdk.AssistantMessage(
            content=[
                sdk.ToolUseBlock(id="toolu_it_1", name="Bash", input={"command": "ls"})
            ],
            model="claude-sonnet-4-6",
            message_id="msg_it_1",
            usage=usage,
            stop_reason="tool_use",
        ),
        sdk.AssistantMessage(
            content=[sdk.TextBlock(text="Two files.")],
            model="claude-sonnet-4-6",
            message_id="msg_it_2",
            usage=usage,
            stop_reason="end_turn",
        ),
        sdk.ResultMessage(
            subtype="success",
            duration_ms=1200,
            duration_api_ms=1000,
            is_error=False,
            num_turns=2,
            session_id=sdk_session,
            total_cost_usd=0.0,
        ),
    ]


@pytest.fixture
def fake_cli(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    """Replace the SDK's CLI-facing call before the sensor patches it."""
    seen: dict[str, Any] = {"session": str(uuid.uuid4())}

    async def process_query(
        self: Any, prompt: Any, options: Any, transport: Any = None
    ) -> Any:
        seen["options"] = options
        messages = _messages(seen["session"])
        for message in messages[:2]:
            yield message
        # Between two messages the CLI may call the options' hook
        # callbacks; a test sets ``step`` to play that part.
        if "step" in seen:
            await seen["step"](options)
        for message in messages[2:]:
            yield message

    sdk_mod.unpatch_claude_agent_sdk()
    from claude_agent_sdk._internal.client import InternalClient

    monkeypatch.setattr(InternalClient, "process_query", process_query)
    yield seen
    sdk_mod.unpatch_claude_agent_sdk()


def _content_status(event_id: str) -> int:
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers()
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def _run(capture_prompts: bool) -> None:
    flightdeck_sensor.init(
        server=INGESTION_URL, token=TOKEN, capture_prompts=capture_prompts
    )
    flightdeck_sensor.patch()

    async def go() -> int:
        return len([m async for m in claude_agent_sdk.query(prompt=PROMPT)])

    assert asyncio.run(go()) == 5, "the caller sees every SDK message"
    flightdeck_sensor.teardown()


def _sdk_events(flavor: str, sdk_session: str) -> list[dict[str, Any]]:
    return [
        e for e in _query_events_for_flavor(flavor) if e["session_id"] == sdk_session
    ]


@pytest.mark.usefixtures("sensor_reset")
def test_an_sdk_run_lands_as_its_own_claude_agent_sdk_session(
    fake_cli: dict[str, Any], unique_flavor: str
) -> None:
    sdk_session = fake_cli["session"]
    _run(capture_prompts=True)

    wait_until(
        lambda: (
            "session_end"
            in [e["event_type"] for e in _sdk_events(unique_flavor, sdk_session)]
        ),
        timeout=15,
        msg=f"no session_end for SDK session {sdk_session}",
    )
    events = _sdk_events(unique_flavor, sdk_session)
    kinds = [e["event_type"] for e in events]
    assert kinds == [
        "session_start",
        "post_call",
        "tool_call",
        "post_call",
        "session_end",
    ]
    assert fake_cli["options"].env["FLIGHTDECK_SDK_OBSERVED"] == "1"

    first_call, tool, second_call = events[1], events[2], events[3]
    assert first_call["tokens_input"] == 352
    assert first_call["tokens_output"] == 9
    assert first_call["model"] == "claude-sonnet-4-6"
    assert tool["tool_name"] == "Bash"
    # A logged-in Claude subscription is not metered.
    assert first_call["billing_mode"] == "subscription"
    assert first_call["platform"] == "anthropic"
    assert tool["payload"]["originating_event_id"] == str(first_call["id"])
    assert first_call["has_content"] is True
    assert _content_status(str(first_call["id"])) == 200
    assert second_call["has_content"] is True

    rows = _psql_json(
        "SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json) FROM sessions s "
        "WHERE session_id = :'sid'",
        sid=sdk_session,
    )
    assert len(rows) == 1
    session = rows[0]
    assert session["client_type"] == "claude_agent_sdk"
    assert session["state"] == "closed"
    assert session["context"]["supports_directives"] is True
    assert session["context"]["claude_code_version"] == "2.1.316"


@pytest.mark.usefixtures("sensor_reset")
def test_capture_off_stores_no_sdk_content(
    fake_cli: dict[str, Any], unique_flavor: str
) -> None:
    sdk_session = fake_cli["session"]
    _run(capture_prompts=False)

    wait_until(
        lambda: (
            "session_end"
            in [e["event_type"] for e in _sdk_events(unique_flavor, sdk_session)]
        ),
        timeout=15,
        msg=f"no session_end for SDK session {sdk_session}",
    )
    events = _sdk_events(unique_flavor, sdk_session)
    for event in events:
        assert event["has_content"] is False
        assert PROMPT not in repr(event)
    call = next(e for e in events if e["event_type"] == "post_call")
    assert _content_status(str(call["id"])) == 404


@pytest.mark.usefixtures("sensor_reset")
def test_a_stop_from_the_api_reaches_the_runs_tool_gate(
    fake_cli: dict[str, Any], unique_flavor: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A shutdown issued for the SDK run's session reaches the run's
    PreToolUse callback through a real heartbeat, denies the tool call,
    and the session closes as a directive shutdown."""
    sdk_session = fake_cli["session"]
    outputs: list[Any] = []

    async def step(options: Any) -> None:
        wait_until(
            lambda: bool(
                _psql_json(
                    "SELECT COALESCE(json_agg(session_id), '[]'::json) FROM sessions "
                    "WHERE session_id = :'sid'",
                    sid=sdk_session,
                )
            ),
            timeout=15,
            msg=f"SDK session {sdk_session} never landed",
        )
        post_directive("shutdown", session_id=sdk_session, reason="manual stop")
        # Poll at once rather than after the run has been idle.
        monkeypatch.setattr(sdk_mod, "_POLL_IDLE_SECS", 0.0)
        gate = options.hooks["PreToolUse"][-1].hooks[0]
        outputs.append(
            await gate(
                {"tool_name": "Bash", "tool_input": {"command": "ls"}}, "t1", None
            )
        )

    fake_cli["step"] = step
    _run(capture_prompts=True)

    assert outputs[0]["continue_"] is False
    assert outputs[0]["hookSpecificOutput"]["permissionDecision"] == "deny"
    wait_until(
        lambda: (
            "session_end"
            in [e["event_type"] for e in _sdk_events(unique_flavor, sdk_session)]
        ),
        timeout=15,
        msg=f"no session_end for SDK session {sdk_session}",
    )
    events = _sdk_events(unique_flavor, sdk_session)
    result = next(e for e in events if e["event_type"] == "directive_result")
    assert result["payload"]["directive_status"] == "acknowledged"
    end = next(e for e in events if e["event_type"] == "session_end")
    assert end["payload"]["close_reason"] == "directive_shutdown"
    rows = _psql_json(
        "SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json) FROM sessions s "
        "WHERE session_id = :'sid'",
        sid=sdk_session,
    )
    assert rows[0]["context"]["supports_directives"] is True
    assert rows[0]["state"] == "closed"
