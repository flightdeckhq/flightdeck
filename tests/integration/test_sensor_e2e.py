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
import uuid
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
) -> None:
    rmock.post("https://api.anthropic.com/v1/messages").mock(
        return_value=httpx.Response(200, json=response or ANTHROPIC_RESPONSE)
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
        headers={"Content-Type": "application/json"},
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
        headers={"Content-Type": "application/json"},
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

    req = urllib.request.Request(f"{API_URL}/v1/fleet")
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
