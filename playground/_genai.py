"""OpenTelemetry GenAI playground plumbing.

The ``*_genai_*.py`` scripts run an agent framework with its own
OpenTelemetry instrumentation and no Flightdeck sensor: the framework's
OTLP exporter sends the run's spans (and Google ADK's log records) to
the dev stack's receiver, which stages them and assembles each trace
into sessions (ARCHITECTURE.md, OTLP ingest > GenAI dialect). This
module points the exporter at the stack and then reads back what the
receiver assembled.

``configure_exporter`` sets the environment every OpenTelemetry SDK
exporter reads, before the framework is imported: the endpoint, the
bearer token, and the ``flightdeck.*`` resource attributes that give
the sessions their identity and capture posture (rules 40a.A and 40a.B:
``agent_type=coding``, ``flavor=playground-genai-<framework>``,
``capture_prompts=true``). ``verify_subagent_run`` then polls the API
until the run's sessions are assembled and checks them.

Each framework is pinned at the versions its recording was made with
(``tests/otlp/requirements-genai*.txt`` with their constraints) and runs
from its own venv, outside the sensor's: Google ADK needs an older
OpenTelemetry SDK than the other three (see playground/README.md).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, NoReturn

from _helpers import API_TOKEN, API_URL, INGESTION_URL, print_result

FLAVOR_PREFIX = "playground-genai-"
AGENT_TYPE = "coding"
CLIENT_TYPE = "otlp"

# How long to wait for a run's sessions after its spans are flushed. A
# trace is assembled 3 s after its root span arrives, a Google ADK trace
# up to 30 s after it when a call's log record is late, and the worker
# then writes the events; 90 s is three times the slowest of those.
ASSEMBLY_DEADLINE_S = 90.0
# Poll gap: well under the 3 s assembly delay, light on the API.
ASSEMBLY_POLL_S = 1.0
# One API read never blocks longer than this, so the deadline above
# stays the only bound on the wait.
FETCH_TIMEOUT_S = 5.0
# The window the session query starts before the run: span timestamps
# come from this machine's clock, so a second covers rounding only.
SESSION_WINDOW_SLACK = timedelta(seconds=1)
# Each model request's client timeout. The calls here answer in 1-15 s;
# without a cap a stalled request waits the SDK default (600 s) and
# run_all's 180 s kill reports a bare timeout instead of the error.
MODEL_TIMEOUT_S = 60.0
# One retry: a stalled request that also stalls on its retry costs
# 2 x 60 s, which with the run's ~30 s of normal work stays under 180 s.
MODEL_MAX_RETRIES = 1


def configure_exporter(framework: str) -> str:
    """Point OpenTelemetry's OTLP exporters at the dev stack and return
    the run's flavor, ``playground-genai-<framework>``.

    Every ``OTEL_*`` variable the shell holds is dropped first, so a
    Claude Code telemetry setup in the environment cannot redirect or
    relabel the run. Call it before importing the framework: some read
    their switches at import.
    """
    flavor = FLAVOR_PREFIX + framework
    for name in [n for n in os.environ if n.startswith("OTEL_")]:
        del os.environ[name]
    os.environ.update(
        {
            # The exporters append /v1/traces and /v1/logs.
            "OTEL_EXPORTER_OTLP_ENDPOINT": INGESTION_URL,
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
            # The SDK URL-decodes header values, so the space after
            # Bearer (and anything else in the token) is encoded.
            "OTEL_EXPORTER_OTLP_HEADERS": "Authorization="
            + urllib.parse.quote(f"Bearer {API_TOKEN}"),
            "OTEL_SERVICE_NAME": flavor,
            "OTEL_RESOURCE_ATTRIBUTES": ",".join(
                (
                    f"flightdeck.agent_type={AGENT_TYPE}",
                    f"flightdeck.flavor={flavor}",
                    "flightdeck.capture_prompts=true",
                )
            ),
            # The OpenAI Agents instrumentation's and Google ADK's
            # content switch; Pydantic AI and Strands send content by
            # default.
            "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "true",
        }
    )
    return flavor


def skip_if_not_installed(exc: ImportError, packages: tuple[str, ...]) -> NoReturn:
    """Exit 2 (SKIP) when ``exc`` says one of the framework's own
    ``packages`` is not installed in this interpreter; re-raise any
    other import error. A package that is installed but fails to import
    (a missing dependency of its own, a name a release no longer has)
    is a broken venv, which must fail loudly rather than skip."""
    missing = (exc.name or "") if isinstance(exc, ModuleNotFoundError) else ""
    if not missing or not any(
        p == missing or p.startswith(missing + ".") for p in packages
    ):
        raise exc
    print(
        f"SKIP: {missing} is not installed in this interpreter; run with the "
        "framework's GenAI venv (playground/README.md, OpenTelemetry GenAI "
        "frameworks)"
    )
    sys.exit(2)


def install_tracer_provider() -> Callable[[], None]:
    """Set a global tracer provider exporting spans to the dev stack
    over OTLP/HTTP protobuf, under the resource the environment names,
    and return the function that flushes and shuts it down. Metrics are
    not exported: the receiver rejects them, since they repeat the
    spans' usage."""
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter,
    )
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create())
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)

    def flush() -> None:
        provider.force_flush()
        provider.shutdown()

    return flush


def run_started() -> datetime:
    """The time a run starts, for the session query's window."""
    return datetime.now(UTC)


@dataclass(frozen=True)
class SubagentRun:
    """What one agent-as-a-tool run must assemble into: a root session
    for ``root`` whose ``root_tool`` ran ``child``, a child session for
    ``child`` that called ``child_tool``, each with exactly its expected
    number of model calls (``post_call`` events). An exact count catches
    a receiver that counts a nested SDK span as a call of its own, or
    drops one."""

    flavor: str
    framework: str
    root: str
    root_tool: str
    child: str
    child_tool: str
    # The model calls each agent makes: the call that picks its tool and
    # the call that answers from the result, in every framework's run.
    root_calls: int
    child_calls: int
    # Google ADK records a tool's arguments and result only inside the
    # next model call's messages, and no content on its agent spans, so
    # its tool_calls carry no content and its child agent no incoming
    # message (the child's input is the parent tool's arguments).
    tool_content: bool = True


def _get(path: str) -> tuple[int, Any]:
    req = urllib.request.Request(
        f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as exc:
        return exc.code, None


def _list_sessions(flavor: str, since: datetime) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode(
        {
            "flavor": flavor,
            "client_type": CLIENT_TYPE,
            "from": (since - SESSION_WINDOW_SLACK).isoformat().replace("+00:00", "Z"),
            "limit": 100,
        }
    )
    status, body = _get(f"/v1/sessions?{query}")
    if status != 200:
        raise RuntimeError(f"GET /v1/sessions -> {status}")
    return list(body.get("sessions") or [])


def _events(session_id: str) -> list[dict[str, Any]]:
    status, body = _get(f"/v1/sessions/{session_id}")
    if status != 200:
        raise RuntimeError(f"GET /v1/sessions/{session_id} -> {status}")
    return list(body.get("events") or [])


def _of(events: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [e for e in events if e.get("event_type") == kind]


Check = tuple[str, bool, str]


def _session_checks(
    run: SubagentRun, rows: list[dict[str, Any]]
) -> tuple[list[Check], dict[str, Any] | None, dict[str, Any] | None]:
    """The checks on the session rows, and the root and child rows."""
    root_name = f"{run.flavor}/{run.root}"
    child_name = f"{root_name}/{run.child}"
    named = {r.get("agent_name"): r for r in rows}
    root, child = named.get(root_name), named.get(child_name)
    checks: list[Check] = [
        (
            "two sessions, root and child",
            len(rows) == 2 and root is not None and child is not None,
            f"agent_names={sorted(str(n) for n in named)}",
        )
    ]
    if root is None or child is None:
        return checks, root, child
    label = f"{run.framework}/"
    identity = [
        f"{r['agent_name']}: {k}={r.get(k)!r}"
        for r in (root, child)
        for k, want in (
            ("flavor", run.flavor),
            ("client_type", CLIENT_TYPE),
            ("agent_type", AGENT_TYPE),
            ("capture_enabled", True),
            ("state", "closed"),
        )
        if r.get(k) != want
    ]
    identity += [
        f"{r['agent_name']}: frameworks={(r.get('context') or {}).get('frameworks')!r}"
        for r in (root, child)
        if not any(
            str(f) == run.framework or str(f).startswith(label)
            for f in (r.get("context") or {}).get("frameworks") or []
        )
    ]
    checks.append(
        (
            "identity: flavor, client_type=otlp, agent_type=coding, capture on, closed",
            not identity,
            "; ".join(identity) or f"frameworks={root['context'].get('frameworks')}",
        )
    )
    trace_ids = {(r.get("context") or {}).get("otel_trace_id") for r in (root, child)}
    checks.append(
        (
            "parent/child: child names the root, role is the child agent",
            root.get("parent_session_id") is None
            and child.get("parent_session_id") == root["session_id"]
            and child.get("agent_role") == run.child
            and len(trace_ids) == 1,
            (
                f"root={root['session_id']} child.parent="
                f"{child.get('parent_session_id')} role={child.get('agent_role')!r}"
                f" traces={len(trace_ids)}"
            ),
        )
    )
    return checks, root, child


def _event_checks(
    run: SubagentRun,
    root: dict[str, Any],
    child: dict[str, Any],
    by_session: dict[str, list[dict[str, Any]]],
) -> list[Check]:
    checks: list[Check] = []
    token_problems: list[str] = []
    counts: list[str] = []
    count_problems: list[str] = []
    for row, want in ((root, run.root_calls), (child, run.child_calls)):
        events = by_session[row["session_id"]]
        calls = _of(events, "post_call")
        total = sum(int(e.get("tokens_total") or 0) for e in calls)
        counts.append(f"{row['agent_name'].rsplit('/', 1)[-1]}={len(calls)}")
        if len(calls) != want:
            count_problems.append(
                f"{row['agent_name']}: {len(calls)} post_calls, want {want}"
            )
        if not calls:
            token_problems.append(f"{row['agent_name']}: no post_call")
        token_problems += [
            f"{row['agent_name']}: {e['id']} tokens {e.get('tokens_input')}/"
            f"{e.get('tokens_output')}"
            for e in calls
            if not (e.get("tokens_input") or 0) > 0
            or not (e.get("tokens_output") or 0) > 0
        ]
        if row.get("tokens_used", 0) <= 0 or row.get("tokens_used") != total:
            token_problems.append(
                f"{row['agent_name']}: tokens_used={row.get('tokens_used')} "
                f"post_call sum={total}"
            )
        if not _of(events, "session_end"):
            token_problems.append(f"{row['agent_name']}: no session_end")
    checks.append(
        (
            f"model calls: {run.root_calls} on the root, {run.child_calls} on the child",
            not count_problems,
            "; ".join(count_problems) or ", ".join(counts),
        )
    )
    checks.append(
        (
            "tokens > 0 on every post_call, tokens_used is their sum",
            not token_problems,
            "; ".join(token_problems)
            or ", ".join(
                f"{r['agent_name'].rsplit('/', 1)[-1]}={r['tokens_used']}"
                for r in (root, child)
            ),
        )
    )
    tools = {
        sid: sorted(str(e.get("tool_name")) for e in _of(events, "tool_call"))
        for sid, events in by_session.items()
    }
    checks.append(
        (
            f"tool calls: {run.root_tool} on the root, {run.child_tool} on the child",
            run.root_tool in tools[root["session_id"]]
            and run.child_tool in tools[child["session_id"]],
            f"root={tools[root['session_id']]} child={tools[child['session_id']]}",
        )
    )
    return checks


def _content_checks(
    run: SubagentRun,
    root: dict[str, Any],
    child: dict[str, Any],
    by_session: dict[str, list[dict[str, Any]]],
) -> list[Check]:
    """GET /v1/events/:id/content answers 200 with the call's messages
    for every post_call; where the framework records tool arguments, the
    child's tool call has content too and the child's start carries its
    incoming message."""
    problems: list[str] = []
    fetched = 0
    targets = [
        e
        for row in (root, child)
        for e in _of(by_session[row["session_id"]], "post_call")
    ]
    if run.tool_content:
        targets += [
            e
            for e in _of(by_session[child["session_id"]], "tool_call")
            if e.get("tool_name") == run.child_tool
        ]
    for e in targets:
        status, body = _get(f"/v1/events/{e['id']}/content")
        fetched += 1
        if status != 200 or not body:
            problems.append(f"{e['event_type']} {e['id']}: {status}")
        elif e["event_type"] == "post_call" and not (
            body.get("provider") == "otel_genai"
            and (body.get("messages") or body.get("response"))
        ):
            problems.append(
                f"post_call {e['id']}: provider={body.get('provider')!r},"
                " no messages or response"
            )
        elif e["event_type"] == "tool_call" and body.get("tool_input") is None:
            problems.append(f"tool_call {e['id']}: no tool_input")
    starts = _of(by_session[child["session_id"]], "session_start")
    if run.tool_content and not any(
        (s.get("payload") or {}).get("incoming_message") for s in starts
    ):
        problems.append("child session_start has no incoming_message")
    return [
        (
            "content: GET /v1/events/:id/content 200 per call"
            + (", the child's tool and incoming message" if run.tool_content else ""),
            not problems,
            "; ".join(problems) or f"{fetched} events read",
        )
    ]


def _evaluate(run: SubagentRun, since: datetime) -> list[Check]:
    try:
        rows = _list_sessions(run.flavor, since)
    except (OSError, RuntimeError, ValueError) as exc:
        return [("sessions listed", False, repr(exc))]
    checks, root, child = _session_checks(run, rows)
    if root is None or child is None or not all(ok for _, ok, _ in checks):
        return checks
    try:
        by_session = {r["session_id"]: _events(r["session_id"]) for r in (root, child)}
    except (OSError, RuntimeError, ValueError) as exc:
        return [*checks, ("session events read", False, repr(exc))]
    checks += _event_checks(run, root, child, by_session)
    if not all(ok for _, ok, _ in checks):
        return checks
    return checks + _content_checks(run, root, child, by_session)


def verify_subagent_run(run: SubagentRun, since: datetime) -> None:
    """Poll until the run's sessions satisfy every check or the deadline
    passes, print one PASS/FAIL line per check, and raise on a FAIL."""
    t0 = time.monotonic()
    deadline = t0 + ASSEMBLY_DEADLINE_S
    while True:
        checks = _evaluate(run, since)
        if all(ok for _, ok, _ in checks) or time.monotonic() > deadline:
            break
        time.sleep(ASSEMBLY_POLL_S)
    waited_ms = int((time.monotonic() - t0) * 1000)
    for i, (label, ok, detail) in enumerate(checks):
        print_result(label, ok, waited_ms if i == 0 else 0, detail)
    failed = [label for label, ok, _ in checks if not ok]
    if failed:
        raise AssertionError(f"{run.flavor}: failed checks {failed}")
