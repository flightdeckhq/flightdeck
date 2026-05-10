"""Phase 7 Step 3.b (D150) — tool capture destination contract.

Locks the migration: tool args + result for mcp_tool_call /
mcp_prompt_get / LLM-side tool_call always route through
event_content's dedicated tool_input / tool_output columns. The
inline-vs-overflow split that the pre-Step-3.b code path used is
gone for these event types.

mcp_resource_read body capture stays on the existing inline-vs-
overflow path (Q1 lock) — covered by the surviving B-6
resource_read tests in test_mcp_interceptor.py.
"""

from __future__ import annotations

from flightdeck_sensor.interceptor.mcp import (
    _build_tool_capture_content,
)


def test_capture_content_includes_tool_input_and_tool_output_keys() -> None:
    """The wire envelope uses the dedicated D150 column names —
    NOT the LLM-prompt-style input / response columns the
    pre-Step-3.b _build_overflow_event_content helper repurposed."""
    content = _build_tool_capture_content(
        tool_input={"a": 1},
        tool_output={"r": 2},
        server_name="srv",
        session_id="sess",
    )
    assert content is not None
    assert content["tool_input"] == {"a": 1}
    assert content["tool_output"] == {"r": 2}
    # Legacy LLM-prompt fields are blanked — operator queries the
    # dedicated columns directly. ``response`` ships {} (NOT NULL
    # column constraint from the pre-D150 schema); ``input`` /
    # ``messages`` are nullable so they ride empty.
    assert content["input"] is None
    assert content["response"] == {}
    assert content["messages"] == []
    assert content["provider"] == "mcp"
    assert content["model"] == "srv"


def test_capture_content_returns_none_when_both_fields_empty() -> None:
    """Capture-off paths or pre-result emissions skip the
    has_content/content envelope entirely. Returning None lets
    the caller short-circuit cleanly."""
    assert (
        _build_tool_capture_content(
            tool_input=None,
            tool_output=None,
            server_name="srv",
            session_id="sess",
        )
        is None
    )


def test_capture_content_emits_when_only_input_present() -> None:
    """LLM-side tool_call emits the input alongside the
    invocation; tool_output populates retroactively when the
    next assistant turn shows the result. Single-field
    populations must produce a content envelope."""
    content = _build_tool_capture_content(
        tool_input={"q": "hello"},
        tool_output=None,
        server_name="claude-opus-4-7",
        session_id="sess",
    )
    assert content is not None
    assert content["tool_input"] == {"q": "hello"}
    assert content["tool_output"] is None


def test_capture_content_emits_when_only_output_present() -> None:
    """Symmetric — output without input is valid (rare; would
    happen on a result-only post-hoc capture)."""
    content = _build_tool_capture_content(
        tool_input=None,
        tool_output={"r": "ok"},
        server_name="srv",
        session_id="sess",
    )
    assert content is not None
    assert content["tool_output"] == {"r": "ok"}


def test_capture_content_session_id_round_trips() -> None:
    """Worker's InsertEventContent uses session_id from the
    payload to satisfy the FK constraint. The envelope must
    carry it verbatim."""
    content = _build_tool_capture_content(
        tool_input={},
        tool_output={},
        server_name="srv",
        session_id="11111111-1111-1111-1111-111111111111",
    )
    assert content is not None
    assert content["session_id"] == "11111111-1111-1111-1111-111111111111"
