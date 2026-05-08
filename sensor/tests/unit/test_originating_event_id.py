"""Phase 7 Step 2 (D149) — originating_event_id chain contract tests.

Locks the sensor-side UUID minting + the chain-stamping behaviour
across the call window. The audit's "operator-actionable triage"
workflow depends on this — without the chain, the dashboard can't
correlate a tool_call back to the post_call that originated it.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig


def _make_session() -> Session:
    """Build a Session with the lightest possible config for unit
    tests. Mocks the transport client + queue; we only care about
    payload-build behaviour."""
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
    client = MagicMock()
    s = Session(config, client=client)
    s.event_queue = MagicMock()
    return s


def test_build_payload_mints_uuid_id() -> None:
    """Every event payload carries a freshly-minted UUID under
    payload['id']. The worker uses this directly via INSERT ON
    CONFLICT for idempotent retry."""
    s = _make_session()
    payload = s._build_payload(EventType.POST_CALL)
    assert "id" in payload
    # uuid.UUID round-trip validates the format.
    parsed = uuid.UUID(payload["id"])
    assert str(parsed) == payload["id"]


def test_consecutive_emissions_have_distinct_ids() -> None:
    """Two payload builds must mint two distinct UUIDs — the chain
    breaks if the sensor reuses ids across emissions."""
    s = _make_session()
    p1 = s._build_payload(EventType.POST_CALL)
    p2 = s._build_payload(EventType.POST_CALL)
    assert p1["id"] != p2["id"]


def test_set_get_current_call_event_id_lifecycle() -> None:
    """The chain primitive: set on post_call, read by downstream
    events. None outside an active call window."""
    s = _make_session()
    assert s.get_current_call_event_id() is None

    s.set_current_call_event_id("abc-123")
    assert s.get_current_call_event_id() == "abc-123"

    s.set_current_call_event_id(None)
    assert s.get_current_call_event_id() is None


def test_chained_event_picks_up_originating_id() -> None:
    """When an LLM call window is open (current_call_event_id set),
    a chained event type (e.g. POLICY_MCP_BLOCK) carries
    originating_event_id pointing at the originator."""
    s = _make_session()
    s.set_current_call_event_id("originator-uuid")
    payload = s._build_payload(EventType.POLICY_MCP_BLOCK)
    assert payload.get("originating_event_id") == "originator-uuid"


def test_originator_event_does_not_self_reference() -> None:
    """POST_CALL is the originator, not a chained event. Even if a
    prior chain id is set (e.g. from a previous call window), the
    new POST_CALL emission must NOT carry originating_event_id (it
    becomes the new originator)."""
    s = _make_session()
    s.set_current_call_event_id("previous-uuid")
    payload = s._build_payload(EventType.POST_CALL)
    assert "originating_event_id" not in payload


def test_call_window_independent_event_skips_chain() -> None:
    """SESSION_START / SESSION_END / MCP_SERVER_ATTACHED happen
    outside any LLM call window — they should never carry an
    originating_event_id even when current_call_event_id is set
    (which it shouldn't be at session boundaries, but defensive)."""
    s = _make_session()
    s.set_current_call_event_id("any-prior-id")
    for event_type in (
        EventType.SESSION_START,
        EventType.SESSION_END,
        EventType.MCP_SERVER_ATTACHED,
        EventType.MCP_SERVER_NAME_CHANGED,
        EventType.DIRECTIVE_RESULT,
    ):
        payload = s._build_payload(event_type)
        assert "originating_event_id" not in payload, (
            f"{event_type} must not carry originating_event_id"
        )


def test_chain_uses_None_when_no_window_open() -> None:
    """A chained event built before any call window opens gets no
    originating_event_id field (not present at all, not null)."""
    s = _make_session()
    assert s.get_current_call_event_id() is None
    payload = s._build_payload(EventType.POLICY_MCP_WARN)
    assert "originating_event_id" not in payload
