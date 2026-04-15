"""End-to-end integration tests that exercise the REAL flightdeck_sensor.

These are the FIRST integration tests that drive `flightdeck_sensor.init()`,
`wrap()`, and `teardown()` against a live `make dev` stack. Provider HTTP
(api.anthropic.com / api.openai.com) is mocked with respx so the tests do
not need real Anthropic / OpenAI tokens. Everything else (sensor →
ingestion → NATS → workers → Postgres → query API) runs for real.

Per Phase 4.5 audit Part 5 (Hat 1 finding: 0 REAL_PIPELINE coverage in
the existing tests/integration/ suite -- every other file in this
directory POSTs hand-crafted payloads directly to /v1/events and bypasses
the sensor entirely).

NOTE on directive delivery via the post_call queue path: the EventQueue
drain thread calls ``ControlPlaneClient.post_event(item)`` and discards
the return value. Directives delivered in response envelopes for events
posted via the queue (every post_call event) are silently dropped because
the drain loop has no Session reference and never invokes
``_apply_directive``. The synchronous paths (``Session.start`` /
``Session.end``) DO apply directives.

Tests below avoid asserting on sensor-side directive application from
queued events. Instead they verify what is observable in the database:
ingestion delivered the directive (delivered_at != NULL), the worker
wrote any policy-evaluator directives, and so on. The drain-thread bug
is reported in the Part 5 findings table.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import anthropic
import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor import _directive_registry

from .conftest import (
    API_URL,
    INGESTION_URL,
    TOKEN,
    wait_until,
)

# ----------------------------------------------------------------------
# Mock provider responses
# ----------------------------------------------------------------------

ANTHROPIC_RESPONSE: dict[str, Any] = {
    "id": "msg_test123",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "Hello from mock Anthropic"}],
    "model": "claude-sonnet-4-6",
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 10, "output_tokens": 8},
}

OPENAI_RESPONSE: dict[str, Any] = {
    "id": "chatcmpl-test123",
    "object": "chat.completion",
    "created": 1234567890,
    "model": "gpt-4o",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello from mock OpenAI",
            },
            "finish_reason": "stop",
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 8,
        "total_tokens": 18,
    },
}

# ----------------------------------------------------------------------
# DB helpers (direct psql via docker exec, mirroring conftest patterns)
# ----------------------------------------------------------------------


def _psql(sql: str) -> str:
    """Run a SELECT through `docker exec psql` and return the raw stdout."""
    result = subprocess.run(
        [
            "docker", "exec", "docker-postgres-1", "psql",
            "-U", "flightdeck", "-d", "flightdeck",
            "-t", "-A", "-c", sql,
        ],
        capture_output=True, text=True, timeout=10,
    )
    return result.stdout.strip()


def _psql_json(sql: str) -> Any:
    """Run a SELECT that returns json_agg(...) and parse the result."""
    raw = _psql(sql)
    if not raw or raw == "null":
        return []
    return json.loads(raw)


def _query_events_for_flavor(flavor: str) -> list[dict[str, Any]]:
    """Return all events for the given flavor in chronological order."""
    return _psql_json(
        f"SELECT COALESCE(json_agg(row_to_json(e) ORDER BY e.occurred_at), "
        f"'[]'::json) FROM events e WHERE flavor = '{flavor}'"
    )


def _query_session_for_flavor(flavor: str) -> dict[str, Any] | None:
    """Return the (single) session row for a given flavor as a dict."""
    rows = _psql_json(
        f"SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json) "
        f"FROM sessions s WHERE flavor = '{flavor}'"
    )
    return rows[0] if rows else None


def _query_directives_for_session(session_id: str) -> list[dict[str, Any]]:
    """Return all directive rows for a session_id."""
    return _psql_json(
        f"SELECT COALESCE(json_agg(row_to_json(d)), '[]'::json) "
        f"FROM directives d WHERE d.session_id = '{session_id}'::uuid"
    )


def _query_event_content_for_session(session_id: str) -> list[dict[str, Any]]:
    """Return all event_content rows for a session_id."""
    return _psql_json(
        f"SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) "
        f"FROM event_content c WHERE c.session_id = '{session_id}'::uuid"
    )


def _delete_flavor_data(flavor: str) -> None:
    """Best-effort cleanup of all DB rows for a flavor (idempotent)."""
    statements = [
        f"DELETE FROM event_content WHERE session_id IN "
        f"(SELECT session_id FROM sessions WHERE flavor = '{flavor}')",
        f"DELETE FROM events WHERE flavor = '{flavor}'",
        f"DELETE FROM directives WHERE flavor = '{flavor}' OR session_id IN "
        f"(SELECT session_id FROM sessions WHERE flavor = '{flavor}')",
        f"DELETE FROM token_policies WHERE scope = 'flavor' AND scope_value = '{flavor}'",
        f"DELETE FROM sessions WHERE flavor = '{flavor}'",
        f"DELETE FROM agents WHERE flavor = '{flavor}'",
        f"DELETE FROM custom_directives WHERE flavor = '{flavor}'",
    ]
    for sql in statements:
        subprocess.run(
            [
                "docker", "exec", "docker-postgres-1", "psql",
                "-U", "flightdeck", "-d", "flightdeck", "-c", sql,
            ],
            capture_output=True, text=True, timeout=10,
        )


def _wait_for_event_type(
    flavor: str, event_type: str, timeout: float = 15.0,
) -> dict[str, Any]:
    """Block until at least one event of event_type exists for flavor."""
    found: dict[str, Any] = {}

    def _check() -> bool:
        nonlocal found
        for e in _query_events_for_flavor(flavor):
            if e.get("event_type") == event_type:
                found = e
                return True
        return False

    wait_until(
        _check,
        timeout=timeout,
        msg=f"no {event_type} event for flavor {flavor}",
    )
    return found


def _wait_for_directive_action(
    session_id: str, action: str, timeout: float = 15.0,
) -> dict[str, Any]:
    """Block until a directive with the given action exists for the session."""
    found: dict[str, Any] = {}

    def _check() -> bool:
        nonlocal found
        for d in _query_directives_for_session(session_id):
            if d.get("action") == action:
                found = d
                return True
        return False

    wait_until(
        _check,
        timeout=timeout,
        msg=f"no {action} directive for session {session_id}",
    )
    return found


# ----------------------------------------------------------------------
# Sensor lifecycle helpers
# ----------------------------------------------------------------------


def _force_reset_sensor() -> None:
    """Force the sensor module-level state back to its uninitialised form.

    teardown() leaves the global lock and the registry intact, but it does
    reset _session and _client to None. We additionally clear the directive
    registry so each test starts from a clean slate.
    """
    try:
        flightdeck_sensor.teardown()
    except Exception:
        pass
    flightdeck_sensor._session = None
    flightdeck_sensor._client = None
    _directive_registry.clear()


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    """Ensure clean sensor state before and after each test."""
    _force_reset_sensor()
    yield
    _force_reset_sensor()


@pytest.fixture
def unique_flavor() -> Iterator[str]:
    """Yield a unique flavor name for test isolation; cleanup DB rows after."""
    flavor = f"e2e-{uuid.uuid4().hex[:10]}"
    # Set the env var BEFORE the sensor is initialised so the value is
    # captured in SensorConfig.agent_flavor at init() time.
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        _delete_flavor_data(flavor)


# ----------------------------------------------------------------------
# Mock provider routes
# ----------------------------------------------------------------------


def _mock_anthropic_messages(
    rmock: respx.MockRouter,
    response: dict[str, Any] | None = None,
    latency_ms: int = 0,
) -> None:
    """Mock the Anthropic /v1/messages endpoint.

    ``latency_ms`` simulates real provider latency. The default of 0
    keeps every existing test's behavior unchanged. The
    multithreaded ``test_pattern_b_*`` and ``test_slow_handler_*``
    tests pass ``latency_ms=50`` so the mocked HTTP round trip takes
    a realistic minimum LLM provider time -- without this, four
    concurrent workers fire thousands of events per second through
    the respx mock and overflow the sensor's 1000-slot event queue
    on a slow CI runner. Real LLM providers take hundreds of
    milliseconds per call, so the unbounded producer rate is a test
    artifact, not a production scenario. KI16 covers the optional
    Phase 4.9 batch ingestion improvement that would raise the
    drain ceiling further; the 50 ms tick here is the minimum
    necessary to make the test scenario match production.
    """
    body = response or ANTHROPIC_RESPONSE
    if latency_ms > 0:
        delay_secs = latency_ms / 1000

        def _delayed_response(_request: httpx.Request) -> httpx.Response:
            time.sleep(delay_secs)
            return httpx.Response(200, json=body)

        rmock.post("https://api.anthropic.com/v1/messages").mock(
            side_effect=_delayed_response
        )
    else:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json=body)
        )


def _mock_openai_chat(
    rmock: respx.MockRouter,
    response: dict[str, Any] | None = None,
) -> None:
    rmock.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=response or OPENAI_RESPONSE)
    )


def _post_directive(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /v1/directives directly to the query API. Never raises on 4xx."""
    import urllib.error
    import urllib.request

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/directives",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except Exception:
            return exc.code, {}


def _post_policy(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /v1/policies and return (status, body)."""
    import urllib.error
    import urllib.request

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/policies",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except Exception:
            return exc.code, {}


def _register_directive_via_api(
    flavor: str,
    fingerprint: str,
    name: str,
    description: str = "multithreading e2e",
    parameters: list[dict[str, Any]] | None = None,
) -> None:
    """Pre-register a custom directive via /api/v1/directives/register.

    Workaround for KI14 -- the sensor's auto-sync URL is broken in dev,
    so the multithreading tests register the directive directly via the
    API to make it triggerable from POST /v1/directives.
    """
    body = {
        "flavor": flavor,
        "directives": [{
            "fingerprint": fingerprint,
            "name": name,
            "description": description,
            "flavor": flavor,
            "parameters": parameters or [],
        }],
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/directives/register",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200, f"register returned {resp.status}"


def _delete_policy_quiet(policy_id: str | None) -> None:
    """Best-effort DELETE /v1/policies/:id, ignoring errors."""
    if not policy_id:
        return
    req = urllib.request.Request(
        f"{API_URL}/v1/policies/{policy_id}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def _wait_for_directive_result(
    flavor: str,
    directive_name: str,
    directive_status: str,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """Block until a directive_result event matching name+status exists."""
    found: dict[str, Any] = {}

    def _check() -> bool:
        nonlocal found
        for e in _query_events_for_flavor(flavor):
            if e.get("event_type") != "directive_result":
                continue
            payload = e.get("payload") or {}
            if payload.get("directive_name") != directive_name:
                continue
            if payload.get("directive_status") != directive_status:
                continue
            found = e
            return True
        return False

    wait_until(
        _check,
        timeout=timeout,
        msg=(
            f"directive_result(name={directive_name}, "
            f"status={directive_status}) not in DB for flavor {flavor}"
        ),
    )
    return found


# ======================================================================
# Test 1 -- Anthropic full pipeline
# ======================================================================


def test_sensor_anthropic_full_pipeline(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Real sensor + wrap(Anthropic) + intercepted call → DB has events."""
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key")
        )

        response = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )
        assert response.id == "msg_test123"

        # session_start is sent synchronously by Session.start() so it
        # should already be in the DB once init() returns.
        _wait_for_event_type(flavor, "session_start", timeout=10)

        # post_call is enqueued by the interceptor, drained asynchronously,
        # then processed by the workers.
        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
        assert post_call["tokens_input"] == 10
        assert post_call["tokens_output"] == 8
        assert post_call["tokens_total"] == 18
        assert post_call["model"] == "claude-sonnet-4-6"

        # capture_prompts default is False -> no event_content rows
        sess = _query_session_for_flavor(flavor)
        assert sess is not None, f"no session for flavor {flavor}"
        content_rows = _query_event_content_for_session(sess["session_id"])
        assert len(content_rows) == 0, (
            "expected zero event_content rows when capture_prompts=False, "
            f"got {len(content_rows)}"
        )

        # has_content must be False on every events row for this flavor.
        for ev in _query_events_for_flavor(flavor):
            assert ev.get("has_content") is False, (
                f"event {ev.get('id')} has has_content=True without capture"
            )


# ======================================================================
# Test 2 -- OpenAI full pipeline
# ======================================================================


def test_sensor_openai_full_pipeline(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Real sensor + wrap(OpenAI) + intercepted chat.completions call."""
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        _mock_openai_chat(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        client = flightdeck_sensor.wrap(openai.OpenAI(api_key="test-key"))

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )
        assert response.id == "chatcmpl-test123"

        _wait_for_event_type(flavor, "session_start", timeout=10)
        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)

        assert post_call["tokens_input"] == 10
        assert post_call["tokens_output"] == 8
        assert post_call["tokens_total"] == 18
        assert post_call["model"] == "gpt-4o"


# ======================================================================
# Test 3 -- capture_prompts=True
# ======================================================================


def test_sensor_capture_prompts_true(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """capture_prompts=True writes to event_content but NOT events.payload."""
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(
            server=INGESTION_URL,
            token=TOKEN,
            capture_prompts=True,
        )
        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key")
        )

        client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )

        _wait_for_event_type(flavor, "session_start", timeout=10)
        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)

        assert post_call.get("has_content") is True, (
            f"expected has_content=True on post_call, got {post_call}"
        )

        sess = _query_session_for_flavor(flavor)
        assert sess is not None
        content_rows = _query_event_content_for_session(sess["session_id"])
        assert len(content_rows) >= 1, (
            f"expected >= 1 event_content row, got {len(content_rows)}"
        )

        # Content lives in event_content only -- the events row's payload
        # column must NOT inline the prompt body. We assert there is no
        # 'messages' / 'system' / 'response' key on the events.payload
        # JSONB for this row (BuildEventExtra only writes
        # directive_result metadata into payload, not prompt content).
        payload = post_call.get("payload")
        if payload:
            assert "messages" not in payload, (
                "events.payload must not inline messages content"
            )
            assert "system" not in payload
            assert "response" not in payload


# ======================================================================
# Test 4 -- Custom directive registered AND triggered end-to-end
# ======================================================================
#
# Strengthened in the Part 5 follow-up commit that fixed B-A (drain
# thread now applies directives via the directive_callback wired
# through Session.__init__) and B-D (directive_result events use the
# worker-schema field names so directive_status / result / error
# survive ingestion).
#
# B-B is still open (KI14): the sensor's auto-sync URL routing
# targets /ingest/v1/directives/sync which 404s in dev. The test
# works around this by pre-registering the directive via the
# auth-bearing /api/v1/directives/register endpoint directly. The
# sensor's local registry is still populated via the @directive
# decorator, init() still calls sync (which fails open), and the
# rest of the path -- POST → drain → _apply_directive → handler
# invocation → directive_result event in DB -- is verified.


def test_sensor_custom_directive_registered_and_triggered(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Decorator registers handler, POST custom directive, drain thread
    applies it, handler runs, directive_result lands in DB."""
    import urllib.request

    flavor = unique_flavor
    handler_calls: list[dict[str, Any]] = []

    @flightdeck_sensor.directive(
        name="e2e_test_action",
        description="E2E custom directive registration test",
        parameters=[
            flightdeck_sensor.Parameter(
                name="value",
                type="string",
                required=False,
                default="default_val",
            ),
        ],
    )
    def e2e_test_action(ctx: Any, value: str = "default_val") -> dict[str, Any]:
        handler_calls.append({"value": value})
        return {"executed": True, "value": value}

    # The decorator must populate the local registry.
    assert "e2e_test_action" in _directive_registry
    fingerprint = _directive_registry["e2e_test_action"].fingerprint

    # KI14 workaround: pre-register the directive via the API directly
    # so the fingerprint exists in custom_directives by the time the
    # POST below runs (the sensor's sync_directives 404s in dev).
    register_body = {
        "flavor": flavor,
        "directives": [{
            "fingerprint": fingerprint,
            "name": "e2e_test_action",
            "description": "E2E custom directive registration test",
            "flavor": flavor,
            "parameters": [
                {"name": "value", "type": "string", "required": False, "default": "default_val"},
            ],
        }],
    }
    data = json.dumps(register_body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/directives/register",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        session_id = flightdeck_sensor.get_status().session_id

        # Verify the directive is in the API list (placed there by the
        # manual register above).
        req = urllib.request.Request(
            f"{API_URL}/v1/directives/custom?flavor={flavor}",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
        names = {d["name"] for d in body.get("directives", [])}
        assert "e2e_test_action" in names, (
            f"expected e2e_test_action in /v1/directives/custom, got {names}"
        )

        # POST the custom directive against the sensor's session BEFORE
        # making the intercepted call so it is in the response envelope
        # of the very next post_event call from the drain thread.
        code, _ = _post_directive({
            "action": "custom",
            "directive_name": "e2e_test_action",
            "fingerprint": fingerprint,
            "session_id": session_id,
            "parameters": {"value": "hello_from_e2e"},
        })
        assert code == 201, f"expected 201, got {code}"

        # The directive row exists in the directives table.
        rows = _query_directives_for_session(session_id)
        custom_rows = [r for r in rows if r.get("action") == "custom"]
        assert len(custom_rows) == 1, (
            f"expected 1 custom directive row, got {len(custom_rows)}"
        )

        # Make an intercepted call. This enqueues a post_call event,
        # the drain thread posts it, ingestion returns the pending
        # custom directive in the response envelope, the drain thread
        # invokes _apply_directive (B-A fix), which calls
        # _execute_custom_directive, which calls the handler.
        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key")
        )
        client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "trigger"}],
            max_tokens=10,
        )

        # 1. Handler was actually called with the parameter from the
        #    directive POST.
        wait_until(
            lambda: len(handler_calls) > 0,
            timeout=15,
            msg="custom directive handler was not invoked",
        )
        assert handler_calls == [{"value": "hello_from_e2e"}], (
            f"unexpected handler invocations: {handler_calls}"
        )

        # 2. directive_result event landed in the DB with
        #    directive_status="success" and the right directive_name
        #    (B-D fix means these fields now survive ingestion).
        def _result_in_db() -> bool:
            for e in _query_events_for_flavor(flavor):
                if e.get("event_type") != "directive_result":
                    continue
                payload = e.get("payload") or {}
                if payload.get("directive_name") != "e2e_test_action":
                    continue
                if payload.get("directive_status") != "success":
                    continue
                return True
            return False

        wait_until(
            _result_in_db,
            timeout=15,
            msg="directive_result(success) event for e2e_test_action not in DB",
        )

        # 3. Directive row is no longer pending -- ingestion's atomic
        #    LookupPending UPDATE...RETURNING marked delivered_at when
        #    the drain thread fetched it.
        def _delivered() -> bool:
            for d in _query_directives_for_session(session_id):
                if d.get("action") == "custom" and d.get("delivered_at"):
                    return True
            return False

        wait_until(
            _delivered,
            timeout=15,
            msg="custom directive was not marked delivered",
        )


# ======================================================================
# Test 5 -- Shutdown directive end-to-end
# ======================================================================


def test_sensor_shutdown_directive_delivered(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """POST shutdown → make call → drain delivers shutdown to session →
    directive_result(acknowledged) lands in DB → teardown closes session.

    Strengthened in the Part 5 follow-up commit that fixed B-A. Before
    the fix the drain thread silently dropped the shutdown directive
    and the test could only verify "directive row inserted".
    """
    flavor = unique_flavor
    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        session_id = flightdeck_sensor.get_status().session_id

        code, _ = _post_directive({
            "action": "shutdown",
            "session_id": session_id,
            "reason": "e2e shutdown test",
        })
        assert code == 201, f"expected 201, got {code}"

        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key")
        )
        client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "trigger drain"}],
            max_tokens=10,
        )

        # Drain processes post_call → ingestion returns shutdown
        # directive in envelope → drain calls _apply_directive →
        # ack enqueued (directive_status="acknowledged") and
        # _shutdown_requested=True. The ack lands in the DB on the
        # drain loop's next iteration.
        def _ack_in_db() -> bool:
            for e in _query_events_for_flavor(flavor):
                if e.get("event_type") != "directive_result":
                    continue
                payload = e.get("payload") or {}
                if payload.get("directive_name") != "shutdown":
                    continue
                if payload.get("directive_status") != "acknowledged":
                    continue
                return True
            return False

        wait_until(
            _ack_in_db,
            timeout=15,
            msg="shutdown acknowledgement event not in DB",
        )

        # teardown calls Session.end() which posts session_end
        # synchronously; the workers then update sessions.state to
        # "closed". Wait for that transition.
        flightdeck_sensor.teardown()

    def _state_closed() -> bool:
        sess = _query_session_for_flavor(flavor)
        return sess is not None and sess.get("state") == "closed"

    wait_until(
        _state_closed,
        timeout=15,
        msg=f"session for flavor {flavor} did not transition to closed",
    )


# ======================================================================
# Test 6 -- Degrade directive (delivered to ingestion, dropped by drain)
# ======================================================================


def test_sensor_degrade_directive_via_policy_threshold(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Server policy crosses degrade threshold → second intercepted call
    uses the degraded model.

    Strengthened in the Part 5 follow-up commit. The previous version
    only verified that the workers wrote the degrade row. Now the test
    actually drives a second LLM call and asserts the post_call event
    in the DB has the degraded model name.

    The mock provider echoes the request's ``model`` field back into
    the response so that the sensor's post_call event reports the
    model the sensor actually sent (which after _pre_call's DEGRADE
    swap is the degraded model).
    """
    flavor = unique_flavor
    degraded_model = "claude-haiku-4-5-20251001"

    # warn=5, degrade=15, block=100. The mock returns 18 tokens. After
    # the first call tokens_used=18, projected for the second call is
    # 18+10=28, pct=28% which crosses degrade (15%) but not block
    # (100%). _pre_call swaps the model on the second call.
    code, policy_body = _post_policy({
        "scope": "flavor",
        "scope_value": flavor,
        "token_limit": 100,
        "warn_at_pct": 5,
        "degrade_at_pct": 15,
        "block_at_pct": 100,
        "degrade_to": degraded_model,
    })
    assert code == 201, f"expected 201 from policy create, got {code}"

    def _echo_model_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        model = body.get("model", "claude-sonnet-4-6")
        return httpx.Response(200, json={**ANTHROPIC_RESPONSE, "model": model})

    with respx.mock(assert_all_called=False) as rmock:
        rmock.post("https://api.anthropic.com/v1/messages").mock(
            side_effect=_echo_model_handler
        )

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        session_id = flightdeck_sensor.get_status().session_id

        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key")
        )

        # Call 1 -- triggers a post_call event that the workers'
        # policy evaluator processes. After processing, the workers
        # write a degrade directive into the directives table because
        # the session's tokens_used (18) has crossed degrade_at_pct
        # (15% of 100 = 15 tokens).
        first = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "first"}],
            max_tokens=10,
        )
        assert first.model == "claude-sonnet-4-6"

        # Wait until the workers have written the degrade directive
        # into the database.
        degrade = _wait_for_directive_action(session_id, "degrade", timeout=15)
        assert degrade["flavor"] == flavor
        assert degrade.get("degrade_to") == degraded_model

        # Call 2 -- the sensor's drain thread will pick up this
        # post_call event, and ingestion will return the pending
        # degrade directive in the response envelope. The drain
        # thread (B-A fix) calls _apply_directive(DEGRADE) which
        # arms PolicyCache._forced_degrade (B-E fix). Call 2 itself
        # still goes out with sonnet because the swap only happens
        # AFTER the directive is delivered.
        client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "second"}],
            max_tokens=10,
        )

        # Wait until the directive has been marked delivered, which
        # is the proof point that the drain thread received and acted
        # on it (delivered_at is populated by ingestion's atomic
        # UPDATE...RETURNING when the drain pulled it).
        def _directive_delivered() -> bool:
            for d in _query_directives_for_session(session_id):
                if d.get("action") == "degrade" and d.get("delivered_at"):
                    return True
            return False

        wait_until(
            _directive_delivered,
            timeout=15,
            msg="degrade directive was not marked delivered",
        )

        # Call 3 -- _pre_call now sees PolicyCache._forced_degrade
        # and swaps the model to haiku. The mock echoes haiku back,
        # so response.model is haiku, and the sensor's post_call
        # event in the DB records model=haiku.
        third = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "third"}],
            max_tokens=10,
        )
        assert third.model == degraded_model, (
            f"expected response model {degraded_model}, got {third.model}"
        )

        # And the sensor's post_call event for the third call records
        # the degraded model in the DB.
        def _post_call_with_degraded_model() -> bool:
            for e in _query_events_for_flavor(flavor):
                if e.get("event_type") == "post_call" and e.get("model") == degraded_model:
                    return True
            return False

        wait_until(
            _post_call_with_degraded_model,
            timeout=15,
            msg=f"no post_call event with model={degraded_model}",
        )

    # Cleanup the policy row
    if policy_body.get("id"):
        import urllib.request
        req = urllib.request.Request(
            f"{API_URL}/v1/policies/{policy_body['id']}",
            headers={"Authorization": f"Bearer {TOKEN}"},
            method="DELETE",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass


# ======================================================================
# Test 7 -- Server policy fires warn directive end-to-end
# ======================================================================


def test_sensor_server_policy_warn_fires_directive(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Server policy → workers evaluate post_call → warn directive row.

    The user spec asked for a "policy_warn event in DB". The sensor
    only emits POLICY_WARN events when it RECEIVES a WARN directive,
    which is dropped by the drain bug. What is observable end-to-end is
    that the workers' policy evaluator wrote a warn directive after the
    sensor's post_call event was processed -- which is what the
    enforcement integration tests already assert against fabricated
    events.
    """
    flavor = unique_flavor

    # Token limit of 100 with warn at 10% so the mock's 18 tokens
    # crosses warn (10 tokens) but not block (100 tokens). The Go
    # PolicyEvaluator returns immediately after writing a block /
    # shutdown directive, so a high enough limit is required for the
    # warn branch to ever fire.
    code, policy_body = _post_policy({
        "scope": "flavor",
        "scope_value": flavor,
        "token_limit": 100,
        "warn_at_pct": 10,
    })
    assert code == 201, f"expected 201 from policy create, got {code}"

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        session_id = flightdeck_sensor.get_status().session_id
        client = flightdeck_sensor.wrap(
            anthropic.Anthropic(api_key="test-key")
        )

        # Mock returns 18 total tokens; 18/12 > 100% so the workers
        # write a warn directive (dedup-once) after the post_call event
        # is processed.
        client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=10,
        )

        _wait_for_event_type(flavor, "post_call", timeout=15)
        warn = _wait_for_directive_action(session_id, "warn", timeout=15)
        assert warn["flavor"] == flavor

    # Cleanup the policy row
    if policy_body.get("id"):
        import urllib.request
        req = urllib.request.Request(
            f"{API_URL}/v1/policies/{policy_body['id']}",
            headers={"Authorization": f"Bearer {TOKEN}"},
            method="DELETE",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass


# ======================================================================
# Test 8 -- Custom directive with unknown fingerprint rejected
# ======================================================================


def test_sensor_custom_directive_unknown_fingerprint(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """POST /v1/directives action=custom with a fake fingerprint → 422.

    The query API's CreateDirectiveHandler refuses the request before
    inserting any rows, via the new CustomDirectiveExists check (Part 2
    audit). Verifies the rejection is enforced and no directive row is
    created.
    """
    flavor = unique_flavor

    flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
    session_id = flightdeck_sensor.get_status().session_id

    fake_fp = f"fake-fp-{uuid.uuid4().hex[:12]}"
    code, body = _post_directive({
        "action": "custom",
        "directive_name": "nonexistent",
        "fingerprint": fake_fp,
        "session_id": session_id,
    })
    assert code == 422, f"expected 422, got {code} (body={body})"

    # Zero directive rows for this fingerprint.
    rows = _psql(
        f"SELECT COUNT(*) FROM directives "
        f"WHERE payload IS NOT NULL "
        f"AND payload->>'fingerprint' = '{fake_fp}'"
    )
    assert rows == "0", f"expected 0 rows, got {rows}"


# ======================================================================
# Test 9 -- Flavor fanout for custom directive
# ======================================================================


def test_sensor_flavor_fanout_directive(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """POST custom directive with flavor (no session_id) → fan out per session.

    Builds 3 active sessions for the flavor by issuing fabricated
    session_start events (the sensor isn't required for the fanout
    semantics under test -- this verifies the API's fanout logic, not the
    sensor's directive delivery).
    """
    import urllib.request

    flavor = unique_flavor

    # Register a directive directly via the sensor-facing endpoint so it
    # exists in custom_directives, then create 3 sessions via the
    # ingestion API and POST a flavor-wide custom directive.
    fp = f"e2e-fanout-{uuid.uuid4().hex[:12]}"
    register_body = {
        "flavor": flavor,
        "directives": [{
            "fingerprint": fp,
            "name": "e2e_fanout",
            "description": "fanout test",
            "flavor": flavor,
            "parameters": [],
        }],
    }
    data = json.dumps(register_body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/directives/register",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200

    # Build 3 active sessions via fabricated session_start events.
    from .conftest import make_event, post_event, wait_for_session_in_fleet

    sids = []
    for _ in range(3):
        sid = str(uuid.uuid4())
        sids.append(sid)
        post_event(make_event(sid, flavor, "session_start"))
        assert wait_for_session_in_fleet(sid, timeout=10) is not None

    code, body = _post_directive({
        "action": "custom",
        "directive_name": "e2e_fanout",
        "fingerprint": fp,
        "flavor": flavor,
    })
    assert code == 201, f"expected 201, got {code} (body={body})"

    # One directive row per active session.
    total_custom = 0
    for sid in sids:
        rows = _query_directives_for_session(sid)
        total_custom += len([r for r in rows if r.get("action") == "custom"])
    assert total_custom == 3, (
        f"expected 3 custom directives total across 3 sessions, got {total_custom}"
    )


# ======================================================================
# Test 10 -- Runtime context collected at init() and stored in sessions
# ======================================================================


def test_sensor_context_collected_at_init(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Init the sensor and verify sessions.context has the expected fields."""
    flavor = unique_flavor

    flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)

    # session_start is synchronous so the row should be there immediately,
    # but the worker INSERT can lag a tick after the publish. Wait for it.
    def _has_session() -> bool:
        return _query_session_for_flavor(flavor) is not None

    wait_until(_has_session, timeout=10, msg=f"no session row for {flavor}")
    sess = _query_session_for_flavor(flavor)
    assert sess is not None

    ctx = sess.get("context") or {}
    # Hostname is best-effort -- some CI environments may give an empty
    # string. Just require the field to exist as a non-empty string.
    assert isinstance(ctx.get("hostname"), str)
    assert len(ctx["hostname"]) > 0
    assert ctx.get("os") in ("Linux", "Darwin", "Windows"), (
        f"unexpected os value: {ctx.get('os')}"
    )
    assert isinstance(ctx.get("pid"), int) and ctx["pid"] > 0
    import platform
    assert ctx.get("python_version") == platform.python_version(), (
        f"python_version mismatch: ctx={ctx.get('python_version')} "
        f"actual={platform.python_version()}"
    )


# ======================================================================
# Test 11 -- Unavailable continue policy: agent proceeds despite no CP
# ======================================================================


def test_sensor_unavailable_continue(sensor_reset: None) -> None:
    """Unreachable control plane + continue policy → call still succeeds.

    This test does NOT use unique_flavor because nothing should land in
    the database -- the control plane is unreachable for the entire test.
    """
    # Bind a unique flavor for log clarity but don't expect DB rows.
    flavor = f"e2e-unreachable-{uuid.uuid4().hex[:8]}"
    os.environ["AGENT_FLAVOR"] = flavor
    os.environ["FLIGHTDECK_UNAVAILABLE_POLICY"] = "continue"

    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_anthropic_messages(rmock)

            # Port 19999 is intentionally not bound by anything in the
            # dev stack, so every sensor POST returns ECONNREFUSED.
            flightdeck_sensor.init(
                server="http://localhost:19999",
                token="fake-token",
            )
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            # No exception expected -- the agent must proceed.
            response = client.messages.create(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "Hello"}],
                max_tokens=10,
            )
            assert response.id == "msg_test123"
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        os.environ.pop("FLIGHTDECK_UNAVAILABLE_POLICY", None)


# ======================================================================
# Test 12 -- Context facets aggregation (Part 5 SECTION D coverage gap)
# ======================================================================


def test_context_facets_aggregation(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """GetContextFacets aggregates real sessions.context across the fleet.

    Part 5 SECTION D: this is the first integration test that exercises
    the Phase 4.5 GetContextFacets path with REAL context data. Existing
    tests only ever insert empty contexts via fabricated session_start
    events.
    """
    import urllib.request

    flavor = unique_flavor
    flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)

    def _has_session() -> bool:
        return _query_session_for_flavor(flavor) is not None

    wait_until(_has_session, timeout=10, msg=f"no session for {flavor}")
    sess = _query_session_for_flavor(flavor)
    assert sess is not None
    ctx = sess.get("context") or {}
    expected_os = ctx.get("os")
    assert expected_os, "context.os not collected"

    req = urllib.request.Request(
        f"{API_URL}/v1/fleet",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        fleet = json.loads(resp.read())

    facets = fleet.get("context_facets") or {}
    assert "os" in facets, (
        f"expected 'os' in context_facets, got keys {list(facets.keys())}"
    )
    os_values = {entry["value"] for entry in facets["os"]}
    assert expected_os in os_values, (
        f"sensor's os ({expected_os}) missing from facets {os_values}"
    )


# ======================================================================
# MULTITHREADING TESTS (Phase 4.5 audit Part 3)
# ======================================================================
#
# All tests below exercise the sensor under realistic concurrent
# deployment patterns. They use real ``threading.Thread``, the real
# ``flightdeck_sensor.init()`` / ``wrap()`` lifecycle, ``respx``
# mocked providers, and verify the resulting state in the live DB.
#
# Each test owns a unique flavor (via ``unique_flavor``) and tears
# down the sensor in a finally block.
#
# Patterns covered:
#   A -- single-threaded agent (test_pattern_a_*)
#   B -- multithreaded agent sharing one Session (test_pattern_b_*)
#   C -- one init() per thread (DOCUMENTS KI15 -- not supported)
#   D -- long-running agent receiving directives mid-flight
#
# These are the FIRST tests that exercise the sensor's threading
# story end-to-end. Several B-A / B-G / B-H bugs were caught by
# adding them.

# Common configuration for the multithreading tests below.
_MT_NUM_THREADS = 4
_MT_CALLS_PER_THREAD = 5


# ======================================================================
# Test M1 -- Pattern B: concurrent calls produce no data loss
# ======================================================================


def test_pattern_b_concurrent_calls_no_data_loss(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """N threads share one patched client → every call is in DB once.

    Pattern B: one init(), one ``client``, multiple worker threads
    making LLM calls concurrently. The sensor's EventQueue must safely
    accept concurrent enqueues from N producers, the workers must
    persist exactly one events row per call, and ``tokens_used_session``
    must be a strictly monotonic sequence with no duplicates and no
    gaps (B-G fix proves out under load).
    """
    flavor = unique_flavor
    expected_calls = _MT_NUM_THREADS * _MT_CALLS_PER_THREAD

    errors: list[BaseException] = []
    errors_lock = threading.Lock()

    with respx.mock(assert_all_called=False) as rmock:
        # 50 ms mock latency simulates real LLM provider RTT so the
        # 4 concurrent workers cannot fire faster than the drain
        # thread can flush. See _mock_anthropic_messages docstring
        # and KI16 for the rationale.
        _mock_anthropic_messages(rmock, latency_ms=50)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        try:
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            def _worker(thread_id: int) -> None:
                try:
                    for i in range(_MT_CALLS_PER_THREAD):
                        client.messages.create(
                            model="claude-sonnet-4-6",
                            messages=[{
                                "role": "user",
                                "content": f"t{thread_id}-c{i}",
                            }],
                            max_tokens=10,
                        )
                except BaseException as exc:  # noqa: BLE001
                    with errors_lock:
                        errors.append(exc)

            threads = [
                threading.Thread(target=_worker, args=(i,))
                for i in range(_MT_NUM_THREADS)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)
                assert not t.is_alive(), f"thread {t.name} did not finish"

            assert errors == [], f"thread errors: {errors}"

            # Wait for every post_call event to land in DB.
            def _all_post_calls() -> bool:
                events = _query_events_for_flavor(flavor)
                return sum(
                    1 for e in events if e.get("event_type") == "post_call"
                ) >= expected_calls

            wait_until(
                _all_post_calls,
                timeout=30,
                msg=f"expected {expected_calls} post_call events",
            )

            events = _query_events_for_flavor(flavor)
            post_calls = [
                e for e in events if e.get("event_type") == "post_call"
            ]
            assert len(post_calls) == expected_calls, (
                f"expected {expected_calls} post_call events, "
                f"got {len(post_calls)} (excess events would mean "
                "duplication; missing events would mean loss)"
            )

            # Per-event token counts always come from the mock, never
            # corrupted by concurrent threads.
            for e in post_calls:
                assert e["tokens_input"] == 10
                assert e["tokens_output"] == 8
                assert e["tokens_total"] == 18
                assert e["model"] == "claude-sonnet-4-6"

            # The per-event sensor field ``tokens_used_session`` is
            # NOT persisted by the workers (BuildEventExtra only
            # writes directive_result metadata into events.payload),
            # so the post-fix sequence is not directly observable
            # from the DB. The B-G fix is verified instead by the
            # CUMULATIVE total in two places:
            #
            #   1. Workers' sessions.tokens_used must equal
            #      expected_calls * 18 (proves no event lost,
            #      no event duplicated by the worker pipeline).
            #   2. Sensor's get_status().tokens_used must equal
            #      expected_calls * 18 (proves record_usage is
            #      atomic under N concurrent producers; the B-G
            #      fix made record_usage return the post-increment
            #      total inside the same critical section).
            expected_total = expected_calls * 18

            wait_until(
                lambda: (
                    (s := _query_session_for_flavor(flavor)) is not None
                    and s.get("tokens_used") == expected_total
                ),
                timeout=15,
                msg=(
                    f"sessions.tokens_used should be {expected_total} "
                    "after all concurrent calls"
                ),
            )

            status = flightdeck_sensor.get_status()
            assert status.tokens_used == expected_total, (
                f"sensor's local _tokens_used should be {expected_total}, "
                f"got {status.tokens_used} -- record_usage race"
            )
        finally:
            flightdeck_sensor.teardown()


# ======================================================================
# Test M2 -- Pattern B: custom directive during concurrent traffic
# ======================================================================


def test_pattern_b_custom_directive_during_traffic(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Custom directive executes exactly once even with N concurrent
    workers. Event throughput must continue uninterrupted."""
    flavor = unique_flavor
    handler_calls: list[float] = []
    handler_lock = threading.Lock()

    @flightdeck_sensor.directive(
        name="e2e_concurrent_action",
        description="custom during concurrent traffic",
        parameters=[],
    )
    def e2e_concurrent_action(ctx: Any) -> dict[str, Any]:
        with handler_lock:
            handler_calls.append(time.time())
        return {"executed": True}

    fingerprint = _directive_registry["e2e_concurrent_action"].fingerprint
    _register_directive_via_api(
        flavor, fingerprint, "e2e_concurrent_action"
    )

    with respx.mock(assert_all_called=False) as rmock:
        # 50 ms mock latency -- see test_pattern_b_concurrent_calls_no_data_loss
        # for the rationale.
        _mock_anthropic_messages(rmock, latency_ms=50)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        try:
            session_id = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            stop = threading.Event()
            errors: list[BaseException] = []
            errors_lock = threading.Lock()

            def _worker() -> None:
                try:
                    while not stop.is_set():
                        client.messages.create(
                            model="claude-sonnet-4-6",
                            messages=[{"role": "user", "content": "x"}],
                            max_tokens=10,
                        )
                except BaseException as exc:  # noqa: BLE001
                    with errors_lock:
                        errors.append(exc)

            workers = [
                threading.Thread(target=_worker)
                for _ in range(_MT_NUM_THREADS)
            ]
            for t in workers:
                t.start()

            try:
                # Let some traffic flow before posting the directive
                wait_until(
                    lambda: sum(
                        1
                        for e in _query_events_for_flavor(flavor)
                        if e.get("event_type") == "post_call"
                    ) >= _MT_NUM_THREADS,
                    timeout=15,
                    msg="initial post_call traffic did not flow",
                )

                # Post the custom directive
                code, _ = _post_directive({
                    "action": "custom",
                    "directive_name": "e2e_concurrent_action",
                    "fingerprint": fingerprint,
                    "session_id": session_id,
                })
                assert code == 201

                # Wait for the handler to be called
                wait_until(
                    lambda: len(handler_calls) >= 1,
                    timeout=20,
                    msg="custom handler was not invoked under traffic",
                )
            finally:
                stop.set()
                for t in workers:
                    t.join(timeout=15)

            assert errors == [], f"thread errors: {errors}"

            # Handler executed EXACTLY once -- single-consumer
            # directive thread gives at-most-once for free (B-H).
            assert len(handler_calls) == 1, (
                f"expected handler called exactly once under concurrent "
                f"traffic, got {len(handler_calls)}"
            )

            # directive_result(success) lands in DB
            _wait_for_directive_result(
                flavor, "e2e_concurrent_action", "success", timeout=15
            )
        finally:
            flightdeck_sensor.teardown()


# ======================================================================
# Test M3 -- Pattern B: shutdown during concurrent traffic
# ======================================================================


def test_pattern_b_shutdown_during_traffic(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Shutdown directive arrives during concurrent traffic. All workers
    stop within bounded time, ack is in DB (B-H flush() guarantee),
    session transitions to closed."""
    flavor = unique_flavor

    with respx.mock(assert_all_called=False) as rmock:
        # 50 ms mock latency -- see test_pattern_b_concurrent_calls_no_data_loss
        # for the rationale.
        _mock_anthropic_messages(rmock, latency_ms=50)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        try:
            session_id = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            stop = threading.Event()
            shutdown_seen = threading.Event()
            shutdown_count = [0]
            shutdown_lock = threading.Lock()
            errors: list[BaseException] = []

            def _worker() -> None:
                try:
                    while not stop.is_set():
                        try:
                            client.messages.create(
                                model="claude-sonnet-4-6",
                                messages=[{"role": "user", "content": "x"}],
                                max_tokens=10,
                            )
                        except flightdeck_sensor.DirectiveError:
                            with shutdown_lock:
                                shutdown_count[0] += 1
                            shutdown_seen.set()
                            return  # exit cleanly
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            workers = [
                threading.Thread(target=_worker)
                for _ in range(_MT_NUM_THREADS)
            ]
            for t in workers:
                t.start()

            try:
                # Let traffic flow
                wait_until(
                    lambda: sum(
                        1
                        for e in _query_events_for_flavor(flavor)
                        if e.get("event_type") == "post_call"
                    ) >= _MT_NUM_THREADS,
                    timeout=15,
                )

                # Post shutdown
                code, _ = _post_directive({
                    "action": "shutdown",
                    "session_id": session_id,
                    "reason": "concurrent shutdown e2e",
                })
                assert code == 201

                # B-H proof: the synchronous flush() inside
                # _apply_directive(SHUTDOWN) ran successfully on the
                # directive handler thread (no deadlock), so the ack
                # event is in the DB before any worker can be observed
                # to raise.
                _wait_for_directive_result(
                    flavor, "shutdown", "acknowledged", timeout=20
                )

                # At least one worker observed the DirectiveError
                assert shutdown_seen.wait(timeout=15), (
                    "no worker raised DirectiveError after shutdown"
                )
            finally:
                stop.set()
                for t in workers:
                    t.join(timeout=20)
                    assert not t.is_alive(), (
                        f"worker {t.name} did not exit after shutdown"
                    )

            assert errors == [], f"unexpected errors: {errors}"
            assert shutdown_count[0] >= 1, (
                f"expected ≥ 1 shutdown observed, got {shutdown_count[0]}"
            )
        finally:
            flightdeck_sensor.teardown()

        # After teardown, the session must be closed in the DB
        wait_until(
            lambda: (
                (s := _query_session_for_flavor(flavor)) is not None
                and s.get("state") == "closed"
            ),
            timeout=15,
            msg=f"session for {flavor} did not transition to closed",
        )


# ======================================================================
# Test M4 -- Pattern A: shutdown on a single-threaded agent
# ======================================================================


def test_pattern_a_shutdown_single_threaded(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Pattern A: one thread, sequential calls, shutdown directive,
    next call raises, session closes cleanly."""
    flavor = unique_flavor

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        try:
            session_id = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            # Warm the pipeline
            client.messages.create(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "warm"}],
                max_tokens=10,
            )
            _wait_for_event_type(flavor, "post_call", timeout=15)

            # Post shutdown
            code, _ = _post_directive({
                "action": "shutdown",
                "session_id": session_id,
                "reason": "pattern-a shutdown",
            })
            assert code == 201

            # Trigger directive delivery via another call
            client.messages.create(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "deliver"}],
                max_tokens=10,
            )

            _wait_for_directive_result(
                flavor, "shutdown", "acknowledged", timeout=15
            )

            # Next call must raise DirectiveError
            with pytest.raises(flightdeck_sensor.DirectiveError):
                client.messages.create(
                    model="claude-sonnet-4-6",
                    messages=[{"role": "user", "content": "after"}],
                    max_tokens=10,
                )
        finally:
            flightdeck_sensor.teardown()

        wait_until(
            lambda: (
                (s := _query_session_for_flavor(flavor)) is not None
                and s.get("state") == "closed"
            ),
            timeout=15,
            msg=f"session for {flavor} did not transition to closed",
        )


# ======================================================================
# Test M5 -- B-H proof: slow handler does not block event throughput
# ======================================================================


def test_slow_handler_does_not_block_event_throughput(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Critical B-H regression test: a custom directive handler that
    blocks for several seconds MUST NOT prevent other LLM call events
    from being posted to ingestion. Under the pre-B-H architecture
    this test would fail with up to 5 lost post_call events.
    """
    flavor = unique_flavor

    handler_started = threading.Event()
    handler_release = threading.Event()
    handler_done = threading.Event()

    @flightdeck_sensor.directive(
        name="e2e_slow_handler",
        description="blocks until released",
        parameters=[],
    )
    def e2e_slow_handler(ctx: Any) -> dict[str, Any]:
        handler_started.set()
        try:
            # Block until the test releases us, with a hard ceiling
            # so a buggy test does not hang indefinitely.
            handler_release.wait(timeout=10)
            return {"slow": True}
        finally:
            handler_done.set()

    fingerprint = _directive_registry["e2e_slow_handler"].fingerprint
    _register_directive_via_api(flavor, fingerprint, "e2e_slow_handler")

    with respx.mock(assert_all_called=False) as rmock:
        # 50 ms mock latency -- the worker thread inside this test
        # fires 5 calls in a tight loop while the directive handler
        # thread is blocked. Real LLM RTT is the only natural
        # producer brake, so the mock simulates it. See
        # _mock_anthropic_messages docstring and KI16.
        _mock_anthropic_messages(rmock, latency_ms=50)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        try:
            session_id = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            # Post the directive then deliver it via one call
            code, _ = _post_directive({
                "action": "custom",
                "directive_name": "e2e_slow_handler",
                "fingerprint": fingerprint,
                "session_id": session_id,
            })
            assert code == 201

            client.messages.create(
                model="claude-sonnet-4-6",
                messages=[{"role": "user", "content": "trigger"}],
                max_tokens=10,
            )

            assert handler_started.wait(timeout=15), (
                "slow handler never started -- directive was not "
                "delivered to the directive thread"
            )

            # Sanity: handler is still blocked
            assert not handler_done.is_set()

            # Snapshot baseline post_call count
            baseline = sum(
                1
                for e in _query_events_for_flavor(flavor)
                if e.get("event_type") == "post_call"
            )

            # ============================================
            # B-H ASSERTION:
            # While the directive handler thread is BLOCKED inside
            # e2e_slow_handler, the drain thread must continue to drain
            # post_call events. We make calls from another thread and
            # verify the events land in DB BEFORE we release the handler.
            # ============================================
            errors: list[BaseException] = []

            def _worker() -> None:
                try:
                    for i in range(5):
                        client.messages.create(
                            model="claude-sonnet-4-6",
                            messages=[{
                                "role": "user",
                                "content": f"during-block-{i}",
                            }],
                            max_tokens=10,
                        )
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            t = threading.Thread(target=_worker)
            t.start()
            t.join(timeout=15)
            assert not t.is_alive(), "worker thread hung -- B-H regressed"
            assert errors == [], (
                f"worker errors during slow handler: {errors}"
            )

            # Wait for the new post_call events to land. CRUCIAL: this
            # MUST succeed before handler_done is set, otherwise the
            # drain thread is blocked by the directive thread and B-H
            # is broken.
            def _new_events_in_db() -> bool:
                count = sum(
                    1
                    for e in _query_events_for_flavor(flavor)
                    if e.get("event_type") == "post_call"
                )
                return count >= baseline + 5

            wait_until(
                _new_events_in_db,
                timeout=15,
                msg=(
                    "B-H REGRESSION: post_call events did not flow "
                    "while custom handler was blocked"
                ),
            )

            # And the handler is STILL running -- proves the events
            # above flowed independently of directive handler progress.
            assert not handler_done.is_set(), (
                "handler completed too early -- could not prove B-H"
            )
            assert handler_started.is_set()

            # No directive_result event yet either, since the handler
            # has not returned.
            results = [
                e
                for e in _query_events_for_flavor(flavor)
                if e.get("event_type") == "directive_result"
                and (e.get("payload") or {}).get(
                    "directive_name"
                ) == "e2e_slow_handler"
            ]
            assert results == [], (
                f"directive_result appeared while handler was still "
                f"blocked: {results}"
            )

            # Release the handler
            handler_release.set()

            # directive_result(success) now lands
            _wait_for_directive_result(
                flavor, "e2e_slow_handler", "success", timeout=15
            )
        finally:
            handler_release.set()  # never leave a hanging handler
            flightdeck_sensor.teardown()


# ======================================================================
# Test M6 -- Pattern D: directive ordering, custom completes before shutdown
# ======================================================================


def test_pattern_d_custom_then_shutdown_ordering(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Custom directive posted before shutdown -- both must be applied
    in issuance order. Custom handler runs to completion, its
    directive_result lands first, THEN shutdown ack lands and the
    session closes. Single-consumer directive queue (B-H) gives the
    ordering guarantee.
    """
    flavor = unique_flavor
    handler_calls: list[float] = []

    @flightdeck_sensor.directive(
        name="e2e_pre_shutdown",
        description="runs before shutdown",
        parameters=[],
    )
    def e2e_pre_shutdown(ctx: Any) -> dict[str, Any]:
        handler_calls.append(time.time())
        return {"done": True}

    fingerprint = _directive_registry["e2e_pre_shutdown"].fingerprint
    _register_directive_via_api(
        flavor, fingerprint, "e2e_pre_shutdown"
    )

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_messages(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        try:
            session_id = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            # Post custom THEN shutdown -- the directives table orders
            # by issued_at and ingestion's LookupPending returns the
            # oldest first, so two consecutive post_call events deliver
            # them in this order.
            code, _ = _post_directive({
                "action": "custom",
                "directive_name": "e2e_pre_shutdown",
                "fingerprint": fingerprint,
                "session_id": session_id,
            })
            assert code == 201

            code, _ = _post_directive({
                "action": "shutdown",
                "session_id": session_id,
                "reason": "after custom",
            })
            assert code == 201

            # Make calls until the shutdown raises. Each call may
            # succeed (delivering one of the pending directives) or
            # raise DirectiveError once shutdown has been applied.
            for _i in range(10):
                try:
                    client.messages.create(
                        model="claude-sonnet-4-6",
                        messages=[{"role": "user", "content": "trigger"}],
                        max_tokens=10,
                    )
                except flightdeck_sensor.DirectiveError:
                    break

            # Custom handler ran exactly once
            wait_until(
                lambda: len(handler_calls) >= 1,
                timeout=15,
                msg="custom handler was not invoked",
            )
            assert len(handler_calls) == 1

            # Both directive_result events land in DB
            custom_event = _wait_for_directive_result(
                flavor, "e2e_pre_shutdown", "success", timeout=20
            )
            shutdown_event = _wait_for_directive_result(
                flavor, "shutdown", "acknowledged", timeout=20
            )

            # ORDERING: custom directive_result occurred_at must be
            # ≤ shutdown directive_result occurred_at. The
            # single-consumer directive queue processes them in
            # delivery order, the synchronous flush() in
            # _apply_directive(SHUTDOWN) waits for the event queue
            # (which contains the prior custom directive_result event)
            # before setting _shutdown_requested.
            assert custom_event["occurred_at"] <= shutdown_event["occurred_at"], (
                f"directive ordering broken: custom={custom_event['occurred_at']} "
                f"shutdown={shutdown_event['occurred_at']}"
            )
        finally:
            flightdeck_sensor.teardown()

        wait_until(
            lambda: (
                (s := _query_session_for_flavor(flavor)) is not None
                and s.get("state") == "closed"
            ),
            timeout=15,
            msg=f"session for {flavor} did not transition to closed",
        )


# ======================================================================
# Test M7 -- Pattern B: degrade directive observed by all threads
# ======================================================================


def test_pattern_b_degrade_seen_by_all_threads(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Multiple workers sharing one Session. The workers' policy
    evaluator writes a degrade directive after enough tokens
    accumulate. The drain delivers it; ALL subsequent calls from
    EVERY thread must use the degraded model.
    """
    flavor = unique_flavor
    degraded_model = "claude-haiku-4-5-20251001"

    # validateDirectiveRequest in api/internal/handlers/policies.go
    # requires warn_at_pct < degrade_at_pct <= block_at_pct (strict).
    # token_limit=10000, degrade_at_pct=2 → trigger threshold = 200
    # tokens. Each call adds 18 tokens, so the workers fire degrade
    # after ~12 cumulative calls across all threads -- a couple of
    # seconds at most.
    code, policy_body = _post_policy({
        "scope": "flavor",
        "scope_value": flavor,
        "token_limit": 10_000,
        "warn_at_pct": 1,
        "degrade_at_pct": 2,
        "block_at_pct": 100,
        "degrade_to": degraded_model,
    })
    assert code == 201

    def _echo_model_handler(request: httpx.Request) -> httpx.Response:
        # 50 ms latency simulates real LLM provider RTT so the four
        # concurrent workers cannot fire faster than the drain
        # thread can flush. See _mock_anthropic_messages docstring
        # and KI16 for the rationale.
        time.sleep(0.05)
        body = json.loads(request.content)
        model = body.get("model", "claude-sonnet-4-6")
        return httpx.Response(
            200, json={**ANTHROPIC_RESPONSE, "model": model}
        )

    try:
        with respx.mock(assert_all_called=False) as rmock:
            rmock.post(
                "https://api.anthropic.com/v1/messages"
            ).mock(side_effect=_echo_model_handler)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            try:
                session_id = flightdeck_sensor.get_status().session_id
                client = flightdeck_sensor.wrap(
                    anthropic.Anthropic(api_key="test-key")
                )

                # Phase tracking. Phase 1 = pre-degrade-ack,
                # Phase 2 = post-degrade-ack. Calls in phase 2 from
                # any thread must report the degraded model.
                phase = [1]
                phase_lock = threading.Lock()
                phase2_results: list[tuple[int, str]] = []
                results_lock = threading.Lock()
                stop = threading.Event()
                errors: list[BaseException] = []

                def _worker(thread_id: int) -> None:
                    try:
                        while not stop.is_set():
                            resp = client.messages.create(
                                model="claude-sonnet-4-6",
                                messages=[{
                                    "role": "user",
                                    "content": f"t{thread_id}",
                                }],
                                max_tokens=10,
                            )
                            with phase_lock:
                                cur = phase[0]
                            if cur == 2:
                                with results_lock:
                                    phase2_results.append(
                                        (thread_id, resp.model)
                                    )
                    except BaseException as exc:  # noqa: BLE001
                        errors.append(exc)

                workers = [
                    threading.Thread(target=_worker, args=(i,))
                    for i in range(_MT_NUM_THREADS)
                ]
                for t in workers:
                    t.start()

                try:
                    # Wait until the directive handler thread has
                    # applied the degrade -- proven by the
                    # directive_result(acknowledged) event landing.
                    _wait_for_directive_result(
                        flavor, "degrade", "acknowledged", timeout=30
                    )

                    # Switch to phase 2: every call from now on must
                    # observe forced_degrade.
                    with phase_lock:
                        phase[0] = 2

                    # Let phase 2 accumulate enough samples that every
                    # worker contributes at least once.
                    def _enough_phase2() -> bool:
                        with results_lock:
                            return len({tid for tid, _ in phase2_results}) >= _MT_NUM_THREADS

                    wait_until(
                        _enough_phase2,
                        timeout=20,
                        msg=(
                            "not all workers contributed phase-2 calls"
                        ),
                    )
                finally:
                    stop.set()
                    for t in workers:
                        t.join(timeout=15)

                assert errors == [], f"thread errors: {errors}"

                # Every phase 2 call from every worker must use the
                # degraded model. ANY sonnet call in phase 2 means a
                # thread missed the directive update -- regression.
                with results_lock:
                    snapshot = list(phase2_results)
                non_haiku = [
                    (tid, m) for tid, m in snapshot if m != degraded_model
                ]
                assert non_haiku == [], (
                    f"phase-2 calls used the wrong model: {non_haiku}"
                )

                # Each worker observed the swap.
                participating = {tid for tid, _ in snapshot}
                assert participating == set(range(_MT_NUM_THREADS)), (
                    f"missing workers in phase 2: "
                    f"{set(range(_MT_NUM_THREADS)) - participating}"
                )
                _ = session_id  # silence unused
            finally:
                flightdeck_sensor.teardown()
    finally:
        _delete_policy_quiet(policy_body.get("id"))


# ======================================================================
# Test M8 -- Pattern C: KI15 singleton limitation (DOCUMENTS the bug)
# ======================================================================


def test_pattern_c_ki15_singleton_limitation(
    sensor_reset: None,
) -> None:
    """KI15: ``init()`` is process-wide. The second call is a no-op.

    This test does NOT use the ``unique_flavor`` fixture because the
    point is to set TWO flavors and demonstrate that only one wins.
    Per Phase 4.5 audit Part 1 finding B-I/B-J, this is a tracked
    architectural limitation; future developers reading this test
    should NOT "fix" it without resolving KI15 first (the resolution
    is a Session-handle API change tracked for Phase 5).

    If this assertion ever flips -- e.g. if KI15 has been resolved
    and the sensor now supports per-thread Sessions -- update this
    test to verify the new behaviour and remove KI15 from
    KNOWN_ISSUES.md.
    """
    flavor_a = f"e2e-ki15-a-{uuid.uuid4().hex[:8]}"
    flavor_b = f"e2e-ki15-b-{uuid.uuid4().hex[:8]}"

    init_results: list[str | Exception] = []
    init_lock = threading.Lock()

    def _init_thread(name: str, flavor: str) -> None:
        # Set the env var inside this thread so the test is explicit
        # about which flavor each init() should *try* to use. Note
        # that os.environ is process-wide, so this can race with the
        # other thread -- the join() between thread starts below
        # serialises them so the race is moot for this test.
        os.environ["AGENT_FLAVOR"] = flavor
        try:
            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            with init_lock:
                init_results.append(name)
        except Exception as exc:
            with init_lock:
                init_results.append(exc)

    try:
        ta = threading.Thread(
            target=_init_thread, args=("a", flavor_a), name="ki15-a"
        )
        ta.start()
        ta.join(timeout=10)
        assert not ta.is_alive()

        tb = threading.Thread(
            target=_init_thread, args=("b", flavor_b), name="ki15-b"
        )
        tb.start()
        tb.join(timeout=10)
        assert not tb.is_alive()

        assert init_results == ["a", "b"], (
            f"both init calls should return without error, got "
            f"{init_results}"
        )

        # The CURRENT behaviour: only the FIRST init() created a
        # Session. ``get_status()`` returns the singleton, which has
        # flavor_a (the env var Thread A set before its init).
        status = flightdeck_sensor.get_status()
        assert status.flavor == flavor_a, (
            f"KI15: expected the singleton to be the first init's "
            f"flavor ({flavor_a}), got {status.flavor}. If this "
            f"assertion now fails, KI15 has been resolved -- update "
            f"this test."
        )

        # Each thread now makes a call. BOTH threads share the
        # singleton Session, so all events land under flavor_a.
        with respx.mock(assert_all_called=False) as rmock:
            _mock_anthropic_messages(rmock)
            client = flightdeck_sensor.wrap(
                anthropic.Anthropic(api_key="test-key")
            )

            errors: list[BaseException] = []

            def _call(content: str) -> None:
                try:
                    client.messages.create(
                        model="claude-sonnet-4-6",
                        messages=[{"role": "user", "content": content}],
                        max_tokens=10,
                    )
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            t1 = threading.Thread(target=_call, args=("from-a",))
            t2 = threading.Thread(target=_call, args=("from-b",))
            t1.start(); t2.start()
            t1.join(timeout=15); t2.join(timeout=15)
            assert errors == []

            # Both calls landed under flavor_a -- there is no flavor_b
            # session because the second init() was a no-op.
            wait_until(
                lambda: sum(
                    1
                    for e in _query_events_for_flavor(flavor_a)
                    if e.get("event_type") == "post_call"
                ) >= 2,
                timeout=15,
                msg="expected ≥ 2 post_calls for flavor_a",
            )

            sess_b = _query_session_for_flavor(flavor_b)
            assert sess_b is None, (
                f"KI15: expected NO session for flavor_b, got "
                f"{sess_b}. If this is None, the singleton is still "
                f"in effect (current behaviour). If this returns a "
                f"row, KI15 has been resolved -- update this test."
            )
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        try:
            flightdeck_sensor.teardown()
        except Exception:
            pass
        _delete_flavor_data(flavor_a)
        _delete_flavor_data(flavor_b)
