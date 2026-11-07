"""The ``agent_handoff`` session_signal the sensor emits.

``Session.emit_agent_handoff`` is the call the framework wraps (Google
ADK, the OpenAI Agents SDK) make when one agent hands the conversation
to another. It must produce the payload the OTLP GenAI receiver
produces for the same fact (``ingestion/internal/genai/normalize.go``
``handoff``), so the worker and the dashboard need no second shape:
``event_type=session_signal``, ``signal=agent_handoff``,
``signal_data`` ``{from, to}``, no model, no tokens and no content,
whatever the capture setting.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.session import (
    HANDOFF_AGENT_NAME_MAX_BYTES,
    SIGNAL_AGENT_HANDOFF,
    Session,
)
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.transport.client import ControlPlaneClient

ROOT_SESSION = "11111111-1111-4111-8111-111111111111"
CHILD_SESSION = "22222222-2222-4222-8222-222222222222"
CHILD_AGENT = "33333333-3333-4333-8333-333333333333"

GENAI = Path(__file__).resolve().parents[3] / "ingestion" / "internal" / "genai"

# Fields minted per event, which two otherwise equal payloads differ in.
PER_EVENT = ("id", "timestamp")


def _session(*, capture_prompts: bool) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_id="44444444-4444-4444-4444-444444444444",
        agent_name="handoff-parent",
        user_name="tester",
        hostname="host1",
        client_type="flightdeck_sensor",
        agent_flavor="playground-test",
        agent_type="coding",
        session_id=ROOT_SESSION,
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    return Session(config=config, client=client), client


def _posted(client: MagicMock) -> list[dict[str, Any]]:
    return [c.args[0] for c in client.post_event.call_args_list]


def _child_identity() -> dict[str, str]:
    return {
        "child_session_id": CHILD_SESSION,
        "child_agent_id": CHILD_AGENT,
        "child_agent_name": "handoff-parent/weather_agent",
        "agent_role": "weather_agent",
    }


def test_root_handoff_payload_is_the_receivers_signal() -> None:
    session, client = _session(capture_prompts=False)

    session.emit_agent_handoff(from_agent="triage_agent", to_agent="weather_agent")

    (p,) = _posted(client)
    assert p["event_type"] == "session_signal" == EventType.SESSION_SIGNAL.value
    assert p["signal"] == "agent_handoff" == SIGNAL_AGENT_HANDOFF
    assert p["signal_data"] == {"from": "triage_agent", "to": "weather_agent"}
    assert p["session_id"] == ROOT_SESSION
    assert p["client_type"] == "flightdeck_sensor"
    assert p["agent_type"] == "coding"
    assert p["flavor"] == "playground-test"
    # No model, no tokens, no content.
    assert p["model"] is None
    assert p["tokens_input"] is None
    assert p["tokens_output"] is None
    assert p["tokens_total"] is None
    assert p["has_content"] is False
    assert p["content"] is None
    # A root session's signal names no parent.
    assert "parent_session_id" not in p
    assert "agent_role" not in p


@pytest.mark.parametrize("capture_prompts", [False, True])
def test_capture_setting_does_not_change_the_payload(capture_prompts: bool) -> None:
    """The agent names are metadata: sent with capture off, and capture on
    adds nothing (no content envelope, no handed-over input)."""
    session, client = _session(capture_prompts=capture_prompts)

    session.emit_agent_handoff(from_agent="triage_agent", to_agent="weather_agent")
    session.emit_agent_handoff(
        from_agent="triage_agent", to_agent="weather_agent", **_child_identity()
    )

    root, child = _posted(client)
    for p in (root, child):
        assert p["signal_data"] == {"from": "triage_agent", "to": "weather_agent"}
        assert p["has_content"] is False
        assert p["content"] is None
        assert not ({"incoming_message", "outgoing_message"} & p.keys())


def test_capture_on_and_off_send_identical_payloads() -> None:
    sent: list[dict[str, Any]] = []
    for capture in (False, True):
        session, client = _session(capture_prompts=capture)
        session.emit_agent_handoff(from_agent="a", to_agent="b")
        (p,) = _posted(client)
        sent.append({k: v for k, v in p.items() if k not in PER_EVENT})
    assert sent[0] == sent[1]


def test_child_handoff_goes_on_the_child_session() -> None:
    session, client = _session(capture_prompts=False)

    session.emit_agent_handoff(
        from_agent="weather_agent", to_agent="billing_agent", **_child_identity()
    )

    (p,) = _posted(client)
    assert p["session_id"] == CHILD_SESSION
    assert p["parent_session_id"] == ROOT_SESSION
    assert p["agent_role"] == "weather_agent"
    assert p["agent_id"] == CHILD_AGENT
    assert p["agent_name"] == "handoff-parent/weather_agent"
    # The child's own running state, not the parent's.
    assert p["tokens_used_session"] == 0
    assert p["token_limit_session"] is None
    # Deployment fields inherit from the parent.
    assert p["flavor"] == "playground-test"
    assert p["user"] == "tester"
    assert p["hostname"] == "host1"
    assert p["signal_data"] == {"from": "weather_agent", "to": "billing_agent"}


@pytest.mark.parametrize(
    "drop", ["child_session_id", "child_agent_id", "child_agent_name", "agent_role"]
)
def test_a_partial_child_identity_is_not_sent(drop: str, caplog: pytest.LogCaptureFixture) -> None:
    session, client = _session(capture_prompts=False)
    identity: dict[str, Any] = _child_identity()
    identity[drop] = None

    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.core.session"):
        session.emit_agent_handoff(from_agent="a", to_agent="b", **identity)

    client.post_event.assert_not_called()
    assert "part of a child session's identity" in caplog.text


def test_an_empty_child_identity_field_is_not_sent() -> None:
    session, client = _session(capture_prompts=False)
    identity: dict[str, Any] = _child_identity()
    identity["agent_role"] = ""

    session.emit_agent_handoff(from_agent="a", to_agent="b", **identity)

    client.post_event.assert_not_called()


@pytest.mark.parametrize(
    ("from_agent", "to_agent", "want"),
    [
        ("  triage_agent\n", "\tweather_agent ", {"from": "triage_agent", "to": "weather_agent"}),
        (None, "weather_agent", {"to": "weather_agent"}),
        ("triage_agent", None, {"from": "triage_agent"}),
        ("", "   ", {}),
        (None, None, {}),
    ],
)
def test_names_are_trimmed_and_unknown_names_left_out(
    from_agent: str | None, to_agent: str | None, want: dict[str, str]
) -> None:
    session, client = _session(capture_prompts=False)

    session.emit_agent_handoff(from_agent=from_agent, to_agent=to_agent)

    (p,) = _posted(client)
    assert p["signal_data"] == want


def test_a_name_that_is_not_a_string_is_left_out() -> None:
    session, client = _session(capture_prompts=False)

    session.emit_agent_handoff(from_agent=42, to_agent=object())  # type: ignore[arg-type]

    (p,) = _posted(client)
    assert p["signal_data"] == {}


def test_a_long_name_is_cut_at_a_utf8_boundary() -> None:
    session, client = _session(capture_prompts=False)
    # 255 ASCII bytes then a 3-byte character: the character would end
    # past the bound, so it is cut whole.
    long_name = "a" * 255 + "€" + "tail"

    session.emit_agent_handoff(from_agent=long_name, to_agent="é" * 200)

    (p,) = _posted(client)
    frm, to = p["signal_data"]["from"], p["signal_data"]["to"]
    assert frm == "a" * 255
    assert to == "é" * 128
    assert len(to.encode("utf-8")) == HANDOFF_AGENT_NAME_MAX_BYTES


def test_the_sessions_model_is_not_stamped_on_the_signal() -> None:
    """The worker makes a signal's model the session's model, so the
    hand-off carries none even after the session has seen a call."""
    session, client = _session(capture_prompts=False)
    session.record_model("gpt-4o")

    session.emit_agent_handoff(from_agent="a", to_agent="b")
    session.emit_agent_handoff(from_agent="a", to_agent="b", **_child_identity())

    for p in _posted(client):
        assert p["model"] is None


def test_the_signal_is_not_chained_to_the_last_call() -> None:
    """The receiver's hand-off has no originating_event_id; neither does
    the sensor's, even inside a call window."""
    session, client = _session(capture_prompts=False)
    session.set_current_call_event_id("55555555-5555-4555-8555-555555555555")

    session.emit_agent_handoff(from_agent="a", to_agent="b")

    (p,) = _posted(client)
    assert "originating_event_id" not in p


def test_the_signal_is_posted_synchronously() -> None:
    """Posted, not queued: a queued signal could reach ingestion after the
    child's synchronous session_end, and the worker would drop it."""
    session, client = _session(capture_prompts=False)
    session.event_queue = MagicMock()

    session.emit_agent_handoff(from_agent="a", to_agent="b")
    session.emit_agent_handoff(from_agent="a", to_agent="b", **_child_identity())

    assert client.post_event.call_count == 2
    session.event_queue.enqueue.assert_not_called()


def test_a_root_handoff_applies_a_returned_directive() -> None:
    session, client = _session(capture_prompts=False)
    directive = MagicMock()
    client.post_event.return_value = (directive, False)
    session._apply_directive = MagicMock()  # type: ignore[method-assign]

    session.emit_agent_handoff(from_agent="a", to_agent="b")

    session._apply_directive.assert_called_once_with(directive)


def test_a_failed_post_never_raises(caplog: pytest.LogCaptureFixture) -> None:
    session, client = _session(capture_prompts=False)
    client.post_event.side_effect = RuntimeError("transport broke")

    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.core.session"):
        session.emit_agent_handoff(from_agent="a", to_agent="b")
        session.emit_agent_handoff(from_agent="a", to_agent="b", **_child_identity())

    assert caplog.text.count("agent_handoff was not reported") == 2


def test_signal_name_and_bound_match_the_receiver() -> None:
    """The receiver's signal name and name bound, read from its source, so
    a change on one side fails here rather than splitting the stored
    shape."""
    normalize = (GENAI / "normalize.go").read_text()
    identity = (GENAI / "identity.go").read_text()
    name = re.search(r'signalHandoff\s*=\s*"([a-z_]+)"', normalize)
    bound = re.search(r"const maxIdentityBytes\s*=\s*(\d+)", identity)
    assert name is not None and bound is not None
    assert name.group(1) == SIGNAL_AGENT_HANDOFF
    assert int(bound.group(1)) == HANDOFF_AGENT_NAME_MAX_BYTES
