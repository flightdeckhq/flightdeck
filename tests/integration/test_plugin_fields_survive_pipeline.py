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

import uuid
from typing import Any

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
