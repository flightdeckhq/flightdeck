"""Wire-seeded round-trip of ``provider_metadata.platform`` on ``post_call``.

The sensor attributes every Anthropic ``post_call`` to the platform the
client talked to under ``provider_metadata.platform``. This test seeds
such an event through the real ingestion API and reads it back through
the API, so the key survives validation, NATS, the worker and Postgres
and comes out as ``events[].payload.provider_metadata.platform``.

Parallel-safe: a unique flavor and session id, no worker pause, no
global state.
"""

from __future__ import annotations

import uuid

from .conftest import (
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)


def test_post_call_provider_metadata_platform_roundtrips() -> None:
    sid = str(uuid.uuid4())
    flavor = f"test-anthropic-platform-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid), timeout=10,
        msg=f"session {sid} did not appear",
    )

    post_event(make_event(
        sid, flavor, "post_call",
        model="claude-haiku-4-5-20251001",
        tokens_input=16, tokens_output=9, tokens_total=25,
        provider_metadata={"platform": "anthropic", "request_id": "req_test"},
    ))
    wait_until(
        lambda: get_session_event_count(sid) >= 2, timeout=10,
        msg=f"expected >= 2 events for session {sid}",
    )

    events = get_session_detail(sid).get("events", [])
    pc = next((e for e in events if e["event_type"] == "post_call"), None)
    assert pc is not None, f"no post_call in {events!r}"
    pm = (pc.get("payload") or {}).get("provider_metadata")
    assert pm is not None, f"no provider_metadata sub-object; event={pc!r}"
    assert pm["platform"] == "anthropic"
    assert pm["request_id"] == "req_test"
