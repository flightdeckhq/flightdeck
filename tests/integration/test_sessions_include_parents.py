"""Integration test for ``GET /v1/sessions?include_parents=true``.

The Fleet swimlane loads the most-recent 100 sessions in a single
fetch and resolves sub-agent topology client-side from the result
set. When a busy deployment has more than 100 sessions, the
100-row window can carry child sessions whose parent fell off the
LIMIT cliff (the parent is older or otherwise outside the
``from`` time-range filter). Without parent-augmentation the
swimlane's ``deriveRelationship`` walks an incomplete in-memory
roster and stamps the orphaned child as ``topology="lone"``.

This test pins the contract:

* ``include_parents`` defaults off — pure pagination semantics
  unchanged (returned row count <= LIMIT).
* ``include_parents=true`` augments the page with the parent of
  every child in the page even when the parent is older than the
  ``from`` window. The parent's row carries ``parent_session_id ==
  null`` (it's a root) and has the same column projection as the
  rest of the response.

The seed shape: one parent at T-2h (outside the swimlane's
typical 24h lookback IS still in window, so to force the
"parent off the page" condition we drop the ``from`` filter and
seed > LIMIT children — easier in test harness terms — and rely
on a tight ``limit=N`` window plus an explicit
``from=<now>`` filter that excludes the older parent.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .conftest import (
    API_URL,
    auth_headers,
    exec_sql,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_until,
)

# Window deltas. The two "off" / "on" tests use a 30-minute
# ``from`` window that excludes the parent's 3-hour backdate; the
# dedup test uses a tight 5-minute window where neither session is
# old enough to fall outside.
_FROM_WINDOW_MINUTES = 30
_BACKDATE_HOURS = 3
_DEDUP_WINDOW_MINUTES = 5


def _list_sessions(params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}/v1/sessions?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _seed_parent_outside_window(*, flavor: str, parent_sid: str) -> None:
    """Seed a parent session whose started_at predates the ``from``
    filter the test will pass. Pushes the parent's started_at /
    last_seen_at back ~3 hours via direct SQL so the API's time
    filter excludes it.
    """
    post_event(make_event(parent_sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(parent_sid),
        timeout=10,
        msg=f"parent {parent_sid} did not appear in fleet",
    )
    # Backdate the parent so a ``from=<now - 30min>`` filter
    # excludes it from the page. The child session is seeded later
    # with a fresh timestamp so it lands in the window.
    backdated = (
        datetime.now(timezone.utc) - timedelta(hours=_BACKDATE_HOURS)
    ).isoformat()
    exec_sql(
        "UPDATE sessions "
        "SET started_at = :'ts'::timestamptz, "
        "    last_seen_at = :'ts'::timestamptz "
        "WHERE session_id = :'sid'::uuid",
        ts=backdated,
        sid=parent_sid,
    )


def _seed_child_in_window(*, flavor: str, parent_sid: str, child_sid: str) -> None:
    """Seed a child session_start that lands inside the test's
    ``from`` window. The child's parent_session_id points at the
    backdated parent so the augmentation path has something to
    resolve.
    """
    payload = make_event(
        child_sid,
        flavor,
        "session_start",
        agent_role="test-include-parents-child",
        parent_session_id=parent_sid,
    )
    post_event(payload)
    wait_until(
        lambda: session_exists_in_fleet(child_sid),
        timeout=10,
        msg=f"child {child_sid} did not appear in fleet",
    )


def test_include_parents_off_keeps_pagination_exact() -> None:
    """Default behaviour: ``include_parents`` omitted means a tight
    ``from`` window that excludes the parent returns the child
    alone. The parent never lands in the result.
    """
    flavor = f"test-include-parents-off-{uuid.uuid4().hex[:6]}"
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())

    _seed_parent_outside_window(flavor=flavor, parent_sid=parent_sid)
    _seed_child_in_window(flavor=flavor, parent_sid=parent_sid, child_sid=child_sid)

    # Filter to the test's flavor + a from-window that starts AFTER
    # the parent's backdated started_at but BEFORE the child's
    # fresh started_at.
    since = (
        datetime.now(timezone.utc) - timedelta(minutes=_FROM_WINDOW_MINUTES)
    ).isoformat()
    body = _list_sessions({"flavor": flavor, "from": since, "limit": "50"})

    sids = {s["session_id"] for s in body.get("sessions", [])}
    assert child_sid in sids, f"child {child_sid} missing from default response: {sids}"
    assert parent_sid not in sids, (
        f"parent {parent_sid} unexpectedly present in default response: "
        f"{sids}. Default pagination should NOT bring in parents."
    )


def test_include_parents_on_brings_in_parent_for_orphaned_child() -> None:
    """include_parents=true pulls the older parent into the page so
    a topology resolver walking the result set finds the parent
    even when the time-range filter would have excluded it.
    """
    flavor = f"test-include-parents-on-{uuid.uuid4().hex[:6]}"
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())

    _seed_parent_outside_window(flavor=flavor, parent_sid=parent_sid)
    _seed_child_in_window(flavor=flavor, parent_sid=parent_sid, child_sid=child_sid)

    since = (
        datetime.now(timezone.utc) - timedelta(minutes=_FROM_WINDOW_MINUTES)
    ).isoformat()
    body = _list_sessions(
        {
            "flavor": flavor,
            "from": since,
            "limit": "50",
            "include_parents": "true",
        }
    )

    sessions = body.get("sessions", [])
    sids = {s["session_id"] for s in sessions}
    assert child_sid in sids, (
        f"child {child_sid} missing from include_parents response: {sids}"
    )
    assert parent_sid in sids, (
        f"parent {parent_sid} missing from include_parents response: "
        f"{sids}. include_parents=true must augment the page with "
        f"parents of any child sessions in the result."
    )

    # The augmented parent must carry the same projection shape
    # as the rest of the page (parent_session_id is None on it
    # because it's a root). The store returns the column as
    # ``None`` for null UUIDs -- an empty string would itself be
    # a serialization bug worth flagging, so assert strict None.
    parent_row = next(s for s in sessions if s["session_id"] == parent_sid)
    assert parent_row.get("parent_session_id") is None

    # Total counts only the FILTERED rows (no parent inflation) so
    # the pagination UI in the Events page stays correct. The
    # parent rides along outside the Total accounting.
    assert body.get("total", 0) >= 1
    assert len(body["sessions"]) >= body["total"], (
        "augmented response should have sessions >= total because "
        "the extra parent rows do not count toward total"
    )


def test_include_parents_does_not_duplicate_parent_already_in_page() -> None:
    """When the parent already lands inside the ``from`` window
    (i.e. it's NOT backdated), the augmentation path must not
    duplicate it.
    """
    flavor = f"test-include-parents-dup-{uuid.uuid4().hex[:6]}"
    parent_sid = str(uuid.uuid4())
    child_sid = str(uuid.uuid4())

    # Seed parent with a fresh timestamp (no backdate).
    post_event(make_event(parent_sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(parent_sid),
        timeout=10,
        msg=f"parent {parent_sid} did not appear in fleet",
    )
    _seed_child_in_window(flavor=flavor, parent_sid=parent_sid, child_sid=child_sid)

    since = (
        datetime.now(timezone.utc) - timedelta(minutes=_DEDUP_WINDOW_MINUTES)
    ).isoformat()
    body = _list_sessions(
        {
            "flavor": flavor,
            "from": since,
            "limit": "50",
            "include_parents": "true",
        }
    )

    sids = [s["session_id"] for s in body.get("sessions", [])]
    assert sids.count(parent_sid) == 1, (
        f"parent {parent_sid} appeared {sids.count(parent_sid)} times "
        f"in response; augmentation must deduplicate against the page."
    )
    assert sids.count(child_sid) == 1
