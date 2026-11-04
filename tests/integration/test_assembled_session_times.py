"""Integration tests for how the worker dates an assembled session.

A session assembled from an OpenTelemetry trace (its ``session_start``
``context`` carries ``otel_trace_id``) reaches the worker after the run
it describes, so its row takes ``started_at`` and ``ended_at`` from its
own start and end, capped at the worker's clock; a re-attachment for
late records keeps the run's start. Every other session is dated by the
worker's clock. Nothing emits such sessions yet, so these tests post
synthetic events through the ingestion API to the live worker. Requires
the dev stack.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from .conftest import exec_sql, make_event, post_event, wait_until

# Room for the worker to process a handful of events on a loaded runner
# (well under a second on the dev stack).
PROCESSING_TIMEOUT_SECS = 15.0

# The tokens each synthetic post_call carries.
CALL_TOKENS = 7


def _iso(ts: datetime) -> str:
    """RFC 3339 with microseconds, the precision Postgres stores."""
    return ts.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _ago(minutes: float) -> datetime:
    return datetime.now(UTC) - timedelta(minutes=minutes)


def _db_now() -> str:
    return exec_sql("SELECT clock_timestamp()")


class _Run:
    """One synthetic session and its own agent, deleted by id afterwards."""

    def __init__(self, assembled: bool) -> None:
        self.sid = str(uuid.uuid4())
        self.assembled = assembled
        self.flavor = f"assembled-times-{uuid.uuid4().hex[:6]}"
        self.agent_name = f"assembled-times/{self.flavor}"
        self.agent_id = ""
        self.trace_id = uuid.uuid4().hex

    def post(self, event_type: str, ts: datetime, **extra: Any) -> None:
        if self.assembled and event_type == "session_start":
            extra.setdefault(
                "context",
                {
                    "telemetry": "otlp",
                    "otel_trace_id": self.trace_id,
                    "otel_span_id": self.trace_id[:16],
                },
            )
        payload = make_event(
            self.sid,
            self.flavor,
            event_type,
            agent_type="production",
            client_type="otlp" if self.assembled else "flightdeck_sensor",
            agent_name=self.agent_name,
            timestamp=_iso(ts),
            **extra,
        )
        self.agent_id = payload["agent_id"]
        post_event(payload)

    def call(self, ts: datetime) -> None:
        self.post(
            "post_call",
            ts,
            model="claude-sonnet-4-6",
            tokens_input=CALL_TOKENS - 2,
            tokens_output=2,
            tokens_total=CALL_TOKENS,
        )

    def row(self) -> dict[str, str]:
        out = exec_sql(
            "SELECT state, tokens_used, started_at, COALESCE(ended_at::text, '') "
            "FROM sessions WHERE session_id = :'sid'::uuid",
            sid=self.sid,
        )
        if not out:
            return {}
        state, tokens, started, ended = out.split("|")
        return {
            "state": state,
            "tokens": tokens,
            "started_at": started,
            "ended_at": ended,
        }

    def wait_closed(self, tokens: int) -> dict[str, str]:
        wait_until(
            lambda: (
                self.row().get("state") == "closed"
                and self.row().get("tokens") == str(tokens)
            ),
            timeout=PROCESSING_TIMEOUT_SECS,
            msg=f"session {self.sid} closed with {tokens} tokens",
        )
        return self.row()

    def holds(self, column: str, op: str, value: str) -> bool:
        """Whether ``<column> <op> value`` holds on the row, compared in SQL."""
        assert column in {"started_at", "ended_at"} and op in {"=", "<=", ">="}
        return (
            exec_sql(
                f"SELECT ({column} {op} :'v'::timestamptz)::text FROM sessions WHERE session_id = :'sid'::uuid",
                v=value,
                sid=self.sid,
            )
            == "true"
        )

    def delete(self) -> None:
        for sql in (
            "DELETE FROM event_content WHERE session_id = :'id'::uuid",
            "DELETE FROM events WHERE session_id = :'id'::uuid",
            "DELETE FROM session_attachments WHERE session_id = :'id'::uuid",
            "DELETE FROM sessions WHERE session_id = :'id'::uuid",
        ):
            exec_sql(sql, id=self.sid)
        if self.agent_id:
            exec_sql(
                "DELETE FROM agents WHERE agent_id = :'id'::uuid", id=self.agent_id
            )


@pytest.fixture
def new_run() -> Iterator[Callable[[bool], _Run]]:
    runs: list[_Run] = []

    def make(assembled: bool) -> _Run:
        run = _Run(assembled)
        runs.append(run)
        return run

    yield make
    for run in runs:
        run.delete()


def test_assembled_session_takes_its_own_start_and_end(
    new_run: Callable[[bool], _Run],
) -> None:
    """A run published after it ended carries its own start and end."""
    run = new_run(True)
    start, end = _ago(12), _ago(10)
    run.post("session_start", start)
    run.call(_ago(11))
    run.post("session_end", end)
    run.wait_closed(CALL_TOKENS)

    assert run.holds("started_at", "=", _iso(start)), run.row()
    assert run.holds("ended_at", "=", _iso(end)), run.row()


def test_assembled_start_is_capped_at_the_workers_clock(
    new_run: Callable[[bool], _Run],
) -> None:
    """A start dated ahead of the worker's clock (inside the ingestion
    API's five-minute allowance) is dated by the clock."""
    run = new_run(True)
    run.post("session_start", datetime.now(UTC) + timedelta(minutes=2))
    run.post("session_end", datetime.now(UTC) + timedelta(minutes=2))
    run.wait_closed(0)
    after = _db_now()

    assert run.holds("started_at", "<=", after), run.row()
    assert run.holds("ended_at", "<=", after), run.row()


@pytest.mark.parametrize(
    "end_after_late", [False, True], ids=["original-end", "after-late-event"]
)
def test_reattached_assembled_session_keeps_its_start(
    new_run: Callable[[bool], _Run], end_after_late: bool
) -> None:
    """Late records arrive wrapped in a re-attaching start dated just
    before them and an end dated at the original end, or just after
    them when the original end is outside the validation window. The
    row keeps the run's start, counts the late call and ends where the
    re-attaching end says."""
    run = new_run(True)
    start, original_end, late = _ago(30), _ago(20), _ago(1)
    run.post("session_start", start)
    run.call(_ago(25))
    run.post("session_end", original_end)
    run.wait_closed(CALL_TOKENS)

    run.post("session_start", late - timedelta(microseconds=1))
    run.call(late)
    end = late + timedelta(microseconds=1) if end_after_late else original_end
    run.post("session_end", end)
    run.wait_closed(2 * CALL_TOKENS)

    assert run.holds("started_at", "=", _iso(start)), run.row()
    assert run.holds("ended_at", "=", _iso(end)), run.row()
    attachments = exec_sql(
        "SELECT COUNT(*) FROM session_attachments WHERE session_id = :'sid'::uuid",
        sid=run.sid,
    )
    assert attachments == "1", (
        f"attachments = {attachments}, want one for the re-attaching start"
    )


def test_other_sessions_are_dated_by_the_workers_clock(
    new_run: Callable[[bool], _Run],
) -> None:
    """The same events without otel_trace_id leave the worker's clock on
    the row, as before."""
    run = new_run(False)
    before = _db_now()
    run.post("session_start", _ago(12))
    run.call(_ago(11))
    run.post("session_end", _ago(10))
    run.wait_closed(CALL_TOKENS)
    after = _db_now()

    for column in ("started_at", "ended_at"):
        assert run.holds(column, ">=", before) and run.holds(column, "<=", after), (
            run.row()
        )
