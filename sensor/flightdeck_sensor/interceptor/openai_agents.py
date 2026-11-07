"""OpenAI Agents SDK wrap: a child session per agent, hand-offs and
guardrails.

The SDK's model calls go through the ``openai`` client, which the OpenAI
patch already meters and enforces: they, and the tool and MCP events the
other patches emit, stay on the sensor's own session, as CrewAI's and
LangGraph's do. This wrap adds the run's structure around them:

* every agent that runs opens a child session (``agent_role`` the
  agent's name, ``agent_name`` ``<sensor agent name>/<agent name>``),
  closed when it hands off or when the run ends, ``state=error`` when
  the run fails, is cancelled or a guardrail tripwire stops it;
* an agent used as a tool (``Agent.as_tool``) runs a nested run, whose
  agents nest under the child session of the agent that called the tool;
* a hand-off posts the ``agent_handoff`` signal on the child of the agent
  handing off, then closes that child; the agent handed to opens its own
  when it starts, so the two are siblings;
* a guardrail that fires (an input or output tripwire, a tool guardrail
  that rejects or raises) posts the ``guardrail_tripwire`` signal on the
  guarded agent's child, names only;
* the child's ``context`` carries the run's conversation id as
  ``gen_ai_conversation_id``: the run's ``conversation_id``, else its SDK
  memory session's ``session_id``, else ``run_config.group_id``.

Seam. ``AgentRunner.run`` and ``AgentRunner.run_streamed`` are patched on
the class (``Runner.run`` and ``Runner.run_streamed`` call them, and
``run_sync`` calls ``run``), and each run gets a composite of run hooks
that does the sensor's work first and then calls the hooks the caller
passed, every ``on_*`` method forwarded, exceptions propagating. The SDK
runs hooks in tasks of their own, so a context variable a hook sets is
lost: the wrapper sets :data:`_RUN_SCOPE` to a mutable scope object
before the run, every task the run starts inherits it, and the hooks
change the object, never the variable. A nested run reads the scope it
inherited to find its parent. The guardrails are seen where they run:
``InputGuardrail.run``, ``OutputGuardrail.run``, ``ToolInputGuardrail.run``
and ``ToolOutputGuardrail.run`` are patched to look at the result they
return, inside the run that called them.

A streamed run's loop runs in a task the result holds (``run_loop_task``,
``_run_impl_task`` in older releases such as 0.6); its open children are
closed from that task's done callback, after the hooks of a normal finish
have run. The posts the hooks and guardrails make run in a worker thread
(``asyncio.to_thread``) so the event loop is not held. The done callback
cannot await: it hands the closing posts to the loop's executor and
registers them with the session, whose ``end()`` waits for them; only when
the loop can no longer run them does it post in place.

Enforcement. A model call's ``pre_call`` raises ``DirectiveError`` or
``BudgetExceededError`` out of ``Runner.run`` (or out of
``stream_events()``). Once a shutdown directive has arrived the hooks
also raise ``DirectiveError`` when an agent starts or hands off. A kill
that lands inside an agent used as a tool surfaces there as the tool's
error, which the SDK hands to the model; the shutdown flag stays set, so
the outer agent's next model call raises. A ``retry_policy`` that retries
every exception would retry a ``DirectiveError`` too.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import dataclasses
import functools
import importlib.metadata
import logging
import os
import threading
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.session import (
    SUBAGENT_ERROR_MESSAGE_KEY,
    SUBAGENT_ERROR_TYPE_KEY,
    SUBAGENT_STATE_CLOSED,
    SUBAGENT_STATE_ERROR,
    GuardrailKind,
    _handoff_agent_label,
    subagent_error,
)
from flightdeck_sensor.core.types import SubagentMessage

if TYPE_CHECKING:
    from collections.abc import Callable

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.openai_agents")

# Distinct from the LLM patches' ``_flightdeck_patched`` so the classes
# this module patches never collide with another patch's marker.
_PATCHED_SENTINEL = "_flightdeck_openai_agents_patched"
_ORIGINAL_ATTR = "_flightdeck_openai_agents_original"

# The distribution the ``agents`` import name must come from: an
# application's own package may be called ``agents`` too.
_DISTRIBUTION = "openai-agents"

# The context key the child's conversation id is stored under, the key
# the OTLP GenAI receiver stores ``gen_ai.conversation.id`` under.
CONVERSATION_ID_KEY = "gen_ai_conversation_id"

# The module of the OpenTelemetry instrumentation's tracing processor,
# whose exporter reports the same runs as an OTLP session, and the
# distribution that installs it.
_OTEL_PROCESSOR_MODULE = "opentelemetry.instrumentation.openai_agents"
_OTEL_DISTRIBUTION = "opentelemetry-instrumentation-openai-agents-v2"
# The issue that tracks a run reported both ways.
_DOUBLE_COUNT_ISSUE = "https://github.com/flightdeckhq/flightdeck/issues/279"
# The OpenTelemetry exporter's endpoint settings, the per-signal one first.
_OTLP_ENDPOINT_ENV = ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT")
# The port a URL without one names, by scheme.
_DEFAULT_PORTS = {"http": 80, "https": 443}

# The guardrail classes this module patches, the module each lives in,
# and the ``kind`` a guardrail_tripwire signal names for it.
_GUARDRAILS = (
    ("agents.guardrail", "InputGuardrail", GuardrailKind.INPUT),
    ("agents.guardrail", "OutputGuardrail", GuardrailKind.OUTPUT),
    ("agents.tool_guardrails", "ToolInputGuardrail", GuardrailKind.TOOL_INPUT),
    ("agents.tool_guardrails", "ToolOutputGuardrail", GuardrailKind.TOOL_OUTPUT),
)
# The guardrail kinds whose result is a tripwire (an input or output
# guardrail's ``output.tripwire_triggered``); the tool kinds return a
# behaviour instead.
_TRIPWIRE_KINDS = frozenset({GuardrailKind.INPUT, GuardrailKind.OUTPUT})
# A tool guardrail's result names its behaviour in ``behavior["type"]``.
_BEHAVIOR_ATTR = "behavior"
_BEHAVIOR_TYPE_KEY = "type"
# The behaviours that refuse the call: ``reject_content`` replaces the
# tool's input or output with a message to the model, ``raise_exception``
# stops the run.
_BEHAVIOR_REJECT_CONTENT = "reject_content"
_BEHAVIOR_RAISE_EXCEPTION = "raise_exception"
_TOOL_GUARDRAIL_REFUSALS = frozenset({_BEHAVIOR_REJECT_CONTENT, _BEHAVIOR_RAISE_EXCEPTION})
# The exception the SDK raises when each kind of guardrail stops the run:
# the error type a child stopped by it ends with when the run itself does
# not raise (a streamed run's input guardrail).
_TRIPWIRE_ERROR_TYPES = {
    GuardrailKind.INPUT: "InputGuardrailTripwireTriggered",
    GuardrailKind.OUTPUT: "OutputGuardrailTripwireTriggered",
    GuardrailKind.TOOL_INPUT: "ToolInputGuardrailTripwireTriggered",
    GuardrailKind.TOOL_OUTPUT: "ToolOutputGuardrailTripwireTriggered",
}

# The prefix of every hook method the SDK's RunHooksBase defines.
_HOOK_PREFIX = "on_"
# The attribute a streamed result keeps its run loop's task in: current
# releases first, then older ones such as 0.6.
_STREAM_TASK_ATTRS = ("run_loop_task", "_run_impl_task")
# The runner methods and the guardrail method the wrap replaces.
_RUN_METHOD = "run"
_RUN_STREAMED_METHOD = "run_streamed"
_GUARDRAIL_METHOD = "run"


# ----------------------------------------------------------------------
# Lazy SDK import, as the CrewAI interceptor does: importing ``agents``
# loads the SDK, so it happens only when the application has imported it
# and patch() asks for it.
# ----------------------------------------------------------------------

_AgentRunner: Any = None
_RunHooksBase: Any = None
_AVAILABLE: bool | None = None


def _ensure_imported() -> bool:
    """Resolve the SDK's runner and hooks once; False when ``agents`` is
    not the OpenAI Agents SDK or its runner cannot be imported."""
    global _AgentRunner, _RunHooksBase, _AVAILABLE
    if _AVAILABLE is not None:
        return _AVAILABLE
    try:
        importlib.metadata.version(_DISTRIBUTION)
        from agents.lifecycle import RunHooksBase
        from agents.run import AgentRunner
    except (ImportError, importlib.metadata.PackageNotFoundError):
        _AVAILABLE = False
        return False
    _AgentRunner, _RunHooksBase = AgentRunner, RunHooksBase
    _AVAILABLE = True
    return True


def _current_session() -> Session | None:
    """The active sensor session, looked up at call time."""
    import flightdeck_sensor

    return flightdeck_sensor._session


# ----------------------------------------------------------------------
# The run scope
# ----------------------------------------------------------------------


@dataclasses.dataclass
class _Child:
    """One agent's child session: the identity its events carry."""

    agent: Any
    session_id: str
    agent_id: str
    agent_name: str
    role: str
    parent_session_id: str | None
    output: Any = None
    has_output: bool = False

    def identity(self) -> dict[str, Any]:
        return {
            "child_session_id": self.session_id,
            "child_agent_id": self.agent_id,
            "child_agent_name": self.agent_name,
            "agent_role": self.role,
            "parent_session_id": self.parent_session_id,
        }


class _RunScope:
    """The state one run shares between its hooks, its guardrails and
    the runs nested in its tools. The hooks run in tasks of their own,
    so they change this object rather than a context variable."""

    def __init__(
        self,
        session: Session,
        *,
        parent_session_id: str | None,
        conversation_id: str | None,
        run_input: Any,
    ) -> None:
        self.session = session
        # The child session the run's agents nest under: None for a
        # top-level run (they nest under the sensor's session), the
        # calling agent's child for a run nested in a tool.
        self.parent_session_id = parent_session_id
        self.conversation_id = conversation_id
        # The run's input, the first agent's incoming message.
        self.run_input = run_input
        self.current: _Child | None = None
        self.open: list[_Child] = []
        # The error a guardrail that stopped the run ends its children
        # with, when the run itself does not raise (a streamed run's
        # input guardrail).
        self.tripwire_error: dict[str, str] | None = None
        self.started = False
        self.closed = False
        self._lock: asyncio.Lock | None = None

    def lock(self) -> asyncio.Lock:
        # Created on first use, inside the run's event loop.
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def new_child(self, agent: Any) -> _Child:
        role = _agent_label(agent)
        session = self.session
        parent_name = session.config.agent_name
        return _Child(
            agent=agent,
            session_id=str(uuid.uuid4()),
            agent_id=session.derive_subagent_id(role),
            agent_name=f"{parent_name}/{role}" if role else parent_name,
            role=role,
            parent_session_id=self.parent_session_id,
        )

    async def ensure_child(self, agent: Any) -> _Child:
        """The open child of ``agent``, opened now if it has none. Caller
        holds :meth:`lock`."""
        current = self.current
        if current is not None and current.agent is agent:
            return current
        child = self.new_child(agent)
        incoming = None
        if not self.started:
            self.started = True
            if isinstance(self.run_input, (str, list)):
                incoming = _message(self.run_input)
        self.current = child
        self.open.append(child)
        context_extra = (
            {CONVERSATION_ID_KEY: self.conversation_id} if self.conversation_id else None
        )
        await asyncio.to_thread(_start_child, self.session, child, incoming, context_extra)
        return child

    async def end_child(self, child: _Child) -> None:
        """Close ``child`` (closed, not in error). Caller holds :meth:`lock`."""
        if child in self.open:
            self.open.remove(child)
        if self.current is child:
            self.current = None
        await asyncio.to_thread(_end_child, self.session, child, None)

    def close_all(self, error: BaseException | None) -> None:
        """Close every child still open, in error when the run raised or
        a guardrail stopped it, once. Posts in place."""
        if self.closed:
            return
        self.closed = True
        err = subagent_error(error) if error is not None else self.tripwire_error
        for child in list(self.open):
            _end_child(self.session, child, err)
        self.open.clear()
        self.current = None

    async def aclose_all(self, error: BaseException | None) -> None:
        """:meth:`close_all` with its posts in a worker thread."""
        await asyncio.to_thread(self.close_all, error)


# The scope of the run the current task belongs to. Set by the run
# wrapper before the SDK starts the run's tasks, which inherit it.
_RUN_SCOPE: contextvars.ContextVar[_RunScope | None] = contextvars.ContextVar(
    "flightdeck_openai_agents_run_scope", default=None
)


def _agent_label(agent: Any) -> str:
    """An agent's name as its child session's role, bounded as a signal's
    names are; "" when it has none."""
    try:
        return _handoff_agent_label(getattr(agent, "name", None))
    except Exception:  # noqa: BLE001 - fail open
        return ""


def _message(body: Any) -> SubagentMessage:
    return SubagentMessage(body=body, captured_at=datetime.now(UTC).isoformat())


def _start_child(
    session: Session,
    child: _Child,
    incoming: SubagentMessage | None,
    context_extra: dict[str, Any] | None,
) -> None:
    try:
        session.emit_subagent_session_start(
            incoming_message=incoming, context_extra=context_extra, **child.identity()
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("child session_start failed", exc_info=True)


def _end_child(session: Session, child: _Child, error: dict[str, str] | None) -> None:
    try:
        session.emit_subagent_session_end(
            state=SUBAGENT_STATE_ERROR if error is not None else SUBAGENT_STATE_CLOSED,
            error=error,
            outgoing_message=_message(child.output) if child.has_output else None,
            **child.identity(),
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("child session_end failed", exc_info=True)


def _conversation_id(kwargs: dict[str, Any], inherited: str | None) -> str | None:
    """The run's conversation id: its ``conversation_id``, else its SDK
    memory session's ``session_id``, else ``run_config.group_id``, else
    the one of the run it is nested in; bounded as a signal's names are."""
    run_config = kwargs.get("run_config")
    if isinstance(run_config, dict):
        group_id = run_config.get("group_id")
    else:
        group_id = getattr(run_config, "group_id", None)
    for value in (
        kwargs.get("conversation_id"),
        getattr(kwargs.get("session"), "session_id", None),
        group_id,
    ):
        label = _handoff_agent_label(value)
        if label:
            return label
    return inherited


def _new_scope(session: Session, run_input: Any, kwargs: dict[str, Any]) -> _RunScope:
    outer = _RUN_SCOPE.get()
    parent: str | None = None
    inherited: str | None = None
    if outer is not None:
        inherited = outer.conversation_id
        parent = outer.current.session_id if outer.current is not None else outer.parent_session_id
    return _RunScope(
        session,
        parent_session_id=parent,
        conversation_id=_conversation_id(kwargs, inherited),
        run_input=run_input,
    )


# ----------------------------------------------------------------------
# Run hooks
# ----------------------------------------------------------------------

_hooks_class: type[Any] | None = None


def _make_hooks_class() -> type[Any]:
    """The composite run hooks class, a subclass of the SDK's
    ``RunHooksBase`` so the runner accepts it. Every ``on_*`` method the
    SDK defines is forwarded to the caller's hooks; the ones the sensor
    acts on do its work first."""
    global _hooks_class
    if _hooks_class is not None:
        return _hooks_class
    if not _ensure_imported():
        raise RuntimeError("the OpenAI Agents SDK is not installed")

    async def on_agent_start(self: Any, context: Any, agent: Any) -> None:
        scope: _RunScope = self._fd_scope
        scope.session.raise_if_shutdown()
        async with scope.lock():
            await scope.ensure_child(agent)
        await self._fd_forward("on_agent_start", context, agent)

    async def on_agent_end(self: Any, context: Any, agent: Any, output: Any) -> None:
        scope: _RunScope = self._fd_scope
        current = scope.current
        if current is not None and current.agent is agent:
            current.output, current.has_output = output, True
        await self._fd_forward("on_agent_end", context, agent, output)

    async def on_handoff(self: Any, context: Any, from_agent: Any, to_agent: Any) -> None:
        scope: _RunScope = self._fd_scope
        scope.session.raise_if_shutdown()
        async with scope.lock():
            child = await scope.ensure_child(from_agent)
            await asyncio.to_thread(
                functools.partial(
                    scope.session.emit_agent_handoff,
                    from_agent=getattr(from_agent, "name", None),
                    to_agent=getattr(to_agent, "name", None),
                    **child.identity(),
                )
            )
            await scope.end_child(child)
        await self._fd_forward("on_handoff", context, from_agent, to_agent)

    async def _fd_forward(self: Any, name: str, *args: Any) -> None:
        inner = self._fd_inner
        if inner is not None:
            await getattr(inner, name)(*args)

    def init(self: Any, scope: _RunScope, inner: Any) -> None:
        self._fd_scope = scope
        self._fd_inner = inner

    def _forwarder(name: str) -> Callable[..., Any]:
        async def forward(self: Any, *args: Any, **kwargs: Any) -> Any:
            inner = self._fd_inner
            if inner is not None:
                return await getattr(inner, name)(*args, **kwargs)
            return None

        forward.__name__ = name
        return forward

    namespace: dict[str, Any] = {
        "__init__": init,
        "_fd_forward": _fd_forward,
        "on_agent_start": on_agent_start,
        "on_agent_end": on_agent_end,
        "on_handoff": on_handoff,
    }
    for name in dir(_RunHooksBase):
        if name.startswith(_HOOK_PREFIX) and name not in namespace:
            namespace[name] = _forwarder(name)
    _hooks_class = type("FlightdeckRunHooks", (_RunHooksBase,), namespace)
    return _hooks_class


def _wrap_hooks(scope: _RunScope, user_hooks: Any) -> Any | None:
    """The run's composite hooks, or None when the caller's hooks are not
    run hooks: the runner then refuses them with its own error."""
    if user_hooks is not None and not isinstance(user_hooks, _RunHooksBase):
        return None
    return _make_hooks_class()(scope, user_hooks)


# ----------------------------------------------------------------------
# Guardrails
# ----------------------------------------------------------------------


def _fired(kind: GuardrailKind, result: Any) -> tuple[bool, bool]:
    """Whether a guardrail's result fired, and whether it stops the run."""
    if kind in _TRIPWIRE_KINDS:
        tripped = bool(getattr(getattr(result, "output", None), "tripwire_triggered", False))
        return tripped, tripped
    behavior = getattr(result, _BEHAVIOR_ATTR, None)
    behavior_type = behavior.get(_BEHAVIOR_TYPE_KEY) if isinstance(behavior, dict) else None
    return (
        behavior_type in _TOOL_GUARDRAIL_REFUSALS,
        behavior_type == _BEHAVIOR_RAISE_EXCEPTION,
    )


def _guarded_agent(kind: GuardrailKind, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
    """The agent a guardrail's ``run`` was called for: its ``agent``
    argument (an input guardrail's first, an output guardrail's second),
    or the ``agent`` of a tool guardrail's data."""
    if "agent" in kwargs:
        return kwargs["agent"]
    if kind is GuardrailKind.INPUT:
        return args[0] if args else None
    if kind is GuardrailKind.OUTPUT:
        return args[1] if len(args) > 1 else None
    data = kwargs.get("data", args[0] if args else None)
    return getattr(data, "agent", None)


async def _report_guardrail(
    kind: GuardrailKind, guardrail: Any, args: tuple[Any, ...], kwargs: dict[str, Any], result: Any
) -> None:
    scope = _RUN_SCOPE.get()
    if scope is None:
        return
    fired, stops = _fired(kind, result)
    if not fired:
        return
    try:
        name = guardrail.get_name()
    except Exception:  # noqa: BLE001 - a name is optional
        name = None
    agent = _guarded_agent(kind, args, kwargs)
    async with scope.lock():
        if stops and scope.tripwire_error is None:
            scope.tripwire_error = {
                SUBAGENT_ERROR_TYPE_KEY: _TRIPWIRE_ERROR_TYPES[kind],
                SUBAGENT_ERROR_MESSAGE_KEY: f"Guardrail {name or kind} triggered tripwire",
            }
        child = await scope.ensure_child(agent) if agent is not None else scope.current
        identity = child.identity() if child is not None else {}
        await asyncio.to_thread(
            functools.partial(
                scope.session.emit_guardrail_tripwire,
                guardrail=name,
                kind=kind,
                agent=getattr(agent, "name", None),
                **identity,
            )
        )


def _wrap_guardrail_run(kind: GuardrailKind, original: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(original)
    async def run(self: Any, *args: Any, **kwargs: Any) -> Any:
        result = await original(self, *args, **kwargs)
        try:
            await _report_guardrail(kind, self, args, kwargs, result)
        except DirectiveError:
            raise
        except Exception:  # noqa: BLE001 - fail open
            _log.debug("guardrail_tripwire was not reported", exc_info=True)
        return result

    return run


# ----------------------------------------------------------------------
# Runner wrappers
# ----------------------------------------------------------------------


def _wrap_run(original: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(original)
    async def run(self: Any, starting_agent: Any, input: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return await original(self, starting_agent, input, **kwargs)
        scope = _new_scope(session, input, kwargs)
        hooks = _wrap_hooks(scope, kwargs.get("hooks"))
        if hooks is None:
            return await original(self, starting_agent, input, **kwargs)
        kwargs["hooks"] = hooks
        _check_double_count(session, kwargs.get("run_config"))
        token = _RUN_SCOPE.set(scope)
        try:
            result = await original(self, starting_agent, input, **kwargs)
        except BaseException as exc:
            await _close_quietly(scope, exc)
            raise
        finally:
            _RUN_SCOPE.reset(token)
        await _close_quietly(scope, None)
        return result

    return run


async def _close_quietly(scope: _RunScope, error: BaseException | None) -> None:
    try:
        await scope.aclose_all(error)
    except BaseException:  # noqa: BLE001 - a cancelled close must not mask the run's outcome
        _log.debug("closing the run's child sessions failed", exc_info=True)


def _wrap_run_streamed(original: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(original)
    def run_streamed(self: Any, starting_agent: Any, input: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return original(self, starting_agent, input, **kwargs)
        scope = _new_scope(session, input, kwargs)
        hooks = _wrap_hooks(scope, kwargs.get("hooks"))
        if hooks is None:
            return original(self, starting_agent, input, **kwargs)
        kwargs["hooks"] = hooks
        _check_double_count(session, kwargs.get("run_config"))
        # The run loop's task is created inside the call and copies the
        # context then, scope included.
        token = _RUN_SCOPE.set(scope)
        try:
            result = original(self, starting_agent, input, **kwargs)
        except BaseException as exc:
            _close_off_loop(scope, exc, _running_loop())
            raise
        finally:
            _RUN_SCOPE.reset(token)
        task = _run_loop_task(result)
        if task is None:
            _log.warning(
                "flightdeck_sensor: this openai-agents release names its streamed run "
                "task differently; the run's child sessions stay open"
            )
        else:
            task.add_done_callback(functools.partial(_stream_done, scope))
        return result

    return run_streamed


def _run_loop_task(result: Any) -> asyncio.Task[Any] | None:
    """The task a streamed result runs its loop in (see
    :data:`_STREAM_TASK_ATTRS`)."""
    for name in _STREAM_TASK_ATTRS:
        task = getattr(result, name, None)
        if isinstance(task, asyncio.Future):
            return task  # type: ignore[return-value]
    return None


def _stream_done(scope: _RunScope, task: asyncio.Future[Any]) -> None:
    """Close a streamed run's open children once its loop ends."""
    try:
        if task.cancelled():
            error: BaseException | None = asyncio.CancelledError()
        else:
            error = task.exception()
        _close_off_loop(scope, error, task.get_loop())
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("closing a streamed run's child sessions failed", exc_info=True)


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _retrieve_outcome(future: asyncio.Future[Any]) -> None:
    """Mark an executor job's outcome as retrieved, logging a failure at
    debug level (the sensor fails open)."""
    if not future.cancelled() and future.exception() is not None:
        _log.debug("closing a run's child sessions failed", exc_info=future.exception())


def _close_off_loop(
    scope: _RunScope, error: BaseException | None, loop: asyncio.AbstractEventLoop | None
) -> None:
    """Close the run's open children from code that cannot await (a done
    callback, the synchronous ``run_streamed``): in a worker thread of
    ``loop``'s executor, registered with the session so its ``end()``
    waits for the posts, or in place when the loop can no longer run one
    (it is closed, or shutting its executor down)."""
    done: concurrent.futures.Future[None] = concurrent.futures.Future()

    def close() -> None:
        try:
            scope.close_all(error)
        finally:
            done.set_result(None)

    try:
        if loop is None or loop.is_closed():
            raise RuntimeError("no running event loop")
        future = loop.run_in_executor(None, close)
        # Retrieve the job's outcome so asyncio never logs an exception as
        # never retrieved; close_all logs its own failures.
        future.add_done_callback(_retrieve_outcome)
    except RuntimeError:
        scope.close_all(error)
        return
    scope.session.track_child_post(done)


# ----------------------------------------------------------------------
# A run reported twice
# ----------------------------------------------------------------------

_double_count_checked = False
_double_count_lock = threading.Lock()


def _tracing_disabled(provider: Any, run_config: Any) -> bool:
    if isinstance(run_config, dict):
        disabled = run_config.get("tracing_disabled", False)
    else:
        disabled = getattr(run_config, "tracing_disabled", False)
    return bool(disabled) or bool(getattr(provider, "_disabled", False))


def _endpoint_host(url: str) -> tuple[str, int | None] | None:
    try:
        parts = urlsplit(url if "://" in url else f"http://{url}")
        host = (parts.hostname or "").lower()
        port = parts.port or _DEFAULT_PORTS.get(parts.scheme)
    except ValueError:
        return None
    return (host, port) if host else None


def _check_double_count(session: Session, run_config: Any) -> None:
    """Once per process, when a run's traces also go to the OpenTelemetry
    instrumentation's processor: warn that its exporter may report the
    run a second time, unless its endpoint is clearly another host."""
    global _double_count_checked
    if _double_count_checked:
        return
    try:
        from agents.tracing import get_trace_provider

        provider = get_trace_provider()
        if _tracing_disabled(provider, run_config):
            return
        processors = getattr(getattr(provider, "_multi_processor", None), "_processors", ())
        if not any(type(p).__module__.startswith(_OTEL_PROCESSOR_MODULE) for p in processors or ()):
            return
        with _double_count_lock:
            if _double_count_checked:
                return
            _double_count_checked = True
        endpoint = next((os.environ[k] for k in _OTLP_ENDPOINT_ENV if os.environ.get(k)), None)
        if endpoint is not None:
            exporter, sensor = _endpoint_host(endpoint), _endpoint_host(session.config.server)
            if exporter is not None and sensor is not None and exporter != sensor:
                _log.debug(
                    "OpenAI Agents traces also go to an OpenTelemetry exporter at %s, "
                    "not this sensor's server",
                    endpoint,
                )
                return
        where = (
            f"to {endpoint}" if endpoint is not None else "to an endpoint the sensor cannot read"
        )
        _log.warning(
            "flightdeck_sensor: this process also exports OpenAI Agents traces through "
            "%s %s. If that exporter sends them "
            "to this Flightdeck, each run may be counted twice: once by the sensor and once "
            "as an OTLP session. Report each run one way (see %s).",
            _OTEL_DISTRIBUTION,
            where,
            _DOUBLE_COUNT_ISSUE,
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("double-count check failed", exc_info=True)


# ----------------------------------------------------------------------
# Patch / unpatch
# ----------------------------------------------------------------------


def _guardrail_classes() -> list[tuple[Any, GuardrailKind]]:
    classes = []
    for module_name, class_name, kind in _GUARDRAILS:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        cls = getattr(module, class_name, None)
        if cls is not None and callable(getattr(cls, _GUARDRAIL_METHOD, None)):
            classes.append((cls, kind))
    return classes


def _patch_method(cls: Any, name: str, wrapper: Callable[..., Any]) -> None:
    original = cls.__dict__[name]
    setattr(cls, name, wrapper(original))
    setattr(cls, f"{_ORIGINAL_ATTR}_{name}", original)


def _unpatch_method(cls: Any, name: str) -> None:
    attr = f"{_ORIGINAL_ATTR}_{name}"
    original = cls.__dict__.get(attr)
    if original is not None:
        setattr(cls, name, original)
        delattr(cls, attr)


def patch_openai_agents(*, quiet: bool = False) -> None:
    """Install the wrap on the OpenAI Agents SDK's runner and guardrails.

    Idempotent; a silent no-op when the ``agents`` module is not the
    OpenAI Agents SDK.
    """
    if not _ensure_imported():
        if not quiet:
            _log.debug("openai-agents not installed; its wrap is skipped.")
        return
    runner = _AgentRunner
    if runner.__dict__.get(_PATCHED_SENTINEL, False):
        return
    _patch_method(runner, _RUN_METHOD, _wrap_run)
    _patch_method(runner, _RUN_STREAMED_METHOD, _wrap_run_streamed)
    setattr(runner, _PATCHED_SENTINEL, True)
    for cls, kind in _guardrail_classes():
        if not cls.__dict__.get(_PATCHED_SENTINEL, False) and _GUARDRAIL_METHOD in cls.__dict__:
            _patch_method(cls, _GUARDRAIL_METHOD, functools.partial(_wrap_guardrail_run, kind))
            setattr(cls, _PATCHED_SENTINEL, True)


def unpatch_openai_agents() -> None:
    """Restore the SDK's runner and guardrails. Idempotent."""
    global _double_count_checked
    if not _ensure_imported():
        return
    runner = _AgentRunner
    if runner.__dict__.get(_PATCHED_SENTINEL, False):
        _unpatch_method(runner, _RUN_METHOD)
        _unpatch_method(runner, _RUN_STREAMED_METHOD)
        delattr(runner, _PATCHED_SENTINEL)
    for cls, _kind in _guardrail_classes():
        if cls.__dict__.get(_PATCHED_SENTINEL, False):
            _unpatch_method(cls, _GUARDRAIL_METHOD)
            delattr(cls, _PATCHED_SENTINEL)
    _double_count_checked = False
