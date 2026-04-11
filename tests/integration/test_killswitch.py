"""Integration tests for the kill switch and directive delivery pipeline.

Tests the full flow: dashboard POST /v1/directives → Postgres → ingestion
delivers in response envelope → session transitions to closed.
Requires `make dev` to be running.
"""

from __future__ import annotations

import uuid

from .conftest import (
    directive_has_delivered_at,
    make_event,
    post_directive,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def test_single_agent_kill() -> None:
    """POST /v1/directives with session_id → directive delivered → session closed."""
    sid = str(uuid.uuid4())
    flavor = f"killswitch-single-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet after session_start",
    )

    # Issue shutdown directive via API
    directive = post_directive(
        action="shutdown",
        session_id=sid,
        reason="test_kill",
    )
    assert directive.get("id") is not None, (
        f"directive POST did not return id: {directive}"
    )

    # Post event via ingestion to trigger directive delivery
    envelope = post_event(make_event(sid, flavor, "post_call", tokens_total=10))
    assert envelope.get("directive") is not None, (
        f"directive missing from response envelope for session {sid}: {envelope}"
    )
    assert envelope["directive"]["action"] == "shutdown", (
        f"expected action=shutdown, got {envelope['directive'].get('action')}"
    )

    # Verify directive was marked delivered in DB
    directive_id = directive["id"]
    wait_until(
        lambda: directive_has_delivered_at(directive_id),
        timeout=5,
        msg=f"directive {directive_id} not marked delivered after pickup",
    )


def test_fleet_wide_kill() -> None:
    """POST /v1/directives with flavor → all sessions of that flavor receive shutdown."""
    sid_a = str(uuid.uuid4())
    sid_b = str(uuid.uuid4())
    flavor = f"killswitch-fleet-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid_a, flavor, "session_start"))
    post_event(make_event(sid_b, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid_a) and session_exists_in_fleet(sid_b),
        timeout=10,
        msg=f"sessions {sid_a} and {sid_b} did not appear in fleet",
    )

    # Issue fleet-wide shutdown
    directive = post_directive(
        action="shutdown_flavor",
        flavor=flavor,
        reason="test_fleet_kill",
    )
    assert directive.get("id") is not None, (
        f"fleet directive POST did not return id: {directive}"
    )

    # Post events for both sessions to trigger delivery
    envelope_a = post_event(make_event(sid_a, flavor, "post_call", tokens_total=10))
    envelope_b = post_event(make_event(sid_b, flavor, "post_call", tokens_total=10))

    assert envelope_a.get("directive") is not None, (
        f"session A ({sid_a}) did not receive directive: {envelope_a}"
    )
    assert envelope_b.get("directive") is not None, (
        f"session B ({sid_b}) did not receive directive: {envelope_b}"
    )


def test_directive_delivered_exactly_once() -> None:
    """Directive appears in first response envelope but not in subsequent ones."""
    sid = str(uuid.uuid4())
    flavor = f"killswitch-once-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear in fleet",
    )

    post_directive(action="shutdown", session_id=sid, reason="test_once")

    # First event should receive the directive
    first_envelope = post_event(make_event(sid, flavor, "post_call", tokens_total=5))
    assert first_envelope.get("directive") is not None, (
        f"directive missing from first response for session {sid}"
    )

    # Second event should NOT receive the directive (already delivered)
    second_envelope = post_event(make_event(sid, flavor, "post_call", tokens_total=5))
    assert second_envelope.get("directive") is None, (
        f"directive re-delivered in second response: {second_envelope.get('directive')}"
    )


# test_directive_not_redelivered_after_acknowledged -- removed in Phase
# 4.5 audit Task 1. Subset of test_directive_delivered_exactly_once
# (which already verifies the second envelope is null) plus
# test_single_agent_kill (which already verifies delivered_at via
# directive_has_delivered_at). No unique coverage was being added.
