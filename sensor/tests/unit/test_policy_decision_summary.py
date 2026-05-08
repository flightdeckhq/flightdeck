"""Phase 7 Step 2 (D148) — PolicyDecisionSummary contract tests.

Locks the canonical wire shape and the token-budget vs MCP
population paths so a future commit can't silently drift the
operator-actionable enrichment.
"""

from __future__ import annotations

from flightdeck_sensor.core.types import PolicyDecisionSummary


def test_token_budget_shape_emits_4_keys() -> None:
    """Token-budget events leave decision_path / matched_entry_*
    None so the dict has only the 4 always-on keys."""
    summary = PolicyDecisionSummary(
        policy_id="p1",
        scope="org",
        decision="warn",
        reason="Token usage 8000/10000 (80%) crossed warn threshold (80%, server policy)",
    )
    out = summary.as_payload_dict()
    assert set(out.keys()) == {"policy_id", "scope", "decision", "reason"}
    assert out["policy_id"] == "p1"
    assert out["scope"] == "org"
    assert out["decision"] == "warn"
    assert "decision_path" not in out
    assert "matched_entry_id" not in out
    assert "matched_entry_label" not in out


def test_mcp_shape_with_entry_emits_7_keys() -> None:
    """MCP entry-path decisions populate the full block including
    matched_entry_id + matched_entry_label."""
    summary = PolicyDecisionSummary(
        policy_id="policy-uuid",
        scope="flavor:research-agent",
        decision="block",
        reason="Server filesystem blocked by flavor entry, enforcement=block",
        decision_path="flavor_entry",
        matched_entry_id="entry-uuid",
        matched_entry_label="filesystem",
    )
    out = summary.as_payload_dict()
    assert set(out.keys()) == {
        "policy_id",
        "scope",
        "decision",
        "reason",
        "decision_path",
        "matched_entry_id",
        "matched_entry_label",
    }
    assert out["matched_entry_id"] == "entry-uuid"
    assert out["matched_entry_label"] == "filesystem"


def test_mcp_mode_default_path_omits_entry_fields() -> None:
    """Mode-default fall-through has no matched entry; matched_entry_id
    and matched_entry_label stay None and the as_payload_dict drops
    them. decision_path is still emitted."""
    summary = PolicyDecisionSummary(
        policy_id="policy-uuid",
        scope="global",
        decision="block",
        reason="Server unknown blocked by allow-list mode default; no matching allow entry",
        decision_path="mode_default",
    )
    out = summary.as_payload_dict()
    assert "decision_path" in out
    assert out["decision_path"] == "mode_default"
    assert "matched_entry_id" not in out
    assert "matched_entry_label" not in out


def test_dataclass_is_frozen() -> None:
    """The shared block is value-semantic — once built, it's a
    snapshot of the decision moment. Frozen prevents accidental
    mutation between build and emit."""
    from dataclasses import FrozenInstanceError

    import pytest

    summary = PolicyDecisionSummary(
        policy_id="p",
        scope="org",
        decision="warn",
        reason="r",
    )
    with pytest.raises(FrozenInstanceError):
        summary.policy_id = "different"  # type: ignore[misc]


def test_reason_pattern_no_newlines() -> None:
    """Operator-readable single-line per the locked Step 2 pattern.
    The dataclass doesn't enforce this directly (caller-supplied
    string), but the assertion documents the contract for emission
    sites and surfaces drift if a future commit accidentally
    embeds a newline."""
    examples = [
        "Token usage 8000/10000 (80%) crossed warn threshold (80%, server policy)",
        "Server filesystem warned by flavor entry, enforcement=warn",
        "Server unknown blocked by allow-list mode default; no matching allow entry",
    ]
    for r in examples:
        assert "\n" not in r, f"reason must be single-line: {r!r}"
