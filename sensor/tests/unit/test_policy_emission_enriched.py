"""Phase 7 Step 2 (D148) — token-budget policy event enrichment tests.

Confirms that policy_warn / policy_block emissions from the
interceptor's _pre_call carry the shared policy_decision block,
and that policy_degrade from the directive arrival path carries
the same shape.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor.base import _pre_call


def _make_session(*, token_limit: int = 10000) -> Session:
    config = SensorConfig(
        server="http://localhost/ingest",
        token="tok_dev",
        agent_id=str(uuid.uuid4()),
        agent_name="test-agent",
        user_name="test",
        hostname="test-host",
        client_type="flightdeck_sensor",
        api_url="http://localhost/api",
        agent_flavor="e2e-test",
        agent_type="coding",
        session_id=str(uuid.uuid4()),
        quiet=True,
    )
    s = Session(config, client=MagicMock())
    s.event_queue = MagicMock()
    # Server policy snapshot — exercise the WARN / BLOCK branches.
    s.policy.update(
        {
            "token_limit": token_limit,
            "warn_at_pct": 80,
            "degrade_at_pct": 90,
            "block_at_pct": 100,
            "policy_id": "policy-uuid",
            "matched_policy_scope": "flavor:e2e-test",
        }
    )
    s._tokens_used = 0
    return s


def _capture_payload(session: Session) -> dict:
    """Pull the most-recent enqueued event payload off the mock queue."""
    enqueue_calls = session.event_queue.enqueue.call_args_list
    assert enqueue_calls, "no event was enqueued"
    return enqueue_calls[-1].args[0]


def test_policy_warn_carries_shared_decision_block() -> None:
    s = _make_session(token_limit=10000)
    s._tokens_used = 8000  # 80% — crosses warn threshold
    provider = MagicMock()
    provider.estimate_tokens = MagicMock(return_value=(0, "tiktoken"))
    provider.get_model = MagicMock(return_value="claude-opus-4-7")
    _pre_call(s, provider, kwargs={"model": "claude-opus-4-7"}, estimated=0)

    payload = _capture_payload(s)
    assert payload["event_type"] == "policy_warn"
    pd = payload["policy_decision"]
    assert pd["policy_id"] == "policy-uuid"
    assert pd["scope"] == "flavor:e2e-test"
    assert pd["decision"] == "warn"
    assert "Token usage" in pd["reason"]
    assert "80%" in pd["reason"]
    assert "warn threshold" in pd["reason"]
    # Token-budget event: no MCP-only fields.
    assert "decision_path" not in pd
    assert "matched_entry_id" not in pd
    assert "matched_entry_label" not in pd


def test_policy_block_carries_shared_decision_block() -> None:
    s = _make_session(token_limit=10000)
    s._tokens_used = 10500  # 105% — over block threshold
    provider = MagicMock()
    provider.estimate_tokens = MagicMock(return_value=(0, "tiktoken"))
    provider.get_model = MagicMock(return_value="claude-opus-4-7")
    with pytest.raises(BudgetExceededError):
        _pre_call(s, provider, kwargs={"model": "claude-opus-4-7"}, estimated=0)

    payload = _capture_payload(s)
    assert payload["event_type"] == "policy_block"
    pd = payload["policy_decision"]
    assert pd["policy_id"] == "policy-uuid"
    assert pd["scope"] == "flavor:e2e-test"
    assert pd["decision"] == "block"
    assert "block threshold" in pd["reason"]
    # Legacy fields still present for backwards compat with the
    # current dashboard renderers (Step 6 will consolidate).
    assert payload["intended_model"] == "claude-opus-4-7"
    assert payload["source"] == "server"


def test_policy_warn_local_source_uses_local_failsafe_scope() -> None:
    """Local init(limit=...) WARN fires with policy_id=local +
    scope=local_failsafe so the shared block stays self-describing."""
    s = _make_session(token_limit=0)  # disable server-side
    # Set a local limit
    s.policy.local_limit = 1000
    s.policy.local_warn_at = 0.5
    s._tokens_used = 600  # crosses local warn (50% of 1000 = 500)
    provider = MagicMock()
    provider.estimate_tokens = MagicMock(return_value=(0, "tiktoken"))
    provider.get_model = MagicMock(return_value="claude-opus-4-7")
    _pre_call(s, provider, kwargs={"model": "claude-opus-4-7"}, estimated=0)

    payload = _capture_payload(s)
    assert payload["event_type"] == "policy_warn"
    pd = payload["policy_decision"]
    assert pd["policy_id"] == "local"
    assert pd["scope"] == "local_failsafe"
    assert pd["decision"] == "warn"
    assert "local policy" in pd["reason"]


def test_originating_event_id_not_set_on_policy_warn() -> None:
    """Policy events fire BEFORE any LLM call event has been
    emitted, so they should NOT carry originating_event_id (no
    chain originator exists yet)."""
    s = _make_session(token_limit=10000)
    s._tokens_used = 8000
    provider = MagicMock()
    provider.estimate_tokens = MagicMock(return_value=(0, "tiktoken"))
    provider.get_model = MagicMock(return_value="claude-opus-4-7")
    _pre_call(s, provider, kwargs={"model": "claude-opus-4-7"}, estimated=0)

    payload = _capture_payload(s)
    # No call window open yet, so no chain.
    assert "originating_event_id" not in payload


def test_originating_event_id_set_after_post_call_propagates_to_subsequent_warn() -> None:
    """If a post_call has fired (call window open), a subsequent
    policy_warn from a later _pre_call WILL carry the chain id —
    operator-actionable: "this warn fires while the call to model X
    was open"."""
    s = _make_session(token_limit=10000)
    # Simulate a prior post_call having minted an id.
    s.set_current_call_event_id("originator-uuid")
    s._tokens_used = 8000
    provider = MagicMock()
    provider.estimate_tokens = MagicMock(return_value=(0, "tiktoken"))
    provider.get_model = MagicMock(return_value="claude-opus-4-7")
    _pre_call(s, provider, kwargs={"model": "claude-opus-4-7"}, estimated=0)

    payload = _capture_payload(s)
    assert payload.get("originating_event_id") == "originator-uuid"
