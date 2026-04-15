"""Integration tests for policy enforcement -- mocked LLM, zero-cost.

Covers the workers' PolicyEvaluator end-to-end: sensor events (synthetic
here, fabricated via POST /ingest/v1/events) flow through ingestion into
NATS, the workers update sessions.tokens_used and run the evaluator,
and the evaluator writes warn / degrade / shutdown directive rows that
these tests assert on via ``query_directives``.

The smoke suite (tests/smoke/smoke_test.py GROUP 3 + GROUP 4) covers
the same enforcement paths with real LLM calls; these tests are the
fast, deterministic counterpart.

Requires ``make dev`` to be running.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid

import pytest

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
    wait_for_session_in_fleet,
    wait_until,
)


# ---------------------------------------------------------------------------
# Local helpers -- REST CRUD for policies. create_policy / delete_policy are
# in conftest; get / list / put are only used here, so they live in-file.
# ---------------------------------------------------------------------------


def _get_policies() -> list[dict]:
    req = urllib.request.Request(
        f"{API_URL}/v1/policies", headers=auth_headers()
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def _get_policy(policy_id: str) -> tuple[int, dict | None]:
    """GET /v1/policies/:id. GetPolicyByID is not wired as a public REST
    route in this build, so we probe via the list endpoint instead."""
    try:
        for p in _get_policies():
            if p["id"] == policy_id:
                return 200, p
        return 404, None
    except urllib.error.HTTPError as exc:
        return exc.code, None


def _put_policy(policy_id: str, body: dict) -> tuple[int, dict | None]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/policies/{policy_id}",
        data=data,
        headers=auth_headers(json_body=True),
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, None


def _delete_policy_raw(policy_id: str) -> int:
    req = urllib.request.Request(
        f"{API_URL}/v1/policies/{policy_id}",
        headers=auth_headers(),
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


def _wait_for_directive_action(
    session_id: str, action: str, timeout: float = 10.0
) -> dict:
    """Poll directives table until a directive with the given action
    exists for the session. Returns the directive row."""
    found: dict = {}

    def _check() -> bool:
        nonlocal found
        for d in query_directives(session_id):
            if d.get("action") == action:
                found = d
                return True
        return False

    wait_until(
        _check,
        timeout=timeout,
        msg=f"no directive with action={action} for session {session_id}",
    )
    return found


def _post_call(
    session_id: str, flavor: str, tokens_total: int, tokens_used_session: int
) -> None:
    post_event(make_event(
        session_id, flavor, "post_call",
        tokens_total=tokens_total, tokens_used_session=tokens_used_session,
    ))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_policy_blocks_when_limit_exceeded() -> None:
    """token_limit=10 with a default block threshold. Pushing tokens_total
    past the limit causes the worker to write a shutdown directive
    (BLOCK maps to action=shutdown in workers/internal/processor/policy.go)."""
    sid = str(uuid.uuid4())
    flavor = f"policy-block-{uuid.uuid4().hex[:6]}"
    policy = None
    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=10, block_at_pct=1,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear in fleet",
        )

        _post_call(sid, flavor, tokens_total=25, tokens_used_session=25)

        shutdown = _wait_for_directive_action(sid, "shutdown", timeout=10)
        assert shutdown["flavor"] == flavor
        assert shutdown["reason"] == "token_budget_exceeded"
    finally:
        if policy:
            delete_policy(policy["id"])


def test_policy_warns_at_threshold() -> None:
    """warn_at_pct=50, token_limit=100. Pushing to 60 crosses warn
    (>=50%) but not block. Exactly one warn directive is written
    (fire-once per session, CheckAndMarkFired)."""
    sid = str(uuid.uuid4())
    flavor = f"policy-warn-{uuid.uuid4().hex[:6]}"
    policy = None
    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=100, warn_at_pct=50,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear",
        )

        _post_call(sid, flavor, tokens_total=60, tokens_used_session=60)

        warn = _wait_for_directive_action(sid, "warn", timeout=10)
        assert warn["reason"] == "token_budget_warning"

        # A second post_call still in warn territory must not add a
        # second warn row (dedup-once).
        _post_call(sid, flavor, tokens_total=10, tokens_used_session=70)
        wait_until(
            lambda: get_session_event_count(sid) >= 3,
            timeout=10,
            msg="second post_call not processed",
        )
        warns = [d for d in query_directives(sid) if d.get("action") == "warn"]
        assert len(warns) == 1, f"expected exactly 1 warn, got {len(warns)}"

        # Session still active -- warn does not close it.
        detail = get_session_detail(sid)
        assert detail["session"]["state"] == "active"
    finally:
        if policy:
            delete_policy(policy["id"])


def test_policy_degrades_model() -> None:
    """degrade_at_pct=80 with degrade_to set. Pushing to 85 triggers
    a degrade directive carrying the degrade_to model. Verified by
    TASK 1 grep: workers/internal/processor/policy.go:198 emits
    action=degrade via writeDirective when pctUsed >= degrade_at_pct."""
    sid = str(uuid.uuid4())
    flavor = f"policy-degrade-{uuid.uuid4().hex[:6]}"
    policy = None
    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=100,
            degrade_at_pct=80,
            degrade_to="gpt-4o-mini",
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear",
        )

        _post_call(sid, flavor, tokens_total=85, tokens_used_session=85)

        degrade = _wait_for_directive_action(sid, "degrade", timeout=10)
        assert degrade["reason"] == "token_budget_degrade"
        assert degrade.get("degrade_to") == "gpt-4o-mini"
    finally:
        if policy:
            delete_policy(policy["id"])


def test_policy_blocks_overrides_warn() -> None:
    """warn_at_pct=50, block_at_pct=100, token_limit=50.
    * 30 tokens -> 60% -> warn fires.
    * Cumulative 60 tokens -> block fires and supersedes warn."""
    sid = str(uuid.uuid4())
    flavor = f"policy-warn-then-block-{uuid.uuid4().hex[:6]}"
    policy = None
    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=50, warn_at_pct=50, block_at_pct=100,
        )

        post_event(make_event(sid, flavor, "session_start"))
        wait_until(
            lambda: session_exists_in_fleet(sid),
            timeout=10,
            msg=f"session {sid} did not appear",
        )

        _post_call(sid, flavor, tokens_total=30, tokens_used_session=30)
        _wait_for_directive_action(sid, "warn", timeout=10)

        _post_call(sid, flavor, tokens_total=30, tokens_used_session=60)
        _wait_for_directive_action(sid, "shutdown", timeout=10)

        actions = {d.get("action") for d in query_directives(sid)}
        assert "warn" in actions
        assert "shutdown" in actions
    finally:
        if policy:
            delete_policy(policy["id"])


def test_policy_applies_by_flavor() -> None:
    """Policy scoped to flavor A only. Session on flavor A crosses the
    block threshold -> directive written. Session on flavor B pushes
    the same tokens -> no directive (no matching policy)."""
    sid_a = str(uuid.uuid4())
    sid_b = str(uuid.uuid4())
    flavor_a = f"policy-flavor-a-{uuid.uuid4().hex[:6]}"
    flavor_b = f"policy-flavor-b-{uuid.uuid4().hex[:6]}"
    policy = None
    try:
        policy = create_policy(
            scope="flavor", scope_value=flavor_a,
            token_limit=10, block_at_pct=1,
        )

        post_event(make_event(sid_a, flavor_a, "session_start"))
        post_event(make_event(sid_b, flavor_b, "session_start"))
        wait_for_session_in_fleet(sid_a, timeout=10)
        wait_for_session_in_fleet(sid_b, timeout=10)

        _post_call(sid_a, flavor_a, tokens_total=50, tokens_used_session=50)
        _post_call(sid_b, flavor_b, tokens_total=50, tokens_used_session=50)

        # A should get a shutdown directive.
        _wait_for_directive_action(sid_a, "shutdown", timeout=10)

        # B should get nothing. Wait long enough that the evaluator has
        # definitely run (its post_call event is visible), then assert
        # an empty directives list.
        wait_until(
            lambda: get_session_event_count(sid_b) >= 2,
            timeout=10,
            msg="flavor B post_call not processed",
        )
        directives_b = query_directives(sid_b)
        assert directives_b == [], (
            f"flavor B must have no directives, got {directives_b}"
        )
    finally:
        if policy:
            delete_policy(policy["id"])


def test_policy_fail_open_on_missing() -> None:
    """No matching policy at any scope -> no directives regardless of
    how many tokens are spent. Fail-open is the default when the
    cascading lookup (session -> flavor -> org) returns nil."""
    sid = str(uuid.uuid4())
    flavor = f"policy-none-{uuid.uuid4().hex[:6]}"

    post_event(make_event(sid, flavor, "session_start"))
    wait_for_session_in_fleet(sid, timeout=10)

    _post_call(sid, flavor, tokens_total=10_000, tokens_used_session=10_000)

    wait_until(
        lambda: get_session_event_count(sid) >= 2,
        timeout=10,
        msg="post_call not processed",
    )
    assert query_directives(sid) == []


def test_policy_crud() -> None:
    """Full CRUD lifecycle on /v1/policies."""
    flavor = f"policy-crud-{uuid.uuid4().hex[:6]}"
    created = create_policy(
        scope="flavor", scope_value=flavor,
        token_limit=100, warn_at_pct=50,
    )
    policy_id = created["id"]
    try:
        # LIST
        policies = _get_policies()
        assert any(p["id"] == policy_id for p in policies), (
            f"policy {policy_id} missing from list"
        )

        # GET (via list; the by-id route is not exposed)
        status, got = _get_policy(policy_id)
        assert status == 200
        assert got is not None
        assert got["scope"] == "flavor"
        assert got["scope_value"] == flavor
        assert got["token_limit"] == 100
        assert got["warn_at_pct"] == 50

        # PUT (full body -- the handler requires scope + scope_value)
        status, updated = _put_policy(policy_id, {
            "scope": "flavor",
            "scope_value": flavor,
            "token_limit": 200,
            "warn_at_pct": 75,
        })
        assert status == 200
        assert updated is not None
        assert updated["token_limit"] == 200
        assert updated["warn_at_pct"] == 75

        # DELETE
        assert _delete_policy_raw(policy_id) == 204

        # Subsequent DELETE returns 404
        assert _delete_policy_raw(policy_id) == 404

        # LIST no longer contains it
        remaining = _get_policies()
        assert not any(p["id"] == policy_id for p in remaining)
    finally:
        # Safety net in case of mid-test failure.
        delete_policy(policy_id)
