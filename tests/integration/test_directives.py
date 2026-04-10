"""Integration tests for the custom directives pipeline.

Exercises the full sensor → ingestion → API directive flow:
- /v1/directives/sync (sensor handshake, returns unknown fingerprints)
- /v1/directives/register (sensor uploads full schemas for unknowns)
- /v1/directives/custom (dashboard list view)
- /v1/directives action="custom" (dashboard issues a custom directive)
- directive_result events appearing in the session timeline

Requires `make dev` to be running.
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

from .conftest import (
    API_URL,
    TOKEN,
    get_session,
    make_event,
    post_event,
    session_exists_in_fleet,
    wait_for_session_in_fleet,
    wait_until,
)


# ----------------------------------------------------------------------
# Helpers (mirror conftest.py patterns -- no shared mutable state)
# ----------------------------------------------------------------------


def _post_json(
    path: str,
    body: dict[str, Any],
    *,
    bearer: str | None = None,
) -> tuple[int, dict[str, Any]]:
    """POST JSON to the API and return (status, body). Never raises on 4xx."""
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(
        f"{API_URL}{path}",
        data=data,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read())
        except Exception:
            payload = {}
        return exc.code, payload


def _get_json(path: str) -> tuple[int, dict[str, Any]]:
    """GET JSON from the API and return (status, body)."""
    req = urllib.request.Request(f"{API_URL}{path}")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read())
        except Exception:
            payload = {}
        return exc.code, payload


def _sync_directives(
    flavor: str,
    fingerprints: list[str],
) -> tuple[int, dict[str, Any]]:
    """POST /v1/directives/sync with the given flavor and fingerprints.

    The query API requires a bearer token on this endpoint as a stopgap
    until Phase 5 JWT auth lands (see DECISIONS.md D073).
    """
    body = {
        "flavor": flavor,
        "directives": [
            {"name": f"name-{i}", "fingerprint": fp}
            for i, fp in enumerate(fingerprints)
        ],
    }
    return _post_json("/v1/directives/sync", body, bearer=TOKEN)


def _register_directive(
    flavor: str,
    fingerprint: str,
    name: str,
    description: str = "test directive",
    parameters: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/directives/register with a single directive."""
    body = {
        "flavor": flavor,
        "directives": [
            {
                "fingerprint": fingerprint,
                "name": name,
                "description": description,
                "flavor": flavor,
                "parameters": parameters or {},
            }
        ],
    }
    return _post_json("/v1/directives/register", body, bearer=TOKEN)


def _list_custom_directives(flavor: str | None = None) -> tuple[int, dict[str, Any]]:
    """GET /v1/directives/custom optionally filtered by flavor."""
    path = "/v1/directives/custom"
    if flavor is not None:
        path = f"{path}?flavor={flavor}"
    return _get_json(path)


def _post_directive_action(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /v1/directives with the given body (no auth)."""
    return _post_json("/v1/directives", body)


def _query_directives_for_session(session_id: str) -> list[dict[str, Any]]:
    """Query the directives table directly for a given session_id."""
    sql = (
        "SELECT COALESCE(json_agg(row_to_json(d)), '[]'::json) "
        "FROM directives d "
        f"WHERE d.session_id = '{session_id}'::uuid"
    )
    result = subprocess.run(
        [
            "docker", "exec", "docker-postgres-1", "psql",
            "-U", "flightdeck", "-d", "flightdeck", "-t", "-c", sql,
        ],
        capture_output=True, text=True, timeout=10,
    )
    raw = result.stdout.strip()
    if not raw or raw == "null":
        return []
    return json.loads(raw)  # type: ignore[no-any-return]


def _delete_custom_directive_by_fingerprint(fingerprint: str) -> None:
    """Clean up a custom_directives row after a test."""
    sql = (
        f"DELETE FROM custom_directives WHERE fingerprint = '{fingerprint}'"
    )
    subprocess.run(
        [
            "docker", "exec", "docker-postgres-1", "psql",
            "-U", "flightdeck", "-d", "flightdeck", "-c", sql,
        ],
        capture_output=True, text=True, timeout=10,
    )


def _start_session(flavor: str) -> str:
    """Create a new active session by POSTing session_start. Returns sid."""
    sid = str(uuid.uuid4())
    post_event(make_event(sid, flavor, "session_start"))
    wait_until(
        lambda: session_exists_in_fleet(sid),
        timeout=10,
        msg=f"session {sid} did not appear after session_start",
    )
    return sid


def _unique_fingerprint(prefix: str = "fp") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# ----------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------


def test_custom_directive_register_and_sync() -> None:
    """sync → register → sync → list happy path."""
    flavor = f"test-dir-sync-{uuid.uuid4().hex[:6]}"
    fp = _unique_fingerprint()

    # Step 1: sync with a brand-new fingerprint
    code, body = _sync_directives(flavor, [fp])
    assert code == 200, f"sync returned {code}: {body}"
    assert fp in body.get("unknown_fingerprints", []), (
        f"expected {fp} in unknown_fingerprints, got {body}"
    )

    try:
        # Step 2: register the full schema
        code, body = _register_directive(
            flavor, fp, name="test_action", description="register test"
        )
        assert code == 200, f"register returned {code}: {body}"
        assert body.get("registered") == 1, (
            f"expected registered=1, got {body}"
        )

        # Step 3: sync again -- the fingerprint is now known
        code, body = _sync_directives(flavor, [fp])
        assert code == 200, f"second sync returned {code}: {body}"
        assert fp not in body.get("unknown_fingerprints", []), (
            f"expected {fp} NOT in unknown_fingerprints after register, got {body}"
        )

        # Step 4: GET /v1/directives/custom -- the directive is in the list
        code, body = _list_custom_directives()
        assert code == 200
        names = {d["name"]: d for d in body.get("directives", [])}
        assert "test_action" in names, (
            f"expected test_action in directive list, got {list(names.keys())}"
        )
        assert names["test_action"]["flavor"] == flavor
        assert names["test_action"]["fingerprint"] == fp
    finally:
        _delete_custom_directive_by_fingerprint(fp)


def test_custom_directive_trigger_session() -> None:
    """POST /v1/directives action=custom on a single session creates one row."""
    flavor = f"test-dir-trig-{uuid.uuid4().hex[:6]}"
    fp = _unique_fingerprint()

    sid = _start_session(flavor)

    code, _ = _register_directive(flavor, fp, name="test_action")
    assert code == 200

    try:
        code, body = _post_directive_action({
            "action": "custom",
            "directive_name": "test_action",
            "fingerprint": fp,
            "session_id": sid,
        })
        assert code == 201, f"create directive returned {code}: {body}"

        rows = _query_directives_for_session(sid)
        custom_rows = [r for r in rows if r.get("action") == "custom"]
        assert len(custom_rows) == 1, (
            f"expected 1 custom directive for session, got {len(custom_rows)}"
        )
    finally:
        _delete_custom_directive_by_fingerprint(fp)


def test_custom_directive_flavor_fanout() -> None:
    """action=custom with flavor (no session_id) fans out one row per active session."""
    flavor = f"test-dir-fanout-{uuid.uuid4().hex[:6]}"
    fp = _unique_fingerprint()

    sids = [_start_session(flavor) for _ in range(3)]

    code, _ = _register_directive(flavor, fp, name="test_action")
    assert code == 200

    try:
        code, body = _post_directive_action({
            "action": "custom",
            "directive_name": "test_action",
            "fingerprint": fp,
            "flavor": flavor,
        })
        assert code == 201, f"create flavor directive returned {code}: {body}"

        # One directive row per active session
        per_session_counts = []
        for sid in sids:
            rows = _query_directives_for_session(sid)
            custom_rows = [r for r in rows if r.get("action") == "custom"]
            per_session_counts.append(len(custom_rows))
        assert sum(per_session_counts) == 3, (
            f"expected 3 directives total across 3 sessions, "
            f"got {per_session_counts}"
        )
    finally:
        _delete_custom_directive_by_fingerprint(fp)


def test_custom_directive_unknown_fingerprint() -> None:
    """action=custom with an unregistered fingerprint returns 422 and creates no rows."""
    flavor = f"test-dir-422-{uuid.uuid4().hex[:6]}"
    sid = _start_session(flavor)

    bogus_fp = _unique_fingerprint("bogus")

    code, body = _post_directive_action({
        "action": "custom",
        "directive_name": "ghost",
        "fingerprint": bogus_fp,
        "session_id": sid,
    })
    assert code == 422, f"expected 422, got {code}: {body}"
    assert "unknown directive fingerprint" in body.get("error", "")

    rows = _query_directives_for_session(sid)
    custom_rows = [r for r in rows if r.get("action") == "custom"]
    assert len(custom_rows) == 0, (
        f"expected 0 directive rows on 422 path, got {len(custom_rows)}"
    )


def test_directive_result_appears_in_timeline() -> None:
    """A directive_result event posted via ingestion shows up in the session timeline."""
    flavor = f"test-dir-result-{uuid.uuid4().hex[:6]}"
    sid = _start_session(flavor)

    post_event(make_event(
        sid,
        flavor,
        "directive_result",
        directive_name="clear_cache",
        directive_action="custom",
        directive_status="success",
        result={"cleared": True},
    ))

    def _has_directive_result() -> bool:
        try:
            detail = get_session(sid)
        except Exception:
            return False
        for ev in detail.get("events", []):
            if ev.get("event_type") == "directive_result":
                return True
        return False

    wait_until(
        _has_directive_result,
        timeout=10,
        msg=f"directive_result event did not appear for session {sid}",
    )

    detail = get_session(sid)
    result_events = [
        ev for ev in detail.get("events", [])
        if ev.get("event_type") == "directive_result"
    ]
    assert len(result_events) >= 1, (
        f"expected at least one directive_result event, got {result_events}"
    )


def test_shutdown_directive_delivered() -> None:
    """Issuing a shutdown directive creates a row with delivered_at NULL until pickup."""
    flavor = f"test-dir-shut-{uuid.uuid4().hex[:6]}"
    sid = _start_session(flavor)

    code, body = _post_directive_action({
        "action": "shutdown",
        "session_id": sid,
        "reason": "test shutdown",
    })
    assert code == 201, f"shutdown directive returned {code}: {body}"

    rows = _query_directives_for_session(sid)
    shutdown_rows = [r for r in rows if r.get("action") == "shutdown"]
    assert len(shutdown_rows) == 1, (
        f"expected 1 shutdown directive row, got {len(shutdown_rows)}"
    )
    # The directive is pending until a sensor POST picks it up
    assert shutdown_rows[0].get("delivered_at") is None, (
        f"expected delivered_at=NULL before any pickup, got {shutdown_rows[0]}"
    )

    # Now POST any event for this session and verify the response
    # envelope contains the directive
    payload = make_event(sid, flavor, "post_call", tokens_total=10)
    resp = post_event(payload)
    directive = resp.get("directive")
    assert directive is not None, (
        f"expected directive in event response envelope, got {resp}"
    )
    assert directive.get("action") == "shutdown", (
        f"expected action=shutdown in directive envelope, got {directive}"
    )


def test_directive_last_seen_updated() -> None:
    """Re-syncing a known fingerprint bumps last_seen_at."""
    flavor = f"test-dir-seen-{uuid.uuid4().hex[:6]}"
    fp = _unique_fingerprint()

    code, _ = _register_directive(flavor, fp, name="seen_test")
    assert code == 200

    try:
        code, body = _list_custom_directives(flavor)
        assert code == 200
        match = next(
            (d for d in body["directives"] if d["fingerprint"] == fp),
            None,
        )
        assert match is not None, "registered directive missing from list"
        first_last_seen = match["last_seen_at"]

        # Wait at least one second so the timestamp differs
        time.sleep(1.1)

        code, _ = _sync_directives(flavor, [fp])
        assert code == 200

        code, body = _list_custom_directives(flavor)
        assert code == 200
        match2 = next(
            (d for d in body["directives"] if d["fingerprint"] == fp),
            None,
        )
        assert match2 is not None
        assert match2["last_seen_at"] > first_last_seen, (
            f"expected last_seen_at to advance after sync, "
            f"first={first_last_seen} second={match2['last_seen_at']}"
        )
    finally:
        _delete_custom_directive_by_fingerprint(fp)


def test_directive_filter_by_flavor() -> None:
    """GET /v1/directives/custom?flavor=X returns only that flavor's directives."""
    flavor_a = f"test-dir-fa-{uuid.uuid4().hex[:6]}"
    flavor_b = f"test-dir-fb-{uuid.uuid4().hex[:6]}"
    fp_a = _unique_fingerprint("a")
    fp_b = _unique_fingerprint("b")

    code, _ = _register_directive(flavor_a, fp_a, name="action_a")
    assert code == 200
    code, _ = _register_directive(flavor_b, fp_b, name="action_b")
    assert code == 200

    try:
        code, body = _list_custom_directives(flavor_a)
        assert code == 200
        fingerprints = {d["fingerprint"] for d in body["directives"]}
        assert fp_a in fingerprints
        assert fp_b not in fingerprints, (
            f"flavor=a filter leaked flavor=b: {fingerprints}"
        )

        code, body = _list_custom_directives(flavor_b)
        assert code == 200
        fingerprints = {d["fingerprint"] for d in body["directives"]}
        assert fp_b in fingerprints
        assert fp_a not in fingerprints, (
            f"flavor=b filter leaked flavor=a: {fingerprints}"
        )
    finally:
        _delete_custom_directive_by_fingerprint(fp_a)
        _delete_custom_directive_by_fingerprint(fp_b)


def test_sync_endpoint_requires_auth() -> None:
    """Sync endpoint without bearer token returns 401."""
    body = {
        "flavor": "test-noauth",
        "directives": [{"name": "x", "fingerprint": _unique_fingerprint()}],
    }
    code, resp = _post_json("/v1/directives/sync", body, bearer=None)
    assert code == 401, (
        f"expected 401 without bearer token, got {code}: {resp}"
    )


def test_register_endpoint_requires_auth() -> None:
    """Register endpoint without bearer token returns 401."""
    body = {
        "flavor": "test-noauth",
        "directives": [{
            "fingerprint": _unique_fingerprint(),
            "name": "x",
            "flavor": "test-noauth",
            "parameters": {},
        }],
    }
    code, resp = _post_json("/v1/directives/register", body, bearer=None)
    assert code == 401, (
        f"expected 401 without bearer token, got {code}: {resp}"
    )
