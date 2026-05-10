"""Phase 7 Step 2 (D148/D149) — MCP-policy event enrichment tests.

Confirms policy_mcp_warn / policy_mcp_block carry the shared
policy_decision block (with matched_entry_id + matched_entry_label
on entry-path decisions, None on mode_default), originating_call_
context, and originating_event_id when a call window is open.
"""

from __future__ import annotations

from flightdeck_sensor.core.mcp_policy import MCPPolicyDecision
from flightdeck_sensor.interceptor.mcp import (
    _build_mcp_policy_reason,
    _build_policy_event_extras,
)


def _decision(
    *,
    decision: str = "warn",
    decision_path: str = "flavor_entry",
    policy_id: str = "policy-uuid",
    scope: str = "flavor:research-agent",
    fingerprint: str = "fp-12345",
    matched_entry_id: str | None = None,
    matched_entry_label: str | None = None,
    block_on_uncertainty: bool = False,
) -> MCPPolicyDecision:
    return MCPPolicyDecision(
        decision=decision,  # type: ignore[arg-type]
        decision_path=decision_path,  # type: ignore[arg-type]
        policy_id=policy_id,
        scope=scope,
        fingerprint=fingerprint,
        block_on_uncertainty=block_on_uncertainty,
        matched_entry_id=matched_entry_id,
        matched_entry_label=matched_entry_label,
    )


def test_flavor_entry_warn_populates_full_block() -> None:
    """Entry-path decisions populate matched_entry_id +
    matched_entry_label on the shared block."""
    extras = _build_policy_event_extras(
        decision=_decision(
            matched_entry_id="entry-uuid",
            matched_entry_label="filesystem",
        ),
        server_url="stdio://example",
        server_name="filesystem",
        transport="stdio",
        tool_name="read_file",
    )
    pd = extras["policy_decision"]
    assert pd["policy_id"] == "policy-uuid"
    assert pd["scope"] == "flavor:research-agent"
    assert pd["decision"] == "warn"
    assert pd["decision_path"] == "flavor_entry"
    assert pd["matched_entry_id"] == "entry-uuid"
    assert pd["matched_entry_label"] == "filesystem"
    assert "filesystem" in pd["reason"]
    assert "flavor entry" in pd["reason"]


def test_mode_default_block_omits_matched_entry_fields() -> None:
    """Mode-default fall-through has no matched entry; the shared
    block omits matched_entry_id + matched_entry_label."""
    extras = _build_policy_event_extras(
        decision=_decision(
            decision="block",
            decision_path="mode_default",
            scope="global",
            block_on_uncertainty=True,
        ),
        server_url="stdio://unknown",
        server_name="unknown-server",
        transport="stdio",
        tool_name="some_tool",
    )
    pd = extras["policy_decision"]
    assert pd["decision_path"] == "mode_default"
    assert "matched_entry_id" not in pd
    assert "matched_entry_label" not in pd
    assert "allow-list mode default" in pd["reason"]
    assert "block_on_uncertainty=true" in pd["reason"]


def test_originating_call_context_defaults_to_tool_call() -> None:
    extras = _build_policy_event_extras(
        decision=_decision(),
        server_url="stdio://x",
        server_name="x",
        transport="stdio",
        tool_name="t",
    )
    assert extras["originating_call_context"] == "tool_call"


def test_originating_call_context_override() -> None:
    """Future emission paths (read_resource, list_tools, etc.)
    pass a different context value; the helper threads it through."""
    extras = _build_policy_event_extras(
        decision=_decision(),
        server_url="stdio://x",
        server_name="x",
        transport="stdio",
        tool_name=None,
        originating_call_context="read_resource",
    )
    assert extras["originating_call_context"] == "read_resource"


def test_legacy_top_level_fields_preserved() -> None:
    """Step 6 will consolidate; until then the dashboard renderers
    expect the legacy top-level policy_id / scope / decision_path /
    fingerprint to remain."""
    extras = _build_policy_event_extras(
        decision=_decision(),
        server_url="stdio://x",
        server_name="x",
        transport="stdio",
        tool_name="t",
    )
    assert extras["policy_id"] == "policy-uuid"
    assert extras["scope"] == "flavor:research-agent"
    assert extras["decision_path"] == "flavor_entry"
    assert extras["fingerprint"] == "fp-12345"


def test_block_on_uncertainty_only_on_block_path() -> None:
    """The legacy block_on_uncertainty top-level field appears only
    on block decisions, not warn (matches pre-Step-2 behaviour)."""
    warn_extras = _build_policy_event_extras(
        decision=_decision(decision="warn"),
        server_url="stdio://x",
        server_name="x",
        transport="stdio",
        tool_name="t",
    )
    assert "block_on_uncertainty" not in warn_extras

    block_extras = _build_policy_event_extras(
        decision=_decision(decision="block", block_on_uncertainty=True),
        server_url="stdio://x",
        server_name="x",
        transport="stdio",
        tool_name="t",
    )
    assert block_extras["block_on_uncertainty"] is True


def test_reason_string_is_single_line() -> None:
    """Locked Step 2 pattern: no newlines."""
    for path in ("flavor_entry", "global_entry", "mode_default"):
        for decision in ("warn", "block"):
            r = _build_mcp_policy_reason(
                _decision(
                    decision=decision,
                    decision_path=path,
                    block_on_uncertainty=(path == "mode_default" and decision == "block"),
                ),
                "test-server",
            )
            assert "\n" not in r, f"reason must be single-line for {path}/{decision}: {r!r}"
            assert "test-server" in r
