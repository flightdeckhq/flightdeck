"""Integration test fixtures.

Phase 3 extracted the pure helpers + constants into
``tests/shared/fixtures.py`` so the E2E fixture seeder
(``tests/e2e-fixtures/seed.py``) can reuse the same event-builder
contract without depending on pytest. This file now holds only the
pytest-specific surface: the session-scoped ``stack`` fixture, the
per-test ``_session_lifecycle`` cleanup fixture, and the marker
registration hook.

Every symbol the existing integration tests imported from this
module (``from .conftest import make_event, post_event, ...``) is
re-exported via the ``from ..shared.fixtures import *`` surface
below, so no test file needs editing.
"""

from __future__ import annotations

import time
import warnings
from typing import Any

import pytest

from ..shared.fixtures import (
    # Constants
    API_HEALTH,
    API_URL,
    DEFAULT_AGENT_TYPE,
    DEFAULT_CLIENT_TYPE,
    DEFAULT_HOSTNAME,
    DEFAULT_TEST_CONTEXT,
    DEFAULT_USER,
    INGEST_HEALTH,
    INGESTION_URL,
    MAX_WAIT_SECS,
    POLL_INTERVAL,
    TOKEN,
    # Public helpers
    agent_row_locked,
    auth_headers,
    create_drifted_agent,
    create_policy,
    delete_drifted_agent,
    delete_flavor_data,
    delete_policy,
    directive_has_delivered_at,
    ensure_worker_running,
    exec_sql,
    get_agent_rollup,
    get_fleet,
    get_session,
    get_session_detail,
    get_session_event_count,
    make_event,
    post_admin_reconcile,
    post_directive,
    post_event,
    post_heartbeat,
    query_directives,
    session_events,
    session_exists_in_fleet,
    session_row_locked,
    wait_for_services,
    wait_for_session_in_fleet,
    wait_for_state,
    wait_until,
    worker_log_lines,
    worker_paused,
    # Private helpers + trackers used by the lifecycle fixture
    _ended_sessions,
    _identity_fields,
    _session_tracker,
)

# Re-exported names so ``from .conftest import make_event`` continues to
# work in every integration test. Keeping this list explicit (rather
# than wildcard) documents the public contract at a glance.
__all__ = [
    "API_HEALTH",
    "API_URL",
    "DEFAULT_AGENT_TYPE",
    "DEFAULT_CLIENT_TYPE",
    "DEFAULT_HOSTNAME",
    "DEFAULT_TEST_CONTEXT",
    "DEFAULT_USER",
    "INGEST_HEALTH",
    "INGESTION_URL",
    "MAX_WAIT_SECS",
    "POLL_INTERVAL",
    "TOKEN",
    "agent_row_locked",
    "auth_headers",
    "create_drifted_agent",
    "create_policy",
    "delete_drifted_agent",
    "delete_flavor_data",
    "delete_policy",
    "directive_has_delivered_at",
    "ensure_worker_running",
    "exec_sql",
    "get_agent_rollup",
    "get_fleet",
    "get_session",
    "get_session_detail",
    "get_session_event_count",
    "make_event",
    "post_admin_reconcile",
    "post_directive",
    "post_event",
    "post_heartbeat",
    "query_directives",
    "session_events",
    "session_exists_in_fleet",
    "session_row_locked",
    "wait_for_session_in_fleet",
    "wait_for_state",
    "wait_until",
    "worker_log_lines",
    "worker_paused",
]


@pytest.fixture(scope="session", autouse=True)
def stack() -> None:
    """Verify all services are healthy before running integration tests.

    Wraps the shared ``wait_for_services`` helper (which raises
    ``TimeoutError``) into a ``pytest.fail`` so the message surfaces
    cleanly in the pytest output, then resumes the worker container if a
    killed run left it paused (see ``worker_paused``; one run at a time
    uses a stack, so a pause another run still holds is not expected).
    Without a docker CLI or with a differently named container the
    repair is skipped with a warning: the HTTP-only tests can still run,
    and the ones that pause the worker fail on their own with the cause.
    """
    try:
        wait_for_services(MAX_WAIT_SECS)
    except TimeoutError as exc:
        pytest.fail(str(exc))
    try:
        ensure_worker_running()
    except (OSError, RuntimeError) as exc:
        warnings.warn(f"worker repair skipped: {exc}", RuntimeWarning, stacklevel=2)


@pytest.fixture(autouse=True)
def _session_lifecycle() -> Any:
    """Track sessions created during a test and POST session_end on teardown.

    Production sensors close their session on teardown via ``Session.end()``
    which posts ``session_end``. Integration tests bypass the sensor and
    POST synthetic events directly, so without this fixture every test
    session would remain in state=active forever and accumulate stale
    rows in the dashboard. The fixture clears the per-test tracker, runs
    the test, then POSTs ``session_end`` for every session_id observed
    that has not already been ended explicitly.

    Failures during cleanup are swallowed -- a teardown error must not
    mask the actual test result. The cleanup pass is best-effort.
    """
    _session_tracker.clear()
    _ended_sessions.clear()
    try:
        yield
    finally:
        for sid, flavor in list(_session_tracker.items()):
            if sid in _ended_sessions:
                continue
            try:
                # Build the payload directly -- calling make_event() here
                # would re-register the session_id in the tracker (already
                # being drained) and pull in DEFAULT_TEST_CONTEXT, which
                # only belongs on session_start.
                payload: dict[str, Any] = {
                    "session_id": sid,
                    "flavor": flavor,
                    "event_type": "session_end",
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
                    "timestamp": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    ),
                }
                payload.update(_identity_fields())
                post_event(payload)
            except Exception:
                pass


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "slow: marks tests that require waiting for background reconciler (60s+)",
    )
    config.addinivalue_line(
        "markers",
        "manual: marks tests that are NOT part of CI -- run manually only "
        "(e.g. test_ui_demo.py is a dashboard data-population tool, not a "
        "regression test). Excluded by `make test-integration` and CI via "
        "`-m 'not manual'`. Phase 4.5 audit Task 1.",
    )
    config.addinivalue_line(
        "markers",
        "exclusive: needs the whole stack to itself -- pauses the worker, "
        "rewrites every agent, or asserts fleet-wide state. `make "
        "test-integration` runs the rest of the suite in parallel under "
        "pytest-xdist and these one at a time afterwards.",
    )
