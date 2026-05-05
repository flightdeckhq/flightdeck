"""Unit tests for the CrewAI sub-agent interceptor (D126).

Verifies the patch-then-execute flow against a mocked
``crewai.Agent.execute_task`` so the suite never calls a real LLM.
The wrapped ``execute_task`` must:

* emit a child ``session_start`` with parent_session_id, agent_role,
  and (when capture is on) the task description as
  ``incoming_message``;
* run the original method with its arguments preserved;
* emit a child ``session_end`` with state=``"closed"`` and the
  return value as ``outgoing_message`` on the success path;
* emit a child ``session_end`` with state=``"error"`` and a
  structured error block on the exception path, then re-raise;
* no-op (passthrough) when ``flightdeck_sensor._session`` is None.

Tests reach into the post_event call stream rather than mocking
``Session.emit_subagent_session_start`` directly, so the assertions
exercise the full payload-build chain (including the
capture_prompts gate inside ``Session``).
"""

from __future__ import annotations

import threading
from typing import Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import crewai as _crewai_mod
from flightdeck_sensor.interceptor.crewai import (
    patch_crewai_classes,
    unpatch_crewai_classes,
)
from flightdeck_sensor.transport.client import ControlPlaneClient


def _crewai_or_skip() -> Any:
    """Resolve the lazily-imported Agent class on first call. Used
    by every test that needs the class. Importing crewai pulls
    transitive deps into sys.modules so we defer until the test
    body actually runs (a module-level import would pollute
    sys.modules before unrelated framework-attribution tests get
    to set up their fixtures).
    """
    if not _crewai_mod._ensure_imported():
        pytest.skip("crewai not installed")
    return _crewai_mod._CrewAIAgent


# ----------------------------------------------------------------------
# Test scaffolding
# ----------------------------------------------------------------------


def _build_session(*, capture_prompts: bool = True) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_id="11111111-1111-1111-1111-111111111111",
        agent_name="parent-agent",
        user_name="tester",
        hostname="host1",
        client_type="flightdeck_sensor",
        agent_flavor="playground-test",
        agent_type="production",
        capture_prompts=capture_prompts,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    return session, client


@pytest.fixture()
def sensor_session() -> Any:
    """Wire a Session into the flightdeck_sensor singleton so the
    interceptor's ``_current_session()`` resolves it. Restores the
    prior state (typically ``None``) on exit so tests stay
    independent.
    """
    session, client = _build_session(capture_prompts=True)
    prior = flightdeck_sensor._session
    flightdeck_sensor._session = session
    try:
        yield session, client
    finally:
        flightdeck_sensor._session = prior
        try:
            session.event_queue.close()
        except Exception:  # noqa: BLE001
            pass


@pytest.fixture()
def crewai_agent_cls() -> Any:
    """Resolve and cache the real ``crewai.Agent`` class for the
    test session. Skips when crewai isn't installed.
    """
    return _crewai_or_skip()


@pytest.fixture()
def patched_crewai(sensor_session: Any, crewai_agent_cls: Any) -> Any:
    """Replace ``Agent.execute_task`` with a controllable mock
    BEFORE installing the interceptor, so the wrapper's captured
    ``original_sync`` IS the mock. Tests configure
    ``stub.return_value`` or ``stub.side_effect`` to drive the
    happy / failure paths without touching the real LLM call
    chain.

    Yields ``(session, client, stub, agent_cls)``. The class-level
    patch is serialised under a lock so a parallel test can't see a
    half-patched state.
    """
    lock = threading.Lock()
    with lock:
        real_sync = crewai_agent_cls.execute_task
        real_async = getattr(crewai_agent_cls, "aexecute_task", None)
        stub_sync = MagicMock(return_value="stub-result")
        crewai_agent_cls.execute_task = stub_sync
        if real_async is not None:
            crewai_agent_cls.aexecute_task = MagicMock(return_value="async-stub-result")

        patch_crewai_classes(quiet=True)
        session, client = sensor_session
        try:
            yield session, client, stub_sync, crewai_agent_cls
        finally:
            unpatch_crewai_classes()
            crewai_agent_cls.execute_task = real_sync
            if real_async is not None:
                crewai_agent_cls.aexecute_task = real_async


def _make_agent_with_role(role: str = "Researcher") -> Any:
    """Construct a real crewai.Agent. The LLM dependency is a stub
    BaseLLM subclass that satisfies Pydantic validation but is
    never actually invoked — the test replaces ``execute_task`` with
    a mock before any LLM call could happen. ``role`` is what the
    interceptor reads as ``agent_role`` for the derive_subagent_id
    path.
    """
    from crewai import Agent, BaseLLM

    class _StubLLM(BaseLLM):
        # Override the abstract __call__ surface with a no-op since
        # the test never lets it run.
        def call(self, *_args: Any, **_kwargs: Any) -> str:  # pragma: no cover
            return ""

    return Agent(
        role=role,
        goal="surface a finding",
        backstory="testing",
        llm=_StubLLM(model="stub-model", provider="openai"),
        allow_delegation=False,
    )


def _make_task(description: str = "Find something interesting") -> Any:
    from crewai import Task
    return Task(
        description=description,
        expected_output="a brief finding",
    )


def _post_event_calls(client: MagicMock) -> list[dict[str, Any]]:
    """Return the list of payload dicts that flowed through
    client.post_event (one per emit_subagent_session_* call).
    """
    return [call.args[0] for call in client.post_event.call_args_list]


# ----------------------------------------------------------------------
# Happy path
# ----------------------------------------------------------------------


def test_execute_task_emits_session_start_then_session_end(
    patched_crewai: Any,
) -> None:
    session, client, stub, _CrewAIAgent = patched_crewai
    stub.return_value = "finding text"
    agent = _make_agent_with_role("Researcher")

    task = _make_task("Find something interesting")
    result = agent.execute_task(task)

    assert result == "finding text"
    assert stub.call_count == 1
    payloads = _post_event_calls(client)
    assert len(payloads) == 2, f"expected 2 emits, got {len(payloads)}: {payloads!r}"
    start_p, end_p = payloads
    assert start_p["event_type"] == "session_start"
    assert start_p["agent_role"] == "Researcher"
    assert start_p["parent_session_id"] == session.config.session_id
    assert start_p["agent_id"] == session.derive_subagent_id("Researcher")
    assert start_p["agent_name"] == f"{session.config.agent_name}/Researcher"
    # capture_prompts=True so incoming_message lands on the wire.
    # has_content stays False — sub-agent messages route inline via
    # events.payload (D126 § 6 v1), not event_content.
    assert start_p["has_content"] is False
    assert start_p["incoming_message"]["body"] == "Find something interesting"

    assert end_p["event_type"] == "session_end"
    # Default state on success path is "closed"; the wire shape
    # omits the explicit state key (the worker's existing
    # session_end → state=closed projection takes over).
    assert "state" not in end_p
    assert end_p["has_content"] is False
    assert end_p["outgoing_message"]["body"] == "finding text"


def test_distinct_roles_produce_distinct_agent_ids(patched_crewai: Any) -> None:
    """A CrewAI Researcher and a CrewAI Writer running on the same
    host land under distinct agent_ids. This is the user-visible
    consequence of D126's conditional 6th-input identity
    derivation.
    """
    session, client, stub, _CrewAIAgent = patched_crewai
    stub.return_value = "x"

    researcher = _make_agent_with_role("Researcher")
    writer = _make_agent_with_role("Writer")
    researcher.execute_task(_make_task("a"))
    writer.execute_task(_make_task("b"))

    payloads = _post_event_calls(client)
    starts = [p for p in payloads if p["event_type"] == "session_start"]
    assert len(starts) == 2
    assert starts[0]["agent_id"] != starts[1]["agent_id"]


def test_same_role_re_executing_produces_same_agent_id(
    patched_crewai: Any,
) -> None:
    """A Researcher who runs twice in the same crew produces the
    same agent_id with distinct session_ids — the agent IS the
    role, the sessions are the runs.
    """
    session, client, stub, _CrewAIAgent = patched_crewai
    stub.return_value = "y"

    agent = _make_agent_with_role("Researcher")
    agent.execute_task(_make_task("a"))
    agent.execute_task(_make_task("b"))

    starts = [p for p in _post_event_calls(client) if p["event_type"] == "session_start"]
    assert len(starts) == 2
    assert starts[0]["agent_id"] == starts[1]["agent_id"]
    assert starts[0]["session_id"] != starts[1]["session_id"]


# ----------------------------------------------------------------------
# Capture-off path
# ----------------------------------------------------------------------


def test_capture_off_omits_incoming_and_outgoing(
    sensor_session: Any, crewai_agent_cls: Any,
) -> None:
    _CrewAIAgent = crewai_agent_cls
    """``capture_prompts=False`` must omit incoming_message and
    outgoing_message from the wire. has_content stays False.
    """
    session, client = sensor_session
    session.config.capture_prompts = False

    real_sync = _CrewAIAgent.execute_task
    real_async = getattr(_CrewAIAgent, "aexecute_task", None)
    stub = MagicMock(return_value="z")
    _CrewAIAgent.execute_task = stub
    if real_async is not None:
        _CrewAIAgent.aexecute_task = MagicMock(return_value="async-z")

    patch_crewai_classes(quiet=True)
    try:
        agent = _make_agent_with_role("Researcher")
        agent.execute_task(_make_task("describe x"))
    finally:
        unpatch_crewai_classes()
        _CrewAIAgent.execute_task = real_sync
        if real_async is not None:
            _CrewAIAgent.aexecute_task = real_async

    payloads = _post_event_calls(client)
    for p in payloads:
        assert "incoming_message" not in p
        assert "outgoing_message" not in p
        assert p["has_content"] is False


# ----------------------------------------------------------------------
# Failure path (L8 row-level cue)
# ----------------------------------------------------------------------


def test_exception_in_execute_task_emits_state_error(patched_crewai: Any) -> None:
    """The framework's ``execute_task`` raises → child session_end
    fires with ``state="error"`` and a structured error block. The
    original exception re-raises so the framework's caller still
    sees it.
    """
    session, client, stub, _CrewAIAgent = patched_crewai
    stub.side_effect = RuntimeError("LLM downtime")
    agent = _make_agent_with_role("Researcher")

    with pytest.raises(RuntimeError, match="LLM downtime"):
        agent.execute_task(_make_task("x"))

    payloads = _post_event_calls(client)
    assert len(payloads) == 2
    start_p, end_p = payloads
    assert start_p["event_type"] == "session_start"
    assert end_p["event_type"] == "session_end"
    assert end_p["state"] == "error"
    assert end_p["error"] == {
        "type": "RuntimeError",
        "message": "LLM downtime",
    }
    # Outgoing absent on the error path (no return value to capture).
    assert "outgoing_message" not in end_p


# ----------------------------------------------------------------------
# Sentinel behaviour
# ----------------------------------------------------------------------


def test_no_active_session_passes_through(
    sensor_session: Any, crewai_agent_cls: Any,
) -> None:
    _CrewAIAgent = crewai_agent_cls
    """When ``flightdeck_sensor._session`` is None, the patched
    ``execute_task`` should run the original method without
    emitting any events. Mirrors the existing
    ``litellm.SensorLitellm`` no-session passthrough behaviour.
    """
    _, client = sensor_session
    flightdeck_sensor._session = None  # type: ignore[assignment]

    real_sync = _CrewAIAgent.execute_task
    real_async = getattr(_CrewAIAgent, "aexecute_task", None)
    stub = MagicMock(return_value="passthrough")
    _CrewAIAgent.execute_task = stub
    if real_async is not None:
        _CrewAIAgent.aexecute_task = MagicMock(return_value="async-passthrough")

    patch_crewai_classes(quiet=True)
    try:
        agent = _make_agent_with_role("Researcher")
        result = agent.execute_task(_make_task("x"))
    finally:
        unpatch_crewai_classes()
        _CrewAIAgent.execute_task = real_sync
        if real_async is not None:
            _CrewAIAgent.aexecute_task = real_async

    assert result == "passthrough"
    assert stub.call_count == 1
    assert client.post_event.call_count == 0


def test_patch_idempotent(
    sensor_session: Any, crewai_agent_cls: Any,
) -> None:
    _CrewAIAgent = crewai_agent_cls
    """Two consecutive ``patch_crewai_classes`` calls are
    equivalent to one — second run is a no-op so wrapping doesn't
    stack and produce double emits per turn.
    """
    patch_crewai_classes(quiet=True)
    first_wrapper = _CrewAIAgent.execute_task
    patch_crewai_classes(quiet=True)
    second_wrapper = _CrewAIAgent.execute_task
    unpatch_crewai_classes()

    assert first_wrapper is second_wrapper
