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
import os
import re
import signal
import sqlite3
import subprocess
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import time
import uuid
import urllib.error
import urllib.request
from typing import Any, Callable, Literal

from flightdeck_sensor.core.agent_id import derive_agent_id

# The stack under test. The defaults are the compose dev stack on
# :4000. The flightdeck binary is tested by pointing
# FLIGHTDECK_TEST_BASE_URL at it, with FLIGHTDECK_TEST_WORKER_LOG naming
# the file its log goes to (there is no worker container to read).
# There is no worker container to pause either, so the worker
# container's name is blank for any stack but the dev stack (see
# default_worker_container) and the tests that pause one skip. The
# binary's database is named by one of two variables:
#   FLIGHTDECK_TEST_DB         for a binary on Postgres: its database on
#                              the same Postgres container, which the SQL
#                              helpers shell into with psql;
#   FLIGHTDECK_TEST_SQLITE_DB  for a binary on SQLite: the path of its
#                              flightdeck.db, which the SQL helpers then
#                              open with the stdlib sqlite3 module instead
#                              of running psql. Tests marked postgres_only
#                              skip, and the Postgres container name is
#                              blank (see POSTGRES_CONTAINER).
# A stack that is not the dev stack must name its database with one of
# the two: stack_configuration_error refuses to run otherwise, because
# the SQL helpers would fall back to the dev stack's own database.
BASE_URL = os.environ.get("FLIGHTDECK_TEST_BASE_URL", "http://localhost:4000").rstrip("/")
INGESTION_URL = f"{BASE_URL}/ingest"
API_URL = f"{BASE_URL}/api"
SQLITE_DB = os.environ.get("FLIGHTDECK_TEST_SQLITE_DB", "")
# The addresses the compose dev stack answers on. Only there do the
# defaults below (its Postgres database, its worker container) name
# what the suite is actually talking to.
DEV_STACK_BASE_URLS = frozenset(
    {"http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"}
)
DEV_STACK_WORKER_CONTAINER = "docker-workers-1"
# The database the dev stack itself runs on, in the Postgres container
# the SQL helpers shell into.
DEV_STACK_DATABASE = "flightdeck"


def stack_configuration_error(
    base_url: str, test_db: str, sqlite_db: str
) -> str | None:
    """Why the fixtures must not run against ``base_url`` with these
    settings, or None when they may.

    The SQL helpers and the e2e seeder write to a database directly. A
    stack other than the dev stack (the flightdeck binary on a port of
    its own) has a database of its own; unless ``FLIGHTDECK_TEST_DB`` or
    ``FLIGHTDECK_TEST_SQLITE_DB`` names it, those writes would land in
    the dev stack's ``flightdeck`` database, whose rows other work uses.
    """
    if test_db and sqlite_db:
        return (
            "FLIGHTDECK_TEST_DB and FLIGHTDECK_TEST_SQLITE_DB are both set; the stack "
            "under test has one database: set the one that names it"
        )
    on_dev_stack = base_url.rstrip("/") in DEV_STACK_BASE_URLS
    if not on_dev_stack and test_db == DEV_STACK_DATABASE:
        return (
            f"FLIGHTDECK_TEST_DB is {DEV_STACK_DATABASE}, the dev stack's own database, "
            f"while FLIGHTDECK_TEST_BASE_URL is {base_url}, which is not the dev stack: "
            "the SQL helpers and the seeder would write to the dev stack's rows. Give "
            "the stack under test a database of its own and name that one (or set "
            "FLIGHTDECK_TEST_SQLITE_DB for a binary on SQLite)."
        )
    if on_dev_stack or test_db or sqlite_db:
        return None
    return (
        f"FLIGHTDECK_TEST_BASE_URL is {base_url}, which is not the dev stack "
        "(http://localhost:4000), and neither FLIGHTDECK_TEST_DB nor "
        "FLIGHTDECK_TEST_SQLITE_DB names its database: the SQL helpers and the seeder "
        "would read and write the dev stack's flightdeck database instead. Set "
        "FLIGHTDECK_TEST_SQLITE_DB to the binary's flightdeck.db, or FLIGHTDECK_TEST_DB "
        "to its Postgres database."
    )


def default_worker_container(base_url: str) -> str:
    """The worker container the pause tests and the log reader use when
    ``FLIGHTDECK_TEST_WORKER_CONTAINER`` is not set: the dev stack's,
    and only when the suite runs against the dev stack. Any other stack
    is the flightdeck binary, which has no worker container; naming the
    dev stack's there would pause a worker other work depends on."""
    if base_url.rstrip("/") in DEV_STACK_BASE_URLS:
        return DEV_STACK_WORKER_CONTAINER
    return ""


_configuration_error = stack_configuration_error(
    BASE_URL, os.environ.get("FLIGHTDECK_TEST_DB", ""), SQLITE_DB
)
if _configuration_error:
    raise RuntimeError(_configuration_error)
# The dev stack's container names are the contract for the helpers that
# shell into it (psql below, the worker log reader). A stack on SQLite
# has no Postgres behind it, so the name is blank there: a psql call
# with no SQLite path (the e2e seeder's backdates) is then refused by
# the docker CLI instead of writing to the dev stack's database, whose
# seeded rows carry the same ids.
POSTGRES_CONTAINER = (
    ""
    if SQLITE_DB
    else os.environ.get("FLIGHTDECK_TEST_POSTGRES_CONTAINER", "docker-postgres-1")
)
POSTGRES_DB = os.environ.get("FLIGHTDECK_TEST_DB", "flightdeck")
# The finest step a stored timestamp resolves: Postgres keeps
# microseconds, SQLite the milliseconds of its strftime('%f'). A test
# that compares a stored time with one it sent allows this much.
DB_TIMESTAMP_RESOLUTION_US = 1000 if SQLITE_DB else 1
WORKER_CONTAINER = os.environ.get(
    "FLIGHTDECK_TEST_WORKER_CONTAINER", default_worker_container(BASE_URL)
)
WORKER_LOG_FILE = os.environ.get("FLIGHTDECK_TEST_WORKER_LOG", "")
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
    """The session's rows of the directives table, read from the database."""
    if SQLITE_DB:
        return _sqlite_rows(
            "SELECT * FROM directives WHERE session_id = :sid", {"sid": session_id}
        )
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
            POSTGRES_DB,
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


# How long a helper's SQLite connection waits for the database's write
# lock. The binary's one writer holds it for a transaction at a time,
# milliseconds each, so this only has to outlast a burst of them.
SQLITE_BUSY_TIMEOUT_MS = 10_000


def sqlite_timestamp(value: str | datetime) -> str:
    """``value`` in the one layout a SQLite timestamp column holds:
    RFC 3339 in UTC with milliseconds (``2026-11-07T12:34:56.789Z``; the
    schema's CHECKs reject any other text). Finer digits are cut off, as
    the stores do when they write a time; SQLite's own strftime would
    round them. A value without an offset is read as UTC.
    """
    moment = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    moment = moment.astimezone(UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


@contextmanager
def _sqlite_connection() -> Iterator[sqlite3.Connection]:
    """A connection to the binary's database file, closed on exit.

    The file is opened read-write and never created: a wrong path fails
    instead of leaving an empty database behind. Statements commit as
    they run unless the caller opens a transaction. Foreign keys are
    enforced, as on the binary's own connections, so a delete cascades
    or is refused the way it is on Postgres.
    """
    conn = sqlite3.connect(
        f"file:{urllib.request.pathname2url(os.path.abspath(SQLITE_DB))}?mode=rw",
        uri=True,
        isolation_level=None,
        timeout=SQLITE_BUSY_TIMEOUT_MS / 1000,
    )
    try:
        conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
    finally:
        conn.close()


def _sqlite_run(
    statements: Sequence[tuple[str, Mapping[str, Any]]],
) -> tuple[list[str], list[tuple[Any, ...]]]:
    """Run the statements on the binary's database and return the column
    names and rows of the last one. Each statement names its parameters
    ``:name``. One statement commits on its own; several run in one
    transaction that takes the write lock up front, so they apply
    together or not at all.
    """
    with _sqlite_connection() as conn:
        in_transaction = len(statements) > 1
        if in_transaction:
            conn.execute("BEGIN IMMEDIATE")
        try:
            cursor = conn.cursor()
            for statement, params in statements:
                cursor.execute(statement, params)
            columns = [d[0] for d in cursor.description or ()]
            rows = cursor.fetchall()
            if in_transaction:
                conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
    return columns, rows


# What _sqlite_schema_columns read, kept for the life of the process:
# the schema of the stack under test does not change during a run.
_sqlite_schema_cache: tuple[frozenset[str], frozenset[str]] | None = None


def _sqlite_schema_columns() -> tuple[frozenset[str], frozenset[str]]:
    """The names of the JSON columns and of the boolean columns of the
    binary's schema, read from the schema itself: a JSON column (jsonb on
    Postgres) is TEXT with a ``json_valid`` CHECK, a boolean column is
    declared BOOLEAN. Read once per process.
    """
    global _sqlite_schema_cache
    if _sqlite_schema_cache is None:
        _, tables = _sqlite_run(
            [("SELECT name, sql FROM sqlite_master WHERE type = 'table'", {})]
        )
        json_columns: set[str] = set()
        boolean_columns: set[str] = set()
        for table, ddl in tables:
            json_columns.update(re.findall(r"json_valid\((\w+)\)", ddl or ""))
            _, columns = _sqlite_run(
                [("SELECT name, type FROM pragma_table_info(:table)", {"table": table})]
            )
            boolean_columns.update(
                name for name, declared in columns if declared.upper() == "BOOLEAN"
            )
        _sqlite_schema_cache = (frozenset(json_columns), frozenset(boolean_columns))
    return _sqlite_schema_cache


def _sqlite_rows(sql: str, params: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Rows of a SQLite SELECT as dicts shaped like Postgres'
    ``row_to_json``: a JSON column decoded, a boolean column a ``bool``.
    Columns are recognised by name, so a JSON or boolean column must be
    selected under its own name; a computed boolean stays 0 or 1.
    """
    json_columns, boolean_columns = _sqlite_schema_columns()
    columns, rows = _sqlite_run([(sql, params)])
    decoded: list[dict[str, Any]] = []
    for row in rows:
        record: dict[str, Any] = {}
        for name, value in zip(columns, row, strict=True):
            if name in json_columns and isinstance(value, str):
                value = json.loads(value)
            elif name in boolean_columns and isinstance(value, int):
                value = bool(value)
            record[name] = value
        decoded.append(record)
    return decoded


def _sqlite_text(rows: Sequence[tuple[Any, ...]]) -> str:
    """Rows rendered the way ``psql -tA`` prints them: one line per row,
    columns joined by ``|``, NULL as the empty string. Values keep
    SQLite's own text: a boolean is ``1`` or ``0`` (psql prints ``t`` or
    ``f``) and a timestamp is RFC 3339, so a caller compares neither
    with a Postgres rendering.
    """

    def cell(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return "\\x" + value.hex()
        return str(value)

    return "\n".join("|".join(cell(v) for v in row) for row in rows).strip()


# The casts the translation drops: SQLite keeps a uuid and JSON as text
# and has one integer type, so the value is already what the cast makes.
_SQLITE_DROPPED_CASTS = ("uuid", "text", "json", "jsonb", "int", "bigint")
# The units a ``NOW() +/- INTERVAL 'N unit'`` offset may use: the ones
# SQLite's date modifiers share with Postgres, singular or plural.
_SQLITE_INTERVAL_UNITS = frozenset({"second", "minute", "hour", "day", "month", "year"})
_SQLITE_NOW_FORMAT = "%Y-%m-%dT%H:%M:%fZ"

_PSQL_TOKEN = re.compile(
    rf"""
      (?P<timestamp>(?<!:):'(?P<timestamp_name>\w+)'::timestamptz\b)
    | (?P<quoted>(?<!:):'(?P<quoted_name>\w+)')
    | (?P<string>'(?:[^']|'')*')
    | (?P<cast>::(?:{"|".join(_SQLITE_DROPPED_CASTS)})\b(?!\s*\[))
    | (?P<raw>(?<![:\w]):(?P<raw_name>[A-Za-z_]\w*))
    | (?P<now>\bNOW\(\)(?P<offsets>(?:\s*[+-]\s*INTERVAL\s*'\s*\d+(?:\.\d+)?\s+[A-Za-z]+\s*')*))
    """,
    re.IGNORECASE | re.VERBOSE,
)
_PSQL_INTERVAL = re.compile(
    r"([+-])\s*INTERVAL\s*'\s*(\d+(?:\.\d+)?)\s+([A-Za-z]+)\s*'", re.IGNORECASE
)

# What the translation leaves alone and SQLite cannot run, or would run
# with another meaning. A statement that still holds one of these after
# the rewrites is refused; its caller passes the SQLite statement.
_POSTGRES_ONLY_SQL: tuple[tuple[str, str], ...] = (
    (r"::", "a cast other than " + ", ".join(f"::{c}" for c in _SQLITE_DROPPED_CASTS)),
    (r":\"", "an identifier binding"),
    (r"\bINTERVAL\b", "an interval outside NOW() +/- INTERVAL 'N unit'"),
    (r"\bNOW\s*\(", "NOW() in a spelling the rewrite does not cover"),
    (r"\bANY\s*\(|\bARRAY\b|\bstring_to_array\b|\bunnest\b", "an array"),
    (
        r"\b(json_agg|row_to_json|json_build_object|to_jsonb?|jsonb_\w+)\b|#>|@>",
        "a Postgres JSON function or operator",
    ),
    (
        r"\b(EXTRACT|to_char|to_timestamp|date_trunc|make_interval|clock_timestamp)\s*\(",
        "a Postgres date function",
    ),
    (r"\bAT\s+TIME\s+ZONE\b", "AT TIME ZONE"),
    (r"\b(decode|encode)\s*\(", "decode() or encode()"),
    (r"\bpg_\w+", "the Postgres catalog"),
    (r"\bgen_random_uuid\b", "gen_random_uuid()"),
    (r"\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b", "IS DISTINCT FROM"),
    (r"\bDELETE\s+FROM\s+\w+(\s+(AS\s+)?\w+)?\s+USING\b", "DELETE ... USING"),
    (r"\bILIKE\b", "ILIKE"),
    (r"\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b", "a row lock"),
    (r"\A\s*WITH\b.*\b(INSERT|UPDATE|DELETE)\b", "a data-modifying CTE"),
    (r";\s*\S", "more than one statement"),
)


def translate_to_sqlite(
    sql: str, bindings: Mapping[str, Any]
) -> tuple[str, dict[str, Any]]:
    """Rewrite a psql statement of ``exec_sql`` for SQLite and return it
    with its parameters.

    The rewrites are these and no others:

      * ``:'name'`` becomes the parameter ``:name``, bound as text;
      * ``:name`` becomes the parameter ``:name``, bound as the number
        it spells (psql pastes it into the statement unquoted);
      * ``:'name'::timestamptz`` becomes a parameter bound to the value
        in the layout SQLite timestamp columns hold (``sqlite_timestamp``);
      * the casts ``::uuid``, ``::text``, ``::json``, ``::jsonb``,
        ``::int`` and ``::bigint`` are dropped;
      * ``NOW()`` becomes ``strftime('%Y-%m-%dT%H:%M:%fZ', 'now')``, and
        each ``+ INTERVAL 'N unit'`` or ``- INTERVAL 'N unit'`` that
        follows it becomes a modifier of that call.

    String literals are left as written. Anything else that is Postgres
    only (the ``_POSTGRES_ONLY_SQL`` list) raises ``ValueError`` rather
    than run half translated: the caller then passes the statement for
    SQLite through ``sqlite=``.
    """
    params: dict[str, Any] = {}
    translated: list[str] = []
    outside_literals: list[str] = []
    position = 0

    def bound(name: str) -> Any:
        if name not in bindings:
            raise ValueError(f"no binding for :{name} in {sql!r}")
        return bindings[name]

    for match in _PSQL_TOKEN.finditer(sql):
        gap = sql[position : match.start()]
        translated.append(gap)
        outside_literals.append(gap)
        position = match.end()
        if match.group("timestamp") is not None:
            name = match.group("timestamp_name")
            params[f"{name}__ts"] = sqlite_timestamp(str(bound(name)))
            translated.append(f":{name}__ts")
        elif match.group("quoted") is not None:
            name = match.group("quoted_name")
            params[name] = str(bound(name))
            translated.append(f":{name}")
        elif match.group("string") is not None:
            translated.append(match.group("string"))
        elif match.group("cast") is not None:
            pass
        elif match.group("raw") is not None:
            name = match.group("raw_name")
            params[name] = _sqlite_number(name, bound(name))
            translated.append(f":{name}")
        else:
            if re.match(r"\s*[+-]", sql[position:]):
                raise ValueError(
                    "NOW() is followed by arithmetic other than INTERVAL 'N unit'; "
                    f"pass the SQLite statement as sqlite=...: {sql!r}"
                )
            modifiers = []
            for sign, amount, unit in _PSQL_INTERVAL.findall(match.group("offsets")):
                if unit.lower().removesuffix("s") not in _SQLITE_INTERVAL_UNITS:
                    raise ValueError(
                        f"interval unit {unit!r} has no SQLite modifier in {sql!r}"
                    )
                modifiers.append(f", '{sign}{amount} {unit.lower()}'")
            translated.append(
                f"strftime('{_SQLITE_NOW_FORMAT}', 'now'{''.join(modifiers)})"
            )
    tail = sql[position:]
    translated.append(tail)
    outside_literals.append(tail)

    residue = " ".join(outside_literals)
    for pattern, what in _POSTGRES_ONLY_SQL:
        if re.search(pattern, residue, re.IGNORECASE | re.DOTALL):
            raise ValueError(
                f"the SQLite translation does not cover {what}; pass the SQLite "
                f"statement as sqlite=...: {sql!r}"
            )
    return "".join(translated), params


def _sqlite_number(name: str, value: Any) -> int | float:
    """The number an unquoted ``:name`` binding spells."""
    if isinstance(value, bool):
        raise TypeError(f"binding :{name} must be a number, not {value!r}")
    if isinstance(value, (int, float)):
        return value
    try:
        return int(str(value))
    except ValueError:
        return float(str(value))


def _sqlite_statements(
    sql: str, sqlite: str | Sequence[str] | None, bindings: Mapping[str, Any]
) -> list[tuple[str, Mapping[str, Any]]]:
    """The statements ``exec_sql`` and ``query_rows`` run on SQLite: the
    ones given as ``sqlite``, bound to ``bindings`` as they are, or else
    the translation of ``sql``."""
    if sqlite is None:
        return [translate_to_sqlite(sql, bindings)]
    if isinstance(sqlite, str):
        return [(sqlite, bindings)]
    return [(statement, bindings) for statement in sqlite]


def query_rows(
    sql: str, *, sqlite: str | None = None, **bindings: Any
) -> list[dict[str, Any]]:
    """The rows of a SELECT as dicts keyed by column name, with the same
    Python shapes on both backends: a dict or list for a JSON column, a
    ``bool`` for a boolean column, ``str`` for uuids and timestamps.

    ``sql`` and ``bindings`` are as for ``exec_sql``; an ``ORDER BY`` in
    ``sql`` orders the rows. On SQLite the statement is ``sqlite`` when
    given, else the translation of ``sql``, and the two differences of
    the engines stay visible: a timestamp reads
    ``2026-11-07T12:34:56.789Z`` (Postgres:
    ``2026-11-07T12:34:56.789012+00:00``) and a computed boolean such as
    ``ended_at IS NOT NULL`` is 1 or 0, so callers parse the former and
    test the latter for truth.
    """
    if SQLITE_DB:
        ((statement, params),) = _sqlite_statements(sql, sqlite, bindings)
        return _sqlite_rows(statement, params)
    raw = exec_sql(
        f"SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM ({sql}) r",
        **bindings,
    )
    return json.loads(raw or "[]")  # type: ignore[no-any-return]


def exec_sql(
    sql: str, *, sqlite: str | Sequence[str] | None = None, **bindings: Any
) -> str:
    """Execute a SQL statement against the database of the stack under
    test, with optional psql bind variables.

    On Postgres (the default) the statement runs through psql in the
    Postgres container. On SQLite (``FLIGHTDECK_TEST_SQLITE_DB``) it runs
    on the binary's database file: ``sqlite`` when given, a statement or
    a sequence of statements applied in one transaction, with ``:name``
    parameters bound to ``bindings``; otherwise the translation of
    ``sql`` (see ``translate_to_sqlite`` for the few rewrites it knows;
    anything beyond them raises and needs ``sqlite=``). The SQLite output
    is shaped like psql's (see ``_sqlite_text``).

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
    if SQLITE_DB:
        _, rows = _sqlite_run(_sqlite_statements(sql, sqlite, bindings))
        return _sqlite_text(rows)
    args = [
        "docker",
        "exec",
        "-i",
        POSTGRES_CONTAINER,
        "psql",
        "-U",
        "flightdeck",
        "-d",
        POSTGRES_DB,
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
# The sessions-and-agents statement of FLAVOR_CLEANUP_SQL for SQLite,
# which has no data-modifying CTE: one transaction that checks its
# foreign keys at commit, so the agents whose every session carries the
# flavor go first, while those sessions still say which agents they are,
# and the sessions after them.
SQLITE_FLAVOR_SESSIONS_CLEANUP = (
    "PRAGMA defer_foreign_keys = ON",
    (
        "DELETE FROM agents WHERE agent_id IN "
        "(SELECT agent_id FROM sessions WHERE flavor = :flavor) AND NOT EXISTS ("
        "SELECT 1 FROM sessions o WHERE o.agent_id = agents.agent_id "
        "AND o.flavor IS NOT :flavor)"
    ),
    "DELETE FROM sessions WHERE flavor = :flavor",
)


def delete_flavor_data(flavor: str) -> None:
    """Best-effort cleanup of all DB rows for a flavor (idempotent).

    Tests that create sessions outside the ``make_event`` tracker, or
    whose agents would otherwise outlive the run, call this at the end
    so nothing they wrote accumulates on a shared stack.
    """
    for sql in FLAVOR_CLEANUP_SQL:
        sqlite = SQLITE_FLAVOR_SESSIONS_CLEANUP if sql.startswith("WITH gone") else None
        try:
            exec_sql(sql, sqlite=sqlite, flavor=flavor)
        except (subprocess.CalledProcessError, sqlite3.IntegrityError):
            # Best-effort: tolerate failures (e.g. row doesn't exist,
            # FK reference still in flight). On SQLite only the refused
            # delete is tolerated: a database that stays locked past the
            # busy timeout is a fault of the stack and surfaces.
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
    if not WORKER_CONTAINER:
        return False
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

    Against the flightdeck binary (no worker container,
    ``FLIGHTDECK_TEST_WORKER_CONTAINER`` empty) the test skips: the
    worker is a goroutine of the one process and cannot be paused alone.
    """
    if not WORKER_CONTAINER:
        import pytest

        pytest.skip("pausing the worker needs the compose worker container")
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

    SQLite locks the whole database for a writer and has no row locks, so
    a test that holds one is marked ``postgres_only``; reaching this on
    SQLite is a missing marker and raises.
    """
    if SQLITE_DB:
        raise RuntimeError(
            f"locking a row of {table} needs Postgres: SQLite has no row "
            "locks; mark the test postgres_only"
        )
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
        POSTGRES_DB,
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
    if WORKER_LOG_FILE:
        return _worker_log_file_lines(needles, tail, since)
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


def _worker_log_file_lines(
    needles: tuple[str, ...], tail: int, since: str | float | None
) -> list[str]:
    """``worker_log_lines`` over the log file of the flightdeck binary.

    The binary logs through slog's default handler, whose lines start
    with a ``YYYY/MM/DD HH:MM:SS`` stamp in the process's zone, which the
    binary sets to UTC; a ``time.time()`` ``since`` keeps the lines
    stamped at or after it (minus the same margin the daemon path
    allows). A string ``since`` (a docker
    duration or RFC 3339 value) cannot be applied to a file and is
    ignored, so a caller gets at most the ``tail`` bound it asked for.
    """
    with open(WORKER_LOG_FILE, encoding="utf-8", errors="replace") as fh:
        lines = fh.read().splitlines()[-tail:]
    if since is not None and not isinstance(since, str):
        floor = time.gmtime(since - DOCKER_CLOCK_MARGIN_SECS)
        floor_text = time.strftime("%Y/%m/%d %H:%M:%S", floor)
        lines = [line for line in lines if line[:19] >= floor_text]
    return [line for line in lines if all(needle in line for needle in needles)]


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
    if SQLITE_DB:
        _, rows = _sqlite_run(
            [
                (
                    "SELECT delivered_at IS NOT NULL FROM directives WHERE id = :id",
                    {"id": directive_id},
                )
            ]
        )
        return bool(rows and rows[0][0])
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
            POSTGRES_DB,
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

    if SQLITE_DB:
        _sqlite_create_drifted_agent(
            agent_id=agent_id,
            agent_name=agent_name,
            client_type=client_type,
            agent_type=agent_type,
            user=user,
            hostname=hostname,
            actual_sessions=actual_sessions,
            actual_tokens_per_session=actual_tokens_per_session,
            total_sessions=total_sessions,
            total_tokens=total_tokens,
            first_seen_override=first_seen_override,
            last_seen_override=last_seen_override,
            last_seen_in_future=last_seen_in_future,
        )
        return agent_id

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


def _sqlite_create_drifted_agent(
    *,
    agent_id: str,
    agent_name: str,
    client_type: str,
    agent_type: str,
    user: str,
    hostname: str,
    actual_sessions: int,
    actual_tokens_per_session: int,
    total_sessions: int,
    total_tokens: int,
    first_seen_override: str | None,
    last_seen_override: str | None,
    last_seen_in_future: bool,
) -> None:
    """``create_drifted_agent`` on SQLite: the same agents row and
    sessions, written in one transaction. Every time is an offset from
    one instant, as the statements of the Postgres block share one
    ``NOW()``."""
    now = datetime.now(UTC)
    hour = timedelta(hours=1)
    first_seen = first_seen_override or now - hour
    if last_seen_override is not None:
        last_seen: str | datetime = last_seen_override
    else:
        last_seen = now + hour if last_seen_in_future else now - hour
    insert_agent = (
        "INSERT INTO agents (agent_id, agent_type, client_type, agent_name, "
        "user_name, hostname, first_seen_at, last_seen_at, total_sessions, "
        "total_tokens) VALUES (:agent_id, :agent_type, :client_type, "
        ":agent_name, :user_name, :hostname, :first_seen_at, :last_seen_at, "
        ":total_sessions, :total_tokens) "
        "ON CONFLICT (agent_id) DO UPDATE SET "
        "total_sessions = excluded.total_sessions, "
        "total_tokens = excluded.total_tokens, "
        "first_seen_at = excluded.first_seen_at, "
        "last_seen_at = excluded.last_seen_at"
    )
    insert_session = (
        "INSERT INTO sessions (session_id, agent_id, flavor, state, "
        "started_at, last_seen_at, tokens_used, agent_type, client_type) "
        "VALUES (:session_id, :agent_id, 'drift-test-flavor', 'closed', "
        ":seen, :seen, :tokens, :agent_type, :client_type)"
    )
    statements: list[tuple[str, Mapping[str, Any]]] = [
        (
            insert_agent,
            {
                "agent_id": agent_id,
                "agent_type": agent_type,
                "client_type": client_type,
                "agent_name": agent_name,
                "user_name": user,
                "hostname": hostname,
                "first_seen_at": sqlite_timestamp(first_seen),
                "last_seen_at": sqlite_timestamp(last_seen),
                "total_sessions": total_sessions,
                "total_tokens": total_tokens,
            },
        )
    ]
    for i in range(actual_sessions):
        # Session 0 is the oldest, as in the Postgres block.
        seen = sqlite_timestamp(now - timedelta(minutes=actual_sessions - i))
        statements.append(
            (
                insert_session,
                {
                    "session_id": str(uuid.uuid4()),
                    "agent_id": agent_id,
                    "seen": seen,
                    "tokens": actual_tokens_per_session,
                    "agent_type": agent_type,
                    "client_type": client_type,
                },
            )
        )
    _sqlite_run(statements)


def delete_drifted_agent(agent_id: str) -> None:
    """Tear down a drifted agent fixture (sessions then agent row).
    Best-effort — missing rows are ignored so repeated cleanup calls
    are safe."""
    if SQLITE_DB:
        _sqlite_run(
            [
                ("DELETE FROM sessions WHERE agent_id = :id", {"id": agent_id}),
                ("DELETE FROM agents WHERE agent_id = :id", {"id": agent_id}),
            ]
        )
        return
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
    if SQLITE_DB:
        rows = _sqlite_rows(
            "SELECT agent_id, total_sessions, total_tokens, first_seen_at, "
            "last_seen_at FROM agents WHERE agent_id = :id",
            {"id": agent_id},
        )
        return rows[0] if rows else None
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
            POSTGRES_DB,
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
            POSTGRES_DB,
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
