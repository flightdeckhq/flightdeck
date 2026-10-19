"""Wire contract of server-driven policy events and child session starts.

The ingestion API rejects every ``policy_*`` event that lacks the shared
``policy_decision`` block (``policy_id``, ``scope``, ``decision`` and
``reason``, all non-empty strings), and it persists a session's capture
posture from the first ``session_start`` it sees for that session id.
These tests pin both contracts on the sensor side so a regression shows
up here instead of as a silent HTTP 400 in a live run.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import Directive, DirectiveAction, SensorConfig
from flightdeck_sensor.transport.client import ControlPlaneClient

_REQUIRED_DECISION_FIELDS = ("policy_id", "scope", "decision", "reason")
_POLICY_ID = "eda44fda-d00b-4b1a-923c-8f5f28cf6641"


def _make_session(capture_prompts: bool = True) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture_prompts,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    return Session(config=config, client=client), client


def _assert_clears_validator(payload: dict[str, Any], decision: str) -> None:
    block = payload["policy_decision"]
    for field in _REQUIRED_DECISION_FIELDS:
        assert isinstance(block[field], str) and block[field], field
    assert block["decision"] == decision


def _enqueued(session: Session) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [call.args[0] for call in queue.enqueue.call_args_list]


def test_server_warn_directive_carries_the_fetched_policy_identity() -> None:
    session, _ = _make_session()
    session.policy.policy_id = _POLICY_ID
    session.policy.matched_policy_scope = "flavor:test"
    session.event_queue = MagicMock()

    session._apply_directive(Directive(action=DirectiveAction.WARN, reason="token_budget_warning"))

    (payload,) = _enqueued(session)
    assert payload["event_type"] == "policy_warn"
    assert payload["source"] == "server"
    _assert_clears_validator(payload, "warn")
    assert payload["policy_decision"]["policy_id"] == _POLICY_ID
    assert payload["policy_decision"]["scope"] == "flavor:test"
    assert "token_budget_warning" in payload["policy_decision"]["reason"]
    assert payload["threshold_pct"] == session.policy.warn_at_pct


def test_server_warn_directive_names_the_server_when_no_policy_was_fetched() -> None:
    session, _ = _make_session()
    assert session.policy.policy_id is None
    session.event_queue = MagicMock()

    session._apply_directive(Directive(action=DirectiveAction.WARN, reason="token_budget_warning"))

    (payload,) = _enqueued(session)
    _assert_clears_validator(payload, "warn")
    assert payload["policy_decision"]["policy_id"] == "server"
    assert payload["policy_decision"]["scope"] == "server"


def test_server_degrade_directive_names_the_server_when_no_policy_was_fetched() -> None:
    session, _ = _make_session()
    session.event_queue = MagicMock()

    session._apply_directive(
        Directive(
            action=DirectiveAction.DEGRADE,
            reason="token_budget_degrade",
            payload={"degrade_to": "claude-haiku-4-5-20251001"},
        )
    )

    degrade = next(p for p in _enqueued(session) if p["event_type"] == "policy_degrade")
    _assert_clears_validator(degrade, "degrade")
    assert degrade["policy_decision"]["policy_id"] == "server"
    assert degrade["policy_decision"]["scope"] == "server"


def test_child_session_start_carries_the_parent_capture_posture() -> None:
    for capture in (True, False):
        session, client = _make_session(capture_prompts=capture)
        session.emit_subagent_session_start(
            child_session_id="4f4a4b9c-7c1e-4b6d-9d2a-0d2c3c8c9a01",
            child_agent_id="a2a8323c-1d86-5a5f-abaa-d2e7c376136c",
            child_agent_name="Researcher",
            agent_role="Researcher",
            incoming_message=None,
        )
        (payload,), _ = client.post_event.call_args
        assert payload["event_type"] == "session_start"
        assert payload["parent_session_id"] == session.config.session_id
        assert payload["capture_prompts"] is capture
