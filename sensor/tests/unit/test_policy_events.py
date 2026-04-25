"""Tests for policy enforcement event emission.

Covers the three policy event types — POLICY_WARN, POLICY_DEGRADE,
POLICY_BLOCK — across local and server-sourced enforcement paths.

See ARCHITECTURE.md "Event Types → policy_warn / policy_degrade /
policy_block" and DECISIONS.md D035.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.exceptions import BudgetExceededError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import (
    Directive,
    DirectiveAction,
    SensorConfig,
)
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.transport.client import ControlPlaneClient


def _make_session(
    *,
    token_limit: int | None = None,
    warn_at_pct: int = 80,
    degrade_at_pct: int = 90,
    block_at_pct: int = 100,
    degrade_to: str | None = None,
    local_limit: int | None = None,
    local_warn_at: float = 0.8,
) -> tuple[Session, MagicMock, AnthropicProvider]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    session.policy = PolicyCache(
        token_limit=token_limit,
        warn_at_pct=warn_at_pct,
        degrade_at_pct=degrade_at_pct,
        block_at_pct=block_at_pct,
        degrade_to=degrade_to,
        local_limit=local_limit,
        local_warn_at=local_warn_at,
    )
    # Replace the event queue with a MagicMock so we can introspect
    # enqueue() calls synchronously without dealing with the drain
    # thread.
    session.event_queue = MagicMock()
    return session, session.event_queue, AnthropicProvider()


def _events_of_type(eq: MagicMock, event_type: str) -> list[dict[str, Any]]:
    """Return the payloads enqueued for ``event_type`` in call order."""
    return [
        c[0][0]
        for c in eq.enqueue.call_args_list
        if c[0][0]["event_type"] == event_type
    ]


# ---------------------------------------------------------------------------
# UT-1: local WARN threshold emits policy_warn
# ---------------------------------------------------------------------------


def test_pre_call_emits_policy_warn_on_local_warn_threshold() -> None:
    session, eq, provider = _make_session(local_limit=100, local_warn_at=0.8)
    session._tokens_used = 80  # past 80% of local_limit=100 already
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=5)

    events = _events_of_type(eq, "policy_warn")
    assert len(events) == 1, f"expected 1 policy_warn, got {len(events)}"
    e = events[0]
    assert e["source"] == "local"
    assert e["threshold_pct"] == 80
    assert e["tokens_used"] == 80
    assert e["token_limit"] == 100


# ---------------------------------------------------------------------------
# UT-2: server WARN threshold emits policy_warn with fire-once semantics
# ---------------------------------------------------------------------------


def test_pre_call_emits_policy_warn_on_server_warn_threshold_fire_once() -> None:
    session, eq, provider = _make_session(token_limit=100, warn_at_pct=50)
    session._tokens_used = 60  # past 50% of token_limit
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=5)

    events = _events_of_type(eq, "policy_warn")
    assert len(events) == 1
    assert events[0]["source"] == "server"
    assert events[0]["threshold_pct"] == 50

    # Second call across the same threshold must NOT re-emit (fire-once).
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=5)
    events_after = _events_of_type(eq, "policy_warn")
    assert len(events_after) == 1, "policy_warn must fire-once per session"


# ---------------------------------------------------------------------------
# UT-3: server DEGRADE directive emits policy_degrade with from/to model
# ---------------------------------------------------------------------------


def test_apply_directive_degrade_emits_policy_degrade() -> None:
    session, eq, _provider = _make_session(
        token_limit=100, degrade_at_pct=50, degrade_to="claude-haiku-4-5"
    )
    session._tokens_used = 60
    session._model = "claude-sonnet-4-6"

    directive = Directive(
        action=DirectiveAction.DEGRADE,
        reason="budget threshold crossed",
        payload={"degrade_to": "claude-haiku-4-5"},
    )
    session._apply_directive(directive)

    degrade_events = _events_of_type(eq, "policy_degrade")
    assert len(degrade_events) == 1
    e = degrade_events[0]
    assert e["source"] == "server"
    assert e["from_model"] == "claude-sonnet-4-6"
    assert e["to_model"] == "claude-haiku-4-5"
    assert e["threshold_pct"] == 50
    assert e["tokens_used"] == 60
    assert e["token_limit"] is None  # token_limit is the session field, not policy

    # Decision-locked: POLICY_DEGRADE first, DIRECTIVE_RESULT second.
    types_in_order = [c[0][0]["event_type"] for c in eq.enqueue.call_args_list]
    assert types_in_order.index("policy_degrade") < types_in_order.index(
        "directive_result"
    )


# ---------------------------------------------------------------------------
# UT-4: forced-DEGRADE flag emits POLICY_DEGRADE once on directive arrival,
#       NOT on per-call swap. Per Decision 1 lock.
# ---------------------------------------------------------------------------


def test_forced_degrade_emits_one_event_per_directive_arm() -> None:
    session, eq, provider = _make_session(
        token_limit=100, degrade_at_pct=50, degrade_to="claude-haiku-4-5"
    )
    session._tokens_used = 60
    session._model = "claude-sonnet-4-6"
    directive = Directive(
        action=DirectiveAction.DEGRADE,
        reason="budget threshold crossed",
        payload={"degrade_to": "claude-haiku-4-5"},
    )
    session._apply_directive(directive)

    degrade_events_before_swap = _events_of_type(eq, "policy_degrade")
    assert len(degrade_events_before_swap) == 1

    # Subsequent _pre_call invocations on the armed session swap the
    # model but must NOT re-emit policy_degrade. Per-call swaps are
    # visible via post_call.model only.
    out_kwargs = base._pre_call(
        session, provider, {"model": "claude-sonnet-4-6"}, estimated=5
    )
    assert out_kwargs["model"] == "claude-haiku-4-5"
    out_kwargs2 = base._pre_call(
        session, provider, {"model": "claude-sonnet-4-6"}, estimated=5
    )
    assert out_kwargs2["model"] == "claude-haiku-4-5"

    degrade_events_after_swaps = _events_of_type(eq, "policy_degrade")
    assert len(degrade_events_after_swaps) == 1, (
        "forced-degrade must emit one policy_degrade per directive arm; "
        "per-call swaps must NOT re-emit"
    )


# ---------------------------------------------------------------------------
# UT-5: BLOCK emits policy_block AND flushes BEFORE raising
# ---------------------------------------------------------------------------


def test_pre_call_emits_policy_block_then_flushes_before_raising() -> None:
    session, eq, provider = _make_session(token_limit=100, block_at_pct=50)
    session._tokens_used = 60

    with pytest.raises(BudgetExceededError):
        base._pre_call(
            session, provider, {"model": "claude-sonnet-4-6"}, estimated=5
        )

    # Event must have been enqueued before the raise.
    block_events = _events_of_type(eq, "policy_block")
    assert len(block_events) == 1
    e = block_events[0]
    assert e["source"] == "server"  # hardcoded per D035
    assert e["threshold_pct"] == 50
    assert e["tokens_used"] == 60
    assert e["token_limit"] == 100
    assert e["intended_model"] == "claude-sonnet-4-6"

    # flush() must have been called synchronously so the event lands
    # before BudgetExceededError tears the call down.
    eq.flush.assert_called_once()


# ---------------------------------------------------------------------------
# UT-6: ALLOW decisions emit zero policy events
# ---------------------------------------------------------------------------


def test_no_policy_event_when_decision_is_allow() -> None:
    session, eq, provider = _make_session(token_limit=1000, warn_at_pct=80)
    session._tokens_used = 100  # well under 80% threshold
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=10)

    for event_type in ("policy_warn", "policy_degrade", "policy_block"):
        assert _events_of_type(eq, event_type) == [], (
            f"unexpected {event_type} on ALLOW decision"
        )


# ---------------------------------------------------------------------------
# UT-7: BLOCK source is always "server" — local never escalates per D035
# ---------------------------------------------------------------------------


def test_policy_block_source_always_server() -> None:
    """Per D035, local PolicyCache fires WARN only — never BLOCK or
    DEGRADE. The hardcoded ``source="server"`` on policy_block reflects
    that architectural invariant. If the local-WARN-only contract is
    ever relaxed, this test fails loudly so a code reviewer must
    examine the source field carefully.
    """
    session, eq, provider = _make_session(
        token_limit=100, block_at_pct=50, local_limit=50, local_warn_at=0.8
    )
    session._tokens_used = 60

    with pytest.raises(BudgetExceededError):
        base._pre_call(
            session, provider, {"model": "claude-sonnet-4-6"}, estimated=5
        )

    e = _events_of_type(eq, "policy_block")[0]
    assert e["source"] == "server", "BLOCK source must be 'server' (D035)"


# ---------------------------------------------------------------------------
# UT-8: emitted payloads carry the contract-level fields and nothing surprising
# ---------------------------------------------------------------------------


def test_policy_event_payload_shape() -> None:
    """For each of warn / degrade / block, the emitted event carries
    the documented fields. Catches accidental field renames that would
    break the dashboard's strict consumer.
    """
    expected_fields = {
        "source",
        "threshold_pct",
        "tokens_used",
        "token_limit",
        "event_type",
        "session_id",
        "agent_id",
        "agent_name",
        "agent_type",
        "client_type",
        "user",
        "hostname",
        "flavor",
        "host",
        "framework",
        "model",
        "tokens_input",
        "tokens_output",
        "tokens_total",
        "tokens_cache_read",
        "tokens_cache_creation",
        "tokens_used_session",
        "token_limit_session",
        "latency_ms",
        "tool_name",
        "tool_input",
        "tool_result",
        "has_content",
        "content",
        "timestamp",
    }

    # WARN
    session, eq, provider = _make_session(token_limit=100, warn_at_pct=50)
    session._tokens_used = 60
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=5)
    warn = _events_of_type(eq, "policy_warn")[0]
    assert expected_fields.issubset(warn.keys()), (
        f"policy_warn missing fields: {expected_fields - warn.keys()}"
    )

    # DEGRADE — extra fields from_model / to_model on top of the base set
    session2, eq2, _ = _make_session(
        token_limit=100, degrade_at_pct=50, degrade_to="claude-haiku-4-5"
    )
    session2._tokens_used = 60
    session2._model = "claude-sonnet-4-6"
    session2._apply_directive(
        Directive(
            action=DirectiveAction.DEGRADE,
            reason="x",
            payload={"degrade_to": "claude-haiku-4-5"},
        )
    )
    degrade = _events_of_type(eq2, "policy_degrade")[0]
    assert "from_model" in degrade and "to_model" in degrade

    # BLOCK — extra field intended_model
    session3, eq3, provider3 = _make_session(token_limit=100, block_at_pct=50)
    session3._tokens_used = 60
    with pytest.raises(BudgetExceededError):
        base._pre_call(
            session3, provider3, {"model": "claude-sonnet-4-6"}, estimated=5
        )
    block = _events_of_type(eq3, "policy_block")[0]
    assert "intended_model" in block


# ---------------------------------------------------------------------------
# UT-9: BLOCK captures intended_model so operators can answer
# "which call was blocked?"
# ---------------------------------------------------------------------------


def test_policy_block_includes_intended_model() -> None:
    session, eq, provider = _make_session(token_limit=100, block_at_pct=50)
    session._tokens_used = 60
    intended = "claude-opus-4-7"
    with pytest.raises(BudgetExceededError):
        base._pre_call(session, provider, {"model": intended}, estimated=5)

    e = _events_of_type(eq, "policy_block")[0]
    assert e["intended_model"] == intended


# ---------------------------------------------------------------------------
# UT-10: local WARN and server WARN fire independently, distinguishable
# via the source field
# ---------------------------------------------------------------------------


def test_local_and_server_warn_fire_independently() -> None:
    """Local and server WARN both configured; server crosses first
    (most-restrictive-wins inside check()), local crosses on a
    subsequent call. Both fire once each, distinguishable by source.

    Server block / degrade thresholds are pinned high enough that
    neither short-circuits the check inside the bumped tokens range
    used here — this test isolates warn-only behaviour across both
    sources.
    """
    session, eq, provider = _make_session(
        token_limit=10_000,           # large server limit so block never fires
        warn_at_pct=1,                # server warn at 100 tokens
        degrade_at_pct=99,            # well above the bumped token range
        block_at_pct=99,              # ditto
        local_limit=200,
        local_warn_at=0.9,            # local warn at 180 tokens
    )
    # First call: tokens_used=110+5 estimated=115 → past server warn
    # (100), under local warn (180). Expect server WARN.
    session._tokens_used = 110
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=5)
    warn_events = _events_of_type(eq, "policy_warn")
    assert len(warn_events) == 1
    assert warn_events[0]["source"] == "server"

    # Bump tokens past local threshold and call again. Server WARN has
    # already fired-once; local now fires once.
    session._tokens_used = 185
    base._pre_call(session, provider, {"model": "claude-sonnet-4-6"}, estimated=5)
    warn_events = _events_of_type(eq, "policy_warn")
    assert len(warn_events) == 2
    assert warn_events[1]["source"] == "local"
