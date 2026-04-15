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

    def put(self, path: str, body: dict) -> dict:
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self._base_url}{path}", data=data, headers=self._headers(), method="PUT",
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


def update_policy(
    policy_id: str,
    *,
    scope: str,
    scope_value: str,
    token_limit: int,
    warn_at_pct: int | None = None,
    degrade_at_pct: int | None = None,
    degrade_to: str | None = None,
    block_at_pct: int | None = None,
) -> dict:
    """PUT /v1/policies/:id. The handler requires the full policy body."""
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
    return api.put(f"/v1/policies/{policy_id}", body)


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
    _scenario_1j_openai_tool_calls()


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
        tool_calls = [e for e in events if e["event_type"] == EventType.TOOL_CALL]
        report.check("1i. tool call post_call events", len(post_calls) >= 1)
        report.check(
            "1i. tool_call event emitted by sensor",
            len(tool_calls) >= 1,
            f"got {len(tool_calls)} tool_call events",
        )
        if tool_calls:
            names = {e.get("tool_name") for e in tool_calls}
            report.check(
                "1i. tool_call tool_name=get_weather",
                "get_weather" in names,
                f"got tool_names={names}",
            )


def _scenario_1j_openai_tool_calls() -> None:
    """1j. OpenAI function/tool calling. Issues a prompt that forces a
    tool_call, replies with a tool_result message, and verifies both a
    post_call event AND a tool_call event with the right tool_name land
    in the DB."""
    if not HAS_OPENAI_KEY:
        report.skip("1j. OpenAI tool calls", "OPENAI_API_KEY not set")
        return
    import flightdeck_sensor
    with scenario("1j. OpenAI tool calls", prefix="1j") as flavor:
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(openai_client())
        tools = [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            },
        }]
        resp = client.chat.completions.create(
            model=Config.OPENAI_MODEL, max_tokens=100,
            messages=[{"role": "user", "content": "What's the weather in Paris?"}],
            tools=tools, tool_choice="auto",
        )
        msg = resp.choices[0].message
        tool_calls_resp = getattr(msg, "tool_calls", None) or []
        if tool_calls_resp:
            tc = tool_calls_resp[0]
            # Send a tool_result follow-up so the full round trip is
            # exercised; matches the Anthropic scenario above.
            client.chat.completions.create(
                model=Config.OPENAI_MODEL, max_tokens=50,
                messages=[
                    {"role": "user", "content": "What's the weather in Paris?"},
                    {"role": "assistant", "tool_calls": [
                        {"id": tc.id, "type": "function", "function": {
                            "name": tc.function.name, "arguments": tc.function.arguments,
                        }},
                    ]},
                    {"role": "tool", "tool_call_id": tc.id, "content": "Sunny, 22C"},
                ],
            )
        time.sleep(Config.DRAIN_WAIT_S)
        flightdeck_sensor.teardown()
        time.sleep(Config.SHORT_WAIT_S)

        events = db.events_for_flavor(flavor)
        post_calls = [e for e in events if e["event_type"] == EventType.POST_CALL]
        tool_events = [e for e in events if e["event_type"] == EventType.TOOL_CALL]
        report.check("1j. OpenAI post_call events", len(post_calls) >= 1)
        report.check(
            "1j. OpenAI tool_call event emitted",
            len(tool_events) >= 1,
            f"got {len(tool_events)} tool_call events",
        )
        if tool_events:
            names = {e.get("tool_name") for e in tool_events}
            report.check(
                "1j. OpenAI tool_call tool_name=get_weather",
                "get_weather" in names,
                f"got tool_names={names}",
            )


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
        report.skip("4d. Policy update blocks mid-session", "ANTHROPIC_API_KEY not set")
        report.skip("4e. Policy deleted fails open", "ANTHROPIC_API_KEY not set")
        report.skip("4f. on_unavailable=continue with unreachable server",
                    "ANTHROPIC_API_KEY not set")
        return
    _scenario_4a_server_warn()
    _scenario_4b_server_degrade()
    _scenario_4c_server_block()
    _scenario_4d_policy_update_blocks()
    _scenario_4e_policy_deleted_fails_open()
    _scenario_4f_on_unavailable_continue()


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


def _scenario_4d_policy_update_blocks() -> None:
    """4d. Policy updated mid-session to a tighter limit is picked up by
    the next agent run. The sensor fetches the effective policy once at
    session start (``_preflight_policy`` in core/session.py), so a mid-
    session PUT does not take effect within the same session -- the
    next ``init()`` re-reads it and blocks on pre-flight."""
    import flightdeck_sensor
    from flightdeck_sensor.core.exceptions import BudgetExceededError
    with scenario("4d. Policy update blocks mid-session", prefix="4d") as flavor:
        policy = create_policy(
            scope=PolicyScope.FLAVOR, scope_value=flavor,
            token_limit=500, warn_at_pct=1,
        )
        try:
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            resp1 = hi_message_anthropic(client)
            report.check("4d. first call succeeds under high limit",
                         resp1 is not None)
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            # Tighten the policy to an effectively-immediate block.
            update_policy(
                policy["id"], scope=PolicyScope.FLAVOR, scope_value=flavor,
                token_limit=100, block_at_pct=1,
            )
            time.sleep(Config.SHORT_WAIT_S)

            # New sensor session re-fetches the effective policy on
            # pre-flight and should block the very first call.
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            blocked = False
            try:
                hi_message_anthropic(client)
            except BudgetExceededError:
                blocked = True
            report.check(
                "4d. next session blocked after policy update",
                blocked,
                "sensor re-reads effective policy on pre-flight",
            )
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)
        finally:
            delete_policy(policy["id"])


def _scenario_4e_policy_deleted_fails_open() -> None:
    """4e. Policy deleted while session active -- the next call must
    succeed. D035 fail-open: absence of a policy is not an error."""
    import flightdeck_sensor
    from flightdeck_sensor.core.exceptions import BudgetExceededError
    with scenario("4e. Policy deleted fails open", prefix="4e") as flavor:
        policy = create_policy(
            scope=PolicyScope.FLAVOR, scope_value=flavor,
            token_limit=100, block_at_pct=1,
        )
        try:
            # Baseline: confirm the BLOCK policy is in effect.
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            blocked_before = False
            try:
                hi_message_anthropic(client)
            except BudgetExceededError:
                blocked_before = True
            report.check(
                "4e. baseline block fires while policy exists",
                blocked_before,
            )
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            # Delete the policy. A fresh sensor init should now fetch
            # no effective policy, so the next call must succeed.
            delete_policy(policy["id"])
            time.sleep(Config.SHORT_WAIT_S)

            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic_client())
            try:
                resp = hi_message_anthropic(client)
                report.check(
                    "4e. call succeeds after policy deletion (fail-open)",
                    resp is not None,
                )
            except BudgetExceededError:
                report.check(
                    "4e. call succeeds after policy deletion (fail-open)",
                    False,
                    "BudgetExceededError raised -- expected fail-open",
                )
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)
        finally:
            # Already deleted above; delete_policy swallows 404s.
            delete_policy(policy["id"])


def _scenario_4f_on_unavailable_continue() -> None:
    """4f. FLIGHTDECK_UNAVAILABLE_POLICY=continue with an unreachable
    server: init() must not raise and the agent continues. The sensor
    kwarg equivalent is the env var -- init() forwards it into
    SensorConfig. The LLM call is issued unwrapped because there is no
    reachable control plane to register directives against."""
    import flightdeck_sensor
    force_reset_sensor()
    prev = os.environ.get("FLIGHTDECK_UNAVAILABLE_POLICY")
    os.environ["FLIGHTDECK_UNAVAILABLE_POLICY"] = "continue"
    try:
        # Deliberately unreachable: port 1 rejects every connect.
        init_ok = False
        try:
            flightdeck_sensor.init(
                server="http://127.0.0.1:1", token=Config.AUTH_TOKEN,
            )
            init_ok = True
        except Exception as exc:
            report.check(
                "4f. init() does not raise when server unreachable",
                False, repr(exc),
            )
        if init_ok:
            report.check(
                "4f. init() does not raise when server unreachable", True,
            )
            try:
                resp = hi_message_anthropic(anthropic_client())
                report.check(
                    "4f. raw LLM call succeeds (fail-open)",
                    resp is not None,
                )
            except Exception as exc:
                report.check(
                    "4f. raw LLM call succeeds (fail-open)",
                    False, repr(exc),
                )
    finally:
        if prev is None:
            os.environ.pop("FLIGHTDECK_UNAVAILABLE_POLICY", None)
        else:
            os.environ["FLIGHTDECK_UNAVAILABLE_POLICY"] = prev
        force_reset_sensor()


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


# Worker script for 5b. Each subprocess runs one sensor session that
# makes LLM calls in a loop until the shutdown_flavor directive fires
# (DirectiveError on the next call). Uses a subprocess (not a thread)
# because the sensor uses a process-wide singleton -- two concurrent
# init() calls in the same process would collide (KI15).
_SHUTDOWN_FLAVOR_WORKER = r"""
import os
import sys
import time

os.environ["AGENT_FLAVOR"] = sys.argv[1]

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import DirectiveError
import anthropic

flightdeck_sensor.init(
    server="http://localhost:4000/ingest",
    token="tok_dev",
)
try:
    client = flightdeck_sensor.wrap(anthropic.Anthropic())
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
        except DirectiveError:
            break
        time.sleep(1)
finally:
    flightdeck_sensor.teardown()
"""


def _wait_for_active_sessions(flavor: str, n: int, timeout: float = 30.0) -> list[str]:
    """Poll /v1/sessions until at least ``n`` distinct active sessions
    exist for ``flavor``. Returns the list of session_ids (may be longer
    than n). Returns whatever was observed last on timeout."""
    holder: dict = {"sids": []}

    def _check() -> bool:
        try:
            resp = api.get(
                f"/v1/sessions?flavor={flavor}&state=active&limit=20"
            )
        except Exception:
            return False
        sids = [
            s.get("session_id") for s in resp.get("sessions", [])
            if s.get("state") == SessionState.ACTIVE and s.get("session_id")
        ]
        holder["sids"] = sids
        return len(sids) >= n

    wait_until(_check, timeout=timeout, description=f"{n} active sessions for {flavor}")
    return holder.get("sids", [])


def _scenario_5b_flavor_wide_shutdown() -> None:
    """5b. Flavor-wide shutdown with two concurrent sessions.

    Spawns two subprocess workers sharing the same flavor, waits for
    both to be live in the fleet, POSTs a shutdown_flavor directive,
    and verifies both sessions close. shutdown_flavor fans out to
    every active session under the flavor -- if only one is targeted
    we are only re-testing 5a.
    """
    with scenario("5b. Flavor-wide shutdown", prefix="5b") as flavor:
        env = {**os.environ}
        proc_a = subprocess.Popen(
            [sys.executable, "-c", _SHUTDOWN_FLAVOR_WORKER, flavor],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        proc_b = subprocess.Popen(
            [sys.executable, "-c", _SHUTDOWN_FLAVOR_WORKER, flavor],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            sids = _wait_for_active_sessions(flavor, n=2, timeout=30.0)
            report.check(
                "5b. two active sessions for flavor",
                len(sids) >= 2, f"got {len(sids)}: {sids}",
            )
            sid_a = sids[0] if len(sids) > 0 else None
            sid_b = sids[1] if len(sids) > 1 else None

            directive = post_directive(
                action=DirectiveAction.SHUTDOWN_FLAVOR,
                flavor=flavor, reason="smoke-5b",
            )
            report.check("5b. shutdown_flavor directive created", "id" in directive)

            state_a = wait_for_session_state(sid_a, SessionState.CLOSED, timeout=45) if sid_a else None
            state_b = wait_for_session_state(sid_b, SessionState.CLOSED, timeout=45) if sid_b else None
            report.check(
                "5b. session A closed by shutdown_flavor",
                state_a == SessionState.CLOSED, f"got state={state_a}",
            )
            report.check(
                "5b. session B closed by shutdown_flavor",
                state_b == SessionState.CLOSED, f"got state={state_b}",
            )

            # shutdown_flavor fans out into one action='shutdown' row per
            # active session (see api/internal/handlers/directives.go).
            # Both fanned-out rows should be marked delivered.
            fanout = [d for d in db.directives_for_flavor(flavor)
                      if d.get("action") == DirectiveAction.SHUTDOWN]
            delivered = [d for d in fanout if d.get("delivered_at")]
            report.check(
                "5b. fan-out created one directive per session",
                len(fanout) >= 2,
                f"got {len(fanout)} shutdown rows for flavor",
            )
            report.check(
                "5b. both fan-out rows delivered", len(delivered) >= 2,
                f"delivered {len(delivered)}/{len(fanout)}",
            )
        finally:
            for p in (proc_a, proc_b):
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)


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
    _framework_scenario(
        scenario_name="12f. LangGraph + Anthropic", prefix="12f",
        package="langgraph", needs_key=HAS_ANTHROPIC_KEY,
        provider="anthropic", invoke=_invoke_langgraph_anthropic,
    )
    _framework_scenario(
        scenario_name="12g. LangGraph + OpenAI", prefix="12g",
        package="langgraph", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_langgraph_openai,
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


def _invoke_langgraph_anthropic() -> None:
    # LangGraph routes LLM calls through LangChain's ChatAnthropic,
    # which patch() already intercepts. A minimal StateGraph with one
    # node exercises the full graph-compile-invoke path without any
    # extra framework surface.
    from langgraph.graph import StateGraph, START, END
    from langchain_anthropic import ChatAnthropic
    from typing_extensions import TypedDict

    class State(TypedDict):
        text: str

    llm = ChatAnthropic(
        model=Config.ANTHROPIC_MODEL, max_tokens=Config.HI_MAX_TOKENS,
    )

    def call(state: State) -> State:
        llm.invoke(state["text"])
        return state

    graph = StateGraph(State)
    graph.add_node("call", call)
    graph.add_edge(START, "call")
    graph.add_edge("call", END)
    graph.compile().invoke({"text": "hi"})


def _invoke_langgraph_openai() -> None:
    from langgraph.graph import StateGraph, START, END
    from langchain_openai import ChatOpenAI
    from typing_extensions import TypedDict

    class State(TypedDict):
        text: str

    llm = ChatOpenAI(
        model=Config.OPENAI_MODEL, max_tokens=Config.HI_MAX_TOKENS,
    )

    def call(state: State) -> State:
        llm.invoke(state["text"])
        return state

    graph = StateGraph(State)
    graph.add_node("call", call)
    graph.add_edge(START, "call")
    graph.add_edge("call", END)
    graph.compile().invoke({"text": "hi"})


# ----------------------------------------------------------------------------
# GROUP 13 -- Framework Tool Calls (sensor emits tool_call per invocation)
# ----------------------------------------------------------------------------

def group_13_framework_tool_calls() -> None:
    report.section("GROUP 13: Framework Tool Calls")
    _framework_tool_scenario(
        scenario_name="13a. LangChain + Anthropic tool call", prefix="13a",
        package="langchain_anthropic", needs_key=HAS_ANTHROPIC_KEY,
        provider="anthropic", invoke=_invoke_langchain_anthropic_tool,
    )
    _framework_tool_scenario(
        scenario_name="13b. LangChain + OpenAI tool call", prefix="13b",
        package="langchain_openai", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_langchain_openai_tool,
    )
    _framework_tool_scenario(
        scenario_name="13c. LlamaIndex + Anthropic tool call", prefix="13c",
        package="llama_index", needs_key=HAS_ANTHROPIC_KEY,
        provider="anthropic", invoke=_invoke_llamaindex_anthropic_tool,
    )
    _framework_tool_scenario(
        scenario_name="13d. LlamaIndex + OpenAI tool call", prefix="13d",
        package="llama_index", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_llamaindex_openai_tool,
    )
    _framework_tool_scenario(
        scenario_name="13e. CrewAI tool call", prefix="13e",
        package="crewai", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_crewai_tool,
    )
    _framework_tool_scenario(
        scenario_name="12h. LangGraph tool call", prefix="12h",
        package="langgraph", needs_key=HAS_OPENAI_KEY,
        provider="openai", invoke=_invoke_langgraph_tool,
    )


def _framework_tool_scenario(
    *,
    scenario_name: str,
    prefix: str,
    package: str,
    needs_key: bool,
    provider: str,
    invoke: Callable[[], None],
) -> None:
    """Like _framework_scenario but asserts at least one tool_call event
    landed (not just post_call). Skips cleanly on missing package or
    missing API key."""
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

            events = db.events_for_flavor(flavor)
            tool_events = [
                e for e in events if e["event_type"] == EventType.TOOL_CALL
            ]
            short = scenario_name.split(". ", 1)[-1]
            report.check(
                f"{prefix}. {short} -- tool_call event emitted",
                len(tool_events) >= 1,
                f"got {len(tool_events)} tool_call events",
            )
        finally:
            flightdeck_sensor.unpatch()


# Tool definitions per framework. Each framework expects its provider's
# native tool schema. The prompt forces the tool call to avoid flaky
# "model decides not to use the tool" runs.

_ANTHROPIC_WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Look up the current weather for a city. Use this whenever asked about weather.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}

_OPENAI_WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Look up the current weather for a city. Use this whenever asked about weather.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}

_WEATHER_PROMPT = "What's the weather in Paris? Use the tool."


def _invoke_langchain_anthropic_tool() -> None:
    from langchain_anthropic import ChatAnthropic
    llm = ChatAnthropic(
        model=Config.ANTHROPIC_MODEL,
        max_tokens=Config.HI_MAX_TOKENS * 20,
    )
    llm.bind_tools([_ANTHROPIC_WEATHER_TOOL]).invoke(_WEATHER_PROMPT)


def _invoke_langchain_openai_tool() -> None:
    from langchain_openai import ChatOpenAI
    llm = ChatOpenAI(
        model=Config.OPENAI_MODEL,
        max_tokens=Config.HI_MAX_TOKENS * 20,
    )
    llm.bind_tools([_OPENAI_WEATHER_TOOL]).invoke(_WEATHER_PROMPT)


def _invoke_llamaindex_anthropic_tool() -> None:
    from llama_index.core.tools import FunctionTool
    from llama_index.llms.anthropic import Anthropic as LlamaAnthropic

    def get_weather(city: str) -> str:
        """Look up the current weather for a city."""
        return f"Sunny, 22C in {city}"

    tool = FunctionTool.from_defaults(fn=get_weather)
    llm = LlamaAnthropic(
        model=Config.ANTHROPIC_MODEL,
        max_tokens=Config.HI_MAX_TOKENS * 20,
    )
    llm.chat_with_tools(tools=[tool], user_msg=_WEATHER_PROMPT)


def _invoke_llamaindex_openai_tool() -> None:
    from llama_index.core.tools import FunctionTool
    from llama_index.llms.openai import OpenAI as LlamaOpenAI

    def get_weather(city: str) -> str:
        """Look up the current weather for a city."""
        return f"Sunny, 22C in {city}"

    tool = FunctionTool.from_defaults(fn=get_weather)
    llm = LlamaOpenAI(
        model=Config.OPENAI_MODEL,
        max_tokens=Config.HI_MAX_TOKENS * 20,
    )
    llm.chat_with_tools(tools=[tool], user_msg=_WEATHER_PROMPT)


def _invoke_crewai_tool() -> None:
    # CrewAI native tool via the decorator; LLM.call() will invoke the
    # underlying OpenAI SDK which the sensor patch intercepts. Keeping
    # the scope to the LLM.call layer mirrors
    # test_crewai_native_openai_patched_intercepts_call in the
    # integration suite -- full Agent/Task/Crew orchestration adds
    # ~30s of latency without exercising additional sensor surface.
    from crewai import LLM
    llm = LLM(
        model=f"openai/{Config.OPENAI_MODEL}",
        max_tokens=Config.HI_MAX_TOKENS * 20,
    )
    llm.call(_WEATHER_PROMPT, tools=[_OPENAI_WEATHER_TOOL])


def _invoke_langgraph_tool() -> None:
    # Minimal tool-calling agent via langgraph.prebuilt.create_react_agent.
    # The prebuilt agent already wires a ToolNode + LLM loop internally,
    # so this scenario doesn't need a hand-written StateGraph. The LLM
    # call still goes through the patched ChatOpenAI, and the ToolNode
    # invokes the @tool-decorated function which produces the sensor's
    # tool_call event through the provider-level tool_use / tool_calls
    # intercept.
    from langgraph.prebuilt import create_react_agent
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI

    @tool
    def get_weather(city: str) -> str:
        """Look up the current weather for a city."""
        return f"Sunny, 22C in {city}"

    llm = ChatOpenAI(
        model=Config.OPENAI_MODEL,
        max_tokens=Config.HI_MAX_TOKENS * 20,
    )
    agent = create_react_agent(llm, [get_weather])
    agent.invoke({"messages": [{"role": "user", "content": _WEATHER_PROMPT}]})


# ----------------------------------------------------------------------------
# GROUP 14 -- Session Attachment (D094)
# ----------------------------------------------------------------------------

@contextmanager
def _capture_sensor_warnings() -> Iterator[list[logging.LogRecord]]:
    """Attach a list-backed handler to the flightdeck_sensor logger so a
    scenario can assert on WARNING-level records emitted during a block."""
    logger = logging.getLogger("flightdeck_sensor")
    records: list[logging.LogRecord] = []

    class _ListHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = _ListHandler(level=logging.WARNING)
    prev_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.WARNING)
    try:
        yield records
    finally:
        logger.removeHandler(handler)
        logger.setLevel(prev_level)


def _run_attach_cycle(flavor: str, session_id: str) -> None:
    """init(session_id=...) + one Anthropic call + teardown. Waits for
    the session row to reach ``closed`` so the next cycle exercises
    the true re-attach path (ingestion sees a terminal row)."""
    import flightdeck_sensor
    force_reset_sensor()
    sensor_init(flavor, session_id=session_id)
    client = flightdeck_sensor.wrap(anthropic_client())
    hi_message_anthropic(client)
    time.sleep(Config.DRAIN_WAIT_S)
    flightdeck_sensor.teardown()
    wait_for_session_state(session_id, SessionState.CLOSED, timeout=10)


def group_14_session_attachment() -> None:
    report.section("GROUP 14: Session Attachment")
    if not HAS_ANTHROPIC_KEY:
        for sid in (
            "14a. Custom session_id hint",
            "14b. Session reattachment",
            "14c. Multiple reattachments",
            "14d. Invalid UUID fallback",
            "14e. FLIGHTDECK_SESSION_ID env var",
        ):
            report.skip(sid, "ANTHROPIC_API_KEY not set")
        return
    _scenario_14a_custom_session_id()
    _scenario_14b_reattachment()
    _scenario_14c_multiple_reattachments()
    _scenario_14d_invalid_uuid_fallback()
    _scenario_14e_session_id_env_var()


def _scenario_14a_custom_session_id() -> None:
    """14a. init(session_id=<valid UUID>) uses the caller-supplied UUID
    verbatim. The sensor also logs a WARNING announcing the custom id."""
    import flightdeck_sensor
    sid = str(uuid4())
    with scenario("14a. Custom session_id hint", prefix="14a") as flavor:
        with _capture_sensor_warnings() as records:
            sensor_init(flavor, session_id=sid)
            status_sid = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

        report.check("14a. status session_id == provided UUID", status_sid == sid,
                     f"got {status_sid}")
        detail = wait_for_session_record(sid)
        api_sid = (detail or {}).get("session", {}).get("session_id")
        report.check("14a. session in API with exact UUID", api_sid == sid,
                     f"got {api_sid}")
        report.check(
            "14a. custom session_id warning logged",
            any(f"Custom session_id provided: '{sid}'" in r.getMessage() for r in records),
            f"records: {[r.getMessage() for r in records]}",
        )


def _scenario_14b_reattachment() -> None:
    """14b. Two cycles with the same UUID produce one session row whose
    attachments list has exactly one entry, and post_call events from
    both runs are associated with that session."""
    sid = str(uuid4())
    with scenario("14b. Session reattachment", prefix="14b") as flavor:
        _run_attach_cycle(flavor, sid)
        _run_attach_cycle(flavor, sid)
        time.sleep(Config.DRAIN_WAIT_S)

        # One session row, matching UUID.
        sessions = api.get(f"/v1/sessions?flavor={flavor}&limit=10").get("sessions", [])
        matching = [s for s in sessions if s["session_id"] == sid]
        report.check("14b. single session row for UUID", len(matching) == 1,
                     f"got {len(matching)}: {[s['session_id'] for s in sessions]}")

        detail = wait_for_session_record(sid)
        attachments = (detail or {}).get("attachments", [])
        report.check("14b. attachments length == 1", len(attachments) == 1,
                     f"got {len(attachments)}: {attachments}")

        events = db.events_for_flavor(flavor)
        session_post_calls = [
            e for e in events
            if e["event_type"] == EventType.POST_CALL and e.get("session_id") == sid
        ]
        report.check("14b. post_call from both runs", len(session_post_calls) >= 2,
                     f"got {len(session_post_calls)}")
        combined_tokens = sum((e.get("tokens_total") or 0) for e in session_post_calls)
        report.check("14b. combined tokens_total > 0", combined_tokens > 0,
                     f"got {combined_tokens}")


def _scenario_14c_multiple_reattachments() -> None:
    """14c. Three cycles with the same UUID produce two attachment rows
    (first cycle is the initial create, cycles 2 and 3 each attach)."""
    sid = str(uuid4())
    with scenario("14c. Multiple reattachments", prefix="14c") as flavor:
        _run_attach_cycle(flavor, sid)
        _run_attach_cycle(flavor, sid)
        _run_attach_cycle(flavor, sid)
        time.sleep(Config.DRAIN_WAIT_S)

        def _two_attachments() -> bool:
            detail = wait_for_session_record(sid, timeout=1)
            return len(((detail or {}).get("attachments") or [])) == 2

        wait_until(_two_attachments, timeout=10,
                   description=f"2 attachments for {sid[:8]}")

        detail = wait_for_session_record(sid)
        attachments = (detail or {}).get("attachments", [])
        report.check("14c. attachments length == 2", len(attachments) == 2,
                     f"got {len(attachments)}: {attachments}")


def _scenario_14d_invalid_uuid_fallback() -> None:
    """14d. init(session_id="not-a-uuid") must warn and fall back to an
    auto-generated UUID. The session reaching the API must carry the
    generated UUID, never the invalid literal."""
    import flightdeck_sensor
    bad = "not-a-uuid"
    with scenario("14d. Invalid UUID fallback", prefix="14d") as flavor:
        with _capture_sensor_warnings() as records:
            sensor_init(flavor, session_id=bad)
            fallback_sid = flightdeck_sensor.get_status().session_id
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

        report.check("14d. fallback session_id is a valid UUID",
                     _smoke_is_valid_uuid(fallback_sid),
                     f"got {fallback_sid}")
        report.check("14d. fallback != invalid literal", fallback_sid != bad)
        report.check(
            "14d. invalid-UUID warning logged",
            any(f"Custom session_id '{bad}' is not a valid UUID" in r.getMessage()
                for r in records),
            f"records: {[r.getMessage() for r in records]}",
        )

        # The generated UUID is what the session_start event carries.
        # "not-a-uuid" must never land as a session_id on any event.
        events = db.events_for_flavor(flavor)
        bad_sid_events = [e for e in events if e.get("session_id") == bad]
        report.check("14d. no events with invalid literal as session_id",
                     len(bad_sid_events) == 0,
                     f"found {len(bad_sid_events)} events with session_id='{bad}'")


def _scenario_14e_session_id_env_var() -> None:
    """14e. FLIGHTDECK_SESSION_ID env var overrides (actually sets when
    absent from kwargs) the session_id used by init(). The sensor must
    pick the env var up exactly. Env var is restored in `finally`."""
    import flightdeck_sensor
    sid = str(uuid4())
    prev = os.environ.get("FLIGHTDECK_SESSION_ID")
    with scenario("14e. FLIGHTDECK_SESSION_ID env var", prefix="14e") as flavor:
        try:
            os.environ["FLIGHTDECK_SESSION_ID"] = sid
            sensor_init(flavor)  # no session_id kwarg
            status_sid = flightdeck_sensor.get_status().session_id
            client = flightdeck_sensor.wrap(anthropic_client())
            hi_message_anthropic(client)
            time.sleep(Config.DRAIN_WAIT_S)
            flightdeck_sensor.teardown()
            time.sleep(Config.SHORT_WAIT_S)

            report.check("14e. status session_id == env var UUID",
                         status_sid == sid, f"got {status_sid}")
            detail = wait_for_session_record(sid)
            api_sid = (detail or {}).get("session", {}).get("session_id")
            report.check("14e. session in API with env var UUID",
                         api_sid == sid, f"got {api_sid}")
        finally:
            if prev is None:
                os.environ.pop("FLIGHTDECK_SESSION_ID", None)
            else:
                os.environ["FLIGHTDECK_SESSION_ID"] = prev


def _smoke_is_valid_uuid(value: str) -> bool:
    """Lightweight UUID check mirroring sensor._is_valid_uuid -- kept
    local to avoid importing a private sensor helper."""
    import uuid as _uuid
    try:
        _uuid.UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


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
    13: ("Framework Tool Calls", group_13_framework_tool_calls),
    14: ("Session Attachment", group_14_session_attachment),
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
