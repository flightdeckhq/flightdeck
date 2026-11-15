"""LangGraph wrap: a child session per run of a node of a graph the
application builds.

Seam. ``langgraph.graph.StateGraph.add_node`` is patched, so each node is
decided once, when the graph is built: a node the wrap leaves alone is
registered as given, and nothing is added to its run path.

What becomes a child session. A child session is a sub-agent, and in a
LangGraph application a sub-agent is a node of a graph the application
builds by hand. Such a node opens a child each time it runs
(``agent_role`` the node name, ``agent_name`` ``<sensor agent
name>/<node name>``, the node's input and its return as the incoming and
outgoing messages under ``capture_prompts``), whatever its action is:

* a function, a method or a callable instance, sync or async: wrapped by
  a function with its signature (``functools.wraps``), through which
  LangGraph reads which of ``config`` / ``runtime`` / ``store`` /
  ``writer`` to inject;
* a Runnable (``RunnableCallable``, ``ToolNode``, ``RunnableLambda``, an
  LCEL pipe): wrapped in a ``RunnableCallable`` subclass named after the
  node, with no tracing or recursion of its own, that passes the node's
  input and config to the Runnable's own ``invoke``, ``ainvoke`` or
  ``astream`` (the last is what LangGraph calls under ``astream_events``),
  so each step of a pipe keeps its own sync or async dispatch. The
  wrapper's ``afunc`` is never called; it is what LangGraph's node-timeout
  check reads, so it is the executor-backed form LangGraph gives a sync
  function when the Runnable has no async code of its own, and a timeout
  is accepted or refused as for the unwrapped node.

Left alone, so no child:

* the nodes ``create_agent`` and ``create_react_agent`` register (the
  model call, the tool execution, middleware and model hooks): one
  agent's own steps, not sub-agents. They are told apart by the module
  that called ``StateGraph``, the first frame outside the sensor and
  ``langgraph.graph``, read when the node is added: any module of
  ``langchain.agents`` or ``langgraph.prebuilt``;
* a compiled graph used as a node (the nodes inside it open their own,
  where that graph registered them);
* a generator or async-generator node function, which LangGraph runs as
  a stream (a ``RunnableLambda``) and a wrapper function would hide;
* a node whose name ``init(langgraph_agent_node_pattern=...)`` does not
  match, when that is set.

Nesting. The node's work runs inside its child's scope
(:meth:`Session.enter_subagent_scope`); a child opened while another
child's scope is active (a node of a graph invoked from inside a node)
names that child as its parent.

Ends. A child closes when its node returns, and ends with
``state=error`` when the node raises or, async, is cancelled. LangGraph's
control-flow exceptions (``GraphBubbleUp``: an interrupt, a ``Command``
for the parent graph, a drain) close it normally; a resumed node runs
again and opens a new child.

Posting. The child's start and end are posted synchronously, as every
wrap's are. An async node queues them on the event loop's executor,
apart from its own task, and waits for them shielded: the loop is not
held, a cancellation of the node (LangGraph cancels a failed run's other
nodes twice) propagates without dropping a post, and the session's
``end()`` waits for posts still running. An end posted while its start
is still under way waits for the start, so the two arrive in order. The
node's model, tool and MCP calls stay on the sensor's session.

Fail open (Rule 28): a node that cannot be wrapped is registered as
given, and a failed post, or an exception that cannot be rendered, never
reaches the node.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import importlib
import inspect
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.session import (
    SUBAGENT_ERROR_TYPE_KEY,
    SUBAGENT_STATE_CLOSED,
    SUBAGENT_STATE_ERROR,
    subagent_error,
)
from flightdeck_sensor.core.types import SubagentMessage

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable

    from langchain_core.runnables import RunnableConfig

    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.core.types import SubagentScope

_log = logging.getLogger("flightdeck_sensor.interceptor.langgraph")

_PATCHED_SENTINEL = "_flightdeck_subagent_patched"

# The packages whose StateGraph nodes are one agent's own steps rather
# than sub-agents: LangChain's agents (create_agent, in
# langchain.agents.factory) and LangGraph's prebuilt agents
# (create_react_agent, in langgraph.prebuilt.chat_agent_executor).
# Matched as packages, so a release that moves the add_node calls to
# another module of the package keeps them excluded.
_AGENT_BUILDER_PACKAGES = ("langchain.agents", "langgraph.prebuilt")
# The frames passed over to find the module that registered a node: the
# sensor's own, and StateGraph's methods that call add_node themselves
# (add_sequence).
_PASSED_OVER_MODULE_PREFIXES = ("flightdeck_sensor.", "langgraph.graph.")
# The class name of LangGraph's control-flow exceptions (an interrupt, a
# Command for the parent graph, a drain), matched by name when
# ``langgraph.errors`` cannot be imported.
_CONTROL_FLOW_BASE = "GraphBubbleUp"
# The attribute a Runnable node's wrapper keeps the Runnable in.
_ORIGINAL_ATTR = "_flightdeck_original"
# How long, in seconds, a child's end waits for its start when the start
# is still being posted (a cancellation reached an async node while it
# waited for its start): the transport bounds one post at two attempts
# of 10 s plus the back-off between them, and 25 s covers that, so the
# end follows the start unless the start is lost anyway.
_START_POST_WAIT_SECS = 25.0


# ----------------------------------------------------------------------
# Lazy framework import. Importing ``langgraph`` at module load time
# pulls langchain_core into ``sys.modules``, which trips the
# FrameworkCollector's bare-SDK-no-attribution invariant. Defer to
# patch / availability check so ``import flightdeck_sensor`` stays
# free of framework side effects until the user actually opts in
# via ``patch()``.
# ----------------------------------------------------------------------

_StateGraph: Any = None  # populated lazily by _ensure_imported()
_LANGGRAPH_AVAILABLE: bool | None = None  # tri-state
# What wrapping a Runnable node needs, resolved with StateGraph; a Runnable
# node is left unwrapped when any of the first four is missing.
_Runnable: Any = None
_RunnableCallable: Any = None
_PregelProtocol: Any = None
_run_in_executor: Any = None
_GraphBubbleUp: Any = None
_native_async_check: Any = None


def _optional(module: str, name: str) -> Any:
    """``module.name``, or None when either cannot be imported."""
    try:
        return getattr(importlib.import_module(module), name, None)
    except ImportError:
        return None


def _ensure_imported() -> bool:
    global _StateGraph, _LANGGRAPH_AVAILABLE, _Runnable, _RunnableCallable
    global _PregelProtocol, _run_in_executor, _GraphBubbleUp, _native_async_check
    if _LANGGRAPH_AVAILABLE is not None:
        return _LANGGRAPH_AVAILABLE
    try:
        from langgraph.graph import StateGraph
    except ImportError:
        _StateGraph = None
        _LANGGRAPH_AVAILABLE = False
        return False
    _StateGraph = StateGraph
    # Loaded with langgraph.graph already, so these import nothing new.
    _Runnable = _optional("langchain_core.runnables", "Runnable")
    _run_in_executor = _optional("langchain_core.runnables.config", "run_in_executor")
    _PregelProtocol = _optional("langgraph.pregel.protocol", "PregelProtocol")
    _RunnableCallable = _optional("langgraph._internal._runnable", "RunnableCallable") or (
        _optional("langgraph.utils.runnable", "RunnableCallable")
    )
    _GraphBubbleUp = _optional("langgraph.errors", _CONTROL_FLOW_BASE)
    # LangGraph's own test of whether a Runnable has async code of its own
    # (its node-timeout check); absent before LangGraph had node timeouts.
    _native_async_check = _optional("langgraph.pregel._utils", "_runnable_has_native_async")
    _LANGGRAPH_AVAILABLE = True
    return True


# Module-level pattern override settable by ``init(langgraph_agent_node_pattern=…)``.
# When None, every node gets wrapped; when set to a compiled regex,
# only nodes whose name matches are wrapped. Init writes through
# ``set_agent_node_pattern`` so tests don't need to reach into module
# state.
_agent_node_pattern: re.Pattern[str] | None = None


def set_agent_node_pattern(pattern: str | None) -> None:
    """Set or clear the regex that decides which LangGraph node
    names get wrapped. Called by ``flightdeck_sensor.init`` when
    the user passes ``langgraph_agent_node_pattern``. Compiled
    once at set time so per-add_node lookup is O(1) regex match.
    """
    global _agent_node_pattern
    _agent_node_pattern = None if pattern is None else re.compile(pattern)


def _is_agent_bearing(node_name: str) -> bool:
    """Return True if the named node should emit sub-agent events:
    always when no pattern is set, else when the name matches it."""
    if _agent_node_pattern is None:
        return True
    return bool(_agent_node_pattern.search(node_name))


def _current_session() -> Session | None:
    import flightdeck_sensor

    return flightdeck_sensor._session


def _capture_message(body: Any) -> SubagentMessage:
    return SubagentMessage(
        body=body,
        captured_at=datetime.now(UTC).isoformat(),
    )


def _agent_name(node_name: str, session: Session) -> str:
    """Compose the child's ``agent_name`` from the parent's plus
    the node-name suffix. Same shape as the CrewAI interceptor.
    """
    parent_name = session.config.agent_name
    if not node_name:
        return parent_name
    return f"{parent_name}/{node_name}"


# ----------------------------------------------------------------------
# Which nodes are wrapped
# ----------------------------------------------------------------------


def _registering_module() -> str | None:
    """The module that called StateGraph to add the node being added: the
    first frame outside the sensor and ``langgraph.graph``."""
    frame = inspect.currentframe()
    try:
        while frame is not None:
            name = frame.f_globals.get("__name__")
            if not isinstance(name, str):
                return None
            if not name.startswith(_PASSED_OVER_MODULE_PREFIXES):
                return name
            frame = frame.f_back
        return None
    finally:
        del frame


def _in_package(module: str | None, packages: tuple[str, ...]) -> bool:
    """Whether ``module`` is one of ``packages`` or a module inside one."""
    if module is None:
        return False
    return any(module == p or module.startswith(f"{p}.") for p in packages)


def _is_generator(action: Any) -> bool:
    """Whether a node action is a generator or async-generator function
    (or an instance whose ``__call__`` is one), which LangGraph runs as a
    stream."""
    return any(
        inspect.isgeneratorfunction(fn) or inspect.isasyncgenfunction(fn)
        for fn in (action, type(action).__call__)
    )


def _default_node_name(action: Any) -> Any:
    """The name LangGraph gives a node registered without one."""
    if _Runnable is not None and isinstance(action, _Runnable):
        return action.get_name()
    return getattr(action, "__name__", type(action).__name__)


def _wrap_node(node_name: Any, action: Any) -> Any | None:
    """The action to register for the node instead of ``action``, or None
    to register ``action`` as given."""
    if action is None or not isinstance(node_name, str) or not _is_agent_bearing(node_name):
        return None
    if _in_package(_registering_module(), _AGENT_BUILDER_PACKAGES):
        return None
    if _Runnable is not None and isinstance(action, _Runnable):
        if _RunnableCallable is None or _run_in_executor is None:
            return None
        if _PregelProtocol is not None and isinstance(action, _PregelProtocol):
            return None
        return _wrap_runnable(node_name, action)
    if not callable(action) or _is_generator(action):
        return None
    return _wrap_function(node_name, action)


# ----------------------------------------------------------------------
# Child sessions
# ----------------------------------------------------------------------

# The result of a node that did not return (it raised, or its stream was
# abandoned).
_NO_RESULT: Any = object()


@dataclass
class _Child:
    """One node run's child session."""

    session: Session
    scope: SubagentScope
    # The child session this one nests under; None for the sensor's own.
    parent_session_id: str | None
    # An async node's start post, queued on the loop's executor; an end
    # waits for it (see _end).
    start_post: concurrent.futures.Future[None] | None = None

    def identity(self) -> dict[str, Any]:
        return {
            "child_session_id": self.scope.child_session_id,
            "child_agent_id": self.scope.child_agent_id,
            "child_agent_name": self.scope.child_agent_name,
            "agent_role": self.scope.agent_role,
            "parent_session_id": self.parent_session_id,
        }


def _open(node_name: str) -> _Child | None:
    """A child session for a run of ``node_name``, nested under the child
    whose scope is active, or None (no session, or it could not be built)."""
    session = _current_session()
    if session is None:
        return None
    try:
        enclosing = session.active_subagent_scope()
        scope = session.new_subagent_scope(
            child_session_id=str(uuid.uuid4()),
            child_agent_id=session.derive_subagent_id(node_name),
            child_agent_name=_agent_name(node_name, session),
            agent_role=node_name,
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("LangGraph child session for %r not opened", node_name, exc_info=True)
        return None
    parent = enclosing.child_session_id if enclosing is not None else None
    return _Child(session=session, scope=scope, parent_session_id=parent)


def _is_control_flow(exc: BaseException) -> bool:
    """Whether ``exc`` is LangGraph steering the run (an interrupt, a
    Command for the parent graph, a drain) rather than a failure."""
    if _GraphBubbleUp is not None:
        return isinstance(exc, _GraphBubbleUp)
    return any(cls.__name__ == _CONTROL_FLOW_BASE for cls in type(exc).__mro__)


def _error_block(error: BaseException) -> dict[str, str]:
    """The child's error block; the type alone when the exception's text
    cannot be rendered (its ``__str__`` raises)."""
    try:
        return subagent_error(error)
    except Exception:  # noqa: BLE001 - fail open: the node's exception still propagates
        return {SUBAGENT_ERROR_TYPE_KEY: type(error).__name__}


def _start(child: _Child, body: Any) -> None:
    try:
        child.session.emit_subagent_session_start(
            incoming_message=_capture_message(body), **child.identity()
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("LangGraph child session_start failed", exc_info=True)


def _end(child: _Child, result: Any = _NO_RESULT, error: BaseException | None = None) -> None:
    started = child.start_post
    if started is not None and not started.done():
        try:
            started.result(timeout=_START_POST_WAIT_SECS)
        except Exception:  # noqa: BLE001 - post the end anyway
            _log.debug("LangGraph child start post did not finish", exc_info=True)
    try:
        state = SUBAGENT_STATE_CLOSED
        error_block: dict[str, str] | None = None
        if error is not None and not _is_control_flow(error):
            state, error_block = SUBAGENT_STATE_ERROR, _error_block(error)
        outgoing = _capture_message(result) if result is not _NO_RESULT else None
        child.session.emit_subagent_session_end(
            state=state, error=error_block, outgoing_message=outgoing, **child.identity()
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("LangGraph child session_end failed", exc_info=True)


def _queue(child: _Child, post: Callable[..., None], *args: Any) -> concurrent.futures.Future[None]:
    """Queue a child post on the running loop's executor, apart from any
    task, so cancelling the task that waits for it cannot drop it; the
    session's ``end()`` waits for it. Posted in place when there is no
    loop or its executor no longer takes work (the loop is shutting
    down). The posts never raise."""
    done: concurrent.futures.Future[None] = concurrent.futures.Future()

    def run() -> None:
        try:
            post(*args)
        finally:
            done.set_result(None)

    try:
        asyncio.get_running_loop().run_in_executor(None, run)
    except RuntimeError:
        run()
        return done
    child.session.track_child_post(done)
    return done


async def _wait(post: concurrent.futures.Future[None]) -> None:
    """Wait for a queued post. A cancellation of the waiter propagates
    and leaves the post running."""
    await asyncio.shield(asyncio.wrap_future(post))


def _run_sync(node_name: str, body: Any, call: Callable[[], Any]) -> Any:
    child = _open(node_name)
    if child is None:
        return call()
    _start(child, body)
    token = child.session.enter_subagent_scope(child.scope)
    try:
        result = call()
    except Exception as exc:
        _end(child, _NO_RESULT, exc)
        raise
    finally:
        child.session.exit_subagent_scope(token)
    _end(child, result)
    return result


async def _run_async(node_name: str, body: Any, call: Callable[[], Awaitable[Any]]) -> Any:
    child = _open(node_name)
    if child is None:
        return await call()
    child.start_post = _queue(child, _start, child, body)
    token = child.session.enter_subagent_scope(child.scope)
    try:
        await _wait(child.start_post)
        result = await call()
    except (Exception, asyncio.CancelledError) as exc:
        await _wait(_queue(child, _end, child, _NO_RESULT, exc))
        raise
    finally:
        child.session.exit_subagent_scope(token)
    await _wait(_queue(child, _end, child, result))
    return result


async def _stream_child(
    node_name: str, body: Any, stream: Callable[[], AsyncIterator[Any]]
) -> AsyncIterator[Any]:
    """:func:`_run_async` for a node LangGraph streams: the child's
    outgoing message is the last chunk, the output LangGraph keeps. A
    stream its consumer abandons closes the child normally."""
    child = _open(node_name)
    if child is None:
        async for chunk in stream():
            yield chunk
        return
    child.start_post = _queue(child, _start, child, body)
    token = child.session.enter_subagent_scope(child.scope)
    last = _NO_RESULT
    try:
        await _wait(child.start_post)
        async for chunk in stream():
            last = chunk
            yield chunk
    except GeneratorExit:
        # Queued, not awaited: a generator being closed must not wait.
        _queue(child, _end, child, _NO_RESULT, None)
        raise
    except (Exception, asyncio.CancelledError) as exc:
        await _wait(_queue(child, _end, child, _NO_RESULT, exc))
        raise
    finally:
        child.session.exit_subagent_scope(token)
    await _wait(_queue(child, _end, child, last))


# ----------------------------------------------------------------------
# Node wrappers
# ----------------------------------------------------------------------


def _wrap_function(node_name: str, action: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a function node, keeping its sync or async shape and its
    signature, so the arguments LangGraph injects by parameter name still
    reach it."""

    # functools.wraps sets __wrapped__, through which LangGraph reads the
    # node's signature to decide which of config / runtime / store /
    # writer to inject; a bare (*args, **kwargs) would hide them and the
    # node would fail with a missing-argument TypeError.
    @functools.wraps(action)
    def _sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        return _run_sync(node_name, args[0] if args else kwargs, lambda: action(*args, **kwargs))

    @functools.wraps(action)
    async def _async_wrapper(*args: Any, **kwargs: Any) -> Any:
        return await _run_async(
            node_name, args[0] if args else kwargs, lambda: action(*args, **kwargs)
        )

    # A callable instance with ``async def __call__`` is a coroutine
    # function only through its __call__, which LangGraph also checks.
    if inspect.iscoroutinefunction(action) or inspect.iscoroutinefunction(type(action).__call__):
        return _async_wrapper
    return _sync_wrapper


def _has_native_async(runnable: Any) -> bool:
    """Whether LangGraph counts ``runnable`` as having async code of its
    own: its own test when it has one, else whether a RunnableCallable or
    RunnableLambda was given an async function."""
    if _native_async_check is not None:
        try:
            return bool(_native_async_check(runnable))
        except Exception:  # noqa: BLE001 - fall back to the attribute test
            _log.debug("LangGraph's native-async test failed", exc_info=True)
    if hasattr(runnable, "func") or hasattr(runnable, "afunc"):
        afunc = getattr(runnable, "afunc", None)
        return afunc is not None and not (
            isinstance(afunc, functools.partial) and afunc.func is _run_in_executor
        )
    return True


@functools.cache
def _node_wrapper_class() -> type[Any]:
    """The RunnableCallable subclass a Runnable node is wrapped in. Its
    ``ainvoke`` and ``astream`` hand the node to the Runnable's own
    (LangGraph calls ``astream`` on a node under ``astream_events``), so
    each step keeps its own dispatch and its own stream events; the sync
    path is RunnableCallable's, which calls the wrapper's function."""

    async def ainvoke(
        self: Any, input: Any, config: RunnableConfig | None = None, **kwargs: Any
    ) -> Any:
        original = getattr(self, _ORIGINAL_ATTR)
        return await _run_async(self.name, input, lambda: original.ainvoke(input, config, **kwargs))

    async def astream(
        self: Any, input: Any, config: RunnableConfig | None = None, **kwargs: Any
    ) -> AsyncIterator[Any]:
        original = getattr(self, _ORIGINAL_ATTR)
        async for chunk in _stream_child(
            self.name, input, lambda: original.astream(input, config, **kwargs)
        ):
            yield chunk

    return type(
        "FlightdeckLangGraphNode",
        (_RunnableCallable,),
        {"ainvoke": ainvoke, "astream": astream},
    )


def _wrap_runnable(node_name: str, original: Any) -> Any:
    """Wrap a Runnable node in a RunnableCallable named after the node,
    with no tracing or recursion of its own, that hands the node's input
    and config to the Runnable. ``config`` is annotated RunnableConfig:
    LangGraph injects a node's config only into a parameter so annotated."""

    def invoke(input: Any, config: RunnableConfig) -> Any:
        return _run_sync(node_name, input, lambda: original.invoke(input, config))

    async def ainvoke(input: Any, config: RunnableConfig) -> Any:
        return await _run_async(node_name, input, lambda: original.ainvoke(input, config))

    # The wrapper's ainvoke never calls afunc: LangGraph's node-timeout
    # check reads it to tell a node with async code of its own from a sync
    # one, so a Runnable without any gets the executor-backed form
    # LangGraph gives a sync function, and a timeout is refused for it as
    # for the unwrapped node.
    afunc: Any = (
        ainvoke
        if _has_native_async(original)
        else functools.partial(_run_in_executor, None, invoke)
    )
    node = _node_wrapper_class()(invoke, afunc, name=node_name, trace=False, recurse=False)
    setattr(node, _ORIGINAL_ATTR, original)
    return node


# ----------------------------------------------------------------------
# Patch / unpatch
# ----------------------------------------------------------------------


def patch_langgraph_classes(*, quiet: bool = False) -> None:
    """Install the sub-agent interceptor on
    ``langgraph.graph.StateGraph.add_node``.

    Idempotent. Silent no-op when ``langgraph`` is missing.
    """
    if not _ensure_imported():
        if not quiet:
            _log.debug("langgraph not installed; sub-agent patch skipped.")
        return
    assert _StateGraph is not None

    if getattr(_StateGraph, _PATCHED_SENTINEL, False):
        return

    original_add_node = _StateGraph.add_node

    def _wrapped_add_node(
        self: Any,
        node: Any,
        action: Any = None,
        **kwargs: Any,
    ) -> Any:
        # Two add_node call shapes exist:
        #   add_node("name", action)
        #   add_node(action)        # named as LangGraph names it
        # Normalize so the wrap site works against (name, action).
        try:
            if isinstance(node, str):
                node_name, node_action = node, action
            else:
                node_name, node_action = _default_node_name(node), node
            wrapped = _wrap_node(node_name, node_action)
        except Exception:  # noqa: BLE001 - fail open: register the node as given
            _log.debug("LangGraph node left unwrapped", exc_info=True)
            wrapped = None
        if wrapped is None:
            return original_add_node(self, node, action=action, **kwargs)
        # Registered under the name explicitly: a callable instance has no
        # __name__ to hand on, so the wrapper alone would register as
        # "_sync_wrapper" and break edges that use the class name.
        return original_add_node(self, node_name, action=wrapped, **kwargs)

    _StateGraph.add_node = _wrapped_add_node
    setattr(_StateGraph, _PATCHED_SENTINEL, True)
    setattr(_StateGraph, f"{_PATCHED_SENTINEL}_orig_add_node", original_add_node)


def unpatch_langgraph_classes() -> None:
    """Restore the original ``StateGraph.add_node``. Idempotent."""
    if not _ensure_imported():
        return
    assert _StateGraph is not None
    if not getattr(_StateGraph, _PATCHED_SENTINEL, False):
        return
    orig = getattr(_StateGraph, f"{_PATCHED_SENTINEL}_orig_add_node", None)
    if orig is not None:
        _StateGraph.add_node = orig
        delattr(_StateGraph, f"{_PATCHED_SENTINEL}_orig_add_node")
    delattr(_StateGraph, _PATCHED_SENTINEL)
