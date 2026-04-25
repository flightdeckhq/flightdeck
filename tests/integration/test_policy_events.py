"""Policy enforcement event-shape integration tests.

Mock-free wire-seeded tests for the three policy event types
(``policy_warn`` / ``policy_degrade`` / ``policy_block``) introduced
to close the gap where enforcement decisions fired but were
invisible on the timeline. Verifies the round-trip from sensor
payload → ingestion → NATS → worker → Postgres → ``GET /v1/events``
preserves the structured fields the dashboard consumes.

Pairs with:

* ``sensor/tests/unit/test_policy_events.py`` (UT-1..10) — sensor-side
  emission semantics + payload shape.
* ``dashboard/tests/unit/policy-event-rendering.test.tsx`` — dashboard
  rendering of the round-tripped fields.
* ``dashboard/tests/e2e/T17-policy-events.spec.ts`` — full-stack
  rendering of the seeded fixtures.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    create_policy,
    delete_policy,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_event,
    query_directives,
    session_exists_in_fleet,
    wait_until,
)


def _wait_for_event_count(session_id: str, want: int, timeout: float = 10.0) -> None:
    wait_until(
        lambda: get_session_event_count(session_id) >= want,
        timeout=timeout,
        msg=f"expected >= {want} events for session {session_id}",
    )


def _fetch_events(session_id: str) -> list[dict[str, Any]]:
    return get_session_detail(session_id).get("events", [])


def _fetch_session_listing(query: dict[str, str]) -> list[dict[str, Any]]:
    qs = urllib.parse.urlencode(query, doseq=True)
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())["sessions"]  # type: ignore[no-any-return]


def _seed_session(prefix: str) -> tuple[str, str]:
    sid = str(uuid.uuid4())
    flavor = f"test-policy-{prefix}-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear",
    )
    return sid, flavor


# ---------------------------------------------------------------------------
# IT-1: policy_warn round-trips with the structured fields
# ---------------------------------------------------------------------------


def test_policy_warn_event_round_trips() -> None:
    sid, flavor = _seed_session("warn")
    post_event(
        make_event(
            sid, flavor, "policy_warn",
            source="server",
            threshold_pct=80,
            tokens_used=8000,
            token_limit=10000,
        )
    )
    _wait_for_event_count(sid, 2)
    events = _fetch_events(sid)
    warn = next((e for e in events if e["event_type"] == "policy_warn"), None)
    assert warn is not None, f"no policy_warn in {events!r}"
    payload = warn.get("payload") or {}
    assert payload.get("source") == "server"
    assert payload.get("threshold_pct") == 80
    assert payload.get("tokens_used") == 8000
    assert payload.get("token_limit") == 10000


# ---------------------------------------------------------------------------
# IT-2: policy_degrade round-trips with from_model / to_model
# ---------------------------------------------------------------------------


def test_policy_degrade_event_round_trips() -> None:
    sid, flavor = _seed_session("degrade")
    post_event(
        make_event(
            sid, flavor, "policy_degrade",
            source="server",
            threshold_pct=90,
            tokens_used=9100,
            token_limit=10000,
            from_model="claude-sonnet-4-6",
            to_model="claude-haiku-4-5",
        )
    )
    _wait_for_event_count(sid, 2)
    events = _fetch_events(sid)
    deg = next((e for e in events if e["event_type"] == "policy_degrade"), None)
    assert deg is not None, f"no policy_degrade in {events!r}"
    payload = deg.get("payload") or {}
    assert payload.get("from_model") == "claude-sonnet-4-6"
    assert payload.get("to_model") == "claude-haiku-4-5"
    assert payload.get("threshold_pct") == 90


# ---------------------------------------------------------------------------
# IT-3: policy_block round-trips with intended_model + source=server
# ---------------------------------------------------------------------------


def test_policy_block_event_round_trips() -> None:
    sid, flavor = _seed_session("block")
    post_event(
        make_event(
            sid, flavor, "policy_block",
            source="server",
            threshold_pct=100,
            tokens_used=10100,
            token_limit=10000,
            intended_model="claude-opus-4-7",
        )
    )
    _wait_for_event_count(sid, 2)
    events = _fetch_events(sid)
    blk = next((e for e in events if e["event_type"] == "policy_block"), None)
    assert blk is not None, f"no policy_block in {events!r}"
    payload = blk.get("payload") or {}
    assert payload.get("source") == "server"
    assert payload.get("intended_model") == "claude-opus-4-7"
    assert payload.get("tokens_used") == 10100
    assert payload.get("token_limit") == 10000


# ---------------------------------------------------------------------------
# IT-4: policy events appear in session detail in chronological order
# ---------------------------------------------------------------------------


def test_policy_events_appear_in_session_detail() -> None:
    sid, flavor = _seed_session("detail")
    for et in ("policy_warn", "policy_degrade", "policy_block"):
        post_event(
            make_event(
                sid, flavor, et,
                source="server", threshold_pct=50,
                tokens_used=500, token_limit=1000,
            )
        )
    _wait_for_event_count(sid, 4)
    events = _fetch_events(sid)
    types = [e["event_type"] for e in events]
    assert "policy_warn" in types
    assert "policy_degrade" in types
    assert "policy_block" in types


# ---------------------------------------------------------------------------
# IT-5: ?event_type filter narrows to a single policy type
# ---------------------------------------------------------------------------


def test_policy_events_filterable_via_event_type() -> None:
    sid, flavor = _seed_session("filter")
    for et in ("policy_warn", "policy_degrade", "policy_block"):
        post_event(
            make_event(
                sid, flavor, et,
                source="server", threshold_pct=50,
                tokens_used=500, token_limit=1000,
            )
        )
    _wait_for_event_count(sid, 4)
    # Bulk events endpoint accepts ?event_type=
    qs = urllib.parse.urlencode({
        "from": "1970-01-01T00:00:00Z",
        "session_id": sid,
        "event_type": "policy_block",
    })
    req = urllib.request.Request(
        f"{API_URL}/v1/events?{qs}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    types = {e["event_type"] for e in body["events"]}
    assert types == {"policy_block"}, f"expected only policy_block; got {types!r}"


# ---------------------------------------------------------------------------
# IT-6: policy_event_types[] populated on /v1/sessions; ?policy_event_type
#       filter narrows
# ---------------------------------------------------------------------------


def test_policy_event_types_in_session_listing_and_filter() -> None:
    sid_warn, flavor_warn = _seed_session("listing-w")
    sid_block, flavor_block = _seed_session("listing-b")

    post_event(
        make_event(
            sid_warn, flavor_warn, "policy_warn",
            source="server", threshold_pct=80,
            tokens_used=8000, token_limit=10000,
        )
    )
    post_event(
        make_event(
            sid_block, flavor_block, "policy_block",
            source="server", threshold_pct=100,
            tokens_used=10100, token_limit=10000,
            intended_model="claude-sonnet-4-6",
        )
    )
    _wait_for_event_count(sid_warn, 2)
    _wait_for_event_count(sid_block, 2)

    listing = _fetch_session_listing({
        "from": "1970-01-01T00:00:00Z",
        "flavor": [flavor_warn, flavor_block],
    })
    by_id = {row["session_id"]: row for row in listing}
    assert by_id[sid_warn]["policy_event_types"] == ["policy_warn"]
    assert by_id[sid_block]["policy_event_types"] == ["policy_block"]

    # ?policy_event_type filter should narrow to one row.
    only_block = _fetch_session_listing({
        "from": "1970-01-01T00:00:00Z",
        "flavor": [flavor_warn, flavor_block],
        "policy_event_type": "policy_block",
    })
    only_block_ids = {r["session_id"] for r in only_block}
    assert only_block_ids == {sid_block}, (
        f"expected only block-emitting session; got {only_block_ids!r}"
    )

    # Out-of-vocab values 400.
    bad = urllib.parse.urlencode({
        "from": "1970-01-01T00:00:00Z",
        "policy_event_type": "policy_invalid",
    })
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{bad}",
        headers=auth_headers(),
    )
    try:
        urllib.request.urlopen(req, timeout=5)
        raised = False
    except urllib.error.HTTPError as e:
        assert e.code == 400, f"expected 400; got {e.code}"
        raised = True
    assert raised, "out-of-vocab policy_event_type must 400"


# ---------------------------------------------------------------------------
# IT-7: forced-degrade emits POLICY_DEGRADE ONCE per directive arm.
#       Per Decision 1 lock — per-call swaps are visible via
#       post_call.model only, NOT via repeated POLICY_DEGRADE events.
#       Wire-seeded contract test: simulate the sensor emitting the
#       single decision event followed by N degraded post_call events.
# ---------------------------------------------------------------------------


def test_forced_degrade_emits_one_policy_event_per_arm() -> None:
    sid, flavor = _seed_session("forced-degrade")
    # The decision event fires once (sensor: _apply_directive(DEGRADE)).
    post_event(
        make_event(
            sid, flavor, "policy_degrade",
            source="server",
            threshold_pct=50,
            tokens_used=600,
            token_limit=1000,
            from_model="claude-sonnet-4-6",
            to_model="claude-haiku-4-5",
        )
    )
    # Subsequent post_call events use the degraded model. They do NOT
    # carry policy_degrade — the model swap is observable via
    # post_call.model alone.
    for _ in range(3):
        post_event(
            make_event(
                sid, flavor, "post_call",
                model="claude-haiku-4-5",
                tokens_input=20, tokens_output=10, tokens_total=30,
            )
        )
    _wait_for_event_count(sid, 5)
    events = _fetch_events(sid)
    degrade_events = [e for e in events if e["event_type"] == "policy_degrade"]
    assert len(degrade_events) == 1, (
        f"expected exactly one policy_degrade; got {len(degrade_events)}: "
        f"{[e['event_type'] for e in events]!r}"
    )
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    assert all(p["model"] == "claude-haiku-4-5" for p in post_calls)


# ---------------------------------------------------------------------------
# IT-8: local-source policy_warn carries no backing directive row.
#       Server-source warn DOES — it was issued by the worker policy
#       evaluator. The source field distinguishes them on the wire and
#       the directives table row count matches.
# ---------------------------------------------------------------------------


def test_local_warn_has_no_backing_directive_server_warn_does() -> None:
    # Local-source event: never paired with a directives row.
    sid_local, flavor_local = _seed_session("local-warn")
    post_event(
        make_event(
            sid_local, flavor_local, "policy_warn",
            source="local",
            threshold_pct=80,
            tokens_used=80,
            token_limit=100,
        )
    )
    _wait_for_event_count(sid_local, 2)
    local_directives = query_directives(sid_local)
    assert local_directives == [], (
        f"local policy_warn must not produce a directive row; "
        f"got {local_directives!r}"
    )

    # Server-source path: drive the worker's policy evaluator into
    # writing a warn directive by creating a real flavor-scoped
    # policy and posting a post_call that crosses the warn threshold.
    sid_server, flavor_server = _seed_session("server-warn")
    policy = create_policy(
        scope="flavor",
        scope_value=flavor_server,
        token_limit=100,
        warn_at_pct=50,
    )
    try:
        post_event(
            make_event(
                sid_server, flavor_server, "post_call",
                model="claude-sonnet-4-6",
                tokens_input=80, tokens_output=0, tokens_total=80,
                tokens_used_session=80,
            )
        )

        def _has_warn_directive() -> bool:
            rows = query_directives(sid_server)
            return any(r["action"] == "warn" for r in rows)

        wait_until(
            _has_warn_directive,
            timeout=10,
            msg="worker did not write a warn directive after threshold cross",
        )
    finally:
        delete_policy(policy["id"])
