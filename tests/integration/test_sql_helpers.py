"""The SQL helpers of ``tests/shared/fixtures.py`` on SQLite.

The suite reads and writes the database of the stack under test through
``exec_sql`` and ``query_rows``. On Postgres they run psql; on SQLite
they translate the psql statement, or run the statement the caller gave
for SQLite, on the binary's database file. These tests pin the
translation (what it rewrites, what it refuses) and run the SQLite path
of every helper on a database built from the SQLite migrations, so that
path is covered whichever backend the stack itself uses. They touch no
row of the stack.
"""

from __future__ import annotations

import pathlib
import sqlite3
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest

from ..shared import fixtures

MIGRATIONS = (
    pathlib.Path(__file__).resolve().parents[2] / "storage" / "migrations" / "sqlite"
)
NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'"


@pytest.mark.parametrize(
    ("psql", "bindings", "statement", "params"),
    [
        (
            "UPDATE sessions SET state = :'state' WHERE session_id = :'sid'::uuid",
            {"state": "lost", "sid": "s-1"},
            "UPDATE sessions SET state = :state WHERE session_id = :sid",
            {"state": "lost", "sid": "s-1"},
        ),
        (
            "SELECT COUNT(*) FROM sessions WHERE tokens_used = :tokens",
            {"tokens": "25"},
            "SELECT COUNT(*) FROM sessions WHERE tokens_used = :tokens",
            {"tokens": 25},
        ),
        (
            (
                "SELECT COALESCE(context::text, 'NULL'), token_id::text, x::int, y::bigint,"
                " '[]'::json, z::jsonb FROM sessions"
            ),
            {},
            "SELECT COALESCE(context, 'NULL'), token_id, x, y, '[]', z FROM sessions",
            {},
        ),
        (
            "UPDATE sessions SET started_at = :'ts'::timestamptz WHERE flavor = :'f'",
            {"ts": "2026-11-07T14:34:56.789999+02:00", "f": "a"},
            "UPDATE sessions SET started_at = :ts__ts WHERE flavor = :f",
            {"ts__ts": "2026-11-07T12:34:56.789Z", "f": "a"},
        ),
        (
            (
                "UPDATE sessions SET ended_at = NOW(), last_seen_at = NOW() - INTERVAL"
                " '24 hours' + INTERVAL '10.5 seconds'"
            ),
            {},
            (
                f"UPDATE sessions SET ended_at = {NOW}), last_seen_at = {NOW},"
                " '-24 hours', '+10.5 seconds')"
            ),
            {},
        ),
        (
            "SELECT payload->>'close_reason', 'a :b ::uuid NOW()' FROM events",
            {},
            "SELECT payload->>'close_reason', 'a :b ::uuid NOW()' FROM events",
            {},
        ),
    ],
    ids=["bindings", "raw-number", "casts", "timestamp", "now", "literals"],
)
def test_translation_rewrites(
    psql: str, bindings: dict[str, object], statement: str, params: dict[str, object]
) -> None:
    assert fixtures.translate_to_sqlite(psql, bindings) == (statement, params)


@pytest.mark.parametrize(
    "psql",
    [
        "SELECT COUNT(*) FROM sessions WHERE session_id = ANY(:'ids'::uuid[])",
        "SELECT id FROM events WHERE event_type = ANY(string_to_array(:'ids', ','))",
        "SELECT COALESCE(json_agg(row_to_json(d)), '[]'::json) FROM directives d",
        "SELECT EXTRACT(EPOCH FROM (ended_at - last_seen_at)) FROM sessions",
        "SELECT to_char(occurred_at, 'YYYY') FROM events",
        "SELECT clock_timestamp()",
        "SELECT count(*) FROM otlp_spans WHERE trace_id = decode(:'ids', 'hex')",
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint",
        "UPDATE sessions SET last_seen_at = NOW() - CAST(:'ids' AS interval)",
        "SELECT NOW() - last_seen_at FROM sessions",
        "SELECT last_seen_at + INTERVAL '1 hour' FROM sessions",
        "SELECT started_at::date FROM sessions",
        "SELECT 1 FROM sessions o WHERE o.flavor IS DISTINCT FROM :'ids'",
        "DELETE FROM agents a USING sessions s WHERE a.agent_id = s.agent_id",
        "WITH gone AS (DELETE FROM sessions RETURNING agent_id) DELETE FROM agents",
        "SELECT 1 FROM sessions WHERE session_id = :'ids' FOR NO KEY UPDATE",
        "INSERT INTO sessions (session_id) VALUES (gen_random_uuid())",
        "DELETE FROM events; DELETE FROM sessions",
    ],
)
def test_translation_refuses_what_it_does_not_cover(psql: str) -> None:
    with pytest.raises(ValueError, match="sqlite="):
        fixtures.translate_to_sqlite(psql, {"ids": "a,b"})


def test_translation_refuses_a_boolean_where_a_number_is_bound() -> None:
    with pytest.raises(TypeError, match="must be a number"):
        fixtures.translate_to_sqlite("SELECT 1 WHERE tokens_used = :n", {"n": True})


def test_translation_names_a_missing_binding() -> None:
    with pytest.raises(ValueError, match="no binding for :sid"):
        fixtures.translate_to_sqlite("SELECT 1 WHERE 'x' = :'sid'", {})


@pytest.mark.parametrize(
    ("value", "stored"),
    [
        ("2026-11-07T12:34:56.789999Z", "2026-11-07T12:34:56.789Z"),
        ("2026-11-07 12:34:56.7+00", "2026-11-07T12:34:56.700Z"),
        ("2026-11-07T12:34:56", "2026-11-07T12:34:56.000Z"),
        (
            datetime(2026, 11, 7, 14, 34, 56, 1999, tzinfo=UTC),
            "2026-11-07T14:34:56.001Z",
        ),
    ],
)
def test_sqlite_timestamp_cuts_to_the_stored_layout(
    value: str | datetime, stored: str
) -> None:
    assert fixtures.sqlite_timestamp(value) == stored


@pytest.fixture
def sqlite_db(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[pathlib.Path]:
    """A database with the binary's SQLite schema that the helpers treat
    as the stack's for the duration of the test."""
    path = tmp_path / "flightdeck.db"
    conn = sqlite3.connect(path)
    try:
        for migration in sorted(MIGRATIONS.glob("*.up.sql")):
            conn.executescript(migration.read_text())
    finally:
        conn.close()
    monkeypatch.setattr(fixtures, "SQLITE_DB", str(path))
    monkeypatch.setattr(fixtures, "_sqlite_schema_cache", None)
    yield path


def _session_ids(agent_id: str) -> list[str]:
    rows = fixtures.query_rows(
        "SELECT session_id FROM sessions WHERE agent_id = :'aid'::uuid ORDER BY started_at",
        aid=agent_id,
    )
    return [row["session_id"] for row in rows]


def test_exec_sql_prints_rows_the_way_psql_does(sqlite_db: pathlib.Path) -> None:
    agent_id = fixtures.create_drifted_agent(
        agent_name=f"sql-helpers-{uuid.uuid4().hex[:8]}", actual_sessions=2
    )
    out = fixtures.exec_sql(
        "SELECT state, ended_at, tokens_used FROM sessions "
        "WHERE agent_id = :'aid'::uuid AND tokens_used = :tokens ORDER BY started_at",
        aid=agent_id,
        tokens=100,
    )
    # One line per row, columns joined by "|", NULL as the empty string.
    assert out == "closed||100\nclosed||100"
    assert fixtures.exec_sql("SELECT 1 WHERE 1 = 0") == ""


def test_query_rows_decodes_json_and_boolean_columns(sqlite_db: pathlib.Path) -> None:
    agent_id = fixtures.create_drifted_agent(
        agent_name=f"sql-helpers-{uuid.uuid4().hex[:8]}", actual_sessions=1
    )
    (sid,) = _session_ids(agent_id)
    fixtures.exec_sql(
        "UPDATE sessions SET capture_prompts = TRUE, last_seen_at = NOW() - INTERVAL '31 minutes'"
        " WHERE session_id = :'sid'::uuid",
        sid=sid,
    )
    fixtures.exec_sql(
        "INSERT INTO events (session_id, flavor, event_type, has_content, payload)"
        " VALUES (:'sid'::uuid, 'drift-test-flavor', 'session_end', FALSE,"
        ' \'{"close_reason": "orphan_timeout"}\')',
        sid=sid,
    )

    (session,) = fixtures.query_rows(
        "SELECT session_id, context, capture_prompts, started_at, last_seen_at,"
        " ended_at IS NOT NULL AS ended FROM sessions WHERE session_id = :'sid'::uuid",
        sid=sid,
    )
    assert session["session_id"] == sid
    assert session["context"] == {}
    assert session["capture_prompts"] is True
    assert not session["ended"]
    silent = datetime.fromisoformat(session["started_at"]) - datetime.fromisoformat(
        session["last_seen_at"]
    )
    assert timedelta(minutes=29) < silent < timedelta(minutes=31)

    (event,) = fixtures.query_rows(
        "SELECT * FROM events WHERE session_id = :'sid'::uuid", sid=sid
    )
    assert event["has_content"] is False
    assert event["payload"] == {"close_reason": "orphan_timeout"}
    reason = fixtures.exec_sql(
        "SELECT payload->>'close_reason' FROM events WHERE session_id = :'sid'::uuid",
        sid=sid,
    )
    assert reason == "orphan_timeout"


def test_directive_helpers_read_the_directives_table(sqlite_db: pathlib.Path) -> None:
    sid = str(uuid.uuid4())
    fixtures.exec_sql(
        "INSERT INTO directives (session_id, flavor, action, reason, issued_by)"
        " VALUES (:'sid'::uuid, :'flavor', 'shutdown', 'test', 'policy_evaluator')",
        sid=sid,
        flavor="sql-helpers",
    )
    (directive,) = fixtures.query_directives(sid)
    assert directive["action"] == "shutdown"
    assert directive["delivered_at"] is None
    assert not fixtures.directive_has_delivered_at(directive["id"])
    fixtures.exec_sql(
        "UPDATE directives SET delivered_at = NOW() WHERE id = :'id'::uuid",
        id=directive["id"],
    )
    assert fixtures.directive_has_delivered_at(directive["id"])


def test_drifted_agent_round_trip(sqlite_db: pathlib.Path) -> None:
    agent_id = fixtures.create_drifted_agent(
        agent_name=f"sql-helpers-{uuid.uuid4().hex[:8]}",
        actual_sessions=3,
        actual_tokens_per_session=7,
        counter_overrides={
            "total_sessions": 99,
            "first_seen_at": "2026-01-02T03:04:05Z",
        },
        last_seen_in_future=True,
    )
    rollup = fixtures.get_agent_rollup(agent_id)
    assert rollup is not None
    assert rollup["total_sessions"] == 99
    assert rollup["total_tokens"] == 3 * 7 + 999_999
    assert rollup["first_seen_at"] == "2026-01-02T03:04:05.000Z"
    assert datetime.fromisoformat(rollup["last_seen_at"]) > datetime.now(UTC)
    assert len(_session_ids(agent_id)) == 3

    fixtures.delete_drifted_agent(agent_id)
    assert fixtures.get_agent_rollup(agent_id) is None
    assert _session_ids(agent_id) == []


def test_flavor_cleanup_removes_only_the_flavors_agents(
    sqlite_db: pathlib.Path,
) -> None:
    """The agent whose every session carries the flavor goes with them;
    one that another flavor's session still references stays."""
    only = fixtures.create_drifted_agent(
        agent_name=f"sql-helpers-only-{uuid.uuid4().hex[:8]}", actual_sessions=2
    )
    shared = fixtures.create_drifted_agent(
        agent_name=f"sql-helpers-shared-{uuid.uuid4().hex[:8]}", actual_sessions=2
    )
    kept_session = _session_ids(shared)[0]
    fixtures.exec_sql(
        "UPDATE sessions SET flavor = 'sql-helpers-other' WHERE session_id = :'sid'::uuid",
        sid=kept_session,
    )

    fixtures.delete_flavor_data("drift-test-flavor")

    assert fixtures.get_agent_rollup(only) is None
    assert fixtures.get_agent_rollup(shared) is not None
    assert _session_ids(shared) == [kept_session]
    assert _session_ids(only) == []


def test_several_sqlite_statements_apply_together_or_not_at_all(
    sqlite_db: pathlib.Path,
) -> None:
    agent_id = fixtures.create_drifted_agent(
        agent_name=f"sql-helpers-{uuid.uuid4().hex[:8]}", actual_sessions=1
    )
    with pytest.raises(sqlite3.IntegrityError):
        fixtures.exec_sql(
            "SELECT 1",
            sqlite=(
                "UPDATE agents SET total_tokens = 1 WHERE agent_id = :aid",
                # Refused: the agent's session still references it.
                "DELETE FROM agents WHERE agent_id = :aid",
            ),
            aid=agent_id,
        )
    rollup = fixtures.get_agent_rollup(agent_id)
    assert rollup is not None and rollup["total_tokens"] != 1


def test_row_locks_are_refused(sqlite_db: pathlib.Path) -> None:
    with (
        pytest.raises(RuntimeError, match="postgres_only"),
        fixtures.session_row_locked(str(uuid.uuid4())),
    ):
        pass


def test_a_stack_on_sqlite_names_no_postgres_container() -> None:
    """The seeder's psql calls have no SQLite path; with the container
    name blank docker refuses them, so they cannot reach the dev
    stack's database."""
    if fixtures.SQLITE_DB:
        assert fixtures.POSTGRES_CONTAINER == ""
    else:
        assert fixtures.POSTGRES_CONTAINER


@pytest.mark.parametrize(
    ("base_url", "test_db", "sqlite_db", "refused_for"),
    [
        # The dev stack with its defaults, however it is spelled.
        ("http://localhost:4000", "", "", None),
        ("http://localhost:4000/", "", "", None),
        ("http://127.0.0.1:4000", "", "", None),
        # The binary with its database named.
        ("http://localhost:4100", "fd_my_db", "", None),
        ("http://localhost:4100", "", "/tmp/fd/data/flightdeck.db", None),
        ("http://localhost:4000", "", "/tmp/fd/data/flightdeck.db", None),
        # The binary with no database named: the helpers would write to
        # the dev stack's database.
        ("http://localhost:4100", "", "", "neither"),
        ("http://127.0.0.1:4110/", "", "", "neither"),
        ("http://example.test:4000", "", "", "neither"),
        # Two databases named for one stack.
        ("http://localhost:4100", "fd_my_db", "/tmp/fd/data/flightdeck.db", "both set"),
    ],
)
def test_a_stack_that_is_not_the_dev_stack_must_name_its_database(
    base_url: str, test_db: str, sqlite_db: str, refused_for: str | None
) -> None:
    error = fixtures.stack_configuration_error(base_url, test_db, sqlite_db)
    if refused_for is None:
        assert error is None
        return
    assert error is not None
    assert refused_for in error
    assert "FLIGHTDECK_TEST_DB" in error
    assert "FLIGHTDECK_TEST_SQLITE_DB" in error


def test_the_dev_stacks_worker_container_is_the_default_only_on_the_dev_stack() -> None:
    """A run against the binary that sets no worker container must not
    reach the dev stack's: the pause tests would pause its worker."""
    assert (
        fixtures.default_worker_container("http://localhost:4000") == "docker-workers-1"
    )
    assert (
        fixtures.default_worker_container("http://127.0.0.1:4000/")
        == "docker-workers-1"
    )
    assert fixtures.default_worker_container("http://localhost:4100") == ""
    assert fixtures.default_worker_container("http://localhost:4110/") == ""
    if fixtures.BASE_URL not in fixtures.DEV_STACK_BASE_URLS:
        # This run is against the binary: whatever the environment set,
        # the name is not the dev stack's.
        assert fixtures.WORKER_CONTAINER != fixtures.DEV_STACK_WORKER_CONTAINER


def test_a_missing_database_file_is_not_created(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "absent.db"
    monkeypatch.setattr(fixtures, "SQLITE_DB", str(missing))
    with pytest.raises(sqlite3.OperationalError):
        fixtures.exec_sql("SELECT 1")
    assert not missing.exists()
