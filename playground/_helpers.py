"""Playground helpers — sensor bootstrap, dev-stack health, event-feed
poll, and the in-tree MCP reference-server StdioServerParameters
factory.

Anything beyond these helpers stops being a playground and starts
becoming a framework. Keep the surface tight.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

import flightdeck_sensor


# ---------------------------------------------------------------------
# Endpoints + auth — single source of truth for every playground script.
# ---------------------------------------------------------------------

INGESTION_URL = os.environ.get("FLIGHTDECK_SERVER", "http://localhost:4000/ingest")
API_URL = os.environ.get(
    "FLIGHTDECK_API_URL",
    INGESTION_URL.rstrip("/").replace("/ingest", "/api")
    if "/ingest" in INGESTION_URL
    else INGESTION_URL.rstrip("/") + "/api",
)
API_TOKEN = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")


# ---------------------------------------------------------------------
# Project root — playground scripts spawn ``python -m
# playground._mcp_reference_server`` and need cwd + PYTHONPATH pinned to
# the repo root so the module path resolves.
# ---------------------------------------------------------------------

_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


# ---------------------------------------------------------------------
# Required-env gate (skip-style exit when an opt-in script can't run).
# ---------------------------------------------------------------------


def require_env(*names: str) -> None:
    """Exit 2 (SKIP) when any of the listed env vars is unset.

    Playground scripts that need API keys / gateway URLs / opt-in flags
    call this at the top so ``run_all.py`` cleanly tags the row SKIP
    rather than failing the whole matrix on a missing key. The skip
    message lists every missing name so an operator sees the full gap
    in one run.
    """
    import sys

    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        print(
            f"SKIP: this script requires {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(2)


# ---------------------------------------------------------------------
# Dev-stack health probe.
# ---------------------------------------------------------------------


def wait_for_dev_stack(timeout_s: float = 30.0) -> None:
    """Block until ingestion + api ``/health`` both return 200.

    Playground scripts depend on ``make dev``; if the stack isn't up
    every script hangs uninformatively while the sensor retries POSTs.
    Explicit probe with a bounded timeout keeps the failure mode loud
    and points operators at the right knob.
    """
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            for url in (f"{INGESTION_URL}/health", f"{API_URL}/health"):
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=2) as r:
                    if r.status != 200:
                        raise RuntimeError(f"{url} -> {r.status}")
            return
        except Exception as exc:
            last_err = exc
        time.sleep(0.5)
    raise RuntimeError(
        f"dev stack not ready within {timeout_s}s; is ``make dev`` running? "
        f"Last error: {last_err!r}",
    )


# ---------------------------------------------------------------------
# Sensor bootstrap.
# ---------------------------------------------------------------------


def init_sensor(
    session_id: str,
    *,
    flavor: str,
    agent_type: str = "coding",
    capture_prompts: bool = True,
    **overrides: Any,
) -> None:
    """flightdeck_sensor.init() with playground defaults.

    Required keyword-only ``flavor`` -- every playground script must
    declare a meaningful agent identity (CLAUDE.md rule 40a / sub-rule
    A). No default here because "one size fits all" would re-introduce
    the ``flavor="unknown"`` failure mode this signature exists to
    prevent. Convention: ``playground-<script-name>``.

    ``agent_type`` defaults to ``"coding"`` -- playground scripts are
    developer-facing smoke, matching the locked agent_type vocabulary for
    developer-driven sessions. Override only if the script is
    exercising a non-coding persona on purpose.

    ``capture_prompts`` defaults to ``True`` (sub-rule B). Playground
    is the highest-fidelity smoke surface; it exists to demonstrate
    what the sensor can see, not to validate a minimal happy path.
    ``09_capture.py`` overrides this to exercise the on/off matrix
    explicitly -- otherwise every script captures maximally.

    ``flavor`` propagates via the ``AGENT_FLAVOR`` env var so the
    wire-level ``flavor`` column on sessions carries the playground
    script's intent. ``agent_type`` is passed as a kwarg directly to
    ``flightdeck_sensor.init``.

    Env overrides: FLIGHTDECK_SERVER (default http://localhost:4000/ingest),
    FLIGHTDECK_TOKEN (default tok_dev), FLIGHTDECK_API_URL (derived).

    The sensor's ``init()`` normalises a plugin-style
    ``FLIGHTDECK_SERVER`` (no ``/ingest`` suffix) on its own, so this
    helper no longer needs to. We still compute ``api_url`` by replacing
    ``/ingest`` with ``/api`` for the default case so the
    ``assert_event_landed`` caller in this module has a base URL to
    hit without another env-var override.
    """
    # Wire-level ``flavor`` column propagation. Sensor reads
    # AGENT_FLAVOR from env; setting it explicitly guarantees the
    # helper's flavor wins even if a caller has stale values in
    # their shell.
    os.environ["AGENT_FLAVOR"] = flavor

    flightdeck_sensor.init(
        server=INGESTION_URL,
        token=API_TOKEN,
        api_url=API_URL,
        session_id=session_id,
        capture_prompts=capture_prompts,
        agent_type=agent_type,
        quiet=True,
        **overrides,
    )


# ---------------------------------------------------------------------
# Event-feed assertions.
# ---------------------------------------------------------------------


def assert_event_landed(
    session_id: str,
    event_type: str,
    timeout: float = 5.0,
    model_contains: str | None = None,
) -> None:
    """Poll GET /api/v1/sessions/{id} until *event_type* appears.

    When *model_contains* is given, also require that at least one
    matching event's `model` field contains that substring -- use this
    to tie the assertion to a specific provider call rather than any
    event of the requested type.
    """
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    deadline = time.monotonic() + timeout
    seen_types: set[str] = set()
    seen_models: set[str] = set()
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(req, timeout=2) as r:
                events = json.loads(r.read()).get("events", [])
            seen_types = {e["event_type"] for e in events}
            matches = [e for e in events if e.get("event_type") == event_type]
            seen_models = {e.get("model") or "" for e in matches}
            if event_type in seen_types and (
                model_contains is None
                or any(model_contains in (e.get("model") or "") for e in matches)
            ):
                return
        except Exception:
            pass
        time.sleep(0.3)
    detail = (
        f"with model containing {model_contains!r} (saw models {sorted(seen_models)})"
        if model_contains
        else f"(saw {sorted(seen_types) or 'nothing'})"
    )
    raise AssertionError(
        f"event_type {event_type!r} never arrived for session {session_id} "
        f"within {timeout}s {detail}. Is the stack running at {API_URL}?"
    )


def fetch_events_for_session(
    session_id: str,
    *,
    timeout_s: float = 15.0,
    poll_s: float = 0.3,
    expect_event_types: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Poll ``/v1/events?session_id=<uuid>`` until the expected events
    are visible.

    Returns the full events list once every type in
    ``expect_event_types`` is present (default: ``["session_start"]``
    — sensor's first emission), or whatever was observed by
    ``timeout_s``. Playground scripts pass higher-bar lists like
    ``["session_start", "post_call"]`` to wait for the streaming
    drain reconciliation event before asserting on its payload.

    ``from`` is required by the API — without it the endpoint 400s
    and the helper would silently treat it as "no events yet".
    """
    expect = set(expect_event_types or ["session_start"])
    deadline = time.monotonic() + timeout_s
    last: list[dict[str, Any]] = []
    params = f"session_id={session_id}&from=2020-01-01T00:00:00Z&limit=100"
    req = urllib.request.Request(
        f"{API_URL}/v1/events?{params}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                last = json.loads(r.read()).get("events", [])
            seen = {e.get("event_type") for e in last}
            if expect.issubset(seen):
                return last
        except Exception:
            pass
        time.sleep(poll_s)
    return last


def assert_token_cost_fields(
    session_id: str,
    *,
    provider: str,
    platform: str,
    billing_mode: str = "metered",
    require_cost: bool = False,
) -> list[dict[str, Any]]:
    """Assert every post_call of the session carries the token, model and
    cost fields the sensor stamps and the worker fills (ARCHITECTURE.md,
    Cost estimation): the requested and canonical model ids, the
    provider, the billing mode and the serving platform, plus a reported
    cost when ``require_cost``. Returns the post_calls checked."""
    events = fetch_events_for_session(session_id, expect_event_types=["post_call"])
    post_calls = [e for e in events if e.get("event_type") == "post_call"]
    problems: list[str] = []
    for e in post_calls:
        want = {"provider": provider, "billing_mode": billing_mode, "platform": platform}
        for key, value in want.items():
            if e.get(key) != value:
                problems.append(f"{e['id']}: {key}={e.get(key)!r}, want {value!r}")
        if not e.get("model_requested") or not e.get("model"):
            problems.append(f"{e['id']}: model ids missing ({e.get('model_requested')!r})")
        if require_cost and not (
            isinstance(e.get("cost_reported"), (int, float)) and e.get("cost_source") == "agent"
        ):
            problems.append(f"{e['id']}: no reported cost ({e.get('cost_reported')!r})")
    passed = bool(post_calls) and not problems
    print_result(
        "post_call token and cost fields",
        passed,
        0,
        f"{len(post_calls)} post_calls; provider={provider} platform={platform}"
        f" billing={billing_mode}",
    )
    if not passed:
        raise AssertionError(f"token and cost fields wrong: {problems or 'no post_call'}")
    return post_calls


# ---------------------------------------------------------------------
# MCP server StdioServerParameters factory.
# ---------------------------------------------------------------------


def mcp_server_params(module: str) -> Any:
    """Return ``StdioServerParameters`` for an in-tree MCP server module
    (currently ``playground._mcp_reference_server`` and
    ``playground._secondary_mcp_server``), with ``cwd`` + PYTHONPATH
    pinned to the project root so ``python -m <module>`` resolves
    regardless of where the playground was launched from.

    Imports the mcp SDK lazily so playground scripts that don't import
    mcp at all still load on a clean venv.
    """
    from mcp import StdioServerParameters
    import sys

    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", module],
        cwd=_PROJECT_ROOT,
        env=server_env,
    )


# ---------------------------------------------------------------------
# Result line.
# ---------------------------------------------------------------------


# The newest llama-index-llms-anthropic release known to send
# ``temperature``, which anthropic 1.x's Messages.create rejects.
LLAMA_INDEX_ANTHROPIC_LAST_INCOMPATIBLE = (0, 12, 3)


def llama_index_anthropic_incompatibility() -> str | None:
    """Why LlamaIndex's Anthropic LLM cannot run against the installed
    ``anthropic`` SDK, or None. llama-index-llms-anthropic (through
    0.12.3) always sends ``temperature``, which anthropic 1.x's
    ``Messages.create`` no longer accepts; the call fails inside the SDK
    with or without the sensor."""
    import inspect
    from importlib import metadata

    try:
        from anthropic.resources.messages.messages import Messages
    except ImportError:
        return None
    if "temperature" in inspect.signature(Messages.create).parameters:
        return None
    # Scoped to the releases known to send it, so a fixed release runs.
    try:
        adapter = metadata.version("llama-index-llms-anthropic")
    except metadata.PackageNotFoundError:
        return None
    parts = tuple(int(p) for p in adapter.split(".")[:3] if p.isdigit())
    if parts > LLAMA_INDEX_ANTHROPIC_LAST_INCOMPATIBLE:
        return None
    import anthropic

    return (
        f"anthropic {anthropic.__version__} rejects the temperature argument "
        "llama-index-llms-anthropic always sends"
    )


def print_result(label: str, passed: bool, duration_ms: int, details: str = "") -> None:
    """Standard result line: '  PASS  <label>  (1240ms)  <details>'."""
    tag = "PASS" if passed else "FAIL"
    print(f"  {tag}  {label}  ({duration_ms}ms){'  ' + details if details else ''}")


# How long a playground run waits for every streamed post_call to land:
# the sensor drains asynchronously and the workers write in batches, so
# the last stream's event can trail its call by several seconds; 20 s is
# an order of magnitude above the worst drain seen on the dev stack.
STREAMED_POST_CALL_DEADLINE_S = 20.0
# One fetch never blocks for more than this, so the deadline above stays
# the only bound on the wait.
STREAMED_POST_CALL_FETCH_TIMEOUT_S = 8.0
# Poll gap: quick enough to notice the last event promptly, slow enough
# not to hammer the API.
STREAMED_POST_CALL_POLL_S = 0.5


def wait_for_streamed_post_calls(
    session_id: str, expected: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Poll until ``expected`` post_call events carrying a ``streaming``
    block have landed for the session, or the deadline passes. Returns
    ``(events, streamed)``: every event of the session as last fetched and
    the streamed post_calls among them, so the caller can report a
    shortfall and keep inspecting the other events."""
    deadline = time.monotonic() + STREAMED_POST_CALL_DEADLINE_S
    while True:
        events = fetch_events_for_session(
            session_id,
            expect_event_types=["post_call"],
            timeout_s=STREAMED_POST_CALL_FETCH_TIMEOUT_S,
        )
        streamed = [
            e
            for e in events
            if e.get("event_type") == "post_call"
            and (e.get("payload") or {}).get("streaming")
        ]
        if len(streamed) >= expected or time.monotonic() > deadline:
            return events, streamed
        time.sleep(STREAMED_POST_CALL_POLL_S)
