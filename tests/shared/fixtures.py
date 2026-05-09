"""Shared test fixtures.

Pure helpers + constants used by both the pytest integration suite
(``tests/integration/conftest.py`` re-exports this module) and the
E2E fixture seeder (``tests/e2e-fixtures/seed.py``). Pytest-specific
surface (session-scoped ``stack`` fixture, per-test
``_session_lifecycle`` fixture, ``pytest_configure`` marker
registration) stays in ``conftest.py``.

Shape guarantee: nothing here imports ``pytest``. Timeouts raise
``TimeoutError`` and the conftest wrapper re-raises as
``pytest.fail`` when the caller is a pytest fixture. This keeps
``seed.py`` importable as a standalone script that does not depend
on the test runner.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from flightdeck_sensor.core.agent_id import derive_agent_id

INGESTION_URL = "http://localhost:4000/ingest"
API_URL = "http://localhost:4000/api"
INGEST_HEALTH = f"{INGESTION_URL}/health"
API_HEALTH = f"{API_URL}/health"
TOKEN = "tok_dev"

# D115 identity defaults for the synthetic-emitter tier. The integration
# suite impersonates a sensor-like client (not the plugin), so client_type
# is pinned to "flightdeck_sensor" and agent_type defaults to the
# sensor's own "production" default. Individual tests can override via
# make_event(..., agent_type="coding") when needed.
DEFAULT_AGENT_TYPE = "production"
DEFAULT_CLIENT_TYPE = "flightdeck_sensor"
DEFAULT_USER = "integration"
DEFAULT_HOSTNAME = "integration-test-host"

MAX_WAIT_SECS = 60
POLL_INTERVAL = 2

DEFAULT_TEST_CONTEXT: dict[str, Any] = {
    "os": "Linux",
    "arch": "x86_64",
    "hostname": "integration-test-host",
    "user": "integration",
    "python_version": "3.13.0",
    "pid": 12345,
    "process_name": "pytest",
    "git_branch": "integration-tests",
    "git_commit": "deadbee",
    "git_repo": "flightdeck",
    "orchestration": "docker-compose",
    "compose_project": "flightdeck-tests",
    "frameworks": ["integration-suite/1.0"],
}

# Session IDs created in the current test, mapped to their flavor, so the
# cleanup fixture can POST session_end. Reset before each test by the
# autouse fixture in conftest.py. Exposed as module-level state so the
# pytest lifecycle fixture and the pure helpers here share one
# tracker — Python imports these by reference, not by value.
_session_tracker: dict[str, str] = {}
_ended_sessions: set[str] = set()


def _check_health(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            body = json.loads(resp.read())
            return body.get("status") == "ok"
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return False


def wait_for_services(timeout: float = MAX_WAIT_SECS) -> None:
    """Wait up to ``timeout`` seconds for ingestion + api to report healthy.

    Raises ``TimeoutError`` (not ``pytest.fail``) so non-pytest callers
    like seed.py can use the same helper.
    """
    deadline = time.time() + timeout
    services = {"ingestion": INGEST_HEALTH, "api": API_HEALTH}
    healthy: dict[str, bool] = {}

    while time.time() < deadline:
        healthy = {name: _check_health(url) for name, url in services.items()}
        if all(healthy.values()):
            return
        time.sleep(POLL_INTERVAL)

    unhealthy = [name for name, ok in healthy.items() if not ok]
    raise TimeoutError(
        f"Services not healthy after {timeout}s: {', '.join(unhealthy)}. "
        f"Run 'make dev' first."
    )


def auth_headers(json_body: bool = False) -> dict[str, str]:
    """Return the standard headers for an authenticated API request.

    All ingestion and API /v1 endpoints require a bearer token (D095);
    every helper below composes its request headers through this
    function so the token is added in exactly one place. Pass
    ``json_body=True`` when the request carries a JSON body so the
    Content-Type header is also set.
    """
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def post_event(payload: dict[str, Any]) -> dict[str, Any]:
    """POST an event to the ingestion API and return the response."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/events",
        data=data,
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    if payload.get("event_type") == "session_end":
        sid = payload.get("session_id")
        if isinstance(sid, str):
            _ended_sessions.add(sid)
    return body  # type: ignore[no-any-return]


def post_heartbeat(session_id: str) -> dict[str, Any]:
    """POST a heartbeat to the ingestion API."""
    data = json.dumps({"session_id": session_id}).encode()
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/heartbeat",
        data=data,
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def get_fleet() -> dict[str, Any]:
    """Return a sessions-flat view reconstructed from GET /v1/sessions.

    D115 retired the ``/v1/fleet`` flavor-grouped shape in favor of
    agent-keyed rollups that no longer nest sessions. Integration tests
    predate that change and scan for specific sessions by flavor, so
    this helper preserves the legacy iteration surface by fetching the
    most recent sessions via ``/v1/sessions`` and grouping them by
    flavor client-side. Returns ``{"flavors": [{"flavor": X,
    "sessions": [...]}...], "total_session_count": N}``.

    Single-page fetch (server caps at 100). Integration tests run
    serially and each creates 1--3 sessions; 100 recent sessions is
    comfortably above the working set per run.
    """
    url = f"{API_URL}/v1/sessions?limit=100"
    req = urllib.request.Request(url, headers=auth_headers())
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())
    sessions = data.get("sessions", [])
    by_flavor: dict[str, dict[str, Any]] = {}
    flavor_order: list[str] = []
    for sess in sessions:
        name = sess.get("flavor", "")
        if name not in by_flavor:
            by_flavor[name] = {"flavor": name, "sessions": []}
            flavor_order.append(name)
        by_flavor[name]["sessions"].append(sess)
    return {
        "flavors": [by_flavor[name] for name in flavor_order],
        "total_session_count": len(sessions),
    }


def get_session(session_id: str) -> dict[str, Any]:
    """GET /v1/sessions/:id from the query API."""
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def wait_for_session_in_fleet(
    session_id: str, timeout: float = 5.0
) -> dict[str, Any] | None:
    """Poll GET /v1/sessions/:id until the worker persists the row or timeout.

    Under D115 the fleet endpoint no longer nests sessions under agents,
    so "did the session land?" is answered by hitting the single-session
    detail endpoint directly. Returns the ``session`` sub-dict on
    success or None on timeout.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            detail = get_session(session_id)
            return detail.get("session")  # type: ignore[no-any-return]
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        time.sleep(0.25)
    return None


def _identity_fields(
    *,
    agent_type: str = DEFAULT_AGENT_TYPE,
    client_type: str = DEFAULT_CLIENT_TYPE,
    user: str = DEFAULT_USER,
    hostname: str = DEFAULT_HOSTNAME,
    agent_name: str | None = None,
    agent_role: str | None = None,
) -> dict[str, str]:
    """Return the D115/D126 identity tuple plus derived agent_id.

    Mirrors ``sensor/flightdeck_sensor/core/session.py::_build_payload``.
    The ingestion validator (D116) rejects any event lacking agent_id /
    a vocabulary-valid agent_type / a vocabulary-valid client_type, so
    every synthetic event must carry this block.

    D126 § 2 extension — when ``agent_role`` is supplied with a
    non-empty value, it joins the input tuple so a Researcher child
    derives a different agent_id than the same host's root session.
    Pre-D126 callers (no agent_role) produce the same UUID they did
    before. The integration test fixtures previously omitted this
    forwarding, which produced the 2026-05-03 anomaly where one
    agent_id carried both root sessions (no role) and Researcher
    children — a direct D126 § 2 violation. Forwarding here is the
    fix; the worker accepts agent_id as supplied and does not
    re-derive.
    """
    if agent_name is None:
        agent_name = f"{user}@{hostname}"
    agent_id = str(
        derive_agent_id(
            agent_type=agent_type,
            user=user,
            hostname=hostname,
            client_type=client_type,
            agent_name=agent_name,
            agent_role=agent_role,
        )
    )
    return {
        "agent_id": agent_id,
        "agent_type": agent_type,
        "agent_name": agent_name,
        "client_type": client_type,
        "user": user,
        "hostname": hostname,
    }


def make_event(
    session_id: str,
    flavor: str,
    event_type: str,
    *,
    agent_type: str = DEFAULT_AGENT_TYPE,
    client_type: str = DEFAULT_CLIENT_TYPE,
    user: str = DEFAULT_USER,
    hostname: str = DEFAULT_HOSTNAME,
    agent_name: str | None = None,
    agent_role: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Build an event payload with D115/D126 identity fields populated.

    ``agent_role`` is the explicit named-arg path for the D126
    sub-agent identity input (see ``_identity_fields`` docstring).
    Callers that pass ``agent_role`` via ``**extra`` instead get the
    role echoed onto the wire payload but the agent_id derivation
    skips the role — the named-arg form is the contract.
    """
    identity = _identity_fields(
        agent_type=agent_type,
        client_type=client_type,
        user=user,
        hostname=hostname,
        agent_name=agent_name,
        agent_role=agent_role,
    )
    payload: dict[str, Any] = {
        "session_id": session_id,
        "flavor": flavor,
        "event_type": event_type,
        "host": "test-host",
        "framework": None,
        "model": None,
        "tokens_input": None,
        "tokens_output": None,
        "tokens_total": None,
        "tokens_used_session": 0,
        "token_limit_session": None,
        "latency_ms": None,
        "tool_name": None,
        "tool_input": None,
        "tool_result": None,
        "has_content": False,
        "content": None,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    payload.update(identity)
    # D126 — surface agent_role on the wire so the worker /
    # ingestion validator see the role (in addition to the role
    # participating in the agent_id derivation above). Skipped when
    # the role is None / blank so pre-D126 events stay byte-
    # identical to the legacy shape.
    if agent_role is not None and agent_role.strip():
        payload["agent_role"] = agent_role.strip()
    payload.update(extra)
    if event_type == "session_start" and "context" not in payload:
        payload["context"] = dict(DEFAULT_TEST_CONTEXT)
    # Ingestion requires a non-empty sensor_version on every
    # session_start event. Stamp a sentinel here so integration
    # tests don't fail with HTTP 400 on the bookend; tests that
    # specifically exercise sensor-version validation can override
    # via **extra.
    if event_type == "session_start" and "sensor_version" not in payload:
        payload["sensor_version"] = "integration-test/0.0.0"
    # Ingestion requires a structured policy_decision block on every
    # policy enforcement event. Stamp a sentinel here so integration
    # tests that don't construct one explicitly don't 400 at the
    # wire boundary. Tests that specifically exercise policy_decision
    # validation override via **extra.
    _POLICY_EVENT_TYPES = {
        "policy_warn", "policy_degrade", "policy_block",
        "policy_mcp_warn", "policy_mcp_block",
    }
    if event_type in _POLICY_EVENT_TYPES and "policy_decision" not in payload:
        decision = (
            "warn" if "warn" in event_type
            else "degrade" if "degrade" in event_type
            else "block"
        )
        payload["policy_decision"] = {
            "policy_id": payload.get("policy_id") or "integration-test-policy",
            "scope": payload.get("scope") or f"flavor:{flavor}",
            "decision": decision,
            "reason": f"integration test sentinel for {event_type}",
        }
    _session_tracker[session_id] = flavor
    return payload


def create_policy(
    scope: str,
    scope_value: str,
    token_limit: int | None,
    warn_at_pct: int | None = None,
    degrade_at_pct: int | None = None,
    degrade_to: str | None = None,
    block_at_pct: int | None = None,
) -> dict[str, Any]:
    """Create a token policy via POST /api/v1/policies."""
    body: dict[str, Any] = {
        "scope": scope,
        "scope_value": scope_value,
        "token_limit": token_limit,
        "warn_at_pct": warn_at_pct,
        "degrade_at_pct": degrade_at_pct,
        "degrade_to": degrade_to,
        "block_at_pct": block_at_pct,
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/policies",
        data=data,
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def delete_policy(policy_id: str) -> None:
    """Delete a token policy via DELETE /api/v1/policies/:id."""
    req = urllib.request.Request(
        f"{API_URL}/v1/policies/{policy_id}",
        headers=auth_headers(),
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
    except urllib.error.HTTPError:
        pass  # Already deleted or not found -- safe to ignore


def get_session_detail(session_id: str) -> dict[str, Any]:
    """GET /api/v1/sessions/:id -- returns session with events and policy fields."""
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def query_directives(session_id: str) -> list[dict[str, Any]]:
    """Query directives table directly via docker exec psql."""
    import subprocess

    sql = (
        f"SELECT COALESCE(json_agg(row_to_json(d)), '[]'::json) "
        f"FROM directives d "
        f"WHERE d.session_id = '{session_id}'::uuid"
    )
    result = subprocess.run(
        [
            "docker",
            "exec",
            "docker-postgres-1",
            "psql",
            "-U",
            "flightdeck",
            "-d",
            "flightdeck",
            "-t",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    raw = result.stdout.strip()
    if not raw or raw == "null":
        return []
    return json.loads(raw)  # type: ignore[no-any-return]


def wait_until(
    condition_fn: Callable[[], bool],
    timeout: float = 10.0,
    interval: float = 0.25,
    msg: str = "condition not met",
) -> None:
    """Poll condition_fn until it returns True or timeout is reached.

    Never use time.sleep() as a fixed wait -- use this instead.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition_fn():
            return
        time.sleep(interval)
    raise TimeoutError(f"Timed out after {timeout}s: {msg}")


def session_exists_in_fleet(session_id: str) -> bool:
    """Return True once the worker has persisted the session row.

    Under D115 the legacy flavor-grouped fleet response is gone, so
    persistence is observed via ``GET /v1/sessions/:id`` returning 200.
    """
    try:
        get_session(session_id)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def get_session_event_count(session_id: str) -> int:
    """Return the number of events for a session."""
    try:
        detail = get_session_detail(session_id)
        return len(detail.get("events", []))
    except Exception:
        return 0


def wait_for_state(
    session_id: str,
    expected_state: str,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Poll until session reaches expected_state or timeout."""
    detail: dict[str, Any] = {}

    def _check() -> bool:
        nonlocal detail
        try:
            detail = get_session_detail(session_id)
            return detail["session"]["state"] == expected_state
        except Exception:
            return False

    wait_until(
        _check,
        timeout=timeout,
        msg=f"session {session_id} did not reach state={expected_state}",
    )
    return detail


def post_directive(
    action: str,
    session_id: str | None = None,
    flavor: str | None = None,
    reason: str | None = None,
    grace_period_ms: int = 5000,
) -> dict[str, Any]:
    """POST /api/v1/directives and return response JSON."""
    body: dict[str, Any] = {
        "action": action,
        "grace_period_ms": grace_period_ms,
    }
    if session_id is not None:
        body["session_id"] = session_id
    if flavor is not None:
        body["flavor"] = flavor
    if reason is not None:
        body["reason"] = reason
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/directives",
        data=data,
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


def directive_has_delivered_at(directive_id: str) -> bool:
    """Check if a directive has been marked delivered via direct DB query."""
    import subprocess

    sql = (
        f"SELECT delivered_at IS NOT NULL "
        f"FROM directives "
        f"WHERE id = '{directive_id}'::uuid"
    )
    result = subprocess.run(
        [
            "docker",
            "exec",
            "docker-postgres-1",
            "psql",
            "-U",
            "flightdeck",
            "-d",
            "flightdeck",
            "-t",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.stdout.strip() == "t"


# ---------------------------------------------------------------------------
# Admin reconcile helpers. Used by integration + E2E tests that
# exercise POST /v1/admin/reconcile-agents. The endpoint is gated by
# auth.AdminRequired, which requires ``IsAdmin=true`` on the resolved
# token — ``tok_admin_dev`` is the dev-mode shortcut (api/internal/
# auth/token.go). Production callers pass
# ``FLIGHTDECK_ADMIN_ACCESS_TOKEN`` verbatim instead.
# ---------------------------------------------------------------------------

ADMIN_TOKEN = "tok_admin_dev"


def admin_auth_headers(json_body: bool = False) -> dict[str, str]:
    """Headers for the admin endpoint. Parallel to ``auth_headers``
    but carries the admin bearer so ``AdminRequired`` lets the call
    through. Tests that explicitly verify the 403 path use
    ``auth_headers`` (tok_dev, non-admin)."""
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def post_admin_reconcile(
    token: str | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/admin/reconcile-agents and return (status, body).

    Returns a tuple rather than raising on non-2xx because several
    tests exercise 401/403/409 paths where a non-success status IS
    the expected result. Body is parsed as JSON when the response
    carries a JSON content-type; otherwise the raw decoded text is
    returned under the ``"error"`` key so every caller sees a dict.

    ``token`` defaults to ``ADMIN_TOKEN``. Pass ``TOKEN`` (the regular
    dev bearer) to verify the 403 path, or an empty string to verify
    the 401 path.
    """
    if token is None:
        token = ADMIN_TOKEN
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{API_URL}/v1/admin/reconcile-agents",
        data=b"",
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            body: dict[str, Any]
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = {"error": raw.decode(errors="replace")}
            return resp.status, body
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        body = {}
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"error": raw.decode(errors="replace")}
        return exc.code, body


def create_drifted_agent(
    *,
    agent_name: str,
    client_type: str = DEFAULT_CLIENT_TYPE,
    agent_type: str = DEFAULT_AGENT_TYPE,
    user: str = DEFAULT_USER,
    hostname: str = DEFAULT_HOSTNAME,
    actual_sessions: int = 1,
    actual_tokens_per_session: int = 100,
    counter_overrides: dict[str, Any] | None = None,
) -> str:
    """Insert an agents row with intentionally wrong counter values,
    plus N matching sessions under that agent_id. Returns the
    agent_id as a string.

    Bypasses the worker's event path (no NATS, no ingestion API) so
    tests can create drifted fixtures deterministically — an event-
    driven path would re-sync the counters the worker maintains,
    defeating the point.

    ``counter_overrides`` keys override the default drift shape:
        - ``total_sessions``: int (default: actual_sessions + 99)
        - ``total_tokens``: int (default: actual_sessions *
          actual_tokens_per_session + 999999)
        - ``first_seen_at``: ISO-8601 string (default: actual
          MIN(started_at) minus 1 hour — wrong direction)
        - ``last_seen_at``: ISO-8601 string (default: NOW + 1 hour
          — future-dated, obviously wrong)

    Cleanup: callers MUST ``DELETE FROM sessions / agents`` manually
    (or use a per-test fixture that does). Keeping cleanup caller-
    side avoids tying this helper to pytest semantics so the E2E
    suite can call it from a pure Python script.
    """
    agent_id = str(
        derive_agent_id(
            agent_type=agent_type,
            user=user,
            hostname=hostname,
            client_type=client_type,
            agent_name=agent_name,
        )
    )

    overrides = counter_overrides or {}
    total_sessions = overrides.get("total_sessions", actual_sessions + 99)
    total_tokens = overrides.get(
        "total_tokens",
        actual_sessions * actual_tokens_per_session + 999_999,
    )
    # Default drift: first_seen_at forward by an hour vs ground
    # truth, last_seen_at forward by an hour vs ground truth.
    first_seen_override = overrides.get("first_seen_at")
    last_seen_override = overrides.get("last_seen_at")

    escaped_agent_name = agent_name.replace("'", "''")
    # Build SQL in a single docker exec. The agents INSERT uses the
    # canonical identity tuple; the sessions INSERTs carry fixed
    # started_at / last_seen_at / tokens so ground truth is
    # predictable.
    first_seen_default = (
        "NOW() - INTERVAL '1 hour'"
        if first_seen_override is None
        else f"'{first_seen_override}'::timestamptz"
    )
    last_seen_default = (
        "NOW() + INTERVAL '1 hour'"
        if last_seen_override is None
        else f"'{last_seen_override}'::timestamptz"
    )

    # Sessions: fixed per-session offsets so MIN/MAX are easy to
    # reason about. Session N starts at NOW() - (actual_sessions-N+1)
    # minutes and last_seen_at at the same point.
    session_inserts = []
    for i in range(actual_sessions):
        minutes_ago = actual_sessions - i  # session 0 is oldest
        session_inserts.append(f"""
            INSERT INTO sessions (
                session_id, agent_id, flavor, state,
                started_at, last_seen_at, tokens_used,
                agent_type, client_type
            ) VALUES (
                gen_random_uuid(), '{agent_id}'::uuid, 'drift-test-flavor', 'closed',
                NOW() - INTERVAL '{minutes_ago} minutes',
                NOW() - INTERVAL '{minutes_ago} minutes',
                {actual_tokens_per_session},
                '{agent_type}', '{client_type}'
            );
        """)

    sql = f"""
        INSERT INTO agents (
            agent_id, agent_type, client_type, agent_name,
            user_name, hostname,
            first_seen_at, last_seen_at,
            total_sessions, total_tokens
        ) VALUES (
            '{agent_id}'::uuid, '{agent_type}', '{client_type}', '{escaped_agent_name}',
            '{user}', '{hostname}',
            {first_seen_default}, {last_seen_default},
            {total_sessions}, {total_tokens}
        )
        ON CONFLICT (agent_id) DO UPDATE SET
            total_sessions = EXCLUDED.total_sessions,
            total_tokens   = EXCLUDED.total_tokens,
            first_seen_at  = EXCLUDED.first_seen_at,
            last_seen_at   = EXCLUDED.last_seen_at;
        {" ".join(session_inserts)}
    """
    _psql_exec(sql)
    return agent_id


def delete_drifted_agent(agent_id: str) -> None:
    """Tear down a drifted agent fixture (sessions then agent row).
    Best-effort — missing rows are ignored so repeated cleanup calls
    are safe."""
    sql = (
        f"DELETE FROM sessions WHERE agent_id = '{agent_id}'::uuid; "
        f"DELETE FROM agents WHERE agent_id = '{agent_id}'::uuid;"
    )
    _psql_exec(sql)


def get_agent_rollup(agent_id: str) -> dict[str, Any] | None:
    """Read the denormalised rollup snapshot for an agent. Returns
    None when the agent does not exist. Used by integration tests to
    assert on post-reconcile state directly rather than round-tripping
    through /v1/fleet."""
    sql = (
        "SELECT json_build_object("
        "'agent_id', agent_id::text, "
        "'total_sessions', total_sessions, "
        "'total_tokens', total_tokens, "
        "'first_seen_at', first_seen_at, "
        "'last_seen_at', last_seen_at"
        ") "
        f"FROM agents WHERE agent_id = '{agent_id}'::uuid"
    )
    import subprocess

    result = subprocess.run(
        [
            "docker",
            "exec",
            "docker-postgres-1",
            "psql",
            "-U",
            "flightdeck",
            "-d",
            "flightdeck",
            "-t",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    raw = result.stdout.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)  # type: ignore[no-any-return]
    except json.JSONDecodeError:
        return None


def _psql_exec(sql: str) -> None:
    """Run a multi-statement SQL block via docker exec psql. Raises
    on non-zero exit so callers see setup failures loudly rather than
    getting a silently unseeded fixture."""
    import subprocess

    result = subprocess.run(
        [
            "docker",
            "exec",
            "docker-postgres-1",
            "psql",
            "-U",
            "flightdeck",
            "-d",
            "flightdeck",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"psql exec failed (exit {result.returncode}): {result.stderr.strip()}"
        )
