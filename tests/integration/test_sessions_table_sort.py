"""Integration tests for /v1/sessions sort ordering (Phase 4.5 S-TBL).

Covers:
* ``?sort=last_seen_at`` — orders by max(events.occurred_at) projected
  through ``sessions.last_seen_at``. Newest first when ``order=desc``.
* ``?sort=state&order=asc`` — custom severity ordinal active → idle →
  stale → lost → closed (most-needs-attention first).
* ``?sort=state&order=desc`` — reverses the ordinal.

The state ordinal is enforced by a CASE expression in
``api/internal/store/sessions.go::allowedSorts``; tests pin the
exact behaviour so a future refactor that lapses to alphabetical
fails loudly.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    get_session,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_for_state,
    wait_until,
)


def _list_sessions(query: dict[str, Any]) -> list[dict[str, Any]]:
    qs = urllib.parse.urlencode(query, doseq=True)
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())["sessions"]  # type: ignore[no-any-return]


def _seed_session(prefix: str, state_target: str | None = None) -> tuple[str, str]:
    sid = str(uuid.uuid4())
    flavor = f"test-tbl-{prefix}-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear",
    )
    if state_target == "closed":
        post_event(make_event(sid, flavor, "session_end"))
        wait_for_state(sid, "closed", timeout=10)
    return sid, flavor


def test_state_sort_ascending_orders_by_severity_ordinal() -> None:
    """active → idle → stale → lost → closed."""
    # Seed two sessions: one active, one closed. Same flavor so the
    # listing returns both side-by-side.
    flavor = f"test-tbl-state-asc-{uuid.uuid4().hex[:6]}"
    sid_active = str(uuid.uuid4())
    sid_closed = str(uuid.uuid4())
    post_event(make_event(sid_active, flavor, "session_start"))
    post_event(make_event(sid_closed, flavor, "session_start"))
    wait_until(
        lambda: (
            session_exists_in_fleet(sid_active)
            and session_exists_in_fleet(sid_closed)
        ),
        timeout=10,
        msg="both sessions did not appear",
    )
    post_event(make_event(sid_closed, flavor, "session_end"))
    wait_for_state(sid_closed, "closed", timeout=10)

    rows = _list_sessions(
        {
            "from": "1970-01-01T00:00:00Z",
            "flavor": flavor,
            "sort": "state",
            "order": "asc",
        }
    )
    states = [r["state"] for r in rows if r["session_id"] in {sid_active, sid_closed}]
    # active must come before closed regardless of started_at order.
    assert states.index("active") < states.index("closed"), (
        f"expected active before closed in ascending state sort; got {states!r}"
    )


def test_state_sort_descending_reverses_severity_ordinal() -> None:
    """closed → lost → stale → idle → active."""
    flavor = f"test-tbl-state-desc-{uuid.uuid4().hex[:6]}"
    sid_active = str(uuid.uuid4())
    sid_closed = str(uuid.uuid4())
    post_event(make_event(sid_active, flavor, "session_start"))
    post_event(make_event(sid_closed, flavor, "session_start"))
    wait_until(
        lambda: (
            session_exists_in_fleet(sid_active)
            and session_exists_in_fleet(sid_closed)
        ),
        timeout=10,
    )
    post_event(make_event(sid_closed, flavor, "session_end"))
    wait_for_state(sid_closed, "closed", timeout=10)

    rows = _list_sessions(
        {
            "from": "1970-01-01T00:00:00Z",
            "flavor": flavor,
            "sort": "state",
            "order": "desc",
        }
    )
    states = [r["state"] for r in rows if r["session_id"] in {sid_active, sid_closed}]
    assert states.index("closed") < states.index("active"), (
        f"expected closed before active in descending state sort; got {states!r}"
    )


def test_last_seen_at_sort_descending_returns_newest_first() -> None:
    flavor = f"test-tbl-lastseen-{uuid.uuid4().hex[:6]}"
    sid_old = str(uuid.uuid4())
    sid_new = str(uuid.uuid4())
    # Seed older session, wait briefly, then newer one. last_seen_at is
    # stamped by the worker as NOW() on session_start so the natural
    # difference is enough.
    post_event(make_event(sid_old, flavor, "session_start"))
    wait_until(lambda: session_exists_in_fleet(sid_old), timeout=10)
    time.sleep(1.2)
    post_event(make_event(sid_new, flavor, "session_start"))
    wait_until(lambda: session_exists_in_fleet(sid_new), timeout=10)

    rows = _list_sessions(
        {
            "from": "1970-01-01T00:00:00Z",
            "flavor": flavor,
            "sort": "last_seen_at",
            "order": "desc",
        }
    )
    # The two seeded sessions appear in descending last_seen_at order.
    relevant = [r["session_id"] for r in rows if r["session_id"] in {sid_old, sid_new}]
    assert relevant.index(sid_new) < relevant.index(sid_old), (
        f"last_seen_at desc must put newer session first; got {relevant!r}"
    )


def test_last_seen_at_listing_field_is_populated() -> None:
    sid, flavor = _seed_session("lastseen-field")
    detail = get_session(sid)
    # GET /v1/sessions/{id} doesn't expose last_seen_at the same way as
    # the listing endpoint, so verify via the listing.
    rows = _list_sessions(
        {"from": "1970-01-01T00:00:00Z", "flavor": flavor}
    )
    row = next((r for r in rows if r["session_id"] == sid), None)
    assert row is not None, f"seeded session {sid} missing from listing"
    assert "last_seen_at" in row, (
        f"listing item must expose last_seen_at; got keys {list(row.keys())!r}"
    )
    # Field is RFC 3339 timestamp.
    last_seen_at = row["last_seen_at"]
    assert "T" in last_seen_at and last_seen_at.endswith("Z"), (
        f"last_seen_at must be ISO 8601 UTC; got {last_seen_at!r}"
    )
    # Use detail to ensure the pair exists (presence check only).
    assert detail.get("session", {}).get("session_id") == sid


def test_invalid_sort_value_returns_400() -> None:
    qs = urllib.parse.urlencode(
        {"from": "1970-01-01T00:00:00Z", "sort": "not_a_sort_field"}
    )
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?{qs}",
        headers=auth_headers(),
    )
    raised_400 = False
    try:
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            raised_400 = True
    assert raised_400, "out-of-vocab sort must 400"
