"""Integration test: GET /v1/events event-grain facet filters and
the facets-count mode (D157 Phase 4 wave 2).

The /events page lists events and filters them by event-grain
facets — event type, model, framework, and event-payload fields.
The `facets=true` mode returns per-dimension chip counts over the
same filter set. This test pins the contract live against the
seeded canonical fixtures.
"""

from __future__ import annotations

import datetime
import json
import urllib.parse
import urllib.request
from typing import Any

from .conftest import API_URL, auth_headers

# Every dimension the facets-count mode returns.
FACET_DIMENSIONS = [
    "event_type",
    "model",
    "framework",
    "agent_id",
    "error_type",
    "close_reason",
    "estimated_via",
    "matched_entry_id",
    "originating_call_context",
    "mcp_server",
    "terminal",
]


def _get(path: str, params: dict[str, str]) -> dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API_URL}{path}?{qs}", headers=auth_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


# 30 days back covers the canonical seed's backdated events.
def _wide_from() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
    ).isoformat()


def test_events_facets_mode_returns_per_dimension_counts() -> None:
    """`facets=true` returns an EventFacets object — every dimension
    present as a list of {value, count}; event_type is non-empty
    against the seed."""
    facets = _get("/v1/events", {"from": _wide_from(), "facets": "true"})
    for dim in FACET_DIMENSIONS:
        assert dim in facets, f"facets response missing dimension {dim!r}"
        assert isinstance(facets[dim], list), (
            f"facets[{dim!r}] must be a list, got {type(facets[dim]).__name__}"
        )
    assert facets["event_type"], (
        "event_type facet is empty — the seed produces many event types"
    )
    for fv in facets["event_type"]:
        assert set(fv) >= {"value", "count"}, (
            f"facet value missing value/count keys: {fv!r}"
        )
        assert isinstance(fv["count"], int) and fv["count"] >= 1


def test_events_event_type_filter_scopes_rows() -> None:
    """Every row returned for an `event_type` filter carries that
    event type."""
    resp = _get(
        "/v1/events",
        {"from": _wide_from(), "event_type": "session_start", "limit": "2000"},
    )
    assert resp["total"] >= 1, "no session_start events after seed"
    for ev in resp["events"]:
        assert ev["event_type"] == "session_start", (
            f"event {ev['id']} is {ev['event_type']}, not session_start — "
            "the event_type filter leaked"
        )


def test_events_facet_filter_narrows_total() -> None:
    """A facet filter narrows the result total — the filtered count
    is a non-empty subset of the unfiltered count."""
    unfiltered = _get("/v1/events", {"from": _wide_from(), "limit": "1"})
    filtered = _get(
        "/v1/events",
        {"from": _wide_from(), "event_type": "session_start", "limit": "1"},
    )
    assert filtered["total"] >= 1
    assert filtered["total"] <= unfiltered["total"]
