"""LlamaIndex agent-workflow interceptor.

Reports each agent of a LlamaIndex agent workflow run (``FunctionAgent``,
``ReActAgent``, ``CodeActAgent``, a multi-agent ``AgentWorkflow``) as a
child session of the sensor's session, with its hand-offs. The child
sessions carry the run's structure (start, end, hand-off signals); the
agents' model calls, tool calls and MCP calls are reported on the
sensor's session, as for the CrewAI and LangGraph wraps.

Seam. LlamaIndex's instrumentation dispatcher calls every span handler
attached to the root dispatcher when a span enters, exits or is dropped.
An agent workflow run opens a run span whose instance is the agent or
workflow (id ``<Class>.run-<uuid>``), and each of its steps opens a span
parented on the run span, in the step's own task, with the step's input
event among its bound arguments. A span handler therefore sees, in the
context the step's code runs in, which run a step belongs to and which
agent it serves; no LlamaIndex class or method is replaced.

Per run the handler keeps the agent whose child session is open:

* the first step event naming an agent (``AgentInput``, ``AgentSetup``,
  ``AgentOutput`` carry ``current_agent_name``) opens its child, with the
  run's ``user_msg`` as the incoming message;
* a step naming another agent is a hand-off: the ``agent_handoff``
  signal goes on the agent handing off, its child ends (its last
  response as the outgoing message) and the next agent's child opens
  (the hand-off's ``reason`` as the incoming message);
* the run span's exit ends the open child, and its drop (the run raised)
  ends it with ``state=error``.

Tool calls. A tool the model asked for in a structured tool call is
already a ``tool_call`` event from the model's response. Every step of a
run runs inside its open child's scope (:meth:`Session.enter_subagent_scope`),
entered when the step's span enters and left when it exits, and the
interceptor base records the call ids of a response's tool calls in that
scope. The handler reports a ``tool_call`` for a tool run only when no
response in the child reported its id: ``ReActAgent`` and
``CodeActAgent`` parse their tool calls from the model's text and give
them fresh ids.

Fail-open per Rule 28: the dispatcher discards whatever a span handler
raises, and the handler also catches its own failures, so LlamaIndex
runs on as if unobserved.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.tool_capture import build_tool_capture_content
from flightdeck_sensor.core.types import EventType, SubagentMessage, SubagentScope

if TYPE_CHECKING:
    from contextvars import Token

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.llama_index")

# The oldest llama-index-core the handler reads correctly: 0.14 is the
# first line on llama-index-workflows 2, whose step spans are parented on
# a run span that names the agent workflow. Older releases are left
# unwrapped (their model calls are still metered).
LLAMA_INDEX_CORE_FLOOR: tuple[int, int] = (0, 14)

# AgentWorkflow's built-in hand-off tool, and the argument that says why.
_HANDOFF_TOOL_NAME = "handoff"
_HANDOFF_REASON_ARG = "reason"

# The informational ``provider`` of a tool_call's content envelope when
# the handler, not a model response, reported the tool run.
_TOOL_CONTENT_PROVIDER = "llama_index"

_AGENT_WORKFLOW_MODULE = "llama_index.core.agent.workflow"

# Exceptions llama-index-workflows raises through a step's span to steer
# the run, not because the step failed: the end of the run, and a step
# waiting for an event.
_STEP_CONTROL_FLOW_EXCEPTIONS = frozenset({"WorkflowDone", "WaitingForEvent"})


def _current_session() -> Session | None:
    import flightdeck_sensor

    return flightdeck_sensor._session


def _core_version() -> tuple[int, int] | None:
    """llama-index-core's (major, minor), or None when it cannot be read."""
    try:
        from importlib.metadata import version

        parts = version("llama-index-core").split(".")
        return int(parts[0]), int(parts[1])
    except Exception:  # noqa: BLE001 -- unknown version: assume current
        return None


def _is_agent_workflow(instance: Any) -> bool:
    """Whether ``instance`` is an agent or a multi-agent workflow. The
    agent-workflow module is looked up, never imported: an instance of
    one of its classes means it is loaded."""
    module = sys.modules.get(_AGENT_WORKFLOW_MODULE)
    if module is None:
        return False
    candidates = (
        getattr(module, "BaseWorkflowAgent", None),
        getattr(module, "AgentWorkflow", None),
    )
    classes = tuple(c for c in candidates if isinstance(c, type))
    return bool(classes) and isinstance(instance, classes)


def _event_field(event: Any, name: str) -> Any:
    """A field of a workflow event, or None. A StartEvent keeps the run's
    keyword arguments as dynamic fields, which ``get`` reads."""
    try:
        value = getattr(event, name, None)
        if value is None and hasattr(event, "get"):
            value = event.get(name)
        return value
    except Exception:  # noqa: BLE001
        return None


def _message_text(message: Any) -> Any:
    """A chat message as its text (LlamaIndex's ``ChatMessage.content``);
    anything else as it is."""
    if message is None or isinstance(message, str):
        return message
    try:
        content = message.content
    except Exception:  # noqa: BLE001
        return message
    return content if content is not None else message


def _json_safe(value: Any) -> Any:
    """``value`` in a form json.dumps encodes: tool arguments and output
    come from the model and the tool, and anything else is its string."""
    try:
        return json.loads(json.dumps(value, default=str))
    except Exception:  # noqa: BLE001
        return str(value)


def _error_block(err: BaseException) -> dict[str, Any]:
    """A child ``session_end``'s error block, as the other wraps build it."""
    return {"type": type(err).__name__, "message": str(err)}


def _subagent_message(body: Any) -> SubagentMessage | None:
    if body is None:
        return None
    return SubagentMessage(body=body, captured_at=datetime.now(UTC).isoformat())


@dataclass
class _Child:
    """The open child session of one agent of a run."""

    agent_name: str
    scope: SubagentScope
    last_output: Any = None


@dataclass
class _Run:
    """One agent workflow run the handler follows."""

    session: Session
    user_msg: Any = None
    handoff_reason: Any = None
    child: _Child | None = None
    # The error of the run's latest failed step, cleared when a later
    # step completes (a retried step). llama-index-workflows releases
    # before the run span drops on failure exit it instead.
    step_error: BaseException | None = None


@dataclass
class _Step:
    """A step span of a followed run, entered in a child's scope."""

    run: _Run
    token: Token[SubagentScope | None] | None
    scope: SubagentScope | None
    tool_call: tuple[str, Any, str | None] | None = None
    started: float = field(default_factory=time.monotonic)


class _Tracker:
    """The runs and step spans the span handler follows. Steps of one run
    can run on worker threads (a sync step), so the maps change under a
    lock; the sensor's events are emitted outside it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: dict[str, _Run] = {}
        self._steps: dict[str, _Step] = {}

    # -- span callbacks -------------------------------------------------

    def enter(self, id_: str, bound_args: Any, instance: Any, parent_id: str | None) -> None:
        if instance is not None and id_.startswith(f"{type(instance).__name__}.run-"):
            if _is_agent_workflow(instance):
                session = _current_session()
                if session is not None:
                    with self._lock:
                        self._runs[id_] = _Run(session=session)
            return
        if parent_id is None:
            return
        with self._lock:
            run = self._runs.get(parent_id)
        if run is None:
            return
        arguments = getattr(bound_args, "arguments", None) or {}
        event = arguments.get("ev")
        tool_call = self._observe(run, event)
        with self._lock:
            child = run.child
        scope = child.scope if child is not None else None
        token = run.session.enter_subagent_scope(scope) if scope is not None else None
        with self._lock:
            self._steps[id_] = _Step(run=run, token=token, scope=scope, tool_call=tool_call)

    def exit(self, id_: str, result: Any) -> None:
        with self._lock:
            run = self._runs.pop(id_, None)
            step = self._steps.pop(id_, None)
        if run is not None:
            self._forget_steps(run)
            failed = run.step_error
            if failed is not None:
                self._end_child(run, state="error", error=_error_block(failed))
            else:
                self._end_child(run, state="closed", error=None)
            return
        if step is not None:
            with self._lock:
                step.run.step_error = None
            try:
                if step.tool_call is not None and step.scope is not None:
                    self._report_tool_run(step, result)
            finally:
                if step.token is not None:
                    step.run.session.exit_subagent_scope(step.token)

    def drop(self, id_: str, err: BaseException | None) -> None:
        with self._lock:
            run = self._runs.pop(id_, None)
            step = self._steps.pop(id_, None)
        if run is not None:
            self._forget_steps(run)
            failed = err if err is not None else run.step_error
            error = _error_block(failed) if failed is not None else None
            self._end_child(run, state="error", error=error)
            return
        if step is None:
            return
        if err is not None and type(err).__name__ not in _STEP_CONTROL_FLOW_EXCEPTIONS:
            with self._lock:
                step.run.step_error = err
        if step.token is not None:
            step.run.session.exit_subagent_scope(step.token)

    def close(self) -> None:
        """End every followed run's open child (``state=closed``) and forget
        the runs and their steps: the wrap is being detached, and the spans
        that would have ended them will not reach it."""
        with self._lock:
            runs = list(self._runs.values())
            self._runs.clear()
        for run in runs:
            self._forget_steps(run)
            self._end_child(run, state="closed", error=None)

    def _forget_steps(self, run: _Run) -> None:
        """Drop the run's step spans that never exited (a cancelled run's
        in-flight steps end without a span exit or drop) and leave their
        scopes. A step's scope token belongs to the step's own context, so
        leaving it from here only succeeds where that context is this one;
        a step whose task is gone took its context, and its scope, with it."""
        with self._lock:
            ids = [i for i, step in self._steps.items() if step.run is run]
            steps = [self._steps.pop(i) for i in ids]
        for step in steps:
            if step.token is not None:
                run.session.exit_subagent_scope(step.token)

    # -- run state ------------------------------------------------------

    def _observe(self, run: _Run, event: Any) -> tuple[str, Any, str | None] | None:
        """Update the run from a step's input event; returns the tool call
        when the step runs one."""
        if event is None:
            return None
        agent_name = _event_field(event, "current_agent_name")
        if isinstance(agent_name, str) and agent_name:
            self._switch_to(run, agent_name)
            response = _event_field(event, "response")
            if response is not None:
                with self._lock:
                    if run.child is not None:
                        run.child.last_output = _message_text(response)
            return None
        tool_name = _event_field(event, "tool_name")
        if isinstance(tool_name, str) and _event_field(event, "tool_output") is None:
            kwargs = _event_field(event, "tool_kwargs")
            tool_id = _event_field(event, "tool_id")
            if tool_name == _HANDOFF_TOOL_NAME and isinstance(kwargs, dict):
                with self._lock:
                    run.handoff_reason = kwargs.get(_HANDOFF_REASON_ARG)
            return tool_name, kwargs, tool_id if isinstance(tool_id, str) else None
        user_msg = _event_field(event, "user_msg")
        if user_msg is not None:
            with self._lock:
                run.user_msg = _message_text(user_msg)
        return None

    def _switch_to(self, run: _Run, agent_name: str) -> None:
        """Make ``agent_name`` the run's open child, ending the previous
        agent's child on a hand-off."""
        session = run.session
        with self._lock:
            previous = run.child
            if previous is not None and previous.agent_name == agent_name:
                return
            incoming = run.user_msg if previous is None else run.handoff_reason
            run.handoff_reason = None
            child_session_id = str(uuid.uuid4())
            scope = session.new_subagent_scope(
                child_session_id=child_session_id,
                child_agent_id=session.derive_subagent_id(agent_name),
                child_agent_name=f"{session.config.agent_name}/{agent_name}",
                agent_role=agent_name,
            )
            run.child = _Child(agent_name=agent_name, scope=scope)
        if previous is not None:
            try:
                session.emit_agent_handoff(
                    from_agent=previous.agent_name,
                    to_agent=agent_name,
                    child_session_id=previous.scope.child_session_id,
                    child_agent_id=previous.scope.child_agent_id,
                    child_agent_name=previous.scope.child_agent_name,
                    agent_role=previous.scope.agent_role,
                )
            except Exception:  # noqa: BLE001 -- fail-open per Rule 28
                _log.debug("emit_agent_handoff failed", exc_info=True)
            self._emit_end(session, previous, state="closed", error=None)
        try:
            session.emit_subagent_session_start(
                child_session_id=scope.child_session_id,
                child_agent_id=scope.child_agent_id,
                child_agent_name=scope.child_agent_name,
                agent_role=scope.agent_role,
                incoming_message=_subagent_message(incoming),
            )
        except Exception:  # noqa: BLE001
            _log.debug("emit_subagent_session_start failed", exc_info=True)

    def _end_child(self, run: _Run, *, state: str, error: dict[str, Any] | None) -> None:
        with self._lock:
            child = run.child
            run.child = None
        if child is not None:
            self._emit_end(run.session, child, state=state, error=error)

    @staticmethod
    def _emit_end(
        session: Session, child: _Child, *, state: str, error: dict[str, Any] | None
    ) -> None:
        try:
            session.emit_subagent_session_end(
                child_session_id=child.scope.child_session_id,
                child_agent_id=child.scope.child_agent_id,
                child_agent_name=child.scope.child_agent_name,
                agent_role=child.scope.agent_role,
                state=state,
                error=error,
                outgoing_message=_subagent_message(child.last_output),
            )
        except Exception:  # noqa: BLE001
            _log.debug("emit_subagent_session_end failed", exc_info=True)

    @staticmethod
    def _report_tool_run(step: _Step, result: Any) -> None:
        """Report a tool the agent ran that no model response reported."""
        assert step.tool_call is not None and step.scope is not None
        tool_name, kwargs, tool_id = step.tool_call
        session = step.run.session
        # A call with no id cannot be matched to a response's tool call,
        # so it is reported (the wrap's text-parsed calls always have one).
        if session.tool_call_reported(step.scope, tool_id):
            return
        latency_ms = int((time.monotonic() - step.started) * 1000)
        try:
            payload = session._build_payload(
                EventType.TOOL_CALL, tool_name=tool_name, latency_ms=latency_ms
            )
            if session.config.capture_prompts:
                output = _event_field(result, "tool_output")
                content = build_tool_capture_content(
                    tool_input=_json_safe(kwargs) if kwargs is not None else None,
                    tool_output=(
                        _json_safe(_event_field(output, "content")) if output is not None else None
                    ),
                    server_name=None,
                    session_id=session.config.session_id,
                )
                if content is not None:
                    content["provider"] = _TOOL_CONTENT_PROVIDER
                    payload["has_content"] = True
                    payload["content"] = content
            session.event_queue.enqueue(payload)
        except Exception:  # noqa: BLE001
            _log.debug("failed to enqueue the LlamaIndex tool_call", exc_info=True)


_tracker = _Tracker()
_handler: Any = None  # the span handler patch_llama_index attached


def _new_span_handler() -> Any:
    """Build the span handler. Its class subclasses LlamaIndex's
    ``BaseSpanHandler`` (the dispatcher's handler type), so it is defined
    only once LlamaIndex is imported."""
    from llama_index_instrumentation.span_handlers import BaseSpanHandler

    class FlightdeckSpanHandler(BaseSpanHandler[Any]):
        """Hands the agent workflow spans to the tracker. It keeps no
        spans of its own, so the base class's bookkeeping stays empty."""

        @classmethod
        def class_name(cls) -> str:
            return "FlightdeckSpanHandler"

        def span_enter(
            self,
            id_: str,
            bound_args: Any,
            instance: Any | None = None,
            parent_id: str | None = None,
            tags: dict[str, Any] | None = None,
            **kwargs: Any,
        ) -> None:
            try:
                _tracker.enter(id_, bound_args, instance, parent_id)
            except Exception:  # noqa: BLE001
                _log.debug("LlamaIndex span_enter failed", exc_info=True)

        def span_exit(
            self,
            id_: str,
            bound_args: Any,
            instance: Any | None = None,
            result: Any | None = None,
            **kwargs: Any,
        ) -> None:
            try:
                _tracker.exit(id_, result)
            except Exception:  # noqa: BLE001
                _log.debug("LlamaIndex span_exit failed", exc_info=True)

        def span_drop(
            self,
            id_: str,
            bound_args: Any,
            instance: Any | None = None,
            err: BaseException | None = None,
            **kwargs: Any,
        ) -> None:
            try:
                _tracker.drop(id_, err)
            except Exception:  # noqa: BLE001
                _log.debug("LlamaIndex span_drop failed", exc_info=True)

        def new_span(self, *args: Any, **kwargs: Any) -> None:
            return None

        def prepare_to_exit_span(self, *args: Any, **kwargs: Any) -> None:
            return None

        def prepare_to_drop_span(self, *args: Any, **kwargs: Any) -> None:
            return None

    return FlightdeckSpanHandler()


def _root_dispatcher() -> Any:
    # The package llama-index-core's own ``instrumentation`` module
    # re-exports; the same root dispatcher.
    from llama_index_instrumentation import get_dispatcher

    return get_dispatcher()


def patch_llama_index(*, quiet: bool = False) -> None:
    """Attach the span handler to LlamaIndex's root dispatcher.

    Idempotent. Silent no-op when llama-index-core is not installed; a
    warning and no wrap below :data:`LLAMA_INDEX_CORE_FLOOR`.
    """
    global _handler
    installed = _core_version()
    if installed is not None and installed < LLAMA_INDEX_CORE_FLOOR:
        # Checked before importing anything: an older release has no
        # llama_index_instrumentation package to import.
        _log.warning(
            "llama-index-core %d.%d is older than %d.%d: its agent workflows open no "
            "child sessions (their model calls are still metered).",
            *installed,
            *LLAMA_INDEX_CORE_FLOOR,
        )
        return
    try:
        dispatcher = _root_dispatcher()
    except ImportError:
        if not quiet:
            _log.debug("llama-index-core not installed; agent workflow wrap skipped.")
        return
    if _handler is not None and _handler in dispatcher.span_handlers:
        return
    _handler = _new_span_handler()
    dispatcher.add_span_handler(_handler)


def unpatch_llama_index() -> None:
    """Detach the span handler. Idempotent. A run still open has its open
    child ended (``state=closed``); its later steps are not followed."""
    global _handler, _tracker
    if _handler is None:
        return
    try:
        dispatcher = _root_dispatcher()
        dispatcher.span_handlers = [h for h in dispatcher.span_handlers if h is not _handler]
    except Exception:  # noqa: BLE001
        _log.debug("detaching the LlamaIndex span handler failed", exc_info=True)
    _handler = None
    try:
        _tracker.close()
    except Exception:  # noqa: BLE001
        _log.debug("ending the open LlamaIndex children failed", exc_info=True)
    _tracker = _Tracker()
