"""Phase 7 Step 3 (D151) — MCP Protection Policy enforcement
extends from call_tool to all six server-access paths.

Operator's "this server is blocked" intent now means ALL access
blocked: call_tool, read_resource, get_prompt, list_tools,
list_resources, list_prompts. An agent blocked from a server
cannot bypass via list_*/read/get.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.exceptions import MCPPolicyBlocked
from flightdeck_sensor.core.mcp_policy import MCPPolicyDecision
from flightdeck_sensor.interceptor.mcp import (
    _METHOD_TO_CALL_CONTEXT,
    _enforce_mcp_policy,
)


def _block_decision() -> MCPPolicyDecision:
    return MCPPolicyDecision(
        decision="block",
        decision_path="flavor_entry",
        policy_id="p",
        scope="flavor:e2e",
        fingerprint="abc",
        block_on_uncertainty=False,
        matched_entry_id="entry-uuid",
        matched_entry_label="some-server",
    )


def _fake_session() -> Any:
    fake = MagicMock()
    fake.mcp_policy = MagicMock()
    fake.mcp_policy.evaluate = MagicMock(return_value=_block_decision())
    fake._build_payload = MagicMock(return_value={"event_type": "test"})
    fake.event_queue = MagicMock()
    return fake


@pytest.mark.parametrize(
    "context",
    [
        "tool_call",
        "list_tools",
        "read_resource",
        "get_prompt",
        "list_resources",
        "list_prompts",
    ],
)
def test_block_decision_raises_for_every_call_context(context: str) -> None:
    """All 6 server-access paths must enforce — pre-Step-3 only
    call_tool did. Block decision returns MCPPolicyBlocked across
    every context value."""
    fake = _fake_session()
    blocked = _enforce_mcp_policy(
        sensor_session=fake,
        server_url="stdio://x",
        server_name="some-server",
        transport="stdio",
        tool_name="x" if context in ("tool_call", "read_resource", "get_prompt") else None,
        originating_call_context=context,
    )
    assert isinstance(blocked, MCPPolicyBlocked)
    fake.event_queue.enqueue.assert_called_once()
    fake.event_queue.flush.assert_called_once()


def test_method_to_call_context_covers_all_six() -> None:
    """The method-name → context map must cover every patched
    ClientSession method. Drift-guard against a future patch
    table addition that forgets to register the context value."""
    expected = {
        "call_tool",
        "list_tools",
        "read_resource",
        "get_prompt",
        "list_resources",
        "list_prompts",
    }
    assert set(_METHOD_TO_CALL_CONTEXT.keys()) == expected


def test_originating_call_context_lands_on_extras() -> None:
    """The shared policy_decision block ships
    originating_call_context per call site."""
    fake = _fake_session()
    _enforce_mcp_policy(
        sensor_session=fake,
        server_url="stdio://x",
        server_name="some-server",
        transport="stdio",
        tool_name=None,
        originating_call_context="read_resource",
    )
    # The build_payload mock captured the extras; pull them.
    args, kwargs = fake._build_payload.call_args
    assert kwargs.get("originating_call_context") == "read_resource"


def test_item_names_helper_caps_at_100() -> None:
    """_collect_item_names truncates over 100 + sets the flag.
    Operationally bounded payload size for servers with huge
    inventories."""
    from flightdeck_sensor.interceptor.mcp import _collect_item_names

    names, truncated = _collect_item_names(f"tool_{i}" for i in range(150))
    assert len(names) == 100
    assert truncated is True
    assert names[0] == "tool_0"
    assert names[99] == "tool_99"


def test_item_names_helper_handles_empty() -> None:
    """Empty input produces an empty array, not None — the wire
    contract per Phase 7 Step 3 Q2 is "always-present array,
    possibly empty"."""
    from flightdeck_sensor.interceptor.mcp import _collect_item_names

    names, truncated = _collect_item_names(iter(()))
    assert names == []
    assert truncated is False


def test_item_names_helper_skips_none_values() -> None:
    """Defensive: an MCP server returning a tool with no name
    shouldn't populate item_names with None — skip the entry."""
    from flightdeck_sensor.interceptor.mcp import _collect_item_names

    names, _ = _collect_item_names(["echo", None, "add", "", "multiply"])
    assert names == ["echo", "add", "multiply"]
