"""The Claude Code plugin's payload fields survive the pipeline.

The plugin sends three fields the Python sensor never does:
``tool_use_id`` on ``tool_call`` / ``mcp_tool_call``, ``mcp_server`` on
``mcp_tool_call`` and ``end_reason`` on ``session_end``. The ingestion
API type-checks them and the workers service projects them into
``events.payload``; a plugin tool failure's ``error.message`` is kept
only when the session's stored capture posture is on.

Wire-seeded, mock-free: the bodies below are shaped as
``plugin/hooks/scripts/observe_cli.mjs`` emits them, POSTed through the
real ingestion API and read back from ``GET /v1/sessions/:id``.
Parallel-safe: a fresh session id and a unique flavor per test.
"""

from __future__ import annotations

import urllib.error
import uuid
from typing import Any

import pytest

from .conftest import (
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)

TOOL_USE_ID = "toolu_01Xg9Qe5dbennMRZ7YuUVr4m"
MCP_TOOL_USE_ID = "toolu_01EcQvDizFdJhFyotPFoe13E"
MCP_SERVER = {"name": "plugin:claude-mem:mcp-search", "source": "plugin"}
ERROR_TEXT = "Exit code 2\nls: cannot access '/missing': No such file or directory"


def _events_by_type(session_id: str) -> dict[str, dict[str, Any]]:
    detail = get_session_detail(session_id)
    return {e["event_type"]: e for e in detail.get("events", [])}


def _seed_plugin_session(*, capture_prompts: bool) -> str:
    sid = str(uuid.uuid4())
    flavor = f"test-plugin-fields-{uuid.uuid4().hex[:6]}"
    post_event(
        make_event(
            sid,
            flavor,
            "session_start",
            client_type="claude_code",
            sensor_version="flightdeck-plugin/test",
            capture_prompts=capture_prompts,
        )
    )
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear",
    )
    post_event(
        make_event(
            sid,
            flavor,
            "tool_call",
            client_type="claude_code",
            tool_name="Bash",
            latency_ms=449,
            duration_ms=449,
            tool_use_id=TOOL_USE_ID,
            error={
                "error_type": "other",
                "error_class": "PluginToolError",
                "message": ERROR_TEXT,
                "interrupted": False,
            },
        )
    )
    post_event(
        make_event(
            sid,
            flavor,
            "mcp_tool_call",
            client_type="claude_code",
            server_name=MCP_SERVER["name"],
            tool_name="list_corpora",
            duration_ms=9,
            tool_use_id=MCP_TOOL_USE_ID,
            mcp_server=MCP_SERVER,
        )
    )
    post_event(
        make_event(
            sid,
            flavor,
            "session_end",
            client_type="claude_code",
            close_reason="normal_exit",
            end_reason="prompt_input_exit",
        )
    )
    wait_until(
        lambda: get_session_event_count(sid) >= 4,
        timeout=10,
        msg=f"expected 4 events for session {sid}",
    )
    return sid


def test_plugin_fields_land_in_event_payloads() -> None:
    sid = _seed_plugin_session(capture_prompts=True)
    events = _events_by_type(sid)

    tool_call = events["tool_call"]["payload"]
    assert tool_call["tool_use_id"] == TOOL_USE_ID
    assert tool_call["duration_ms"] == 449
    assert tool_call["error"]["error_class"] == "PluginToolError"
    assert tool_call["error"]["message"] == ERROR_TEXT

    mcp = events["mcp_tool_call"]["payload"]
    assert mcp["tool_use_id"] == MCP_TOOL_USE_ID
    assert mcp["mcp_server"] == MCP_SERVER
    assert mcp["server_name"] == MCP_SERVER["name"]

    end = events["session_end"]["payload"]
    assert end["close_reason"] == "normal_exit"
    assert end["end_reason"] == "prompt_input_exit"


def test_tool_error_text_is_withheld_when_capture_is_off() -> None:
    sid = _seed_plugin_session(capture_prompts=False)
    error = _events_by_type(sid)["tool_call"]["payload"]["error"]
    assert error["message"] == "<redacted>"
    assert error["error_type"] == "other"
    assert error["error_class"] == "PluginToolError"
    assert error["interrupted"] is False


def test_session_signals_land_and_a_model_switch_moves_the_session_model() -> None:
    """session_signal events land with their signal and metadata; a
    compaction's summary reaches event_content; a model switch's model
    becomes the session's model."""
    sid = str(uuid.uuid4())
    flavor = f"test-plugin-signals-{uuid.uuid4().hex[:6]}"
    post_event(
        make_event(
            sid,
            flavor,
            "session_start",
            client_type="claude_code",
            sensor_version="flightdeck-plugin/test",
            capture_prompts=True,
            model="claude-sonnet-5",
        )
    )
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear",
    )
    post_event(
        make_event(
            sid,
            flavor,
            "session_signal",
            client_type="claude_code",
            model=None,
            signal="context_compacted",
            signal_data={"trigger": "auto"},
            has_content=True,
            content={
                "provider": "flightdeck-signal",
                "model": "",
                "system": None,
                "messages": [],
                "tools": None,
                "response": {"compact_summary": "Summary of the work."},
            },
        )
    )
    post_event(
        make_event(
            sid,
            flavor,
            "session_signal",
            client_type="claude_code",
            model="claude-opus-5",
            signal="model_switched",
            signal_data={
                "from_model": "claude-sonnet-5",
                "to_model": "claude-opus-5",
                "source": "command",
                "context_tokens": 182340,
                "prompt_cache_warm": True,
            },
        )
    )
    wait_until(
        lambda: get_session_event_count(sid) >= 3,
        timeout=10,
        msg=f"session_signal events did not land for {sid}",
    )
    detail = get_session_detail(sid)
    signals = {
        e["payload"]["signal"]: e
        for e in detail.get("events", [])
        if e["event_type"] == "session_signal"
    }
    compacted = signals["context_compacted"]
    assert compacted["payload"]["signal_data"] == {"trigger": "auto"}
    assert compacted["has_content"] is True
    switched = signals["model_switched"]
    assert switched["payload"]["signal_data"]["to_model"] == "claude-opus-5"
    assert switched["payload"]["signal_data"]["context_tokens"] == 182340
    assert detail["session"]["model"] == "claude-opus-5"


def test_a_malformed_session_signal_is_rejected() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-plugin-signals-{uuid.uuid4().hex[:6]}"
    bad = make_event(
        sid,
        flavor,
        "session_signal",
        client_type="claude_code",
        signal="Not A Signal",
    )
    with pytest.raises(urllib.error.HTTPError) as err:
        post_event(bad)
    assert err.value.code == 400
