"""Directives addressed to an agent: POST /v1/directives with agent_id.

The API sends one directive to each live run of the agent that can act
on it, and none to a run that cannot or to another agent's run that
shares the flavor. Delivery is checked the way a client sees it: the
next event POST of a session returns its pending directive and marks it
delivered, so nothing is left pending.

Each test runs two agents of its own (their names are unique to the
run) under a flavor of its own, ends their sessions and removes the
flavor's rows when it finishes.

Requires `make dev` to be running.
"""

from __future__ import annotations

import contextlib
import json
import urllib.error
import urllib.request
import uuid
from typing import Any

from .conftest import (
    API_URL,
    DEFAULT_TEST_CONTEXT,
    auth_headers,
    delete_flavor_data,
    get_session,
    get_session_event_count,
    make_event,
    post_event,
    wait_until,
)

# Each session posts session_start, one event to collect its directive,
# and session_end; the flavor's rows are removed only once the worker
# has stored all three, so a late event cannot recreate a removed row.
EVENTS_PER_SESSION = 3
# Seconds to wait for the worker to store a session's events or state.
WORKER_WAIT_SECS = 20


def _agent_names(suffix: str) -> tuple[str, str]:
    """Two agents that share a flavor: agent_name is part of the agent_id
    derivation, so the names make them distinct agents."""
    return (
        f"integration-agent-scope-a-{suffix}@integration-test-host",
        f"integration-agent-scope-b-{suffix}@integration-test-host",
    )


def _post_directive(body: dict[str, Any]) -> tuple[int, int | None, dict[str, Any]]:
    """POST /v1/directives; return (status, X-Directive-Count, body)."""
    req = urllib.request.Request(
        f"{API_URL}/v1/directives",
        data=json.dumps(body).encode(),
        headers=auth_headers(json_body=True),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            count = resp.headers.get("X-Directive-Count")
            return (
                resp.status,
                int(count) if count is not None else None,
                json.loads(resp.read()),
            )
    except urllib.error.HTTPError as exc:
        return exc.code, None, json.loads(exc.read() or b"{}")


def _register_directive(flavor: str, fingerprint: str, name: str) -> None:
    """Register a custom directive under flavor, as a sensor's init does."""
    body = {
        "flavor": flavor,
        "directives": [
            {
                "fingerprint": fingerprint,
                "name": name,
                "description": "agent-scoped directive integration test",
                "flavor": flavor,
                "parameters": [],
            }
        ],
    }
    req = urllib.request.Request(
        f"{API_URL}/v1/directives/register",
        data=json.dumps(body).encode(),
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200, f"register returned {resp.status}"


def _state(session_id: str) -> str | None:
    try:
        return str(get_session(session_id)["session"]["state"])
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def _start_all(
    runs: dict[str, tuple[str, str]],
    extra: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Start each run (session id -> (flavor, agent name)), with the
    session_start fields ``extra`` adds for it, and wait until the worker
    has it active."""
    for sid, (flavor, name) in runs.items():
        fields = (extra or {}).get(sid, {})
        post_event(make_event(sid, flavor, "session_start", agent_name=name, **fields))
    for sid in runs:
        wait_until(
            lambda sid=sid: _state(sid) == "active",
            timeout=WORKER_WAIT_SECS,
            msg=f"session {sid} not active after session_start",
        )


def _delivered(sid: str, flavor: str, name: str) -> dict[str, Any] | None:
    """POST one event for the session; return the directive its response
    carries (the response delivers it and marks it delivered)."""
    envelope = post_event(
        make_event(sid, flavor, "post_call", agent_name=name, tokens_total=10)
    )
    directive = envelope.get("directive")
    return directive if isinstance(directive, dict) else None


def _finish(runs: dict[str, tuple[str, str]], flavors: tuple[str, ...]) -> None:
    """End each run, wait until the worker has stored its events, then
    remove the test's flavors. Best effort: a test that failed early
    still cleans up what it created."""
    for sid, (flavor, name) in runs.items():
        # urllib's errors are OSErrors.
        with contextlib.suppress(OSError):
            post_event(make_event(sid, flavor, "session_end", agent_name=name))
    for sid in runs:
        try:
            wait_until(
                lambda sid=sid: (
                    _state(sid) == "closed"
                    and get_session_event_count(sid) >= EVENTS_PER_SESSION
                ),
                timeout=WORKER_WAIT_SECS,
                msg=f"session {sid} not closed with its events stored",
            )
        except TimeoutError:
            pass
    for flavor in flavors:
        delete_flavor_data(flavor)


def test_agent_stop_reaches_only_that_agents_runs_that_can_act() -> None:
    suffix = uuid.uuid4().hex[:8]
    flavor = f"agent-scope-stop-{suffix}"
    name_a, name_b = _agent_names(suffix)
    a1, a2, a_observer, b1 = (str(uuid.uuid4()) for _ in range(4))
    runs = {
        a1: (flavor, name_a),
        a2: (flavor, name_a),
        a_observer: (flavor, name_a),
        b1: (flavor, name_b),
    }
    try:
        # A run of the same agent that says it cannot act on a directive
        # (an observe-only client sets the flag the same way).
        observer_context = {**DEFAULT_TEST_CONTEXT, "supports_directives": False}
        _start_all(runs, {a_observer: {"context": observer_context}})
        agent_a = get_session(a1)["session"]["agent_id"]
        assert get_session(b1)["session"]["agent_id"] != agent_a

        status, count, body = _post_directive(
            {
                "action": "shutdown",
                "agent_id": agent_a,
                "reason": "integration_agent_stop",
            }
        )
        assert status == 201, f"agent stop returned {status}: {body}"
        assert count == 2, f"X-Directive-Count = {count}, want 2 (a1, a2)"
        assert body["action"] == "shutdown" and body["session_id"] in (a1, a2), body

        for sid in (a1, a2):
            directive = _delivered(sid, flavor, name_a)
            assert directive is not None and directive["action"] == "shutdown", (
                f"{sid} of agent A did not get the stop: {directive}"
            )
        assert _delivered(a_observer, flavor, name_a) is None, (
            "a run that cannot act got the stop"
        )
        assert _delivered(b1, flavor, name_b) is None, (
            "another agent's run got agent A's stop"
        )
    finally:
        _finish(runs, (flavor,))


def test_agent_custom_directive_reaches_only_that_agents_runs_that_run_it() -> None:
    suffix = uuid.uuid4().hex[:8]
    flavor = f"agent-scope-custom-{suffix}"
    other_flavor = f"agent-scope-custom-other-{suffix}"
    name_a, name_b = _agent_names(suffix)
    fingerprint = f"fp-agent-scope-{suffix}"
    a1, a2, a_other, b1 = (str(uuid.uuid4()) for _ in range(4))
    runs = {
        a1: (flavor, name_a),
        a2: (flavor, name_a),
        # A live run of agent A under a flavor that registered nothing.
        a_other: (other_flavor, name_a),
        b1: (flavor, name_b),
    }
    try:
        _register_directive(flavor, fingerprint, "agent_scope_rotate")
        _start_all(runs)
        agent_a = get_session(a1)["session"]["agent_id"]

        status, count, body = _post_directive(
            {
                "action": "custom",
                "agent_id": agent_a,
                "flavor": flavor,
                "directive_name": "agent_scope_rotate",
                "fingerprint": fingerprint,
                "parameters": {"value": "rotated"},
            }
        )
        assert status == 201, f"agent custom directive returned {status}: {body}"
        assert count == 2, f"X-Directive-Count = {count}, want 2 (a1, a2)"

        for sid in (a1, a2):
            directive = _delivered(sid, flavor, name_a)
            assert directive is not None and directive["action"] == "custom", (
                f"{sid} of agent A did not get the directive: {directive}"
            )
            payload = directive.get("payload") or {}
            assert payload.get("fingerprint") == fingerprint, payload
            assert payload.get("directive_name") == "agent_scope_rotate", payload
            assert payload.get("parameters") == {"value": "rotated"}, payload
        assert _delivered(a_other, other_flavor, name_a) is None, (
            "a run whose flavor did not register the directive got it"
        )
        assert _delivered(b1, flavor, name_b) is None, (
            "another agent's run got agent A's directive"
        )

        # No live run of agent B's can take an unregistered fingerprint.
        agent_b = get_session(b1)["session"]["agent_id"]
        status, _, body = _post_directive(
            {
                "action": "custom",
                "agent_id": agent_b,
                "directive_name": "ghost",
                "fingerprint": f"fp-unregistered-{suffix}",
            }
        )
        assert status == 422, f"unknown fingerprint returned {status}: {body}"
    finally:
        _finish(runs, (flavor, other_flavor))
