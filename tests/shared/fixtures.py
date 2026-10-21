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
import signal
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
import time
import uuid
import urllib.error
import urllib.request
from typing import Any, Callable, Literal

from flightdeck_sensor.core.agent_id import derive_agent_id

INGESTION_URL = "http://localhost:4000/ingest"
API_URL = "http://localhost:4000/api"
# The dev stack's container names are the contract for the helpers that
# shell into it (psql below, the worker log reader).
POSTGRES_CONTAINER = "docker-postgres-1"
WORKER_CONTAINER = "docker-workers-1"
# A docker CLI call against a healthy daemon returns well within this;
# the bound only keeps a hung daemon from stalling a poll forever.
DOCKER_CLI_TIMEOUT_SECS = 20
# Lines of worker log a reader looks back over. The worker logs about
# one line per dropped or retried event, so this covers a whole
# integration run; readers scope matches by session id anyway.
WORKER_LOG_TAIL_LINES = 5000
INGEST_HEALTH = f"{INGESTION_URL}/health"
API_HEALTH = f"{API_URL}/health"
TOKEN = "tok_dev"

# Identity defaults for the synthetic-emitter tier. The integration
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

# Sentinel value stamped on session_start.sensor_version when the test
# fixture didn't construct one explicitly. Ingestion requires the field
# but doesn't constrain its content; the sentinel just keeps the wire
# contract satisfied. Tests that exercise sensor_version validation
# pass an explicit value via **extra.
INTEGRATION_TEST_SENSOR_VERSION = "integration-test/0.0.0"

# Sentinel policy_id used by the make_event auto-stamp path for the 5
# policy event types when the caller didn't supply policy_decision.
# Same posture as INTEGRATION_TEST_SENSOR_VERSION — keeps the wire
# contract satisfied for tests that don't care about the field's
# content.
INTEGRATION_TEST_POLICY_ID = "integration-test-policy"

# Closed set of event types that require the structured
# policy_decision block on the wire. Module-level frozenset (not
# rebuilt per make_event call). Tests that exercise the validator
# pass an explicit policy_decision via **extra.
_POLICY_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "policy_warn",
        "policy_degrade",
        "policy_block",
        "policy_mcp_warn",
        "policy_mcp_block",
    }
)

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
        f"Services not healthy after {timeout}s: {', '.join(unhealthy)}. Run 'make dev' first."
    )


def auth_headers(json_body: bool = False) -> dict[str, str]:
    """Return the standard headers for an authenticated API request.

    All ingestion and API /v1 endpoints require a bearer token;
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

    ``/v1/fleet`` returns agent-keyed rollups that do not nest
    sessions. Integration tests scan for specific sessions by flavor, so
    this helper preserves the legacy iteration surface by fetching the
    most recent sessions via ``/v1/sessions`` and grouping them by
    flavor client-side. Returns ``{"flavors": [{"flavor": X,
    "sessions": [...]}...], "total_session_count": N}``.

    Single-page fetch (server caps at 100). Only the manual dashboard
    demo uses it; tests that run in the parallel phase look sessions up
    by their own flavor or id instead, since the 100 most recent rows
    belong to whichever tests posted last.
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

    The fleet endpoint does not nest sessions under agents,
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
    """Return the identity tuple plus derived agent_id.

    Mirrors ``sensor/flightdeck_sensor/core/session.py::_build_payload``.
    The ingestion validator rejects any event lacking agent_id /
    a vocabulary-valid agent_type / a vocabulary-valid client_type, so
    every synthetic event must carry this block.

    Sub-agent extension — when ``agent_role`` is supplied with a
    non-empty value, it joins the input tuple so a Researcher child
    derives a different agent_id than the same host's root session.
    Callers with no agent_role produce the same UUID they did
    before. The integration test fixtures previously omitted this
    forwarding, which produced the 2026-05-03 anomaly where one
    agent_id carried both root sessions (no role) and Researcher
    children — a direct identity-model violation. Forwarding here is the
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
    """Build an event payload with identity fields populated.

    ``agent_role`` is the explicit named-arg path for the
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
        # Server-authoritative capture posture (migration 000026). The
        # worker persists this from session_start and gates all prompt
        # content storage on it. Fixtures represent capture-on sessions
        # so their content persists; the worker only reads it from the
        # session_start event.
        "capture_prompts": True,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    payload.update(identity)
    # Surface agent_role on the wire so the worker /
    # ingestion validator see the role (in addition to the role
    # participating in the agent_id derivation above). Skipped when
    # the role is None / blank so root events stay byte-
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
        payload["sensor_version"] = INTEGRATION_TEST_SENSOR_VERSION
    # Ingestion requires a structured policy_decision block on every
    # policy enforcement event. Stamp a sentinel here so integration
    # tests that don't construct one explicitly don't 400 at the
    # wire boundary. Tests that specifically exercise policy_decision
    # validation override via **extra.
    if event_type in _POLICY_EVENT_TYPES and "policy_decision" not in payload:
        decision = (
            "warn"
            if "warn" in event_type
            else "degrade"
            if "degrade" in event_type
            else "block"
        )
        payload["policy_decision"] = {
            "policy_id": payload.get("policy_id") or INTEGRATION_TEST_POLICY_ID,
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
            POSTGRES_CONTAINER,
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


def exec_sql(sql: str, **bindings: Any) -> str:
    """Execute a SQL statement against the dev Postgres container with
    optional psql bind variables.

    Reference bind values in the SQL via psql's substitution syntax:

      * ``:'name'`` — value rendered as a single-quoted SQL literal,
        suitable for strings and UUIDs (e.g. ``:'sid'::uuid``).
      * ``:name`` — raw value, suitable for numerics.
      * ``:"name"`` — value rendered as a double-quoted SQL identifier.

    Pass bindings as keyword arguments; each becomes a ``-v name=value``
    flag on the underlying ``psql`` invocation. This is the migration
    target for the f-string SQL pattern that previously interpolated
    Python values directly into the SQL text — the bind-variable form
    keeps the SQL static + auditable and removes the interpolation
    anti-pattern from test files.

    Returns the trimmed psql ``-tA`` output. Raises CalledProcessError
    on non-zero exit (which surfaces psql's stderr in the test failure
    message).

    Example::

        exec_sql(
            "UPDATE sessions SET state = :'state' "
            "WHERE session_id = :'sid'::uuid",
            state="lost",
            sid=str(uuid.uuid4()),
        )

    Implementation note: psql substitutes ``:name`` / ``:'name'`` /
    ``:"name"`` only for SQL it reads from stdin or ``-f file``, NOT
    from ``-c command``. We therefore pipe the SQL via stdin (with
    ``docker exec -i``) and pass the bindings as ``-v`` flags.
    """
    args = [
        "docker",
        "exec",
        "-i",
        POSTGRES_CONTAINER,
        "psql",
        "-U",
        "flightdeck",
        "-d",
        "flightdeck",
        "-t",
        "-A",
    ]
    for name, value in bindings.items():
        args.extend(["-v", f"{name}={value}"])
    result = subprocess.run(
        args,
        input=sql,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    return result.stdout.strip()


# Cleanup statements share a single :'flavor' binding via exec_sql.
# Each is idempotent and ordered to satisfy FK constraints (children
# before parents). The agents table has no flavor column: the rollup
# is keyed by agent_id and is reached through the sessions it
# summarises. The sessions -> agents foreign key is checked at the end
# of the statement, so one data-modifying CTE deletes the flavor's
# sessions and then the agents those sessions belonged to, unless a
# session of another flavor still references the agent. A rollup left
# behind keeps total_sessions above zero with no session behind it,
# which breaks the fleet's recent-sessions contract on the next run.
FLAVOR_CLEANUP_SQL = (
    "DELETE FROM event_content WHERE session_id IN "
    "(SELECT session_id FROM sessions WHERE flavor = :'flavor')",
    "DELETE FROM events WHERE flavor = :'flavor'",
    "DELETE FROM directives WHERE flavor = :'flavor' OR session_id IN "
    "(SELECT session_id FROM sessions WHERE flavor = :'flavor')",
    "DELETE FROM token_policies WHERE scope = 'flavor' AND scope_value = :'flavor'",
    "WITH gone AS ("
    "DELETE FROM sessions WHERE flavor = :'flavor' RETURNING agent_id"
    ") "
    "DELETE FROM agents a USING (SELECT DISTINCT agent_id FROM gone) g "
    "WHERE a.agent_id = g.agent_id AND NOT EXISTS ("
    "SELECT 1 FROM sessions o WHERE o.agent_id = a.agent_id "
    "AND o.flavor IS DISTINCT FROM :'flavor')",
    "DELETE FROM custom_directives WHERE flavor = :'flavor'",
)


def delete_flavor_data(flavor: str) -> None:
    """Best-effort cleanup of all DB rows for a flavor (idempotent).

    Tests that create sessions outside the ``make_event`` tracker, or
    whose agents would otherwise outlive the run, call this at the end
    so nothing they wrote accumulates on a shared stack.
    """
    for sql in FLAVOR_CLEANUP_SQL:
        try:
            exec_sql(sql, flavor=flavor)
        except subprocess.CalledProcessError:
            # Best-effort: tolerate failures (e.g. row doesn't exist,
            # FK reference still in flight).
            pass


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

    The fleet response is agent-level, not flavor-grouped, so
    persistence is observed via ``GET /v1/sessions/:id`` returning 200.
    """
    try:
        get_session(session_id)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def session_events(detail: dict[str, Any]) -> list[dict[str, Any]]:
    """The ``events`` list of a session detail, never ``None``.

    The API serialises an empty list as ``[]``; older binaries sent
    ``null`` for a session whose event rows had not landed, so readers
    that poll go through this helper rather than ``detail["events"]``.
    """
    return detail.get("events") or []


def get_session_event_count(session_id: str) -> int:
    """Return the number of events for a session, 0 while it is unreachable."""
    try:
        return len(session_events(get_session_detail(session_id)))
    except (OSError, ValueError):
        # URLError and HTTPError are OSErrors, as are the socket
        # timeouts and resets a poll must simply retry through.
        return 0


def _docker(*args: str) -> subprocess.CompletedProcess[str]:
    """Run a docker CLI command and raise with its stderr when it fails.

    ``subprocess.CalledProcessError`` alone would only say "exit status
    1"; the daemon's message ("No such container", ...) is what a reader
    of a failing test needs.
    """
    try:
        proc = subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=DOCKER_CLI_TIMEOUT_SECS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        # The same error type as a failed command, so callers that
        # tolerate one daemon message handle a hung CLI the same way.
        raise RuntimeError(
            f"docker {' '.join(args)} gave no answer in {DOCKER_CLI_TIMEOUT_SECS}s"
        ) from exc
    if proc.returncode != 0:
        raise RuntimeError(
            f"docker {' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip()}"
        )
    return proc


def worker_is_paused() -> bool:
    """Whether the worker container is paused (left so by an interrupted test)."""
    paused = _docker("inspect", "-f", "{{.State.Paused}}", WORKER_CONTAINER)
    return paused.stdout.strip() == "true"


def ensure_worker_running() -> None:
    """Unpause the worker if an earlier run was killed inside ``worker_paused``."""
    if worker_is_paused():
        _docker("unpause", WORKER_CONTAINER)


def _abort_on_signal(signum: int, _frame: object) -> None:
    """Turn a termination signal into the interrupt pytest aborts the run on."""
    raise KeyboardInterrupt(f"signal {signum}")


@contextmanager
def worker_paused() -> Iterator[None]:
    """Pause the worker container for the duration of the block.

    Events published meanwhile queue in NATS, and when the worker resumes
    its goroutine pool drains the backlog concurrently, which makes the
    orderings the pool can introduce between a session's events
    reproducible instead of timing-dependent. The container is resumed
    when the block ends, raises, or is interrupted by SIGTERM (turned into
    a ``KeyboardInterrupt`` for the duration, so the run aborts the way
    Ctrl-C does and ``finally`` runs); a run killed outright is repaired
    by ``ensure_worker_running`` at the next session start. A failing
    unpause surfaces unless the block itself already failed.
    """
    previous = signal.signal(signal.SIGTERM, _abort_on_signal)
    try:
        _docker("pause", WORKER_CONTAINER)
    except BaseException:
        signal.signal(signal.SIGTERM, previous)
        raise
    failed = False
    try:
        yield
    except BaseException:
        failed = True
        raise
    finally:
        # Resume first, with SIGTERM held off while the unpause runs,
        # and give the handler back last, so no moment exists in which
        # a SIGTERM could end the run with the container still paused;
        # one that arrives meanwhile is delivered once the mask drops.
        held = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
        try:
            _docker("unpause", WORKER_CONTAINER)
        except RuntimeError as exc:
            if "is not paused" in str(exc):
                pass  # another run's guard already resumed it
            elif not failed:
                raise  # the block passed, so a stuck pause must not be silent
        finally:
            signal.signal(signal.SIGTERM, previous)
            signal.pthread_sigmask(signal.SIG_SETMASK, held)


# Rows the ordering tests hold locks on, and the lock modes they use:
# table, column and mode are code constants checked against these
# allow-lists, so they are safe to place in SQL text; the value is bound
# through psql.
_LOCKABLE_ROWS = {"agents": "agent_id", "sessions": "session_id"}
LockMode = Literal["KEY SHARE", "NO KEY UPDATE", "UPDATE"]
# The mode a NOWAIT probe takes to prove each held lock: one the held
# mode conflicts with. KEY SHARE is compatible with itself (two event
# inserts share a session row), so only an UPDATE probe detects it; the
# other modes conflict with themselves.
_PROBE_MODES: dict[LockMode, LockMode] = {
    "KEY SHARE": "UPDATE",
    "NO KEY UPDATE": "NO KEY UPDATE",
    "UPDATE": "UPDATE",
}
# A lock probe gives up on a row that nobody holds after this long.
LOCK_PROOF_TIMEOUT_SECS = 10.0


@contextmanager
def _row_locked(table: str, row_id: str, mode: LockMode) -> Iterator[None]:
    """Hold a row lock for the duration of the block.

    The lock belongs to a psql session kept open on stdin and tagged
    through its application name; the block starts once a second
    session's NOWAIT probe, in a mode the held lock conflicts with, fails
    on the row, which proves the lock is held (an unknown id locks
    nothing and is reported instead).
    """
    column = _LOCKABLE_ROWS[table]
    probe_mode = _PROBE_MODES.get(mode)
    if probe_mode is None:
        raise ValueError(f"unsupported lock mode {mode!r}")
    row_id = str(uuid.UUID(row_id))
    tag = f"lock-{uuid.uuid4().hex[:8]}"
    docker_exec = ["docker", "exec", "-i"]
    psql = [
        POSTGRES_CONTAINER,
        "psql",
        "-U",
        "flightdeck",
        "-d",
        "flightdeck",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        f"row_id={row_id}",
    ]
    # The holder carries the tag in its environment; the probe is the
    # same client without it.
    holder = [*docker_exec, "-e", f"PGAPPNAME={tag}", *psql]
    prober = [*docker_exec, *psql]
    proc = subprocess.Popen(
        holder,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin is not None and proc.stderr is not None
    stdin, stderr = proc.stdin, proc.stderr
    try:
        stdin.write(
            f"BEGIN; SELECT 1 FROM {table} WHERE {column} = :'row_id'::uuid "
            f"FOR {mode};\n"
        )
        stdin.flush()

        def _held() -> bool:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"psql exited {proc.returncode}: {stderr.read().strip()}"
                )
            # psql substitutes :'name' only in SQL read from stdin, not -c.
            probe = subprocess.run(
                prober,
                input=(
                    f"SELECT 1 FROM {table} WHERE {column} = :'row_id'::uuid "
                    f"FOR {probe_mode} NOWAIT;\n"
                ),
                capture_output=True,
                text=True,
                timeout=DOCKER_CLI_TIMEOUT_SECS,
                check=False,
            )
            if probe.returncode == 0 and "(0 rows)" in probe.stdout:
                raise RuntimeError(f"no {table} row for {row_id}; nothing to lock")
            if probe.returncode != 0 and "could not obtain lock" not in probe.stderr:
                raise RuntimeError(f"lock probe failed: {probe.stderr.strip()}")
            return probe.returncode != 0

        wait_until(
            _held,
            timeout=LOCK_PROOF_TIMEOUT_SECS,
            msg=f"the {table} row lock was never taken ({tag})",
        )
        yield
    finally:
        try:
            stdin.write("COMMIT;\n")
            stdin.flush()
            stdin.close()
        except OSError:
            # psql already exited (reported above through _held), so
            # there is no transaction left to end.
            pass
        proc.wait(timeout=DOCKER_CLI_TIMEOUT_SECS)


@contextmanager
def agent_row_locked(agent_id: str) -> Iterator[None]:
    """Hold the agents row FOR NO KEY UPDATE for the duration of the block.

    HandleSessionStart's first write is the agents upsert, so every
    session_start of that agent blocks in the worker until the block ends
    while the other handlers, which only take KEY SHARE locks on the row
    through the sessions foreign key, proceed.
    """
    with _row_locked("agents", agent_id, "NO KEY UPDATE"):
        yield


@contextmanager
def session_row_locked(
    session_id: str, mode: LockMode = "NO KEY UPDATE"
) -> Iterator[None]:
    """Hold the sessions row for the duration of the block.

    Under the default NO KEY UPDATE every update of the row by the worker
    or by the ingestion API's re-attachment stamp waits on or skips the
    lock, while event inserts, which take KEY SHARE through the foreign
    key, proceed. KEY SHARE holds the row the way an in-flight event
    insert does: updates of the row's other columns, the stamp among
    them, must pass it.
    """
    with _row_locked("sessions", session_id, mode):
        yield


def _docker_timestamp(since: str | float) -> str:
    """Render a ``docker logs --since`` value.

    A string passes through as given (RFC 3339, or a relative span such
    as ``"5m"``); a ``time.time()`` stamp becomes RFC 3339 in UTC with
    microseconds, truncated rather than rounded so the bound never
    lands after the stamp.
    """
    if isinstance(since, str):
        return since
    whole = int(since)
    micros = int((since - whole) * MICROS_PER_SECOND)
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(whole)) + f".{micros:06d}Z"


# The fractional part of a docker logs timestamp is rendered in
# microseconds, the finest unit the daemon accepts.
MICROS_PER_SECOND = 1_000_000
# A stamp from this process is moved back by this much before it is
# handed to the daemon, which compares it with its own clock: a daemon
# in a VM that has lagged a second or two after a sleep would otherwise
# drop the lines the test is looking for. The needles are unique ids,
# so the extra two seconds of lines can never match.
DOCKER_CLOCK_MARGIN_SECS = 2.0


def worker_log_lines(
    *needles: str,
    tail: int = WORKER_LOG_TAIL_LINES,
    since: str | float | None = None,
) -> list[str]:
    """Recent worker-container log lines that contain every needle.

    The worker logs through slog's default handler on stderr
    (``2026/10/20 12:18:37 WARN dropped orphan session_end session_id=…``);
    ``docker logs`` returns both streams. Raises when the CLI fails so a
    missing container reads as an infrastructure error, not as "the
    worker never logged it".

    ``since`` keeps only lines logged at or after a point in time, given
    as a ``time.time()`` stamp or as a string ``docker logs --since``
    accepts. A test that passes its own start time reads only the lines
    its events produced, so a line an earlier run or a parallel worker
    logged for the same marker never counts. The ``tail`` bound still
    applies on top. The daemon compares the stamp with its own clock, so
    a caller that must not miss a line takes the stamp before it posts.
    """
    args = ["logs", "--tail", str(tail)]
    if since is not None:
        if not isinstance(since, str):
            since -= DOCKER_CLOCK_MARGIN_SECS
        args += ["--since", _docker_timestamp(since)]
    proc = _docker(*args, WORKER_CONTAINER)
    return [
        line
        for line in (proc.stdout + proc.stderr).splitlines()
        if all(needle in line for needle in needles)
    ]


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

    sql = f"SELECT delivered_at IS NOT NULL FROM directives WHERE id = '{directive_id}'::uuid"
    result = subprocess.run(
        [
            "docker",
            "exec",
            POSTGRES_CONTAINER,
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
# exercise POST /v1/admin/reconcile-agents. Single-tier auth: the
# endpoint accepts any valid bearer token.
# ---------------------------------------------------------------------------


def post_admin_reconcile(
    token: str | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict[str, Any]]:
    """POST /v1/admin/reconcile-agents and return (status, body).

    Returns a tuple rather than raising on non-2xx because several
    tests exercise 401/409 paths where a non-success status IS the
    expected result. Body is parsed as JSON when the response carries
    a JSON content-type; otherwise the raw decoded text is returned
    under the ``"error"`` key so every caller sees a dict.

    ``token`` defaults to ``TOKEN`` (the regular dev bearer); pass an
    empty string to verify the 401 path.
    """
    if token is None:
        token = TOKEN
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
    last_seen_in_future: bool = False,
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
        - ``last_seen_at``: ISO-8601 string (default: NOW - 1 hour,
          an hour behind the ground truth of a minute ago)

    ``last_seen_in_future`` flips the default ``last_seen_at`` drift to
    NOW + 1 hour. The past-dated default keeps the fixture off the top
    of the fleet page, which lists the most recently seen agents first
    and is what other tests read while this fixture exists; a test that
    watches the reconciler pull the stamp back in time asks for the
    future-dated drift instead.

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
    # Default drift: first_seen_at an hour before ground truth, and
    # last_seen_at an hour before it too unless the caller asked for
    # the future-dated stamp.
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
    if last_seen_override is not None:
        last_seen_default = f"'{last_seen_override}'::timestamptz"
    elif last_seen_in_future:
        last_seen_default = "NOW() + INTERVAL '1 hour'"
    else:
        last_seen_default = "NOW() - INTERVAL '1 hour'"

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
            POSTGRES_CONTAINER,
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
            POSTGRES_CONTAINER,
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
