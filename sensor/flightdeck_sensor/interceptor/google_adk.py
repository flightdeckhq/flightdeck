"""Google ADK wrap: a child session per sub-agent run, and hand-offs.

ADK's model calls go through the model class the agent names: its default
Gemini model (``google-genai``), ``LiteLlm`` (litellm), ``AnthropicLlm`` and
``Claude`` (the Anthropic SDK), which the google-genai, litellm and
Anthropic patches already meter and enforce, one event per request each
(ADK's Gemini model makes one google-genai call per model turn). Those
calls, and the tool and MCP events the other patches emit, stay on the
sensor's own session, as the other framework wraps leave them, made in the
scope of the agent's child. This wrap adds the run's structure around
them.

What opens a child session. A child session is a sub-agent: every agent
run except the root agent of a top-level run, which is the sensor's own
session, and except the workflow agents (``SequentialAgent``,
``ParallelAgent``, ``LoopAgent``), which orchestrate and open none of
their own. So a child opens for an agent reached by ``transfer_to_agent``,
for each sub-agent a workflow agent runs (``ParallelAgent`` branches are
open at once; each ``LoopAgent`` iteration is a new child), and for the
agent of an ``AgentTool`` (its nested run's root agent), nested or not.
``agent_role`` is the agent's name, ``agent_name`` ``<sensor agent
name>/<agent name>``. Under ``capture_prompts`` the first child of a run
takes the run's new message as its incoming message, and each child its
agent's last final response as its outgoing message.

Parents. A child's parent is the nearest ancestor agent (``parent_agent``)
with a child open in the same run, else the child the run itself runs in
(an ``AgentTool``'s run runs in its caller's child), else the sensor's
session. Each agent's work runs in its child's scope
(:meth:`Session.enter_subagent_scope`), entered when the agent starts, so
its tool calls, and a run started inside one, see it.

Hand-offs. A ``transfer_to_agent`` (read from the run's events, whose
author is the agent handing off) posts the ``agent_handoff`` signal, from
and to, on the session of the agent handing off: its child, or the
sensor's session for the root agent.

Ends. A child closes when its agent ends (``after_agent``); it ends with
``state=error`` and the exception's type when the agent raises
(``on_agent_error``) or its task is cancelled (``after_agent`` running
under a cancellation). An agent that ends without ``after_agent`` (one
that transfers, on ADK's node runtime; one whose run ends the invocation
or is closed early) is closed when the run ends: normally, or in error
with the run's exception.

Seams. ``google.adk.runners.Runner.__init__`` is patched to put the
sensor's plugin first in the new runner's plugin manager, unless one is
there already (a nested ``AgentTool`` runner given its caller's plugins);
the caller's plugins, ``App.plugins`` and the deprecated
``Runner(plugins=...)`` alike, are kept, and an ``AgentTool`` built with
``include_plugins=False`` still gets the sensor's. ``InMemoryRunner`` and
the ``AgentTool``'s own runner go through it. ``Runner.run_async`` (which
``Runner.run`` calls) and ``Runner.run_live`` are wrapped: the run's state
is set in a context variable around each step of the run, and left before
each event reaches the run's consumer, so the tasks ADK starts for the
run's agents and tools inherit it and the consumer's own code does not.
The wrapper's ``finally`` closes what the run left open.

Posting. The child's posts are queued on the event loop's executor and
chained per child (``_child_posts``, shared with the LangGraph wrap), so
its start, its hand-off and its end arrive in that order; a callback
waits for its post shielded, so the loop is never held and a
cancellation never drops a post, and the session's ``end()`` waits for
posts still running. The posts of a run's end are queued and not
waited for.

Enforcement. A model call's ``pre_call`` raises ``DirectiveError`` or
``BudgetExceededError`` through ADK unchanged. Once a shutdown directive
has arrived, a run that starts raises ``DirectiveError`` before its first
event. The plugin callbacks never raise: ADK would turn the exception into
a ``RuntimeError`` and stop the run.

Fail open (Rule 28): every callback catches its own failures and returns
None, so the run, its output and its exceptions are those of the
unpatched run. With no sensor session the plugin does nothing.
"""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
import functools
import importlib
import logging
import threading
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.session import (
    SUBAGENT_ERROR_TYPE_KEY,
    SUBAGENT_STATE_CLOSED,
    SUBAGENT_STATE_ERROR,
    Session,
    _handoff_agent_label,
    subagent_error,
)
from flightdeck_sensor.core.types import SubagentMessage
from flightdeck_sensor.interceptor._child_posts import queue_post as _queue
from flightdeck_sensor.interceptor._child_posts import wait_post as _wait

if TYPE_CHECKING:
    import concurrent.futures
    from collections.abc import AsyncGenerator, Callable

    from flightdeck_sensor.core.types import SubagentScope

_log = logging.getLogger("flightdeck_sensor.interceptor.google_adk")

# The module whose import makes ADK patchable, and the class patched.
_RUNNERS_MODULE = "google.adk.runners"
_RUNNER_CLASS = "Runner"
# The plugin base class the sensor's plugin subclasses.
_PLUGIN_MODULE = "google.adk.plugins.base_plugin"
_PLUGIN_BASE = "BasePlugin"
# The workflow agents, which orchestrate their sub-agents and open no
# child of their own: (module, class).
_WORKFLOW_AGENTS = (
    ("google.adk.agents.sequential_agent", "SequentialAgent"),
    ("google.adk.agents.parallel_agent", "ParallelAgent"),
    ("google.adk.agents.loop_agent", "LoopAgent"),
)

# The name the sensor's plugin is registered under in a runner's plugin
# manager, which refuses two plugins of one name.
PLUGIN_NAME = "flightdeck_sensor"

# Distinct from the other patches' sentinels so the class this module
# patches never collides with another patch's marker.
_PATCHED_SENTINEL = "_flightdeck_google_adk_patched"
_ORIGINAL_ATTR = "_flightdeck_google_adk_original"
# The Runner methods the wrap replaces.
_INIT_METHOD = "__init__"
_RUN_METHODS = ("run_async", "run_live")

# The keyword argument that carries a run's new message.
_NEW_MESSAGE_ARG = "new_message"


def _current_session() -> Session | None:
    """The active sensor session, looked up at call time."""
    import flightdeck_sensor

    return flightdeck_sensor._session


# ----------------------------------------------------------------------
# Child sessions
# ----------------------------------------------------------------------


@dataclasses.dataclass
class _Child:
    """One agent run's child session."""

    session: Session
    scope: SubagentScope
    # The child session this one nests under; None for the sensor's own.
    parent_session_id: str | None
    # The scope active when the agent started, restored when it ends.
    outer_scope: SubagentScope | None
    output: Any = None
    has_output: bool = False
    # The child's last queued post; the next one is queued from its
    # completion, so the child's posts arrive in order (see _queue).
    last_post: concurrent.futures.Future[None] | None = None

    def identity(self) -> dict[str, Any]:
        return {
            "child_session_id": self.scope.child_session_id,
            "child_agent_id": self.scope.child_agent_id,
            "child_agent_name": self.scope.child_agent_name,
            "agent_role": self.scope.agent_role,
            "parent_session_id": self.parent_session_id,
        }


def _message(body: Any) -> SubagentMessage:
    return SubagentMessage(body=body, captured_at=datetime.now(UTC).isoformat())


def _error_block(error: BaseException) -> dict[str, str]:
    """The child's error block; the type alone when the exception's text
    cannot be rendered (its ``__str__`` raises)."""
    try:
        return subagent_error(error)
    except Exception:  # noqa: BLE001 - fail open: the agent's exception still propagates
        return {SUBAGENT_ERROR_TYPE_KEY: type(error).__name__}


def _start(child: _Child, incoming: Any) -> None:
    try:
        child.session.emit_subagent_session_start(
            incoming_message=_message(incoming) if incoming is not None else None,
            **child.identity(),
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("Google ADK child session_start failed", exc_info=True)


def _end(child: _Child, error: dict[str, str] | None) -> None:
    try:
        child.session.emit_subagent_session_end(
            state=SUBAGENT_STATE_ERROR if error is not None else SUBAGENT_STATE_CLOSED,
            error=error,
            outgoing_message=_message(child.output) if child.has_output else None,
            **child.identity(),
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("Google ADK child session_end failed", exc_info=True)


def _handoff(session: Session, child: _Child | None, from_agent: str, to_agent: str) -> None:
    try:
        identity = child.identity() if child is not None else {}
        session.emit_agent_handoff(from_agent=from_agent, to_agent=to_agent, **identity)
    except Exception:  # noqa: BLE001 - fail open: a halt policy's DirectiveError included
        _log.debug("Google ADK agent_handoff failed", exc_info=True)


# ----------------------------------------------------------------------
# The run
# ----------------------------------------------------------------------


class _Run:
    """One run of a runner (``run_async`` or ``run_live``): its open
    children, by agent name (ADK names every agent of a tree uniquely)."""

    def __init__(
        self,
        session: Session,
        *,
        root_name: str,
        nested: bool,
        parent: SubagentScope | None,
        incoming: Any,
    ) -> None:
        self.session = session
        # The runner's root agent: in a top-level run it is the sensor's
        # session and opens no child; in a nested run (an AgentTool's, or
        # one started inside another child) it does.
        self.root_name = root_name
        self.nested = nested
        # The child the run runs in, if any: its children's parent when no
        # ancestor agent has one open.
        self.parent = parent
        # The run's new message, the first child's incoming message (None
        # with capture off).
        self.incoming = incoming
        self.started = False
        self.open: dict[str, _Child] = {}
        self.closed = False
        self._lock = threading.Lock()

    def opens_child(self, agent: Any) -> bool:
        if _is_workflow_agent(agent):
            return False
        return self.nested or _agent_name(agent) != self.root_name

    def parent_of(self, agent: Any) -> str | None:
        """The session id a child of ``agent`` nests under: the nearest
        ancestor with an open child, else the run's own child, else None
        (the sensor's session)."""
        ancestor = getattr(agent, "parent_agent", None)
        with self._lock:
            while ancestor is not None:
                child = self.open.get(_agent_name(ancestor))
                if child is not None:
                    return child.scope.child_session_id
                ancestor = getattr(ancestor, "parent_agent", None)
        return self.parent.child_session_id if self.parent is not None else None

    def open_child(self, agent: Any) -> tuple[_Child, Any, _Child | None]:
        """A new child for ``agent``: (the child, its incoming message, the
        agent's previous child still open, which the caller closes)."""
        session = self.session
        role = _handoff_agent_label(_agent_name(agent))
        scope = session.new_subagent_scope(
            child_session_id=str(uuid.uuid4()),
            child_agent_id=session.derive_subagent_id(role),
            child_agent_name=(
                f"{session.config.agent_name}/{role}" if role else session.config.agent_name
            ),
            agent_role=role,
        )
        child = _Child(
            session=session,
            scope=scope,
            parent_session_id=self.parent_of(agent),
            outer_scope=session.active_subagent_scope(),
        )
        with self._lock:
            incoming = None
            if not self.started:
                self.started = True
                incoming = self.incoming
            previous = self.open.get(_agent_name(agent))
            self.open[_agent_name(agent)] = child
        return child, incoming, previous

    def child_of(self, agent_name: Any) -> _Child | None:
        if not isinstance(agent_name, str):
            return None
        with self._lock:
            return self.open.get(agent_name)

    def take(self, agent: Any) -> _Child | None:
        """Remove and return ``agent``'s open child."""
        with self._lock:
            return self.open.pop(_agent_name(agent), None)

    def close_all(self, error: BaseException | None) -> None:
        """Queue the end of every child still open, in error when the run
        raised; once."""
        with self._lock:
            if self.closed:
                return
            self.closed = True
            children = list(self.open.values())
            self.open.clear()
        block = _error_block(error) if error is not None else None
        for child in children:
            _queue(child, _end, child, block)


# The run whose step is running in this context, set by the run wrapper
# around each step (see _watch); the tasks ADK starts for the run's agents
# and tools inherit it.
_RUN: contextvars.ContextVar[_Run | None] = contextvars.ContextVar(
    "flightdeck_google_adk_run", default=None
)


def _agent_name(agent: Any) -> str:
    """An agent's name, "" when it has none (ADK requires one)."""
    name = getattr(agent, "name", None)
    return name if isinstance(name, str) else ""


_workflow_classes: tuple[type[Any], ...] | None = None


def _is_workflow_agent(agent: Any) -> bool:
    global _workflow_classes
    if _workflow_classes is None:
        classes = []
        for module_name, class_name in _WORKFLOW_AGENTS:
            try:
                cls = getattr(importlib.import_module(module_name), class_name, None)
            except ImportError:
                cls = None
            if isinstance(cls, type):
                classes.append(cls)
        _workflow_classes = tuple(classes)
    return isinstance(agent, _workflow_classes)


def _content_text(content: Any) -> str | None:
    """The text of an ADK ``Content`` (its text parts, joined), or None."""
    parts = getattr(content, "parts", None) or ()
    texts = [p.text for p in parts if isinstance(getattr(p, "text", None), str)]
    return "\n".join(texts) if texts else None


# ----------------------------------------------------------------------
# The plugin
# ----------------------------------------------------------------------


def _active() -> _Run | None:
    """The run of the step running here, when there is a sensor session
    and the run is one the wrapper watches."""
    run = _RUN.get()
    if run is None or run.closed or _current_session() is not run.session:
        return None
    return run


async def _agent_started(agent: Any) -> None:
    run = _active()
    if run is None or not run.opens_child(agent):
        return
    child, incoming, previous = run.open_child(agent)
    if previous is not None:
        # The agent's earlier run ended without after_agent.
        _queue(previous, _end, previous, None)
    post = _queue(child, _start, child, incoming)
    Session.enter_subagent_scope(child.scope)
    await _wait(post)


async def _agent_ended(agent: Any, error: BaseException | None) -> None:
    run = _active()
    if run is None:
        return
    child = run.take(agent)
    if child is None:
        return
    # Queued first: the child has left the run's open children, so nothing
    # else would close it if what follows failed.
    post = _queue(child, _end, child, _error_block(error) if error is not None else None)
    try:
        Session.enter_subagent_scope(child.outer_scope)
    except Exception:  # noqa: BLE001 - fail open: the end is queued already
        _log.debug("Google ADK scope not restored after an agent", exc_info=True)
    await _wait(post)


def _cancelled_here() -> bool:
    """Whether the current task is being cancelled: ADK runs after_agent
    for an agent whose task is cancelled, inside the cancellation."""
    task = asyncio.current_task()
    return task is not None and task.cancelling() > 0


async def _event_seen(event: Any) -> None:
    run = _active()
    if run is None:
        return
    author = getattr(event, "author", None)
    child = run.child_of(author)
    if child is not None and run.session.config.capture_prompts and event.is_final_response():
        text = _content_text(getattr(event, "content", None))
        if text is not None:
            child.output, child.has_output = text, True
    actions = getattr(event, "actions", None)
    target = getattr(actions, "transfer_to_agent", None)
    if not isinstance(target, str) or not target or not isinstance(author, str):
        return
    if child is not None:
        await _wait(_queue(child, _handoff, run.session, child, author, target))
    else:
        # The root agent hands off on the sensor's own session; posted off
        # the loop as a child's is.
        await asyncio.to_thread(_handoff, run.session, None, author, target)


_plugin: Any = None


def _sensor_plugin() -> Any:
    """The sensor's plugin, one per process (it keeps no state: a run's
    state is the run's). Its class subclasses ADK's ``BasePlugin``, so it
    is defined only once ADK is imported. Every callback returns None,
    never short-circuiting the run, and never raises."""
    global _plugin
    if _plugin is not None:
        return _plugin
    base = getattr(importlib.import_module(_PLUGIN_MODULE), _PLUGIN_BASE)

    class FlightdeckPlugin(base):  # type: ignore[misc, valid-type]
        """Reports the run's sub-agents as child sessions of the sensor's
        session, and its hand-offs."""

        def __init__(self) -> None:
            super().__init__(name=PLUGIN_NAME)

        async def before_agent_callback(self, *, agent: Any, callback_context: Any) -> None:
            try:
                await _agent_started(agent)
            except Exception:  # noqa: BLE001 - fail open
                _log.debug("Google ADK before_agent failed", exc_info=True)

        async def after_agent_callback(self, *, agent: Any, callback_context: Any) -> None:
            try:
                cancelled = _cancelled_here()
                await _agent_ended(agent, asyncio.CancelledError() if cancelled else None)
            except Exception:  # noqa: BLE001 - fail open
                _log.debug("Google ADK after_agent failed", exc_info=True)

        async def on_agent_error_callback(
            self, *, agent: Any, callback_context: Any, error: Exception
        ) -> None:
            try:
                await _agent_ended(agent, error)
            except Exception:  # noqa: BLE001 - fail open
                _log.debug("Google ADK on_agent_error failed", exc_info=True)

        async def on_event_callback(self, *, invocation_context: Any, event: Any) -> None:
            try:
                await _event_seen(event)
            except Exception:  # noqa: BLE001 - fail open
                _log.debug("Google ADK on_event failed", exc_info=True)

    _plugin = FlightdeckPlugin()
    return _plugin


def _install_plugin(runner: Any) -> None:
    """Put the sensor's plugin first in ``runner``'s plugin manager unless
    one is registered there already."""
    manager = getattr(runner, "plugin_manager", None)
    plugins = getattr(manager, "plugins", None)
    if not isinstance(plugins, list):
        return
    if any(getattr(p, "name", None) == PLUGIN_NAME for p in plugins):
        return
    plugins.insert(0, _sensor_plugin())


def _has_plugin(runner: Any) -> bool:
    plugins = getattr(getattr(runner, "plugin_manager", None), "plugins", None) or ()
    return any(getattr(p, "name", None) == PLUGIN_NAME for p in plugins)


# ----------------------------------------------------------------------
# Runner wrappers
# ----------------------------------------------------------------------


def _wrap_init(original: Callable[..., None]) -> Callable[..., None]:
    @functools.wraps(original)
    def init(self: Any, *args: Any, **kwargs: Any) -> None:
        original(self, *args, **kwargs)
        try:
            _install_plugin(self)
        except Exception:  # noqa: BLE001 - fail open: the runner runs unobserved
            _log.debug("Google ADK plugin not installed", exc_info=True)

    return init


def _new_run(session: Session, runner: Any, kwargs: dict[str, Any]) -> _Run:
    enclosing = session.active_subagent_scope()
    incoming = None
    if session.config.capture_prompts:
        incoming = _content_text(kwargs.get(_NEW_MESSAGE_ARG))
    return _Run(
        session,
        root_name=_agent_name(getattr(runner, "agent", None)),
        nested=_RUN.get() is not None or enclosing is not None,
        parent=enclosing,
        incoming=incoming,
    )


def _check_shutdown(session: Session) -> None:
    """Raise the shutdown's ``DirectiveError`` before a run starts; any
    other failure of the check leaves the run to run (fail open)."""
    try:
        session.raise_if_shutdown()
    except DirectiveError:
        raise
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("Google ADK shutdown check failed", exc_info=True)


def _scope_now(session: Session, fallback: SubagentScope | None) -> SubagentScope | None:
    """The child scope active here, or ``fallback`` when it cannot be read."""
    try:
        return session.active_subagent_scope()
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("Google ADK step scope not read", exc_info=True)
        return fallback


def _enter_step(run: _Run, scope: SubagentScope | None) -> tuple[Any, Any]:
    """Set the run and the child scope for one step of the run; a part
    that cannot be set is left as it is (fail open)."""
    tokens: list[Any] = [None, None]
    try:
        tokens[0] = _RUN.set(run)
        tokens[1] = Session.enter_subagent_scope(scope)
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("Google ADK step state not set", exc_info=True)
    return tokens[0], tokens[1]


def _exit_step(tokens: tuple[Any, Any]) -> None:
    # Each reset on its own: the run must leave the consumer's context even
    # when the scope cannot be reset, and the other way round.
    run_token, scope_token = tokens
    if scope_token is not None:
        try:
            Session.exit_subagent_scope(scope_token)
        except Exception:  # noqa: BLE001 - another context's token, or a failure: fail open
            _log.debug("Google ADK step scope not reset", exc_info=True)
    if run_token is not None:
        try:
            _RUN.reset(run_token)
        except Exception:  # noqa: BLE001 - another context's token, or a failure: fail open
            _log.debug("Google ADK step run not reset", exc_info=True)


def _close_run(run: _Run, error: BaseException | None) -> None:
    try:
        run.close_all(error)
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("closing the Google ADK run's children failed", exc_info=True)


def _wrap_run(original: Callable[..., Any]) -> Callable[..., Any]:
    """``Runner.run_async`` / ``run_live``: the run's events, unchanged.
    A run with a sensor session, on a runner that has the sensor's plugin,
    has its state set around each step and left before each event reaches
    the consumer; what it left open is closed when it ends."""

    @functools.wraps(original)
    async def run(self: Any, *args: Any, **kwargs: Any) -> AsyncGenerator[Any, None]:
        agen = original(self, *args, **kwargs)
        session = _current_session()
        watched: _Run | None = None
        if session is not None and _has_plugin(self):
            try:
                watched = _new_run(session, self, kwargs)
            except Exception:  # noqa: BLE001 - fail open: the run goes on unwatched
                _log.debug("Google ADK run left unwatched", exc_info=True)
        if session is None or watched is None:
            try:
                async for event in agen:
                    yield event
            finally:
                await agen.aclose()
            return
        scope = watched.parent
        error: BaseException | None = None
        try:
            _check_shutdown(session)
            while True:
                tokens = _enter_step(watched, scope)
                try:
                    event = await agen.__anext__()
                except StopAsyncIteration:
                    break
                finally:
                    # The scope the run's own code left set (an agent of a
                    # workflow running on this task), resumed next step.
                    scope = _scope_now(session, scope)
                    _exit_step(tokens)
                yield event
        except GeneratorExit:
            raise
        except BaseException as exc:
            error = exc
            raise
        finally:
            tokens = _enter_step(watched, scope)
            try:
                await agen.aclose()
            finally:
                _exit_step(tokens)
                _close_run(watched, error)

    return run


# ----------------------------------------------------------------------
# Patch / unpatch
# ----------------------------------------------------------------------


def _runner_class() -> Any | None:
    try:
        module = importlib.import_module(_RUNNERS_MODULE)
    except ImportError:
        return None
    cls = getattr(module, _RUNNER_CLASS, None)
    return cls if isinstance(cls, type) else None


def patch_google_adk(*, quiet: bool = False) -> None:
    """Install the wrap on ``google.adk.runners.Runner``.

    Idempotent; a silent no-op when Google ADK is not installed.
    """
    runner = _runner_class()
    if runner is None:
        if not quiet:
            _log.debug("google-adk not installed; its wrap is skipped.")
        return
    if runner.__dict__.get(_PATCHED_SENTINEL, False):
        return
    originals = {_INIT_METHOD: runner.__dict__[_INIT_METHOD]}
    for name in _RUN_METHODS:
        if name in runner.__dict__:
            originals[name] = runner.__dict__[name]
    for name, original in originals.items():
        wrapper = _wrap_init if name == _INIT_METHOD else _wrap_run
        setattr(runner, name, wrapper(original))
        setattr(runner, f"{_ORIGINAL_ATTR}_{name}", original)
    setattr(runner, _PATCHED_SENTINEL, True)


def unpatch_google_adk() -> None:
    """Restore ``Runner``. Idempotent. A runner built while patched keeps
    the sensor's plugin, which does nothing once its runs are unwatched."""
    runner = _runner_class()
    if runner is None or not runner.__dict__.get(_PATCHED_SENTINEL, False):
        return
    for name in (_INIT_METHOD, *_RUN_METHODS):
        attr = f"{_ORIGINAL_ATTR}_{name}"
        original = runner.__dict__.get(attr)
        if original is not None:
            setattr(runner, name, original)
            delattr(runner, attr)
    delattr(runner, _PATCHED_SENTINEL)
