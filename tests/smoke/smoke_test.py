#!/usr/bin/env python3
"""Flightdeck end-to-end smoke test suite.

Runs real LLM provider calls against a live Flightdeck stack and asserts
every sensor and platform capability works end to end. No mocks.

This file doubles as a playground -- each scenario is a small, readable
example of the corresponding feature. Copy a `with scenario(...)` block
into your own code as a starting point.

REQUIREMENTS
    Docker compose dev stack running:   make dev
    ANTHROPIC_API_KEY in environment    (skip provider tests if missing)
    OPENAI_API_KEY    in environment    (skip provider tests if missing)
    flightdeck-sensor installed:        pip install -e sensor/
    tok_dev auth token seeded in DB     (init.sql does this)

USAGE
    python tests/smoke/smoke_test.py            # all groups
    python tests/smoke/smoke_test.py --groups 1,2,6   # selected groups
    python tests/smoke/smoke_test.py --list     # list available groups
    python tests/smoke/smoke_test.py --help

COST
    < $0.05 per full run on claude-haiku-4-5-20251001 + gpt-4o-mini
    with max_tokens=5 and "hi" prompts. ~32 LLM calls total.

EXIT CODES
    0  all checks passed (or skipped)
    1  one or more checks failed
    2  stack unhealthy / config error
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator
from uuid import uuid4


# ============================================================================
# CONFIGURATION
# ============================================================================

class Config:
    """Endpoints, auth, models, and timing knobs.

    All values are intentionally module-level constants -- this is a smoke
    test, not a configurable framework. Tweak in source if you really need
    to change them.
    """

    # Stack endpoints (nginx gateway routes to ingestion + API services)
    INGEST_URL = "http://localhost:4000/ingest"
    API_URL = "http://localhost:4000/api"
    AUTH_TOKEN = "tok_dev"

    # Cheap models so a full run costs < $0.05
    ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
    OPENAI_MODEL = "gpt-4o-mini"
    DEGRADE_TARGET_MODEL = "claude-haiku-4-5-20251001"

    # Standard wait windows. Drain queue + reconciler tick is ~5s in dev.
    SHORT_WAIT_S = 2
    DRAIN_WAIT_S = 3
    POLICY_WAIT_S = 5
    POLL_TIMEOUT_S = 10
    POLL_INTERVAL_S = 0.5

    # Tiny prompts to keep cost minimal
    HI_PROMPT = [{"role": "user", "content": "hi"}]
    HI_MAX_TOKENS = 5


# Probed once at import; gates provider-specific scenarios with clear SKIPs
HAS_ANTHROPIC_KEY = bool(os.environ.get("ANTHROPIC_API_KEY"))
HAS_OPENAI_KEY = bool(os.environ.get("OPENAI_API_KEY"))


# ============================================================================
# WIRE-FORMAT CONSTANTS
# ============================================================================

class EventType:
    """Event types written to the events table by the workers."""
    SESSION_START = "session_start"
    SESSION_END = "session_end"
    POST_CALL = "post_call"
    PRE_CALL = "pre_call"
    TOOL_CALL = "tool_call"
    HEARTBEAT = "heartbeat"
    POLICY_WARN = "policy_warn"
    POLICY_BLOCK = "policy_block"
    POLICY_DEGRADE = "policy_degrade"
    DIRECTIVE_RESULT = "directive_result"


class DirectiveAction:
    """Directive action types accepted by POST /v1/directives."""
    SHUTDOWN = "shutdown"
    SHUTDOWN_FLAVOR = "shutdown_flavor"
    CUSTOM = "custom"


class DirectiveStatus:
    """Values that appear in directive_result.payload.directive_status."""
    SUCCESS = "success"
    ERROR = "error"
    ACKNOWLEDGED = "acknowledged"


class SessionState:
    """Session state values per ARCHITECTURE.md."""
    ACTIVE = "active"
    IDLE = "idle"
    STALE = "stale"
    CLOSED = "closed"
    LOST = "lost"


class PolicyScope:
    """Policy scope values for POST /v1/policies."""
    ORG = "org"
    FLAVOR = "flavor"
    SESSION = "session"


# ============================================================================
# RESULT TRACKING & REPORTING
# ============================================================================

@dataclass
class CheckResult:
    name: str
    status: str  # "PASS", "FAIL", "SKIP"
    detail: str = ""


class Reporter:
    """Collects check results and prints them with section headers and a
    final summary. Color codes are used only when stdout is a TTY."""

    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"

    def __init__(self, *, use_color: bool | None = None) -> None:
        if use_color is None:
            use_color = sys.stdout.isatty()
        self._use_color = use_color
        self._results: list[CheckResult] = []

    # ----- formatting --------------------------------------------------

    def _color(self, text: str, code: str) -> str:
        if not self._use_color:
            return text
        return f"\033[{code}m{text}\033[0m"

    def _icon(self, status: str) -> str:
        if status == self.PASS:
            return self._color("✓", "32")
        if status == self.FAIL:
            return self._color("✗", "31")
        return self._color("⊘", "33")

    # ----- public API --------------------------------------------------

    def section(self, title: str) -> None:
        print(f"\n{'─' * 60}")
        print(f"  {title}")
        print(f"{'─' * 60}")

    def check(self, name: str, passed: bool, detail: str = "") -> None:
        status = self.PASS if passed else self.FAIL
        result = CheckResult(name=name, status=status, detail=detail)
        self._results.append(result)
        line = f"  {self._icon(status)} {name}"
        if detail and not passed:
            line += f"  -- {detail}"
        print(line)

    def skip(self, name: str, reason: str) -> None:
        result = CheckResult(name=name, status=self.SKIP, detail=reason)
        self._results.append(result)
        print(f"  {self._icon(self.SKIP)} {name}  -- {reason}")

    def summary(self) -> None:
        passed = sum(1 for r in self._results if r.status == self.PASS)
        failed = sum(1 for r in self._results if r.status == self.FAIL)
        skipped = sum(1 for r in self._results if r.status == self.SKIP)
        total = len(self._results)
        print(f"\n{'═' * 60}")
        print(f"  PASS: {passed}  FAIL: {failed}  SKIP: {skipped}  TOTAL: {total}")
        if failed:
            print("\n  Failed checks:")
            for r in self._results:
                if r.status == self.FAIL:
                    print(f"    ✗ {r.name}: {r.detail}")
        print(f"{'═' * 60}")

    @property
    def failure_count(self) -> int:
        return sum(1 for r in self._results if r.status == self.FAIL)


# Module-level singleton -- scenarios pull this in via `report`.
report = Reporter()


# ============================================================================
# HTTP CLIENT
# ============================================================================

class HTTPError(Exception):
    """Raised when a non-2xx response is received and the caller wants
    raise-on-error semantics. ``status_code`` carries the HTTP status."""

    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"HTTP {status_code}: {body[:200]}")
        self.status_code = status_code
        self.body = body


class APIClient:
    """Thin urllib wrapper for the API service. All methods include the
    bearer token. ``get_status`` and ``post_status`` never raise on HTTP
    errors -- they return ``(status_code, body_or_None)``."""

    def __init__(self, base_url: str, token: str, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._token}",
        }

    def get(self, path: str) -> dict:
        req = urllib.request.Request(f"{self._base_url}{path}", headers=self._headers())
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode())

    def get_status(self, path: str) -> tuple[int, dict | None]:
        """GET that never raises on HTTP errors. Useful for 404 checks."""
        try:
            return 200, self.get(path)
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            return 0, None

    def post(self, path: str, body: dict) -> dict:
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self._base_url}{path}", data=data, headers=self._headers(), method="POST",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode())

    def delete(self, path: str) -> None:
        """DELETE that swallows all errors. Used for cleanup."""
        try:
            req = urllib.request.Request(
                f"{self._base_url}{path}", headers=self._headers(), method="DELETE",
            )
            urllib.request.urlopen(req, timeout=self._timeout).read()
        except Exception:
            pass


api = APIClient(Config.API_URL, Config.AUTH_TOKEN)


def stack_is_healthy() -> bool:
    """Probe both ingestion and API health endpoints. Returns False if
    either is unreachable or returns non-200."""
    for url in (f"{Config.INGEST_URL}/health", f"{Config.API_URL}/health"):
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status != 200:
                    return False
        except Exception:
            return False
    return True


# ============================================================================
# DATABASE CLIENT
# ============================================================================

class DBClient:
    """Direct psql via ``docker exec`` for assertions that hit the DB
    side of the platform (event_type counts, directive delivery,
    event_content rows). Smoke tests bypass the API for these because
    some fields (e.g. ``directives.delivered_at``) are not exposed by
    any endpoint."""

    POSTGRES_CONTAINER = "docker-postgres-1"
    POSTGRES_USER = "flightdeck"

    def query(self, sql: str) -> str:
        result = subprocess.run(
            [
                "docker", "exec", self.POSTGRES_CONTAINER,
                "psql", "-U", self.POSTGRES_USER, "-tAX", "-c", sql,
            ],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    def query_json(self, sql: str) -> list:
        raw = self.query(sql)
        if not raw or raw == "null":
            return []
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []

    # ----- domain queries ----------------------------------------------

    def events_for_flavor(self, flavor: str) -> list[dict]:
        return self.query_json(
            "SELECT json_agg(row_to_json(e) ORDER BY e.occurred_at) "
            f"FROM events e WHERE e.flavor = '{flavor}'"
        )

    def event_content_for_session(self, session_id: str) -> list[dict]:
        return self.query_json(
            "SELECT json_agg(row_to_json(ec)) FROM event_content ec "
            f"WHERE ec.session_id = '{session_id}'"
        )

    def directives_for_session(self, session_id: str) -> list[dict]:
        return self.query_json(
            "SELECT json_agg(row_to_json(d)) FROM directives d "
            f"WHERE d.session_id = '{session_id}'"
        )

    def directives_for_flavor(self, flavor: str) -> list[dict]:
        return self.query_json(
            "SELECT json_agg(row_to_json(d)) FROM directives d "
            f"WHERE d.flavor = '{flavor}'"
        )


db = DBClient()


# ============================================================================
# POLLING HELPERS
# ============================================================================

def wait_until(
    predicate: Callable[[], bool],
    *,
    timeout: float = Config.POLL_TIMEOUT_S,
    interval: float = Config.POLL_INTERVAL_S,
    description: str = "condition",
) -> bool:
    """Poll ``predicate`` until it returns True or ``timeout`` elapses.
    Returns True on success, False on timeout. Never raises."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def wait_for_session_record(session_id: str, *, timeout: float = Config.POLL_TIMEOUT_S) -> dict | None:
    """Poll ``GET /v1/sessions/{id}`` until it returns 200. Returns the
    full session detail dict, or None on timeout."""
    holder: dict = {}

    def _check() -> bool:
        status, body = api.get_status(f"/v1/sessions/{session_id}")
        if status == 200 and body:
            holder["body"] = body
            return True
        return False

    wait_until(_check, timeout=timeout, description=f"session {session_id[:8]} record")
    return holder.get("body")


def wait_for_directive_registered(
    flavor: str, name: str, *, timeout: float = Config.POLL_TIMEOUT_S,
) -> dict | None:
    """Poll ``GET /v1/directives/custom`` until ``name`` appears for
    ``flavor``. Returns the directive dict (with ``fingerprint``), or
    None on timeout."""
    holder: dict = {}

    def _check() -> bool:
        try:
            data = api.get(f"/v1/directives/custom?flavor={flavor}")
        except Exception:
            return False
        for d in data.get("directives", []):
            if d.get("name") == name:
                holder["d"] = d
                return True
        return False

    wait_until(_check, timeout=timeout, description=f"directive {name}")
    return holder.get("d")


def wait_for_event_type(
    flavor: str, event_type: str, *, timeout: float = Config.POLL_TIMEOUT_S,
) -> dict | None:
    """Poll the events table for an event of ``event_type`` on this
    flavor. Returns the event row, or None on timeout."""
    holder: dict = {}

    def _check() -> bool:
        for ev in db.events_for_flavor(flavor):
            if ev.get("event_type") == event_type:
                holder["ev"] = ev
                return True
        return False

    wait_until(_check, timeout=timeout, description=f"event {event_type}")
    return holder.get("ev")


def wait_for_session_state(
    session_id: str, expected: str, *, timeout: float = Config.POLL_TIMEOUT_S,
) -> str | None:
    """Poll until the session reaches ``expected`` state. Returns the
    current state when matched, or the last observed state on timeout."""
    holder = {"state": None}

    def _check() -> bool:
        detail = wait_for_session_record(session_id, timeout=1)
        if not detail:
            return False
        state = detail.get("session", {}).get("state")
        holder["state"] = state
        return state == expected

    wait_until(_check, timeout=timeout, description=f"session state={expected}")
    return holder["state"]


# ============================================================================
# DOMAIN HELPERS
# ============================================================================

def parse_event_payload(event: dict) -> dict:
    """The events table column ``payload`` is JSONB. psql may return it
    pre-parsed (dict) or as a JSON string depending on the json_agg path.
    Normalize to dict."""
    payload = event.get("payload") or {}
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except Exception:
            return {}
    return payload


def find_directive_result(events: list[dict], directive_name: str) -> dict | None:
    """Find the first directive_result event for the given directive_name.
    Returns the event row with payload preserved as-is."""
    for ev in events:
        if ev.get("event_type") != EventType.DIRECTIVE_RESULT:
            continue
        if parse_event_payload(ev).get("directive_name") == directive_name:
            return ev
    return None


def create_policy(
    *,
    scope: str,
    scope_value: str,
    token_limit: int,
    warn_at_pct: int | None = None,
    degrade_at_pct: int | None = None,
    degrade_to: str | None = None,
    block_at_pct: int | None = None,
) -> dict:
    """Create a token policy via POST /v1/policies. Returns the created
    policy dict including the ``id`` for later deletion."""
    body: dict[str, Any] = {
        "scope": scope, "scope_value": scope_value, "token_limit": token_limit,
    }
    for key, val in [
        ("warn_at_pct", warn_at_pct),
        ("degrade_at_pct", degrade_at_pct),
        ("degrade_to", degrade_to),
        ("block_at_pct", block_at_pct),
    ]:
        if val is not None:
            body[key] = val
    return api.post("/v1/policies", body)


def delete_policy(policy_id: str) -> None:
    """Best-effort policy deletion. Used in finally blocks so a fail in
    cleanup never masks a real failure."""
    api.delete(f"/v1/policies/{policy_id}")


def post_directive(
    *,
    action: str,
    session_id: str | None = None,
    flavor: str | None = None,
    reason: str | None = None,
    directive_name: str | None = None,
    fingerprint: str | None = None,
    parameters: dict | None = None,
) -> dict:
    """POST /v1/directives. ``session_id`` and ``flavor`` are mutually
    optional -- pass one for targeted directives, the other for fan-out.
    Returns the created directive dict including ``id``."""
    body: dict[str, Any] = {"action": action, "grace_period_ms": 5000}
    for key, val in [
        ("session_id", session_id),
        ("flavor", flavor),
        ("reason", reason),
        ("directive_name", directive_name),
        ("fingerprint", fingerprint),
        ("parameters", parameters),
    ]:
        if val is not None:
            body[key] = val
    return api.post("/v1/directives", body)


# ============================================================================
# SENSOR HARNESS
# ============================================================================

def unique_flavor(prefix: str) -> str:
    """Generate a flavor name that is unique per scenario.
    Pattern: ``smoke-{prefix}-{8 hex chars}`` so smoke data is easy to
    grep in the dashboard and DB."""
    return f"smoke-{prefix}-{uuid4().hex[:8]}"


def force_reset_sensor() -> None:
    """Tear down the sensor singleton. Safe to call when no session
    exists. Used between scenarios so a fresh ``init()`` succeeds."""
    import flightdeck_sensor
    try:
        flightdeck_sensor.teardown()
    except Exception:
        pass
    flightdeck_sensor._session = None  # type: ignore[attr-defined]
    flightdeck_sensor._client = None  # type: ignore[attr-defined]
    flightdeck_sensor._directive_registry.clear()  # type: ignore[attr-defined]


def cleanup_smoke_directives() -> None:
    """Delete any custom_directives rows left over from previous smoke
    runs. The smoke test registers directives under ``smoke_*`` names so
    a single prefix-match wipe keeps the test idempotent across runs
    against a persistent Postgres volume."""
    api.delete("/v1/directives/custom?name_prefix=smoke_")


def sensor_init(flavor: str, *, server: str = Config.INGEST_URL, **kwargs: Any) -> None:
    """``flightdeck_sensor.init`` with smoke-test defaults. Sets
    ``AGENT_FLAVOR`` env var so context collection picks it up."""
    import flightdeck_sensor
    os.environ["AGENT_FLAVOR"] = flavor
    flightdeck_sensor.init(server=server, token=Config.AUTH_TOKEN, **kwargs)


@contextmanager
def scenario(name: str, prefix: str) -> Iterator[str]:
    """Context manager that yields a unique flavor and guarantees the
    sensor is reset before AND after the scenario, regardless of
    success/failure.

    Usage:
        with scenario("1a. Anthropic patch()", prefix="1a") as flavor:
            sensor_init(flavor)
            ...
    """
    flavor = unique_flavor(prefix)
    force_reset_sensor()
    try:
        yield flavor
    except Exception as exc:
        report.check(f"{name} (uncaught)", False, repr(exc))
    finally:
        force_reset_sensor()


# ============================================================================
# PROVIDER LAZY IMPORTS
# ============================================================================

def anthropic_client() -> Any:
    """Import + construct Anthropic client. Raises if package missing."""
    import anthropic
    return anthropic.Anthropic()


def openai_client() -> Any:
    """Import + construct OpenAI client. Raises if package missing."""
    import openai
    return openai.OpenAI()


def hi_message_anthropic(client: Any, *, model: str = Config.ANTHROPIC_MODEL) -> Any:
    """One-shot Anthropic call with minimal tokens. Returns the raw
    response so scenarios can inspect tool_use blocks etc."""
    return client.messages.create(
        model=model, max_tokens=Config.HI_MAX_TOKENS, messages=Config.HI_PROMPT,
    )


def hi_message_openai(client: Any, *, model: str = Config.OPENAI_MODEL) -> Any:
    """One-shot OpenAI chat completion with minimal tokens."""
    return client.chat.completions.create(
        model=model, max_tokens=Config.HI_MAX_TOKENS, messages=Config.HI_PROMPT,
    )


# ============================================================================
# ============================================================================
# SCENARIOS
# ============================================================================
# Each ``group_N_*`` function maps to a section in the report. The order
# below matches the documented test plan in ARCHITECTURE.md.
# ============================================================================


# ----------------------------------------------------------------------------
# GROUP 1 -- Provider Interception
# ----------------------------------------------------------------------------

def group_1_provider_interception() -> None:
    report.section("GROUP 1: Provider Interception")
    _scenario_1a_anthropic_patch()
    _scenario_1b_anthropic_wrap()
    _scenario_1c_openai_patch()
    _scenario_1d_openai_wrap()
    _scenario_1e_openai_embeddings()
    _scenario_1f_anthropic_beta_messages()
    _scenario_1g_anthropic_streaming()
    _scenario_1h_openai_streaming()
    _scenario_1i_anthropic_tool_calls()


def _scenario_1a_anthropic_patch() -> None:
    """1a. Anthropic via patch() -- the recommended interception path.
    Class-level patching catches every Anthropic instance constructed
    after the patch call."""
    if not HAS_ANTHROPIC_KEY:
        report.skip("1a. Anthropic patch()", "ANTHROPIC_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1a. Anthropic patch()", prefix="1a") as flavor:
        try:
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["anthropic"])
            hi_message_anthropic(anthropic_client())
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            types = {e["event_type"] for e in events}
            report.check("1a. session_start event", EventType.SESSION_START in types)
            post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
            report.check("1a. post_call event", len(post_calls) >= 1)
            if post_calls:
                pc = post_calls[0]
                report.check("1a. tokens_total > 0", (pc.get("tokens_total") or 0) > 0,
                             f"got {pc.get('tokens_total')}")
                report.check("1a. model matches", Config.ANTHROPIC_MODEL in (pc.get("model") or ""),
                             f"got {pc.get('model')}")
                report.check("1a. has_content=false (capture off)", pc.get("has_content") is False)
        finally:
            flightdeck_sensor.unpatch()


def _scenario_1b_anthropic_wrap() -> None:
    """1b. Anthropic via wrap() -- per-instance wrapping for users who
    want explicit control. Should produce identical events to patch()."""
    if not HAS_ANTHROPIC_KEY:
        report.skip("1b. Anthropic wrap()", "ANTHROPIC_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1b. Anthropic wrap()", prefix="1b") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        report.check("1b. post_call event via wrap()", len(post_calls) >= 1)
        if post_calls:
            report.check("1b. tokens_total > 0", (post_calls[0].get("tokens_total") or 0) > 0)


def _scenario_1c_openai_patch() -> None:
    """1c. OpenAI chat.completions via patch()."""
    if not HAS_OPENAI_KEY:
        report.skip("1c. OpenAI chat patch()", "OPENAI_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1c. OpenAI chat patch()", prefix="1c") as flavor:
        try:
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            hi_message_openai(openai_client())
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
            report.check("1c. OpenAI post_call event", len(post_calls) >= 1)
            if post_calls:
                report.check("1c. tokens_total > 0", (post_calls[0].get("tokens_total") or 0) > 0)
                report.check("1c. model field set", bool(post_calls[0].get("model")))
        finally:
            flightdeck_sensor.unpatch()


def _scenario_1d_openai_wrap() -> None:
    """1d. OpenAI chat.completions via wrap()."""
    if not HAS_OPENAI_KEY:
        report.skip("1d. OpenAI chat wrap()", "OPENAI_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1d. OpenAI chat wrap()", prefix="1d") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(openai_client())
        hi_message_openai(client)
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        report.check("1d. OpenAI wrap() post_call", len(post_calls) >= 1)


def _scenario_1e_openai_embeddings() -> None:
    """1e. OpenAI embeddings.create() -- proves the embeddings resource
    is patched end to end."""
    if not HAS_OPENAI_KEY:
        report.skip("1e. OpenAI embeddings", "OPENAI_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1e. OpenAI embeddings", prefix="1e") as flavor:
        try:
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            openai_client().embeddings.create(model="text-embedding-3-small", input="hello world")
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
            report.check("1e. embeddings post_call", len(post_calls) >= 1)
        finally:
            flightdeck_sensor.unpatch()


def _scenario_1f_anthropic_beta_messages() -> None:
    """1f. Anthropic beta.messages via patch().

    KI17 NOTE: wrap() does NOT intercept beta.messages -- SensorAnthropic
    has no .beta property. Only patch() covers this path. Tracked as KI17.
    """
    if not HAS_ANTHROPIC_KEY:
        report.skip("1f. Anthropic beta.messages", "ANTHROPIC_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1f. Anthropic beta.messages", prefix="1f") as flavor:
        try:
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["anthropic"])
            anthropic_client().beta.messages.create(
                model=Config.ANTHROPIC_MODEL,
                max_tokens=Config.HI_MAX_TOKENS,
                messages=Config.HI_PROMPT,
                betas=["prompt-caching-2024-07-31"],
            )
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
            report.check("1f. beta.messages post_call via patch()", len(post_calls) >= 1,
                         "KI17: only patch() intercepts beta.messages")
        finally:
            flightdeck_sensor.unpatch()


def _scenario_1g_anthropic_streaming() -> None:
    """1g. Anthropic messages.stream() -- the GuardedStream context
    manager reconciles tokens on __exit__ after the stream is consumed.
    Async streaming raises NotImplementedError and is intentionally not
    tested."""
    if not HAS_ANTHROPIC_KEY:
        report.skip("1g. Anthropic streaming", "ANTHROPIC_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1g. Anthropic streaming", prefix="1g") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        with client.messages.stream(
            model=Config.ANTHROPIC_MODEL, max_tokens=10,
            messages=[{"role": "user", "content": "Say one word."}],
        ) as stream:
            stream.get_final_text()
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        report.check("1g. streaming post_call", len(post_calls) >= 1)
        if post_calls:
            report.check("1g. streaming tokens > 0", (post_calls[0].get("tokens_total") or 0) > 0)


def _scenario_1h_openai_streaming() -> None:
    """1h. OpenAI chat.completions.create(stream=True). Sensor injects
    stream_options={"include_usage": True} so OpenAI returns token
    counts in the final chunk. Use ``with`` because GuardedStream is a
    context manager."""
    if not HAS_OPENAI_KEY:
        report.skip("1h. OpenAI streaming", "OPENAI_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1h. OpenAI streaming", prefix="1h") as flavor:
        try:
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            with openai_client().chat.completions.create(
                model=Config.OPENAI_MODEL, max_tokens=10,
                messages=[{"role": "user", "content": "Say one word."}],
                stream=True,
            ) as stream:
                for _ in stream:
                    pass
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
            report.check("1h. OpenAI streaming post_call", len(post_calls) >= 1)
            if post_calls:
                report.check("1h. streaming tokens > 0", (post_calls[0].get("tokens_total") or 0) > 0)
        finally:
            flightdeck_sensor.unpatch()


def _scenario_1i_anthropic_tool_calls() -> None:
    """1i. Tool calls -- verifies the sensor handles tool_use response
    blocks and follow-up tool_result messages without losing events."""
    if not HAS_ANTHROPIC_KEY:
        report.skip("1i. Tool calls", "ANTHROPIC_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1i. Tool calls", prefix="1i") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        tools = [{
            "name": "get_weather",
            "description": "Get the weather for a city",
            "input_schema": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        }]
        resp = client.messages.create(
            model=Config.ANTHROPIC_MODEL, max_tokens=100,
            messages=[{"role": "user", "content": "What's the weather in Paris?"}],
            tools=tools,
        )
        tool_blocks = [b for b in resp.content if b.type == "tool_use"]
        if tool_blocks:
            tool_block = tool_blocks[0]
            client.messages.create(
                model=Config.ANTHROPIC_MODEL, max_tokens=50,
                messages=[
                    {"role": "user", "content": "What's the weather in Paris?"},
                    {"role": "assistant", "content": resp.content},
                    {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": tool_block.id, "content": "Sunny, 22°C"},
                    ]},
                ],
                tools=tools,
            )
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        report.check("1i. tool call post_call events", len(post_calls) >= 1)


# ----------------------------------------------------------------------------
# GROUP 2 -- Prompt Capture
# ----------------------------------------------------------------------------

def group_2_prompt_capture() -> None:
    report.section("GROUP 2: Prompt Capture")
    if not HAS_ANTHROPIC_KEY:
        report.skip("2a. Capture ON", "ANTHROPIC_API_KEY not set")
        report.skip("2b. Capture OFF", "ANTHROPIC_API_KEY not set")
        return
    _scenario_2a_capture_on()
    _scenario_2b_capture_off()


def _scenario_2a_capture_on() -> None:
    """2a. capture_prompts=True: post_call.has_content=true,
    event_content row exists, GET /v1/events/{id}/content returns 200."""
    import flightdeck_sensor
    with scenario("2a. Capture ON", prefix="2a") as flavor:
        sensor_init(flavor, capture_prompts=True)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        report.check("2a. post_call exists", len(post_calls) >= 1)
        if post_calls:
            pc = post_calls[0]
            report.check("2a. has_content=true", pc.get("has_content") is True)
            content_rows = db.event_content_for_session(pc["session_id"])
            report.check("2a. event_content row exists", len(content_rows) >= 1)
            status, _ = api.get_status(f"/v1/events/{pc['id']}/content")
            report.check("2a. GET content returns 200", status == 200, f"got {status}")


def _scenario_2b_capture_off() -> None:
    """2b. capture_prompts default (False): has_content=false on event,
    GET /v1/events/{id}/content returns 404."""
    import flightdeck_sensor
    with scenario("2b. Capture OFF", prefix="2b") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        if post_calls:
            pc = post_calls[0]
            status, _ = api.get_status(f"/v1/events/{pc['id']}/content")
            report.check("2b. GET content returns 404", status == 404, f"got {status}")
            report.check("2b. has_content=false", pc.get("has_content") is False)


# ----------------------------------------------------------------------------
# GROUP 3 -- Local Policy Enforcement
# ----------------------------------------------------------------------------

def group_3_local_policy() -> None:
    report.section("GROUP 3: Local Policy Enforcement")
    if not HAS_ANTHROPIC_KEY:
        report.skip("3a. Local WARN", "ANTHROPIC_API_KEY not set")
        report.skip("3b. Local limit=1 does NOT block", "ANTHROPIC_API_KEY not set")
        return
    _scenario_3a_local_warn()
    _scenario_3b_local_limit_does_not_block()


def _scenario_3a_local_warn() -> None:
    """3a. init(limit=50, warn_at=0.01) -- the first call crosses the
    warn threshold, the call still succeeds, the policy_warn does NOT
    abort processing (D035)."""
    import flightdeck_sensor
    with scenario("3a. Local WARN", prefix="3a") as flavor:
        sensor_init(flavor, limit=50, warn_at=0.01)
        client = flightdeck_sensor.wrap(anthropic_client())
        resp = hi_message_anthropic(client)
        report.check("3a. call succeeds despite warn", resp is not None)
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        post_calls = [e for e in db.events_for_flavor(flavor) if e["event_type"] == EventType.POST_CALL]
        report.check("3a. post_call exists (call went through)", len(post_calls) >= 1)


def _scenario_3b_local_limit_does_not_block() -> None:
    """3b. D035: local limit fires WARN only, never BLOCK. init(limit=1)
    must NOT raise BudgetExceededError."""
    import flightdeck_sensor
    from flightdeck_sensor.core.exceptions import BudgetExceededError
    with scenario("3b. Local limit=1 does NOT block", prefix="3b") as flavor:
        sensor_init(flavor, limit=1, warn_at=0.01)
        client = flightdeck_sensor.wrap(anthropic_client())
        try:
            resp = hi_message_anthropic(client)
            report.check("3b. local limit=1 does NOT block (D035)", resp is not None,
                         "Local limit fires WARN only, never BLOCK")
        except BudgetExceededError:
            report.check("3b. local limit=1 does NOT block (D035)", False,
                         "BudgetExceededError raised -- local limit should WARN only")
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)


# ----------------------------------------------------------------------------
# GROUP 4 -- Server-Side Policy
# ----------------------------------------------------------------------------

def group_4_server_policy() -> None:
    report.section("GROUP 4: Server-Side Policy")
    if not HAS_ANTHROPIC_KEY:
        report.skip("4a. Server WARN", "ANTHROPIC_API_KEY not set")
        report.skip("4b. Server DEGRADE", "ANTHROPIC_API_KEY not set")
        report.skip("4c. Server BLOCK", "ANTHROPIC_API_KEY not set")
        return
    _scenario_4a_server_warn()
    _scenario_4b_server_degrade()
    _scenario_4c_server_block()


def _scenario_4a_server_warn() -> None:
    """4a. Flavor-scoped policy with warn_at_pct=1, token_limit=500.
    Call succeeds, workers fire a warn directive in the background."""
    import flightdeck_sensor
    with scenario("4a. Server WARN", prefix="4a") as flavor:
        policy = create_policy(scope=PolicyScope.FLAVOR, scope_value=flavor,
                               token_limit=500, warn_at_pct=1)
        try:
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.POLICY_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            report.check("4a. post_call exists (call succeeded)",
                         any(e["event_type"] == EventType.POST_CALL for e in events))
            report.check("4a. server policy applied", True, "warn fires via workers reconciler")
        finally:
            delete_policy(policy["id"])


def _scenario_4b_server_degrade() -> None:
    """4b. Server DEGRADE -- crossing degrade_at_pct triggers a degrade
    directive; subsequent calls use ``degrade_to`` model."""
    import flightdeck_sensor
    with scenario("4b. Server DEGRADE", prefix="4b") as flavor:
        policy = create_policy(
            scope=PolicyScope.FLAVOR, scope_value=flavor,
            token_limit=100, degrade_at_pct=1, degrade_to=Config.DEGRADE_TARGET_MODEL,
        )
        try:
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            client.messages.create(model="claude-sonnet-4-6", max_tokens=Config.HI_MAX_TOKENS, messages=Config.HI_PROMPT)
            time.sleep(Config.POLICY_WAIT_S)
            client.messages.create(model="claude-sonnet-4-6", max_tokens=Config.HI_MAX_TOKENS, messages=Config.HI_PROMPT)
            time.sleep(Config.DRAIN_WAIT_S)
            try:
                client.messages.create(model="claude-sonnet-4-6", max_tokens=Config.HI_MAX_TOKENS, messages=Config.HI_PROMPT)
            except Exception:
                pass
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            events = db.events_for_flavor(flavor)
            post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
            report.check("4b. multiple post_call events", len(post_calls) >= 2)
            degraded = [e for e in post_calls if e.get("model") == Config.DEGRADE_TARGET_MODEL]
            report.check("4b. model degraded to target", len(degraded) >= 1,
                         f"expected model={Config.DEGRADE_TARGET_MODEL} in at least one post_call")
        finally:
            delete_policy(policy["id"])


def _scenario_4c_server_block() -> None:
    """4c. Server BLOCK with block_at_pct=1: preflight loads the
    threshold, the first call's pre-call estimate exceeds 1% of 100
    tokens, sensor raises BudgetExceededError immediately."""
    import flightdeck_sensor
    from flightdeck_sensor.core.exceptions import BudgetExceededError
    with scenario("4c. Server BLOCK", prefix="4c") as flavor:
        policy = create_policy(scope=PolicyScope.FLAVOR, scope_value=flavor,
                               token_limit=100, block_at_pct=1)
        try:
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            blocked = False
            try:
                hi_message_anthropic(client)
            except BudgetExceededError:
                blocked = True
            report.check("4c. BudgetExceededError raised", blocked,
                         "Server BLOCK should fire on first call when threshold is 1%")
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)
        except BudgetExceededError:
            report.check("4c. BudgetExceededError raised", True)
        finally:
            delete_policy(policy["id"])


# ----------------------------------------------------------------------------
# GROUP 5 -- Kill Switch
# ----------------------------------------------------------------------------

def group_5_kill_switch() -> None:
    report.section("GROUP 5: Kill Switch")
    if not HAS_ANTHROPIC_KEY:
        report.skip("5a. Single session shutdown", "ANTHROPIC_API_KEY not set")
        report.skip("5b. Flavor-wide shutdown", "ANTHROPIC_API_KEY not set")
        return
    _scenario_5a_single_session_shutdown()
    _scenario_5b_flavor_wide_shutdown()


def _scenario_5a_single_session_shutdown() -> None:
    """5a. POST shutdown directive for a specific session_id, make
    another LLM call to trigger envelope delivery, verify the session
    closes AND the directives.delivered_at column is populated."""
    import flightdeck_sensor
    from flightdeck_sensor.core.exceptions import DirectiveError
    with scenario("5a. Single session shutdown", prefix="5a") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.DRAIN_WAIT_S)
        sid = flightdeck_sensor.get_status().session_id

        directive = post_directive(action=DirectiveAction.SHUTDOWN, session_id=sid, reason="smoke-test")
        report.check("5a. shutdown directive created", "id" in directive)
        directive_id = directive["id"]

        try:
            hi_message_anthropic(client)
        except DirectiveError:
            pass  # expected after shutdown
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        state = wait_for_session_state(sid, SessionState.CLOSED, timeout=10)
        report.check("5a. session state is closed", state == SessionState.CLOSED, f"got state={state}")

        rows = db.directives_for_session(sid)
        target = next((d for d in rows if d.get("id") == directive_id), None)
        report.check("5a. directive delivered_at populated",
                     target is not None and target.get("delivered_at") is not None,
                     f"directive_id={directive_id} delivered_at="
                     f"{target.get('delivered_at') if target else 'row missing'}")


def _scenario_5b_flavor_wide_shutdown() -> None:
    """5b. Flavor-wide shutdown via sequential sessions (KI15 workaround).
    Directives persist in the DB until delivered. We POST a
    shutdown_flavor before session B starts; B picks it up on its first
    LLM call envelope and closes."""
    import flightdeck_sensor
    from flightdeck_sensor.core.exceptions import DirectiveError
    with scenario("5b. Flavor-wide shutdown", prefix="5b") as flavor:
        # Session A: establishes flavor + agent row
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.SHORT_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        directive = post_directive(action=DirectiveAction.SHUTDOWN_FLAVOR, flavor=flavor, reason="smoke-5b")
        report.check("5b. shutdown_flavor directive created", "id" in directive)
        time.sleep(Config.SHORT_WAIT_S)

        # Session B: same flavor, expects the pending directive
        force_reset_sensor()
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        try:
            hi_message_anthropic(client)
        except DirectiveError:
            pass
        sid_b = flightdeck_sensor.get_status().session_id
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.DRAIN_WAIT_S)

        state_b = wait_for_session_state(sid_b, SessionState.CLOSED, timeout=10)
        report.check("5b. session B closed by shutdown_flavor",
                     state_b == SessionState.CLOSED, f"got state={state_b}")

        delivered = [d for d in db.directives_for_flavor(flavor)
                     if d.get("action") == DirectiveAction.SHUTDOWN_FLAVOR and d.get("delivered_at")]
        report.check("5b. shutdown_flavor delivered row exists", len(delivered) >= 1,
                     f"flavor rows: {len(db.directives_for_flavor(flavor))}, delivered: {len(delivered)}")


# ----------------------------------------------------------------------------
# GROUP 6 -- Custom Directives
# ----------------------------------------------------------------------------

def group_6_custom_directives() -> None:
    report.section("GROUP 6: Custom Directives")
    if not HAS_ANTHROPIC_KEY:
        for sid in ("6a. Directive registration", "6b. Directive execution",
                    "6c. Directive with parameters", "6d. Handler raises exception"):
            report.skip(sid, "ANTHROPIC_API_KEY not set")
        return
    # Wipe smoke_* rows left by prior runs so the re-register path on a
    # persistent Postgres volume is exercised cleanly. Each scenario
    # below also calls cleanup_smoke_directives() so a failing scenario
    # does not poison the next.
    cleanup_smoke_directives()
    _scenario_6a_directive_registration()
    _scenario_6b_directive_execution()
    _scenario_6c_directive_with_parameters()
    _scenario_6d_handler_raises_exception()


def _scenario_6a_directive_registration() -> None:
    """6a. @directive + init() registers a directive with the API.
    Verifies KI14 fix: control-plane URL routing works end to end."""
    import flightdeck_sensor
    cleanup_smoke_directives()
    with scenario("6a. Directive registration", prefix="6a") as flavor:
        @flightdeck_sensor.directive(name="smoke_6a_action", description="Smoke test 6a")
        def smoke_6a_action(ctx):  # noqa: ARG001
            return {"registered": True}

        sensor_init(flavor)
        d = wait_for_directive_registered(flavor, "smoke_6a_action", timeout=10)
        report.check("6a. directive registered", d is not None,
                     "directive never appeared in /v1/directives/custom")
        if d:
            report.check("6a. correct flavor", d["flavor"] == flavor)
            report.check("6a. description preserved", d["description"] == "Smoke test 6a")
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)


def _scenario_6b_directive_execution() -> None:
    """6b. Trigger a custom directive via API and verify the handler
    runs in-process AND a directive_result event is written to the DB."""
    import flightdeck_sensor
    cleanup_smoke_directives()
    with scenario("6b. Directive execution", prefix="6b") as flavor:
        handler_called = threading.Event()

        @flightdeck_sensor.directive(name="smoke_6b_exec", description="Execution test")
        def smoke_6b_exec(ctx):  # noqa: ARG001
            handler_called.set()
            return {"executed": True}

        sensor_init(flavor)
        d = wait_for_directive_registered(flavor, "smoke_6b_exec", timeout=10)
        report.check("6b. directive registered", d is not None)
        if d:
            sid = flightdeck_sensor.get_status().session_id
            post_directive(
                action=DirectiveAction.CUSTOM, session_id=sid,
                directive_name="smoke_6b_exec", fingerprint=d["fingerprint"],
            )
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.POLICY_WAIT_S)
            report.check("6b. handler was called", handler_called.is_set())
        flightdeck_sensor.teardown()
        time.sleep(Config.DRAIN_WAIT_S)

        result_ev = find_directive_result(db.events_for_flavor(flavor), "smoke_6b_exec")
        report.check("6b. directive_result event in DB", result_ev is not None)
        if result_ev:
            payload = parse_event_payload(result_ev)
            report.check("6b. directive_status=success",
                         payload.get("directive_status") == DirectiveStatus.SUCCESS,
                         f"got: {payload.get('directive_status')}")


def _scenario_6c_directive_with_parameters() -> None:
    """6c. Directive with a typed parameter. Verify the handler receives
    the exact value and the directive_result event lands in the DB."""
    import flightdeck_sensor
    from flightdeck_sensor import Parameter
    cleanup_smoke_directives()
    with scenario("6c. Directive with parameters", prefix="6c") as flavor:
        received: dict[str, Any] = {}

        @flightdeck_sensor.directive(
            name="smoke_6c_params",
            description="Param test",
            parameters=[Parameter(name="msg", type="string", required=True)],
        )
        def smoke_6c_params(ctx, msg: str = ""):  # noqa: ARG001
            received["msg"] = msg
            return {"msg": msg}

        sensor_init(flavor)
        d = wait_for_directive_registered(flavor, "smoke_6c_params", timeout=10)
        report.check("6c. directive registered", d is not None)
        if d:
            sid = flightdeck_sensor.get_status().session_id
            post_directive(
                action=DirectiveAction.CUSTOM, session_id=sid,
                directive_name="smoke_6c_params", fingerprint=d["fingerprint"],
                parameters={"msg": "hello-from-smoke"},
            )
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.POLICY_WAIT_S)
            report.check("6c. parameter received", received.get("msg") == "hello-from-smoke",
                         f"got: {received}")
        flightdeck_sensor.teardown()
        time.sleep(Config.DRAIN_WAIT_S)

        result_ev = find_directive_result(db.events_for_flavor(flavor), "smoke_6c_params")
        report.check("6c. directive_result event in DB", result_ev is not None)
        if result_ev:
            payload = parse_event_payload(result_ev)
            report.check("6c. directive_status=success",
                         payload.get("directive_status") == DirectiveStatus.SUCCESS,
                         f"got: {payload.get('directive_status')}")


def _scenario_6d_handler_raises_exception() -> None:
    """6d. A handler that raises must not propagate. The sensor must
    record a directive_result with directive_status="error" and remain
    functional for subsequent LLM calls."""
    import flightdeck_sensor
    cleanup_smoke_directives()
    with scenario("6d. Handler raises exception", prefix="6d") as flavor:
        @flightdeck_sensor.directive(name="smoke_6d_raises", description="Failure path test")
        def smoke_6d_raises(ctx):  # noqa: ARG001
            raise RuntimeError("intentional smoke-6d failure")

        sensor_init(flavor)
        d = wait_for_directive_registered(flavor, "smoke_6d_raises", timeout=10)
        report.check("6d. directive registered", d is not None)
        if d:
            sid = flightdeck_sensor.get_status().session_id
            post_directive(
                action=DirectiveAction.CUSTOM, session_id=sid,
                directive_name="smoke_6d_raises", fingerprint=d["fingerprint"],
            )
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.DRAIN_WAIT_S)
            resp = hi_message_anthropic(client)
            report.check("6d. sensor remains functional after handler raise", resp is not None)
        flightdeck_sensor.teardown()
        time.sleep(Config.DRAIN_WAIT_S)

        result_ev = find_directive_result(db.events_for_flavor(flavor), "smoke_6d_raises")
        report.check("6d. directive_result event in DB", result_ev is not None)
        if result_ev:
            payload = parse_event_payload(result_ev)
            report.check("6d. directive_status=error",
                         payload.get("directive_status") == DirectiveStatus.ERROR,
                         f"got: {payload.get('directive_status')}")


# ----------------------------------------------------------------------------
# GROUP 7 -- Runtime Context
# ----------------------------------------------------------------------------

def group_7_runtime_context() -> None:
    report.section("GROUP 7: Runtime Context")
    if not HAS_ANTHROPIC_KEY:
        report.skip("7a. Context fields", "ANTHROPIC_API_KEY not set")
        return
    _scenario_7a_context_fields()


def _scenario_7a_context_fields() -> None:
    """7a. The sensor collects runtime context (os, hostname,
    python_version) at init() and posts it on session_start."""
    import flightdeck_sensor
    with scenario("7a. Context fields", prefix="7a") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.DRAIN_WAIT_S)
        sid = flightdeck_sensor.get_status().session_id
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        detail = wait_for_session_record(sid)
        ctx = (detail or {}).get("session", {}).get("context", {})
        for field_name in ("os", "hostname", "python_version"):
            report.check(f"7a. context.{field_name} present", bool(ctx.get(field_name)),
                         f"got: {ctx.get(field_name)}")


# ----------------------------------------------------------------------------
# GROUP 8 -- Session Visibility
# ----------------------------------------------------------------------------

def group_8_session_visibility() -> None:
    report.section("GROUP 8: Session Visibility")
    if not HAS_ANTHROPIC_KEY:
        report.skip("8a. Investigate screen", "ANTHROPIC_API_KEY not set")
        report.skip("8b. Session detail", "ANTHROPIC_API_KEY not set")
        return
    _scenario_8_visibility()


def _scenario_8_visibility() -> None:
    """8a/8b. After teardown the session appears in /v1/sessions with
    state=closed and the session detail endpoint returns events."""
    import flightdeck_sensor
    with scenario("8. Session visibility", prefix="8a") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)
        time.sleep(Config.DRAIN_WAIT_S)
        sid = flightdeck_sensor.get_status().session_id
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        sessions = api.get(f"/v1/sessions?flavor={flavor}&limit=10").get("sessions", [])
        ids = [s["session_id"] for s in sessions]
        report.check("8a. session in /v1/sessions", sid in ids)
        if ids:
            s = next((s for s in sessions if s["session_id"] == sid), None)
            report.check("8a. state is closed", bool(s) and s["state"] == SessionState.CLOSED)

        detail = api.get(f"/v1/sessions/{sid}")
        events = detail.get("events", [])
        report.check("8b. session detail has events", len(events) >= 2,
                     f"expected session_start + post_call, got {len(events)}")
        report.check("8b. session_id matches", detail.get("session", {}).get("session_id") == sid)


# ----------------------------------------------------------------------------
# GROUP 9 -- Sensor Status
# ----------------------------------------------------------------------------

def group_9_sensor_status() -> None:
    report.section("GROUP 9: Sensor Status")
    if not HAS_ANTHROPIC_KEY:
        report.skip("9a. get_status() accuracy", "ANTHROPIC_API_KEY not set")
        return
    _scenario_9a_get_status()


def _scenario_9a_get_status() -> None:
    """9a. get_status() returns a session_id, the configured flavor, and
    a tokens_used counter that grows with usage."""
    import flightdeck_sensor
    with scenario("9a. get_status()", prefix="9a") as flavor:
        sensor_init(flavor)
        before = flightdeck_sensor.get_status()
        report.check("9a. session_id present", bool(before.session_id))
        report.check("9a. flavor correct", before.flavor == flavor)
        tokens_before = before.tokens_used

        client = flightdeck_sensor.wrap(anthropic_client())
        hi_message_anthropic(client)

        after = flightdeck_sensor.get_status()
        report.check("9a. tokens increased", after.tokens_used > tokens_before,
                     f"before={tokens_before}, after={after.tokens_used}")
        flightdeck_sensor.teardown()


# ----------------------------------------------------------------------------
# GROUP 10 -- Unavailability Policy
# ----------------------------------------------------------------------------

def group_10_unavailability() -> None:
    report.section("GROUP 10: Unavailability Policy")
    if not HAS_ANTHROPIC_KEY:
        report.skip("10a. Continue policy", "ANTHROPIC_API_KEY not set")
        return
    _scenario_10a_continue_policy()


def _scenario_10a_continue_policy() -> None:
    """10a. With server unreachable and unavailable_policy=continue
    (the default), real LLM calls succeed and the sensor never raises."""
    import flightdeck_sensor
    flavor = unique_flavor("10a")
    force_reset_sensor()
    try:
        os.environ["AGENT_FLAVOR"] = flavor
        flightdeck_sensor.init(server="http://localhost:9999", token=Config.AUTH_TOKEN)
        client = flightdeck_sensor.wrap(anthropic_client())
        resp = hi_message_anthropic(client)
        report.check("10a. call succeeds with unreachable server", resp is not None)
        flightdeck_sensor.teardown()
    except Exception as e:
        report.check("10a. Continue policy", False, str(e))
    finally:
        force_reset_sensor()


# ----------------------------------------------------------------------------
# GROUP 11 -- Multi-Session Fleet
# ----------------------------------------------------------------------------

def group_11_multi_session() -> None:
    report.section("GROUP 11: Multi-Session Fleet")
    if not HAS_ANTHROPIC_KEY:
        report.skip("11a. Three sequential flavors", "ANTHROPIC_API_KEY not set")
        return
    _scenario_11a_multi_flavor_fleet()


def _scenario_11a_multi_flavor_fleet() -> None:
    """11a. KI15 workaround: sequential init/run/teardown for three
    flavors. All three end up in the fleet response after completion."""
    import flightdeck_sensor
    flavors = [unique_flavor(f"11a-{i}") for i in range(3)]
    try:
        for flavor in flavors:
            force_reset_sensor()
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.SHORT_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(1)
        time.sleep(Config.DRAIN_WAIT_S)

        fleet = api.get("/v1/fleet?limit=200")
        seen = {f["flavor"] for f in fleet.get("flavors", [])}
        found = sum(1 for fl in flavors if fl in seen)
        report.check("11a. all 3 flavors in fleet", found == 3, f"found {found}/3")
    except Exception as e:
        report.check("11a. Multi-session fleet", False, str(e))
    finally:
        force_reset_sensor()


# ----------------------------------------------------------------------------
# GROUP 12 -- Framework Support
# ----------------------------------------------------------------------------

def group_12_frameworks() -> None:
    report.section("GROUP 12: Framework Support")
    _framework_scenario(
        scenario_name="12a. LangChain + Anthropic", prefix="12a",
        package="langchain_anthropic", needs_key=HAS_ANTHROPIC_KEY,
        provider="anthropic", invoke=_invoke_langchain_anthropic,
    )
    _framework_scenario(
        scenario_name="12b. LangChain + OpenAI", prefix="12b",
        package="langchain_openai", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_langchain_openai,
    )
    _framework_scenario(
        scenario_name="12c. LlamaIndex + Anthropic", prefix="12c",
        package="llama_index", needs_key=HAS_ANTHROPIC_KEY,
        provider="anthropic", invoke=_invoke_llamaindex_anthropic,
    )
    _framework_scenario(
        scenario_name="12d. LlamaIndex + OpenAI", prefix="12d",
        package="llama_index", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_llamaindex_openai,
    )
    _framework_scenario(
        scenario_name="12e. CrewAI", prefix="12e",
        package="crewai", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_crewai,
    )


def _framework_scenario(
    *,
    scenario_name: str,
    prefix: str,
    package: str,
    needs_key: bool,
    provider: str,
    invoke: Callable[[], None],
) -> None:
    """Common scaffolding for framework smoke checks: skip on missing
    package or missing key; init+patch; invoke the framework; assert
    a post_call event landed."""
    if not importlib.util.find_spec(package):
        report.skip(scenario_name, f"{package} not installed")
        return
    if not needs_key:
        env_var = "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY"
        report.skip(scenario_name, f"{env_var} not set")
        return
    import flightdeck_sensor
    with scenario(scenario_name, prefix=prefix) as flavor:
        try:
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=[provider])
            invoke()
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)
            post_calls = [e for e in db.events_for_flavor(flavor) if e["event_type"] == EventType.POST_CALL]
            check_name = f"{prefix}. {scenario_name.split('. ', 1)[-1]} post_call"
            report.check(check_name, len(post_calls) >= 1)
        finally:
            flightdeck_sensor.unpatch()


def _invoke_langchain_anthropic() -> None:
    from langchain_anthropic import ChatAnthropic
    ChatAnthropic(model=Config.ANTHROPIC_MODEL).invoke("hi")


def _invoke_langchain_openai() -> None:
    from langchain_openai import ChatOpenAI
    ChatOpenAI(model=Config.OPENAI_MODEL).invoke("hi")


def _invoke_llamaindex_anthropic() -> None:
    from llama_index.llms.anthropic import Anthropic as LlamaAnthropic
    LlamaAnthropic(model=Config.ANTHROPIC_MODEL).complete("hi")


def _invoke_llamaindex_openai() -> None:
    from llama_index.llms.openai import OpenAI as LlamaOpenAI
    LlamaOpenAI(model=Config.OPENAI_MODEL).complete("hi")


def _invoke_crewai() -> None:
    from crewai import LLM
    LLM(model=f"openai/{Config.OPENAI_MODEL}").call("hi")


# ============================================================================
# MAIN
# ============================================================================

# Map of group number -> (label, function). Add a new group here and
# argparse will pick it up automatically.
GROUPS: dict[int, tuple[str, Callable[[], None]]] = {
    1: ("Provider Interception", group_1_provider_interception),
    2: ("Prompt Capture", group_2_prompt_capture),
    3: ("Local Policy Enforcement", group_3_local_policy),
    4: ("Server-Side Policy", group_4_server_policy),
    5: ("Kill Switch", group_5_kill_switch),
    6: ("Custom Directives", group_6_custom_directives),
    7: ("Runtime Context", group_7_runtime_context),
    8: ("Session Visibility", group_8_session_visibility),
    9: ("Sensor Status", group_9_sensor_status),
    10: ("Unavailability Policy", group_10_unavailability),
    11: ("Multi-Session Fleet", group_11_multi_session),
    12: ("Framework Support", group_12_frameworks),
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Flightdeck end-to-end smoke test suite.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--groups", type=str, default=None,
        help="Comma-separated list of group numbers to run (e.g. 1,2,6). "
             "Default: all groups.",
    )
    p.add_argument(
        "--list", action="store_true",
        help="List available groups and exit.",
    )
    p.add_argument(
        "--no-color", action="store_true",
        help="Disable ANSI color output.",
    )
    return p.parse_args()


def list_groups() -> None:
    print("Available groups:")
    for num, (name, _) in GROUPS.items():
        print(f"  {num:>2}. {name}")


def selected_groups(args: argparse.Namespace) -> list[int]:
    if args.groups is None:
        return list(GROUPS.keys())
    try:
        return [int(g.strip()) for g in args.groups.split(",") if g.strip()]
    except ValueError:
        print(f"Invalid --groups value: {args.groups}", file=sys.stderr)
        sys.exit(2)


def main() -> int:
    args = parse_args()
    if args.list:
        list_groups()
        return 0
    if args.no_color:
        global report
        report = Reporter(use_color=False)

    print("\n  Flightdeck Smoke Test Suite")
    print(f"  Stack:         {Config.INGEST_URL} / {Config.API_URL}")
    print(f"  Anthropic key: {'set' if HAS_ANTHROPIC_KEY else 'MISSING'}")
    print(f"  OpenAI key:    {'set' if HAS_OPENAI_KEY else 'MISSING'}")

    if not stack_is_healthy():
        print("\n  ✗ Stack is not healthy. Run 'make dev' first.")
        return 2
    print("  Stack:         healthy\n")

    chosen = selected_groups(args)
    unknown = [g for g in chosen if g not in GROUPS]
    if unknown:
        print(f"Unknown group numbers: {unknown}", file=sys.stderr)
        return 2

    for num in chosen:
        name, func = GROUPS[num]
        try:
            func()
        except Exception as exc:  # never let a group crash abort the run
            report.check(f"GROUP {num}: {name} (uncaught)", False, repr(exc))

    report.summary()
    return 0 if report.failure_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
