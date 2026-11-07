"""The event_content envelope for a captured tool call.

``mcp_tool_call``, ``mcp_prompt_get``, the LLM-side ``tool_call`` and the
Claude Agent SDK's ``tool_call`` all carry their captured arguments and
result in this one shape. It lives outside every interceptor module, and
imports no SDK, because an interceptor module imports its SDK: the
LLM-side path, which emits ``tool_call`` for an Anthropic or OpenAI call,
reaching into the MCP interceptor for it would import ``mcp`` into an
application that never imported it, inside an LLM call.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def build_tool_capture_content(
    *,
    tool_input: Any,
    tool_output: Any,
    server_name: str | None,
    session_id: str,
) -> dict[str, Any] | None:
    """Build the event_content envelope for tool capture using the
    dedicated ``tool_input`` / ``tool_output`` columns (migration
    000021).

    Sensor and plugin produce the same wire shape; the worker's
    ``InsertEventContent`` parses both keys and writes them into the
    dedicated columns.

    Returns ``None`` when neither field is populated (capture off or
    call errored before producing args/output); the caller then skips
    setting ``has_content`` / ``content``.

    Tool args and results are never repurposed into the LLM-prompt
    columns (``input`` carrying tool args, ``response`` carrying a tool
    result spelled like an LLM prompt). Operators querying
    ``event_content.tool_input`` get tool args directly without the
    column-name semantics gymnastics.
    """
    if tool_input is None and tool_output is None:
        return None
    return {
        "system": None,
        "messages": [],
        "tools": None,
        # ``response`` is a NOT NULL column in event_content that
        # predates tool capture; send the empty-dict default so the
        # INSERT satisfies the column constraint. The operationally
        # meaningful tool capture lives in tool_input / tool_output.
        "response": {},
        "input": None,
        "tool_input": tool_input,
        "tool_output": tool_output,
        "provider": "mcp",
        "model": server_name or "",
        "session_id": session_id,
        "event_id": "",
        "captured_at": datetime.now(UTC).isoformat(),
    }
