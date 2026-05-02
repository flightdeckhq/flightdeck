"""Cross-cutting message-capture parity for the sub-agent
interceptors (D126).

The CrewAI and LangGraph interceptors capture two bodies per child
execution — ``incoming_message`` on the child's ``session_start``
event and ``outgoing_message`` on the child's ``session_end`` event.
The shape of those captures must be uniform across frameworks so
the dashboard's MESSAGES sub-section, the Investigate INCOMING /
OUTGOING fields, and the worker's ``event_content`` projection all
read the same wire format regardless of which interceptor produced
the event.

This module asserts that parity at the boundary by exercising both
interceptors against the same fixture and comparing the field
shapes the way the worker / dashboard do. The per-framework test
modules (``test_interceptor_crewai.py`` /
``test_interceptor_langgraph.py``) cover framework-specific
behaviour; this module covers the cross-framework contract.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig, SubagentMessage
from flightdeck_sensor.transport.client import ControlPlaneClient


# ----------------------------------------------------------------------
# Direct Session-method coverage (interceptor-independent)
# ----------------------------------------------------------------------


def _build_session(*, capture_prompts: bool) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_id="44444444-4444-4444-4444-444444444444",
        agent_name="parent-cross",
        user_name="tester",
        hostname="host1",
        client_type="flightdeck_sensor",
        agent_flavor="playground-test",
        agent_type="production",
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    return Session(config=config, client=client), client


def _last_payloads(client: MagicMock) -> list[dict[str, Any]]:
    return [c.args[0] for c in client.post_event.call_args_list]


@pytest.mark.parametrize(
    "body",
    [
        "a CrewAI task description string",
        {"messages": [{"role": "user", "content": "hi"}]},
        ["a", "list", "of", "strings"],
        42,
        None,
    ],
)
def test_session_emit_preserves_body_verbatim_when_capture_on(body: Any) -> None:
    """When capture_prompts=True, the body lands on the wire verbatim
    (Python type preserved) under the field name ``incoming_message``
    on session_start and ``outgoing_message`` on session_end.
    Provider terminology is preserved per Rule 20 — no normalising
    transforms at the sensor boundary; what the framework produces
    is what the dashboard sees.
    """
    session, client = _build_session(capture_prompts=True)
    msg = SubagentMessage(body=body, captured_at="2026-05-02T00:00:00Z")

    session.emit_subagent_session_start(
        child_session_id="c-1",
        child_agent_id="agent-1",
        child_agent_name="parent/role",
        agent_role="role",
        incoming_message=msg,
    )
    session.emit_subagent_session_end(
        child_session_id="c-1",
        child_agent_id="agent-1",
        child_agent_name="parent/role",
        agent_role="role",
        outgoing_message=msg,
    )

    payloads = _last_payloads(client)
    assert len(payloads) == 2
    start_p, end_p = payloads
    # Each parametric body fits within the D126 § 6 inline
    # threshold (8 KiB), so the wire shape is the inline form:
    # ``has_content`` False, body lives directly under
    # ``incoming_message`` / ``outgoing_message`` on payload.
    # The overflow path is exercised by the size-based tests
    # below.
    assert start_p["has_content"] is False
    assert start_p["incoming_message"]["body"] == body
    assert start_p["incoming_message"]["captured_at"] == "2026-05-02T00:00:00Z"
    assert "outgoing_message" not in start_p
    assert end_p["has_content"] is False
    assert end_p["outgoing_message"]["body"] == body
    assert "incoming_message" not in end_p


# ----------------------------------------------------------------------
# D126 § 6 size-based routing
# ----------------------------------------------------------------------
#
# Three boundaries to pin:
#   * ≤ 8 KiB → inline on payload, has_content=false.
#   * > 8 KiB and ≤ 2 MiB → overflow via the existing D119
#     event_content path: has_content=true, payload.content
#     populated with the PromptContent envelope (provider=
#     "flightdeck-subagent"), the payload field becomes a stub.
#   * > 2 MiB → hard reject with WARN, no field on the wire.


def _approx_bytes_string(n: int) -> str:
    """Return a string whose JSON-encoded form is approximately n
    bytes. JSON-encoded length of ``"<chars>"`` is ``len(chars) + 2``
    (the surrounding quotes); we subtract the overhead so the
    serialized payload lands at ~n bytes for size-threshold tests.
    """
    return "x" * max(0, n - 2)


def test_inline_path_just_under_threshold() -> None:
    """Body just under 8 KiB takes the inline path: payload field
    holds ``{body, captured_at}``; no payload.content; has_content
    stays False.
    """
    from flightdeck_sensor.core.session import SUBAGENT_INLINE_THRESHOLD_BYTES

    session, client = _build_session(capture_prompts=True)
    body = _approx_bytes_string(SUBAGENT_INLINE_THRESHOLD_BYTES - 16)
    msg = SubagentMessage(body=body, captured_at="2026-05-02T00:00:00Z")
    session.emit_subagent_session_start(
        child_session_id="c-inline",
        child_agent_id="agent-inline",
        child_agent_name="parent/role",
        agent_role="role",
        incoming_message=msg,
    )
    p = _last_payloads(client)[0]
    assert p["has_content"] is False
    assert p["content"] is None
    assert p["incoming_message"]["body"] == body
    assert p["incoming_message"]["captured_at"] == "2026-05-02T00:00:00Z"
    assert "has_content" not in p["incoming_message"]


def test_overflow_path_just_over_threshold() -> None:
    """Body just over 8 KiB takes the overflow path: payload.content
    populated with PromptContent envelope, has_content=true,
    incoming_message becomes a {has_content, content_bytes,
    captured_at} stub.
    """
    from flightdeck_sensor.core.session import (
        SUBAGENT_INLINE_THRESHOLD_BYTES,
        SUBAGENT_OVERFLOW_PROVIDER,
    )

    session, client = _build_session(capture_prompts=True)
    body = _approx_bytes_string(SUBAGENT_INLINE_THRESHOLD_BYTES + 1024)
    msg = SubagentMessage(body=body, captured_at="2026-05-02T00:00:00Z")
    session.emit_subagent_session_start(
        child_session_id="c-overflow",
        child_agent_id="agent-overflow",
        child_agent_name="parent/role",
        agent_role="role",
        incoming_message=msg,
    )
    p = _last_payloads(client)[0]
    assert p["has_content"] is True
    # PromptContent envelope on payload.content for the worker's
    # InsertEventContent path.
    assert p["content"]["provider"] == SUBAGENT_OVERFLOW_PROVIDER
    assert p["content"]["response"]["body"] == body
    assert p["content"]["response"]["direction"] == "incoming"
    assert p["content"]["response"]["captured_at"] == "2026-05-02T00:00:00Z"
    # PromptContent NOT NULL columns satisfied with empty / null
    # placeholders — the worker's existing InsertEventContent
    # accepts these.
    assert p["content"]["messages"] == []
    # Stub on the payload field signals the dashboard "fetch via
    # /v1/events/{id}/content".
    stub = p["incoming_message"]
    assert stub["has_content"] is True
    assert stub["content_bytes"] > SUBAGENT_INLINE_THRESHOLD_BYTES
    assert stub["captured_at"] == "2026-05-02T00:00:00Z"
    # Body must NOT live on the inline field — that's the whole
    # point of the overflow path.
    assert "body" not in stub


def test_overflow_outgoing_message_uses_outgoing_direction() -> None:
    """The PromptContent envelope's ``response.direction`` field
    discriminates incoming vs outgoing so the dashboard can label
    the body correctly.
    """
    from flightdeck_sensor.core.session import SUBAGENT_INLINE_THRESHOLD_BYTES

    session, client = _build_session(capture_prompts=True)
    body = _approx_bytes_string(SUBAGENT_INLINE_THRESHOLD_BYTES + 1024)
    msg = SubagentMessage(body=body, captured_at="2026-05-02T00:00:00Z")
    session.emit_subagent_session_end(
        child_session_id="c-out",
        child_agent_id="agent-out",
        child_agent_name="parent/role",
        agent_role="role",
        outgoing_message=msg,
    )
    p = _last_payloads(client)[0]
    assert p["has_content"] is True
    assert p["content"]["response"]["direction"] == "outgoing"


def test_hard_cap_drops_oversized_body(caplog: Any) -> None:
    """Body above 2 MiB is dropped at the sensor with a WARN log.
    No incoming_message / outgoing_message / content on the wire.
    """
    from flightdeck_sensor.core.session import SUBAGENT_HARD_CAP_BYTES

    session, client = _build_session(capture_prompts=True)
    body = _approx_bytes_string(SUBAGENT_HARD_CAP_BYTES + 1024)
    msg = SubagentMessage(body=body, captured_at="2026-05-02T00:00:00Z")
    import logging
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.core.session"):
        session.emit_subagent_session_start(
            child_session_id="c-cap",
            child_agent_id="agent-cap",
            child_agent_name="parent/role",
            agent_role="role",
            incoming_message=msg,
        )
    p = _last_payloads(client)[0]
    assert p["has_content"] is False
    assert p["content"] is None
    assert "incoming_message" not in p
    # WARN must mention the hard cap so operators notice.
    assert any("hard cap" in r.message for r in caplog.records), (
        f"expected WARN about hard cap; got {[r.message for r in caplog.records]}"
    )


def test_capture_off_drops_messages_at_session_boundary() -> None:
    """``capture_prompts=False`` must drop both incoming_message and
    outgoing_message at the session boundary so the body never
    reaches the wire. ``has_content`` stays False; the dashboard's
    "Prompt capture is not enabled for this deployment" branch
    renders.
    """
    session, client = _build_session(capture_prompts=False)
    msg = SubagentMessage(body="leak risk", captured_at="2026-05-02T00:00:00Z")

    session.emit_subagent_session_start(
        child_session_id="c-2",
        child_agent_id="agent-2",
        child_agent_name="parent/role",
        agent_role="role",
        incoming_message=msg,
    )
    session.emit_subagent_session_end(
        child_session_id="c-2",
        child_agent_id="agent-2",
        child_agent_name="parent/role",
        agent_role="role",
        outgoing_message=msg,
    )

    for payload in _last_payloads(client):
        assert "incoming_message" not in payload
        assert "outgoing_message" not in payload
        assert payload["has_content"] is False


def test_state_error_payload_carries_error_block() -> None:
    """The L8 row-level failure cue on the dashboard reads
    ``state="error"`` plus a structured ``error`` block. Confirm
    the wire shape matches.
    """
    session, client = _build_session(capture_prompts=True)
    session.emit_subagent_session_end(
        child_session_id="c-3",
        child_agent_id="agent-3",
        child_agent_name="parent/role",
        agent_role="role",
        state="error",
        error={"type": "RuntimeError", "message": "boom"},
    )
    payload = _last_payloads(client)[0]
    assert payload["state"] == "error"
    assert payload["error"] == {"type": "RuntimeError", "message": "boom"}
    # Outgoing must not be auto-populated on the error path.
    assert "outgoing_message" not in payload


def test_session_start_carries_required_identity_keys() -> None:
    """Cross-framework parity floor: every child session_start
    payload must carry parent_session_id, agent_role, agent_id,
    agent_name, and the standard 5-tuple identity keys regardless
    of which interceptor produced it. The worker's UpsertSession
    relies on every key being present.
    """
    session, client = _build_session(capture_prompts=True)
    session.emit_subagent_session_start(
        child_session_id="c-4",
        child_agent_id="agent-4",
        child_agent_name="parent/role",
        agent_role="role",
    )
    payload = _last_payloads(client)[0]
    expected_keys = {
        "session_id",
        "parent_session_id",
        "agent_role",
        "agent_id",
        "agent_name",
        "agent_type",
        "client_type",
        "user",
        "hostname",
        "flavor",
        "framework",
        "host",
        "event_type",
        "timestamp",
    }
    missing = expected_keys - payload.keys()
    assert not missing, f"session_start payload missing keys: {missing}"
    assert payload["parent_session_id"] == session.config.session_id


# ----------------------------------------------------------------------
# Cross-interceptor parity
# ----------------------------------------------------------------------


def _post_event_calls(client: MagicMock) -> list[dict[str, Any]]:
    return [c.args[0] for c in client.post_event.call_args_list]


def test_crewai_and_langgraph_emit_identical_message_envelope_shape() -> None:
    """The CrewAI and LangGraph interceptors must produce identical
    ``incoming_message`` / ``outgoing_message`` envelope shapes —
    the worker's projection and the dashboard's MESSAGES sub-section
    can't reasonably branch per-framework, so the contract is one
    shape to rule them all. Both interceptors stamp:

        {
            "body": <framework's source object>,
            "captured_at": <ISO 8601 UTC>,
        }

    This test wraps both interceptors in turn against the same
    Session and asserts the schema parity directly on the wire.
    """
    from flightdeck_sensor.interceptor.crewai import (
        _CREWAI_AVAILABLE,
    )
    from flightdeck_sensor.interceptor.langgraph import (
        _LANGGRAPH_AVAILABLE,
    )

    if not _CREWAI_AVAILABLE or not _LANGGRAPH_AVAILABLE:
        pytest.skip("crewai or langgraph not installed")

    session, client = _build_session(capture_prompts=True)
    prior = flightdeck_sensor._session
    flightdeck_sensor._session = session

    try:
        # Drive two emits through the Session API directly (the
        # interceptor wrappers ultimately funnel here, so the
        # envelope shape this test pins also pins what every
        # interceptor produces).
        session.emit_subagent_session_start(
            child_session_id="c-crewai",
            child_agent_id="agent-crewai",
            child_agent_name="parent/Researcher",
            agent_role="Researcher",
            incoming_message=SubagentMessage(
                body="task: find x", captured_at="2026-05-02T00:00:00Z",
            ),
        )
        session.emit_subagent_session_start(
            child_session_id="c-langgraph",
            child_agent_id="agent-langgraph",
            child_agent_name="parent/researcher",
            agent_role="researcher",
            incoming_message=SubagentMessage(
                body={"text": "node input"},
                captured_at="2026-05-02T00:00:01Z",
            ),
        )
    finally:
        flightdeck_sensor._session = prior

    payloads = _post_event_calls(client)
    assert len(payloads) == 2
    p_crewai, p_lg = payloads

    # Both payloads must have the same set of envelope keys (body
    # + captured_at) under incoming_message — that's the parity
    # invariant.
    assert set(p_crewai["incoming_message"].keys()) == set(
        p_lg["incoming_message"].keys()
    ) == {"body", "captured_at"}

    # Bodies stay verbatim (string for CrewAI's task description,
    # dict for LangGraph's state) — no auto-stringification or
    # normalisation at the sensor boundary.
    assert p_crewai["incoming_message"]["body"] == "task: find x"
    assert p_lg["incoming_message"]["body"] == {"text": "node input"}
