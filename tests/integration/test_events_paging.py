"""Events that share a timestamp page through GET /v1/events without a
gap or a repeat: offset pages in both directions and the run drawer's
``before`` / ``before_id`` keyset all follow ``(occurred_at, id)`` order,
and the session detail's capped first page ends on the row the keyset
resumes after. A range without ``to`` also lists an event dated ahead
of the API's clock.

One session, created through ingestion, carries several tool calls
stamped with the same whole-second timestamp, the way a client that
stamps whole seconds sends them. Requires the dev stack (``make dev``).
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
    exec_sql,
    make_event,
    post_event,
    wait_for_session_in_fleet,
    wait_until,
)

# More tool calls share the timestamp than the page sizes below hold, so
# every page boundary the tests cross can fall inside the tie.
TIED_CALLS = 7

# Ingestion -> NATS -> worker for a handful of events on the dev stack.
LANDING_TIMEOUT_SECS = 15.0

EPOCH = "1970-01-01T00:00:00Z"


def _get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}{path}?{query}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def _status(path: str, params: dict[str, Any]) -> int:
    try:
        _get(path, params)
    except urllib.error.HTTPError as err:
        return err.code
    return 200


def _session_with_tied_calls() -> tuple[str, list[str]]:
    """Create a session whose tool calls share one timestamp; return its id
    and every event id in (occurred_at, id) order, read from the rows."""
    sid = str(uuid.uuid4())
    flavor = f"test-events-paging-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    assert wait_for_session_in_fleet(sid, timeout=LANDING_TIMEOUT_SECS)
    tie = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60))
    for i in range(TIED_CALLS):
        post_event(make_event(sid, flavor, "tool_call", tool_name=f"tie-{i}", timestamp=tie))

    def rows() -> list[tuple[str, str]]:
        raw = exec_sql(
            "SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), id "
            "FROM events WHERE session_id = :'sid'::uuid",
            sid=sid,
        )
        return [tuple(line.split("|")) for line in raw.splitlines() if line]  # type: ignore[misc]

    wait_until(
        lambda: len(rows()) == TIED_CALLS + 1,
        timeout=LANDING_TIMEOUT_SECS,
        msg=f"the {TIED_CALLS} tied tool calls of {sid} never landed",
    )
    # The contract, computed independently of the server: time to the
    # microsecond, then the id (canonical lowercase UUIDs sort as
    # Postgres orders uuids).
    ordered = [event_id for _, event_id in sorted(rows())]
    return sid, ordered


def _ids(resp: dict[str, Any]) -> list[str]:
    return [e["id"] for e in resp["events"]]


def test_offset_pages_return_tied_events_once_in_both_directions() -> None:
    sid, ordered = _session_with_tied_calls()
    for order, limit, want in (("asc", 2, ordered), ("desc", 3, ordered[::-1])):
        got: list[str] = []
        offset = 0
        while True:
            resp = _get(
                "/v1/events",
                {
                    "from": EPOCH,
                    "session_id": sid,
                    "order": order,
                    "limit": limit,
                    "offset": offset,
                },
            )
            got += _ids(resp)
            if not resp["has_more"] or not resp["events"]:
                break
            offset += limit
        assert got == want, f"{order} offset pages: got {got}, want {want}"


def test_keyset_walks_the_tie_one_row_past_the_cursor() -> None:
    sid, ordered = _session_with_tied_calls()
    newest_first = {"from": EPOCH, "session_id": sid, "order": "desc", "limit": 2}
    page = _get("/v1/events", newest_first)
    got = _ids(page)
    while page["has_more"] and page["events"]:
        cursor = page["events"][-1]
        page = _get(
            "/v1/events",
            {**newest_first, "before": cursor["occurred_at"], "before_id": cursor["id"]},
        )
        got += _ids(page)
    assert got == ordered[::-1], f"keyset pages: got {got}, want {ordered[::-1]}"


def test_session_detail_capped_page_is_the_newest_in_order() -> None:
    sid, ordered = _session_with_tied_calls()
    capped = 4
    detail = _get(f"/v1/sessions/{sid}", {"events_limit": capped})
    assert [e["id"] for e in detail["events"]] == ordered[-capped:]
    # The drawer resumes from the oldest event it holds.
    oldest = detail["events"][0]
    rest = _get(
        "/v1/events",
        {
            "from": EPOCH,
            "session_id": sid,
            "order": "desc",
            "limit": 100,
            "before": oldest["occurred_at"],
            "before_id": oldest["id"],
        },
    )
    assert _ids(rest) == ordered[:-capped][::-1]


def test_range_without_to_includes_event_dated_ahead_of_api_clock() -> None:
    """A query without ``to`` has no upper bound on occurred_at.

    occurred_at is the client's timestamp, and ingestion accepts one up
    to five minutes ahead of its own clock. Ending an open range at the
    API's clock hid such an event until that clock caught up.
    """
    sid = str(uuid.uuid4())
    flavor = f"test-events-ahead-{uuid.uuid4().hex[:6]}"
    post_event(make_event(sid, flavor, "session_start"))
    assert wait_for_session_in_fleet(sid, timeout=LANDING_TIMEOUT_SECS)
    ahead = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 120))
    post_event(make_event(sid, flavor, "tool_call", tool_name="ahead", timestamp=ahead))
    wait_until(
        lambda: (
            exec_sql(
                "SELECT count(*) FROM events WHERE session_id = :'sid'::uuid "
                "AND event_type = 'tool_call'",
                sid=sid,
            )
            == "1"
        ),
        timeout=LANDING_TIMEOUT_SECS,
        msg=f"the tool call of {sid} never landed",
    )
    resp = _get("/v1/events", {"from": EPOCH, "session_id": sid, "event_type": "tool_call"})
    assert [e["tool_name"] for e in resp["events"]] == ["ahead"], (
        f"an event dated ahead of the API's clock must be listed; got {resp['events']!r}"
    )


def test_before_id_is_rejected_without_before_or_when_not_a_uuid() -> None:
    assert _status("/v1/events", {"from": EPOCH, "before_id": str(uuid.uuid4())}) == 400
    not_a_uuid = {"from": EPOCH, "before": "2026-01-01T00:00:00Z", "before_id": "not-a-uuid"}
    assert _status("/v1/events", not_a_uuid) == 400
