"""Recorded Claude Code OTLP exports land as the OTLP ingest contract says.

Each test replays one recorded scenario (tests/fixtures/otlp/
claude-code-2.1.316) into the live stack, as Claude Code sent it
(protobuf gzipped, or OTLP JSON), with a fresh Claude Code session id,
timestamps moved to the moment of the replay and a flavor of its own
(``flightdeck.flavor``, as an operator sets it), then reads the sessions
and events back through the query API: the session ids derived from the
Claude Code session, the parent/child link of a sub-agent, tokens and
the agent-reported cost, the capture contract of
``GET /v1/events/:id/content`` and the dedupe of a session the plugin
already reports. Expected values come from the fixtures, not from the
receiver.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from ..otlp.replay import is_mapped, latest_time_ns, record_attributes, rewrite_logs
from .conftest import (
    API_URL,
    INGESTION_URL,
    TOKEN,
    auth_headers,
    delete_flavor_data,
    get_session_detail,
    make_event,
    post_event,
    session_events,
    wait_until,
)

FIXTURES = (
    Path(__file__).resolve().parents[1] / "fixtures" / "otlp" / "claude-code-2.1.316"
)
NAMESPACE_FLIGHTDECK = uuid.UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")
JSON = "application/json"
PROTOBUF = "application/x-protobuf"

# How long a replayed session may take to show all its events: the
# worker drains the bus in well under a second on an idle stack; the
# ceiling absorbs a loaded CI runner.
LAND_TIMEOUT_SECS = 30.0


def otlp_session_id(claude_code_session_id: str, agent_id: str = "") -> str:
    name = f"flightdeck://otlp/claude-code/session/{claude_code_session_id}"
    if agent_id:
        name += f"/{agent_id}"
    return str(uuid.uuid5(NAMESPACE_FLIGHTDECK, name))


def _log_requests(scenario: str) -> list[dict[str, Any]]:
    manifest = json.loads((FIXTURES / scenario / "manifest.json").read_text())
    return [
        {**r, "body": (FIXTURES / scenario / r["file"]).read_bytes()}
        for r in manifest["requests"]
        if r["path"] == "/v1/logs"
    ]


def _post_logs(body: bytes, content_type: str, gzipped: bool) -> tuple[int, bytes]:
    headers = {"Content-Type": content_type, "Authorization": f"Bearer {TOKEN}"}
    if gzipped:
        body = gzip.compress(body)
        headers["Content-Encoding"] = "gzip"
    req = urllib.request.Request(
        f"{INGESTION_URL}/v1/logs", data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _rejected(content_type: str, body: bytes) -> tuple[int, str]:
    """(rejected log records, message) of an export response."""
    if content_type == JSON:
        ps = json.loads(body).get("partialSuccess", {})
        return int(ps.get("rejectedLogRecords", 0)), ps.get("errorMessage", "")
    from ..otlp.fixture_checks import _fields

    rejected, message = 0, ""
    for n, _w, partial in _fields(body):
        if n != 1:
            continue
        for n2, _w2, value in _fields(partial):
            if n2 == 1:
                rejected = value
            elif n2 == 2:
                message = bytes(value).decode()
    return rejected, message


class Replay:
    """One replay of a scenario under a fresh Claude Code session id."""

    def __init__(self, scenario: str, flavor: str, **resource_attrs: str) -> None:
        self.scenario = scenario
        self.claude_code_session_id = str(uuid.uuid4())
        self.session_id = otlp_session_id(self.claude_code_session_id)
        self.requests = _log_requests(scenario)
        self.attrs = {"flightdeck.flavor": flavor, **resource_attrs}
        records = [
            a
            for r in self.requests
            for a in record_attributes(r["content_type"], r["body"])
        ]
        self.mapped = [a for a in records if is_mapped(a)]
        self.unmapped = len(records) - len(self.mapped)
        self.rejected = 0
        self.messages: list[str] = []
        self.shift_ns: int | None = None

    def send(self, first: int = 0, last: int | None = None) -> Replay:
        """POST the scenario's log requests ``[first:last]``. Every send
        of one replay moves the records by the same shift, taken at the
        first send so the last record lands a second before it, inside
        the validation window."""
        if self.shift_ns is None:
            latest = latest_time_ns(
                [(r["content_type"], r["body"]) for r in self.requests]
            )
            self.shift_ns = time.time_ns() - latest - 1_000_000_000
        for r in self.requests[first:last]:
            self.post(r["content_type"], r["body"], r.get("sent_encoding") == "gzip")
        return self

    def post(self, content_type: str, body: bytes, gzipped: bool = False) -> None:
        """POST one log export of the scenario, rewritten as send does."""
        assert self.shift_ns is not None, "send the replay first"
        body = rewrite_logs(
            content_type,
            body,
            session_id=self.claude_code_session_id,
            shift_ns=self.shift_ns,
            resource_attrs=self.attrs,
        )
        status, resp = _post_logs(body, content_type, gzipped)
        assert status == 200, resp
        rejected, message = _rejected(content_type, resp)
        self.rejected += rejected
        if message:
            self.messages.append(message)

    def count(self, name: str) -> int:
        return sum(1 for a in self.mapped if a.get("event.name") == name)


def _events_when(session_id: str, ready: Any) -> list[dict[str, Any]]:
    """The session's events once ``ready(events)`` holds."""
    found: list[dict[str, Any]] = []

    def check() -> bool:
        try:
            found[:] = session_events(get_session_detail(session_id))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return False
            raise
        return bool(ready(found))

    wait_until(check, timeout=LAND_TIMEOUT_SECS, msg=f"events of {session_id}")
    return found


def _of(events: list[dict[str, Any]], event_type: str) -> list[dict[str, Any]]:
    return [e for e in events if e["event_type"] == event_type]


def _content_status(event_id: str) -> tuple[int, dict[str, Any] | None]:
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers()
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, None


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"otlp-it-{uuid.uuid4().hex[:10]}"
    yield name
    delete_flavor_data(name)


def test_bash_export_lands_as_a_claude_code_session(flavor: str) -> None:
    replay = Replay("bash-json-prompts", flavor).send()
    assert replay.rejected == replay.unmapped, replay.messages
    posts = replay.count("api_request")
    events = _events_when(
        replay.session_id, lambda ev: len(_of(ev, "post_call")) == posts
    )

    session = get_session_detail(replay.session_id)["session"]
    assert session["client_type"] == "claude_code"
    assert session["agent_type"] == "coding"
    assert session["flavor"] == flavor
    assert session["capture_enabled"] is False
    ctx = session["context"]
    assert ctx["claude_code_session_id"] == replay.claude_code_session_id
    assert ctx["telemetry"] == "otlp"
    assert ctx["supports_directives"] is False

    assert [e["event_type"] for e in events].count("session_start") == 1
    assert len(_of(events, "pre_call")) == replay.count("user_prompt")
    assert len(_of(events, "tool_call")) == replay.count("tool_result")
    denied = _of(events, "session_signal")
    assert len(denied) == 1
    assert denied[0]["payload"]["signal"] == "permission_denied"
    assert set(denied[0]["payload"]["signal_data"]) == {
        "tool_name",
        "tool_use_id",
        "reason",
    }

    first = next(a for a in replay.mapped if a.get("event.name") == "api_request")
    call = next(
        e
        for e in _of(events, "post_call")
        if e["payload"]["provider_metadata"]["request_id"] == first["request_id"]
    )
    # The bash recording's first model call: 10 uncached input tokens,
    # 14595 cache reads, 7474 cache writes (all 1-hour), 155 output.
    assert call["tokens_input"] == 10 + 14595 + 7474
    assert call["tokens_output"] == 155
    assert call["tokens_total"] == 10 + 14595 + 7474 + 155
    assert call["tokens_cache_read"] == 14595
    assert call["tokens_cache_creation"] == 7474
    assert call["payload"]["tokens_cache_creation_1h"] == 7474
    assert call["cost_source"] == "agent"
    assert call["cost_reported"] == pytest.approx(0.0171925)
    assert call["billing_mode"] == "subscription"
    assert call["provider"] == "anthropic"
    assert call["payload"]["streaming"] == {
        "ttft_ms": 1062,
        "final_outcome": "completed",
    }

    # Capture is off unless the exporter declares it: no event stores
    # content and the content endpoint answers 404.
    for event in events:
        assert event["has_content"] is False
    assert _content_status(_of(events, "pre_call")[0]["id"])[0] == 404


def test_protobuf_gzip_export_lands_the_same(flavor: str) -> None:
    replay = Replay("bash-protobuf-gzip", flavor).send()
    assert replay.rejected == replay.unmapped, replay.messages
    events = _events_when(
        replay.session_id,
        lambda ev: len(_of(ev, "post_call")) == replay.count("api_request"),
    )
    assert len(_of(events, "pre_call")) == 1
    assert len(_of(events, "tool_call")) == 1
    assert len(_of(events, "session_signal")) == 1
    assert all(e["cost_source"] == "agent" for e in _of(events, "post_call"))


def test_subagent_is_a_child_session_ended_by_subagent_completed(flavor: str) -> None:
    replay = Replay("subagent-json", flavor).send()
    agent_id = next(a["agent_id"] for a in replay.mapped if a.get("agent_id"))
    child_id = otlp_session_id(replay.claude_code_session_id, agent_id)

    child_events = _events_when(child_id, lambda ev: len(_of(ev, "session_end")) == 1)
    child = get_session_detail(child_id)["session"]
    assert child["parent_session_id"] == replay.session_id
    assert child["agent_role"] == "general-purpose"
    wait_until(
        lambda: get_session_detail(child_id)["session"]["state"] == "closed",
        timeout=LAND_TIMEOUT_SECS,
        msg="child closed by subagent_completed",
    )
    child_calls = [
        a
        for a in replay.mapped
        if a.get("agent_id") and a.get("event.name") == "api_request"
    ]
    assert len(_of(child_events, "post_call")) == len(child_calls)
    assert len(_of(child_events, "tool_call")) == 1

    root_calls = replay.count("api_request") - len(child_calls)
    parent_events = _events_when(
        replay.session_id, lambda ev: len(_of(ev, "post_call")) == root_calls
    )
    # The Agent tool's own result stays a tool_call on the parent.
    assert [e["tool_name"] for e in _of(parent_events, "tool_call")] == ["Agent"]
    parent = get_session_detail(replay.session_id)["session"]
    assert parent["state"] != "closed"
    assert parent.get("parent_session_id") in (None, "")


def test_capture_on_serves_prompt_and_tool_input(flavor: str) -> None:
    replay = Replay("mcp-json", flavor, **{"flightdeck.capture_prompts": "true"}).send()
    events = _events_when(
        replay.session_id, lambda ev: len(_of(ev, "mcp_tool_call")) == 1
    )
    assert get_session_detail(replay.session_id)["session"]["capture_enabled"] is True

    pre = _of(events, "pre_call")[0]
    status, content = _content_status(pre["id"])
    assert status == 200, content
    assert content is not None
    prompt = next(
        a["prompt"] for a in replay.mapped if a.get("event.name") == "user_prompt"
    )
    assert content["messages"] == [{"role": "user", "content": prompt}]

    mcp = _of(events, "mcp_tool_call")[0]
    assert mcp["tool_name"] == "echo"
    assert mcp["payload"]["server_name"] == "flightdeck-mcp-reference"
    status, content = _content_status(mcp["id"])
    assert status == 200, content
    assert content is not None
    assert content["tool_input"] == {"text": "hi"}


def test_api_error_is_an_llm_error_without_its_text(flavor: str) -> None:
    replay = Replay("api-error-json", flavor).send()
    events = _events_when(replay.session_id, lambda ev: len(_of(ev, "llm_error")) == 1)
    error = _of(events, "llm_error")[0]["payload"]["error"]
    assert error["error_type"] == "not_found"
    assert error["http_status"] == 404
    assert error["error_message"] == "Claude Code API error (HTTP 404)"
    assert "terminal" not in _of(events, "llm_error")[0]["payload"]


def test_session_the_plugin_reports_is_not_reported_again(flavor: str) -> None:
    replay = Replay("bash-json-prompts", flavor)
    plugin_session = str(uuid.uuid4())
    post_event(
        make_event(
            plugin_session,
            flavor,
            "session_start",
            agent_type="coding",
            client_type="claude_code",
            context={"claude_code_session_id": replay.claude_code_session_id},
        )
    )
    wait_until(
        lambda: _session_exists(plugin_session),
        timeout=LAND_TIMEOUT_SECS,
        msg="plugin session stored",
    )

    replay.send()
    mapped = len(replay.mapped)
    assert replay.rejected == replay.unmapped + mapped
    assert any("reported by another Flightdeck client" in m for m in replay.messages)
    assert not _session_exists(replay.session_id)
    assert len(session_events(get_session_detail(plugin_session))) == 1


def _session_exists(session_id: str) -> bool:
    try:
        get_session_detail(session_id)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def _state(session_id: str) -> str:
    """The session's state, or "" while it has no row."""
    try:
        return str(get_session_detail(session_id)["session"]["state"])
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return ""
        raise


def _typed_records(replay: Replay) -> list[dict[str, Any]]:
    """Every attribute of each log record of a JSON scenario, typed as the
    fixture holds it (Claude Code sends token counts as numbers), with the
    record's recorded time as ``timeUnixNano``."""
    out = []
    for r in replay.requests:
        assert r["content_type"] == JSON, r["file"]
        for rl in json.loads(r["body"]).get("resourceLogs", []):
            for sl in rl.get("scopeLogs", []):
                for rec in sl.get("logRecords", []):
                    attrs: dict[str, Any] = {
                        kv["key"]: next(iter(kv["value"].values()), None)
                        if kv.get("value")
                        else None
                        for kv in rec.get("attributes", [])
                    }
                    attrs["timeUnixNano"] = int(rec["timeUnixNano"])
                    out.append(attrs)
    return out


def _call_tokens(call: dict[str, Any]) -> int:
    """A recorded model call's tokens as the contract counts them: its
    input (uncached, cache reads and cache writes) plus its output."""
    return sum(
        int(call[k])
        for k in (
            "input_tokens",
            "cache_read_tokens",
            "cache_creation_tokens",
            "output_tokens",
        )
    )


def _sub_agent(records: list[dict[str, Any]], event_name: str) -> list[dict[str, Any]]:
    return [
        a for a in records if a.get("agent_id") and a.get("event.name") == event_name
    ]


def _child_call_export(
    replay: Replay, agent_id: str, at_ns: int, sequence: int
) -> bytes:
    """A JSON log export holding a copy of the sub-agent's last recorded
    model call, dated ``at_ns`` (recorded time, before the replay's shift)
    under a new ``event.sequence``, so it is a record of its own."""
    for r in reversed(replay.requests):
        for rl in json.loads(r["body"])["resourceLogs"]:
            for sl in rl["scopeLogs"]:
                for rec in reversed(sl["logRecords"]):
                    attrs = {kv["key"]: kv["value"] for kv in rec["attributes"]}
                    if attrs.get("agent_id") == {"stringValue": agent_id} and attrs.get(
                        "event.name"
                    ) == {"stringValue": "api_request"}:
                        rec["timeUnixNano"] = rec["observedTimeUnixNano"] = str(at_ns)
                        for kv in rec["attributes"]:
                            if kv["key"] == "event.sequence":
                                kv["value"] = {"intValue": sequence}
                        export = {
                            "resourceLogs": [
                                {
                                    "resource": rl["resource"],
                                    "scopeLogs": [
                                        {"scope": sl["scope"], "logRecords": [rec]}
                                    ],
                                }
                            ]
                        }
                        return json.dumps(export).encode()
    raise AssertionError(f"no model call of {agent_id} in {replay.scenario}")


def _children(parent_session_id: str) -> list[str]:
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?parent_session_id={parent_session_id}",
        headers=auth_headers(),
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return [s["session_id"] for s in json.loads(resp.read())["sessions"]]


def test_resumed_subagent_re_attaches_its_child_and_counts_its_tokens(
    flavor: str,
) -> None:
    """The recorded SendMessage resume: the sub-agent's second run, dated
    after the subagent_completed that closed its child session,
    re-attaches that same row, and the worker adds the second run's
    tokens to tokens_used. Claude Code exports the resumed run seconds
    after the end (4.5 s in the recording), by when the worker has closed
    the child, so the replay waits for that close before sending the
    rest. A late copy of a call, dated before the end, then leaves the
    child closed; the same call dated after the end re-attaches it."""
    replay = Replay("subagent-resume-json", flavor)
    records = _typed_records(replay)
    calls = _sub_agent(records, "api_request")
    ends = _sub_agent(records, "subagent_completed")
    agent_id = calls[0]["agent_id"]
    assert len(ends) == 2 and len(calls) == 4
    assert {a["agent_id"] for a in calls + ends} == {agent_id}
    child_id = otlp_session_id(replay.claude_code_session_id, agent_id)

    first_end = next(
        i
        for i, r in enumerate(replay.requests)
        if any(
            a.get("event.name") == "subagent_completed"
            for a in record_attributes(r["content_type"], r["body"])
        )
    )
    replay.send(last=first_end + 1)
    wait_until(
        lambda: _state(child_id) == "closed",
        timeout=LAND_TIMEOUT_SECS,
        msg="first run's end closes the child",
    )
    replay.send(first=first_end + 1)
    assert replay.rejected == replay.unmapped, replay.messages

    events = _events_when(
        child_id,
        lambda ev: len(_of(ev, "session_end")) == 2 and len(_of(ev, "post_call")) == 4,
    )
    wait_until(
        lambda: _state(child_id) == "closed",
        timeout=LAND_TIMEOUT_SECS,
        msg="second run's end closes the child",
    )
    detail = get_session_detail(child_id)
    both_runs = sum(_call_tokens(c) for c in calls)
    assert detail["session"]["tokens_used"] == both_runs, (
        f"tokens_used {detail['session']['tokens_used']}, the two runs' calls "
        f"hold {both_runs} (first run alone: {sum(_call_tokens(c) for c in calls[:2])})"
    )
    assert len(_of(events, "session_start")) == 2
    assert len(detail["attachments"]) == 1, detail["attachments"]
    assert _children(replay.session_id) == [child_id]
    assert detail["session"]["parent_session_id"] == replay.session_id
    assert detail["session"]["agent_role"] == "general-purpose"

    # A late record, dated before the second end, does not reopen it.
    second_end = int(ends[1]["timeUnixNano"])
    replay.post(
        JSON, _child_call_export(replay, agent_id, second_end - 2 * 10**9, 9001)
    )
    events = _events_when(child_id, lambda ev: len(_of(ev, "post_call")) == 5)
    detail = get_session_detail(child_id)
    assert detail["session"]["state"] == "closed"
    assert len(detail["attachments"]) == 1
    assert detail["session"]["tokens_used"] == both_runs
    assert len(_of(events, "session_start")) == 2

    # The same call dated after the end resumes the sub-agent again.
    replay.post(
        JSON, _child_call_export(replay, agent_id, second_end + 5 * 10**9, 9002)
    )
    wait_until(
        lambda: len(get_session_detail(child_id)["attachments"]) == 2,
        timeout=LAND_TIMEOUT_SECS,
        msg="a record after the end re-attaches the child",
    )
    wait_until(
        lambda: (
            get_session_detail(child_id)["session"]["tokens_used"]
            == both_runs + _call_tokens(calls[-1])
        ),
        timeout=LAND_TIMEOUT_SECS,
        msg="the resumed call's tokens count",
    )
    assert get_session_detail(child_id)["session"]["state"] != "closed"


def test_resume_in_the_export_that_ends_the_run(flavor: str) -> None:
    """Claude Code's 5 s default export interval can put a run's
    subagent_completed and the resumed run's records in one export: the
    receiver publishes the end, then a start, then the resumed run, and
    the worker closes the child and reopens it in that order."""
    replay = Replay("subagent-resume-json", flavor)
    records = _typed_records(replay)
    calls = _sub_agent(records, "api_request")
    merged = {
        "resourceLogs": [
            rl for r in replay.requests for rl in json.loads(r["body"])["resourceLogs"]
        ]
    }
    replay.requests = [
        {
            "file": "merged",
            "path": "/v1/logs",
            "content_type": JSON,
            "sent_encoding": None,
            "body": json.dumps(merged).encode(),
        }
    ]
    replay.send()
    assert replay.rejected == replay.unmapped, replay.messages

    child_id = otlp_session_id(replay.claude_code_session_id, calls[0]["agent_id"])
    events = _events_when(
        child_id,
        lambda ev: len(_of(ev, "session_end")) == 2 and len(_of(ev, "post_call")) == 4,
    )
    assert len(_of(events, "session_start")) == 2
    wait_until(
        lambda: (
            _state(child_id) == "closed"
            and get_session_detail(child_id)["session"]["tokens_used"]
            == sum(_call_tokens(c) for c in calls)
        ),
        timeout=LAND_TIMEOUT_SECS,
        msg="both runs' tokens count and the second end closes the child",
    )
    assert _children(replay.session_id) == [child_id]
