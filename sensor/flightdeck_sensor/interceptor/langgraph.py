"""LangGraph wrap: a child session per run of a node of a graph the
application builds, and per graph run started inside another.

Seams. ``langgraph.graph.StateGraph.add_node`` is patched, so each node is
decided once, when the graph is built: a node the wrap leaves alone is
registered as given, and nothing is added to its run path.
``langgraph.pregel.Pregel.stream`` and ``astream`` are patched too: every
run of a compiled graph goes through one of them (``invoke`` and
``ainvoke`` call them, so do ``stream_events`` and ``astream_events``).
They are patched once ``langgraph.pregel`` is imported, without
importing ``langgraph.graph``: an application on LangGraph's functional
API (``@entrypoint``) never imports it.

What becomes a child session. A child session is a sub-agent. In a
LangGraph application that is a node of a graph the application builds
by hand, and a graph run started inside another graph run or inside a
child: a compiled graph used as a node, a graph invoked from a node or a
tool (an agent used as a tool), and each sub-agent a Deep Agents ``task``
call runs.

Nodes. A node of a hand-built graph opens a child each time it runs
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
* a compiled graph used as a node, bound or not (``with_config``,
  ``with_retry``), or with fallbacks that are all graphs: its run opens
  the child (see Graph runs), and the nodes inside it open theirs under
  that child;
* a generator or async-generator node function, which LangGraph runs as
  a stream (a ``RunnableLambda``) and a wrapper function would hide;
* a node whose name ``init(langgraph_agent_node_pattern=...)`` does not
  match, when that is set.

Graph runs. A run of a compiled graph opens a child when it starts inside
another graph run (as, or inside, one of that run's tasks: its own
config or the one it inherits carries the task's id) or inside a child
of the sensor's; a top-level run opens none, its session is the
sensor's. The role is the run's name as LangGraph names it (``run_name``
in its config, else the graph's name: ``create_agent(name=...)``, and so
the name Deep Agents gives each sub-agent); an unnamed graph
(``LangGraph``) takes the name of the node it runs in, unless that node
is one of ``create_agent``'s or ``create_react_agent``'s own steps, else
``subgraph``. Each run records its graph as the one whose step runs,
around its steps, so a run started inside a node knows whose node it
is. The run's
input is the incoming message and its last full state (what ``invoke``
returns) the outgoing one. ``langgraph_agent_node_pattern`` names nodes
and does not narrow graph runs. A ``RemoteGraph`` is not a ``Pregel``:
its run happens in its server, and opens no child here.

Nesting. A node's work, and a graph run's, runs inside its child's scope
(:meth:`Session.enter_subagent_scope`); a child opened while another
child's scope is active names that child as its parent. A run's scope is
entered around each step it streams and left before the chunk is handed
to its consumer, so the consumer's own code is not attributed to it.

Ends. A child closes when its node returns or its run finishes, and ends
with ``state=error`` when the node or the run raises or, async, is
cancelled. LangGraph's control-flow exceptions (``GraphBubbleUp``: an
interrupt, a ``Command`` for the parent graph, a drain) close it
normally; a resumed node or run runs again and opens a new child. A run
whose stream is closed before its end (abandoned) closes normally.
Closing an async run's stream closes LangGraph's own stream at once,
however the close is awaited, unless the event loop has taken that
stream's close over (collected unclosed, or swept when the loop shuts
down), which asyncio's loop shows by its set of live generators; a loop
that keeps that set out of reach (uvloop) is taken to close it when the
close runs as a task of its own.

Posting. The child's start and end are posted synchronously, as every
wrap's are, except on a thread that runs an event loop. An async node or
run queues them on the event loop's executor, apart from its own task,
and waits for them shielded: the loop is not held, a cancellation of the
node (LangGraph cancels a failed run's other nodes twice) propagates
without dropping a post, and the session's ``end()`` waits for posts
still running. Sync code on a loop's thread (a sync graph run inside a
coroutine) queues them and does not wait. An end queued while its start
is still being posted is queued from the start post's completion, so the
two arrive in order and no thread waits. The model, tool and MCP calls
stay on the sensor's session.

Fail open (Rule 28): a node that cannot be wrapped is registered as
given, a run whose child cannot be opened runs as it would unpatched, and
a failed post, or an exception that cannot be rendered, never reaches the
node or the run.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import importlib
import inspect
import logging
import re
import threading
import uuid
from collections.abc import Mapping
from contextvars import ContextVar
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
    from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
    from contextvars import Token

    from langchain_core.runnables import RunnableConfig

    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.core.types import SubagentScope

_log = logging.getLogger("flightdeck_sensor.interceptor.langgraph")

_PATCHED_SENTINEL = "_flightdeck_subagent_patched"
# Set on Pregel while its stream and astream are patched; the originals
# are kept beside it under these names.
_RUNS_PATCHED_SENTINEL = "_flightdeck_runs_patched"
_ORIG_STREAM_ATTR = "_flightdeck_orig_stream"
_ORIG_ASTREAM_ATTR = "_flightdeck_orig_astream"
# The name LangGraph gives a graph compiled without one; a run of such a
# graph is named after the node it runs in instead.
_DEFAULT_GRAPH_NAME = "LangGraph"
# The role of a run of an unnamed graph that runs in no node (started
# inside a child of another framework's, say).
_GENERIC_RUN_ROLE = "subgraph"
# The metadata key under which LangGraph gives each task the name of its
# node; a run inside a node inherits it with the node's config.
_NODE_METADATA_KEY = "langgraph_node"
# The configurable key under which LangGraph gives each task its id: a run
# whose config carries it runs as, or inside, another run's task. Read
# from LangGraph when it can be imported.
_TASK_ID_KEY_DEFAULT = "__pregel_task_id"
# A RunnableConfig's sections the wrap reads: the per-run settings (the
# task id among them), the metadata (the node name among them), and the
# run's own name.
_CONFIGURABLE_KEY = "configurable"
_METADATA_KEY = "metadata"
_RUN_NAME_KEY = "run_name"
# The Pregel.stream arguments that shape its chunks.
_STREAM_MODE_ARG = "stream_mode"
_VERSION_ARG = "version"
_SUBGRAPHS_ARG = "subgraphs"
# The stream version whose chunks are stream parts, dicts of the three
# keys below: the chunk's mode, its namespace and its data.
_STREAM_PARTS_VERSION = "v2"
_PART_TYPE_KEY = "type"
_PART_NS_KEY = "ns"
_PART_DATA_KEY = "data"
# The stream mode whose chunks are the run's full state.
_VALUES_MODE = "values"
# The tuple chunks of a run streaming several modes or its sub-graphs:
# (namespace, data) for one mode with sub-graphs, (mode, data) for
# several modes, (namespace, mode, data) for several with sub-graphs.
_NAMESPACED_CHUNK_LEN = 2
_MODE_CHUNK_LEN = 2
_NAMESPACED_MODE_CHUNK_LEN = 3
# The Pregel methods the run patch replaces.
_STREAM_METHOD = "stream"
_ASTREAM_METHOD = "astream"
# Set on a StateGraph whose nodes create_agent or create_react_agent
# registered: a run started inside one of them is not named after it.
_AGENT_STEPS_ATTR = "_flightdeck_agent_steps"
# The attribute under which asyncio's event loop keeps the async
# generators it will close itself; read where present (see
# _live_async_generators).
_LIVE_ASYNCGENS_ATTR = "_asyncgens"
# The type of the coroutine of a task asyncio runs to close an async
# generator itself (one collected unclosed, or one still open when the
# loop shuts down): the generator's own aclose(). The test used where the
# loop does not expose its live generators.
_LOOP_CLOSE_CORO_TYPE = "async_generator_athrow"

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
_native_async_check: Any = None
# The binding classes a compiled graph used as a node may be wrapped in.
_RunnableBinding: Any = None
_RunnableWithFallbacks: Any = None
# What a graph run's child needs, resolved from langgraph.pregel alone (an
# application on LangGraph's functional API never imports langgraph.graph):
# the class whose stream and astream are patched, the context variable
# LangChain keeps a running Runnable's config in (a run started inside a
# node or a tool reads its enclosing task from it), the task-id key, and
# LangGraph's control-flow exception class.
_RUNS_AVAILABLE: bool | None = None  # tri-state
_Pregel: Any = None
_var_child_runnable_config: Any = None
_task_id_key: str = _TASK_ID_KEY_DEFAULT
_GraphBubbleUp: Any = None


def _optional(module: str, name: str) -> Any:
    """``module.name``, or None when either cannot be imported."""
    try:
        return getattr(importlib.import_module(module), name, None)
    except ImportError:
        return None


def _ensure_runs_imported() -> bool:
    """Resolve what the run patch needs from ``langgraph.pregel``, never
    importing ``langgraph.graph``: the run patch is applied as soon as
    ``langgraph.pregel`` is imported, which may be midway through the
    import of ``langgraph.graph``."""
    global _RUNS_AVAILABLE, _Pregel, _var_child_runnable_config, _task_id_key
    global _GraphBubbleUp
    if _RUNS_AVAILABLE is not None:
        return _RUNS_AVAILABLE
    _Pregel = _optional("langgraph.pregel", "Pregel")
    if _Pregel is None:
        _RUNS_AVAILABLE = False
        return False
    # Loaded with langgraph.pregel already, so these import nothing new.
    _var_child_runnable_config = _optional(
        "langchain_core.runnables.config", "var_child_runnable_config"
    )
    task_id_key = _optional("langgraph._internal._constants", "CONFIG_KEY_TASK_ID")
    _task_id_key = task_id_key if isinstance(task_id_key, str) else _TASK_ID_KEY_DEFAULT
    _GraphBubbleUp = _optional("langgraph.errors", _CONTROL_FLOW_BASE)
    _RUNS_AVAILABLE = True
    return True


def _ensure_imported() -> bool:
    global _StateGraph, _LANGGRAPH_AVAILABLE, _Runnable, _RunnableCallable
    global _PregelProtocol, _run_in_executor, _native_async_check
    global _RunnableBinding, _RunnableWithFallbacks
    if _LANGGRAPH_AVAILABLE is not None:
        return _LANGGRAPH_AVAILABLE
    try:
        from langgraph.graph import StateGraph
    except ImportError:
        _StateGraph = None
        _LANGGRAPH_AVAILABLE = False
        return False
    _StateGraph = StateGraph
    _ensure_runs_imported()
    # Loaded with langgraph.graph already, so these import nothing new.
    _Runnable = _optional("langchain_core.runnables", "Runnable")
    _run_in_executor = _optional("langchain_core.runnables.config", "run_in_executor")
    _PregelProtocol = _optional("langgraph.pregel.protocol", "PregelProtocol")
    _RunnableCallable = _optional("langgraph._internal._runnable", "RunnableCallable") or (
        _optional("langgraph.utils.runnable", "RunnableCallable")
    )
    # LangGraph's own test of whether a Runnable has async code of its own
    # (its node-timeout check); absent before LangGraph had node timeouts.
    _native_async_check = _optional("langgraph.pregel._utils", "_runnable_has_native_async")
    _RunnableBinding = _optional("langchain_core.runnables.base", "RunnableBindingBase")
    _RunnableWithFallbacks = _optional("langchain_core.runnables", "RunnableWithFallbacks")
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


def _is_compiled_graph(action: Any) -> bool:
    """Whether a node action is a compiled graph, a binding of one
    (``with_retry``, ``bind``), or graphs with fallbacks that are all
    graphs (``with_fallbacks``): whichever runs, its run, not the node,
    opens the child."""
    if _PregelProtocol is None:
        return False
    while _RunnableBinding is not None and isinstance(action, _RunnableBinding):
        action = action.bound
    if _RunnableWithFallbacks is not None and isinstance(action, _RunnableWithFallbacks):
        return all(_is_compiled_graph(r) for r in (action.runnable, *action.fallbacks))
    return isinstance(action, _PregelProtocol)


def _mark_agent_steps(graph: Any) -> None:
    """Record that ``graph``'s nodes are an agent's own steps."""
    try:
        setattr(graph, _AGENT_STEPS_ATTR, True)
    except Exception:  # noqa: BLE001 - fail open: such a run keeps the node's name
        _log.debug("LangGraph agent graph left unmarked", exc_info=True)


def _wrap_node(graph: Any, node_name: Any, action: Any) -> Any | None:
    """The action to register for the node instead of ``action``, or None
    to register ``action`` as given."""
    if action is None or not isinstance(node_name, str):
        return None
    if _in_package(_registering_module(), _AGENT_BUILDER_PACKAGES):
        _mark_agent_steps(graph)
        return None
    if not _is_agent_bearing(node_name):
        return None
    if _Runnable is not None and isinstance(action, _Runnable):
        if _RunnableCallable is None or _run_in_executor is None:
            return None
        if _is_compiled_graph(action):
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
    """One node run's, or one graph run's, child session."""

    session: Session
    scope: SubagentScope
    # The child session this one nests under; None for the sensor's own.
    parent_session_id: str | None
    # The start post when it was queued on a loop's executor; a later post
    # still in flight is queued from its completion (see _queue).
    start_post: concurrent.futures.Future[None] | None = None

    def identity(self) -> dict[str, Any]:
        return {
            "child_session_id": self.scope.child_session_id,
            "child_agent_id": self.scope.child_agent_id,
            "child_agent_name": self.scope.child_agent_name,
            "agent_role": self.scope.agent_role,
            "parent_session_id": self.parent_session_id,
        }


def _open(role: str) -> _Child | None:
    """A child session with ``role`` (a node's name, a graph run's),
    nested under the child whose scope is active, or None (no session, or
    it could not be built)."""
    session = _current_session()
    if session is None:
        return None
    try:
        enclosing = session.active_subagent_scope()
        scope = session.new_subagent_scope(
            child_session_id=str(uuid.uuid4()),
            child_agent_id=session.derive_subagent_id(role),
            child_agent_name=_agent_name(role, session),
            agent_role=role,
        )
    except Exception:  # noqa: BLE001 - fail open
        _log.debug("LangGraph child session for %r not opened", role, exc_info=True)
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


def _submit(loop: asyncio.AbstractEventLoop, run: Callable[[], None]) -> None:
    """Run ``run`` on the loop's executor; in place when the executor no
    longer takes work (the loop is shutting down)."""
    try:
        loop.run_in_executor(None, run)
    except RuntimeError:
        run()


def _queue(child: _Child, post: Callable[..., None], *args: Any) -> concurrent.futures.Future[None]:
    """Queue a child post on the running loop's executor, apart from any
    task, so cancelling the task that waits for it cannot drop it; the
    session's ``end()`` waits for it. Posted in place when there is no
    loop. While the child's start is still being posted, the post is
    queued from the start post's completion instead, in the thread that
    finishes it: it follows the start, and no thread waits for the start.
    The posts never raise."""
    done: concurrent.futures.Future[None] = concurrent.futures.Future()

    def run() -> None:
        try:
            post(*args)
        finally:
            done.set_result(None)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        run()
        return done
    child.session.track_child_post(done)
    started = child.start_post
    if started is None or started.done():
        _submit(loop, run)
        return done
    loop_thread = threading.get_ident()

    def after_start(_: concurrent.futures.Future[None]) -> None:
        # Called on the loop's thread when the start finished before the
        # callback was added; the post must not run there.
        if threading.get_ident() == loop_thread:
            _submit(loop, run)
        else:
            run()

    started.add_done_callback(after_start)
    return done


async def _wait(post: concurrent.futures.Future[None]) -> None:
    """Wait for a queued post. A cancellation of the waiter propagates
    and leaves the post running."""
    await asyncio.shield(asyncio.wrap_future(post))


def _on_loop_thread() -> bool:
    """Whether this thread runs an event loop: sync LangGraph code called
    from a coroutine, where a post in place would hold the loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _start_from_sync(child: _Child, body: Any) -> None:
    """Post the child's start from sync code: in place, or queued and not
    waited for on a loop's thread."""
    if _on_loop_thread():
        child.start_post = _queue(child, _start, child, body)
    else:
        _start(child, body)


def _end_from_sync(
    child: _Child, result: Any = _NO_RESULT, error: BaseException | None = None
) -> None:
    """Post the child's end from sync code, as :func:`_start_from_sync`."""
    if _on_loop_thread():
        _queue(child, _end, child, result, error)
    else:
        _end(child, result, error)


def _run_sync(node_name: str, body: Any, call: Callable[[], Any]) -> Any:
    child = _open(node_name)
    if child is None:
        return call()
    _start_from_sync(child, body)
    token = child.session.enter_subagent_scope(child.scope)
    try:
        result = call()
    except Exception as exc:
        _end_from_sync(child, _NO_RESULT, exc)
        raise
    finally:
        child.session.exit_subagent_scope(token)
    _end_from_sync(child, result)
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
# Graph runs
# ----------------------------------------------------------------------


# The graph whose step runs in this context: set by each run around its
# steps, so a run started inside one of its nodes can tell whose node it
# is (see _run_role).
_RUNNING_GRAPH: ContextVar[Any] = ContextVar("flightdeck_langgraph_running_graph", default=None)


def _section(config: Any, key: str) -> Mapping[str, Any]:
    """``config[key]`` when both are mappings, else an empty mapping."""
    value = config.get(key) if isinstance(config, Mapping) else None
    return value if isinstance(value, Mapping) else {}


def _ambient_config() -> Any:
    """The config of the Runnable running in this context (a node's, a
    tool's), from which a graph run started inside it inherits."""
    if _var_child_runnable_config is None:
        return None
    return _var_child_runnable_config.get()


def _in_graph_task(config: Any) -> bool:
    """Whether a run with ``config`` runs as, or inside, a task of another
    graph run: the task's id is in the run's own config or in the one it
    inherits. LangGraph looks only at the two merged, where an explicit
    ``configurable`` replaces the inherited one; this looks at both."""
    return any(_task_id_key in _section(c, _CONFIGURABLE_KEY) for c in (config, _ambient_config()))


def _named(name: Any) -> bool:
    return isinstance(name, str) and bool(name) and name != _DEFAULT_GRAPH_NAME


def _is_agent_graph(graph: Any) -> bool:
    """Whether ``graph`` (a compiled graph) was built by create_agent or
    create_react_agent, whose nodes are the agent's own steps."""
    builder = getattr(graph, "builder", None)
    return bool(getattr(builder, _AGENT_STEPS_ATTR, False))


def _run_role(graph: Any, config: Any) -> str:
    """A graph run's role: its name as LangGraph names the run (the config's
    ``run_name``, else the graph's name), else the node it runs in, unless
    that node is an agent's own step, else the generic role."""
    for source in (config, getattr(graph, "config", None)):
        name = source.get(_RUN_NAME_KEY) if isinstance(source, Mapping) else None
        if _named(name):
            return str(name)
    name = getattr(graph, "name", None)
    if _named(name):
        return str(name)
    for source in (config, _ambient_config()):
        node = _section(source, _METADATA_KEY).get(_NODE_METADATA_KEY)
        if isinstance(node, str) and node:
            return _GENERIC_RUN_ROLE if _is_agent_graph(_RUNNING_GRAPH.get()) else node
    return _GENERIC_RUN_ROLE


def _open_run(graph: Any, config: Any) -> _Child | None:
    """A child session for a graph run started inside another graph run or
    inside a child, or None for a top-level run (or no session)."""
    session = _current_session()
    if session is None:
        return None
    try:
        if session.active_subagent_scope() is None and not _in_graph_task(config):
            return None
        role = _run_role(graph, config)
    except Exception:  # noqa: BLE001 - fail open: the run goes on without a child
        _log.debug("LangGraph graph run left without a child", exc_info=True)
        return None
    return _open(role)


class _RunOutput:
    """A graph run's output, read from the chunks it streams: its last full
    state at its own level (what ``invoke`` returns), else, when it
    streams no state, its last chunk. A chunk that carries a namespace
    (``subgraphs=True``, or a v2 stream part) is at the run's own level
    when its namespace is the shortest seen: a nested run's own chunks
    carry the namespace of the task it runs in, and the graphs it runs
    extend it."""

    def __init__(self, graph: Any, config: Any, kwargs: Mapping[str, Any]) -> None:
        mode = kwargs.get(_STREAM_MODE_ARG)
        if mode is None:
            # LangGraph's default: state values for a run given a task's
            # config (a graph run as a node), else the graph's own mode.
            in_task = _task_id_key in _section(config, _CONFIGURABLE_KEY)
            mode = _VALUES_MODE if in_task else getattr(graph, _STREAM_MODE_ARG, _VALUES_MODE)
        self._parts = kwargs.get(_VERSION_ARG) == _STREAM_PARTS_VERSION
        self._subgraphs = bool(kwargs.get(_SUBGRAPHS_ARG))
        self._single = mode if isinstance(mode, str) else None
        self._state: Any = _NO_RESULT
        self._state_depth: int | None = None
        self._last: Any = _NO_RESULT

    @property
    def value(self) -> Any:
        return self._state if self._state is not _NO_RESULT else self._last

    def add(self, chunk: Any) -> None:
        self._last = chunk
        try:
            found = self._values_in(chunk)
            if found is None:
                return
            namespace, state = found
            depth = len(namespace) if namespace is not None else 0
            if self._state_depth is None or depth <= self._state_depth:
                self._state, self._state_depth = state, depth
        except Exception:  # noqa: BLE001 - fail open: keep the last chunk
            _log.debug("LangGraph run chunk not read", exc_info=True)

    def _values_in(self, chunk: Any) -> tuple[Any, Any] | None:
        """(namespace or None, state) when ``chunk`` is a values chunk."""
        if self._parts:
            if isinstance(chunk, Mapping) and chunk.get(_PART_TYPE_KEY) == _VALUES_MODE:
                return chunk.get(_PART_NS_KEY) or (), chunk.get(_PART_DATA_KEY)
            return None
        if self._single is not None:
            if self._single != _VALUES_MODE:
                return None
            if not self._subgraphs:
                return None, chunk
            if isinstance(chunk, tuple) and len(chunk) == _NAMESPACED_CHUNK_LEN:
                return chunk[0], chunk[1]
            return None
        if not isinstance(chunk, tuple):
            return None
        if not self._subgraphs and len(chunk) == _MODE_CHUNK_LEN and chunk[0] == _VALUES_MODE:
            return None, chunk[1]
        if (
            self._subgraphs
            and len(chunk) == _NAMESPACED_MODE_CHUNK_LEN
            and chunk[1] == _VALUES_MODE
        ):
            return chunk[0], chunk[2]
        return None


def _enter_step(child: _Child, graph: Any) -> tuple[Any, Token[Any]]:
    """Enter a nested run's step: its child's scope, and its graph as the
    graph whose step runs."""
    return child.session.enter_subagent_scope(child.scope), _RUNNING_GRAPH.set(graph)


def _exit_step(child: _Child, tokens: tuple[Any, Token[Any]]) -> None:
    scope_token, graph_token = tokens
    _reset_running_graph(graph_token)
    child.session.exit_subagent_scope(scope_token)


def _reset_running_graph(token: Token[Any]) -> None:
    """Restore the graph whose step ran before; a token from another
    context (a stream finished elsewhere than it started) is ignored:
    that context's value ends with it."""
    try:
        _RUNNING_GRAPH.reset(token)
    except (ValueError, RuntimeError):
        _log.debug("LangGraph run ended in another context", exc_info=True)


def _close_inner(child: _Child, graph: Any, inner: Any) -> None:
    """Close a sync run's stream as one of its steps."""
    tokens = _enter_step(child, graph)
    try:
        inner.close()
    finally:
        _exit_step(child, tokens)


def _stream_wrapper(original: Callable[..., Iterator[Any]]) -> Callable[..., Iterator[Any]]:
    """``Pregel.stream``, opening a child for a graph run started inside
    another or inside a child."""

    @functools.wraps(original)
    def stream(self: Any, input: Any, config: Any = None, **kwargs: Any) -> Iterator[Any]:
        child = _open_run(self, config)
        if child is None:
            # A top-level run: its stream is the original's, delegated to.
            token = _RUNNING_GRAPH.set(self)
            try:
                yield from original(self, input, config, **kwargs)
            finally:
                _reset_running_graph(token)
            return
        output = _RunOutput(self, config, kwargs)
        _start_from_sync(child, input)
        inner = original(self, input, config, **kwargs)
        try:
            while True:
                tokens = _enter_step(child, self)
                try:
                    chunk = next(inner)
                except StopIteration:
                    break
                finally:
                    _exit_step(child, tokens)
                output.add(chunk)
                yield chunk
        except GeneratorExit:
            # The consumer closed the stream before its end.
            try:
                _close_inner(child, self, inner)
            finally:
                _end_from_sync(child, _NO_RESULT, None)
            raise
        except BaseException as exc:
            try:
                _close_inner(child, self, inner)
            finally:
                _end_from_sync(child, _NO_RESULT, exc)
            raise
        _end_from_sync(child, output.value)

    return stream


def _live_async_generators() -> Any:
    """The running loop's set of the async generators it will close
    itself, or None where the loop does not expose it. asyncio's loop
    keeps it as ``_asyncgens``: a generator is added when first iterated,
    and leaves it when the loop takes its close over (collected unclosed,
    or swept when the loop shuts down). uvloop keeps it out of reach."""
    try:
        live = getattr(asyncio.get_running_loop(), _LIVE_ASYNCGENS_ATTR, None)
    except RuntimeError:
        return None
    return live if hasattr(live, "discard") else None


def _closed_by_the_loop() -> bool:
    """Whether this close is a task of its own whose coroutine is the
    generator's ``aclose()``: how a loop closes an async generator itself,
    and so how a loop that keeps its live generators out of reach is
    taken to close this one. An application can close a stream that way
    too (``asyncio.gather(stream.aclose())``), and is then taken for the
    loop."""
    task = asyncio.current_task()
    return task is not None and type(task.get_coro()).__name__ == _LOOP_CLOSE_CORO_TYPE


async def _aclose(inner: Any) -> None:
    """Close an async run's stream at once, as the stream unpatched would
    be closed, unless it has finished, another close has it (it is
    running), or the loop has taken its close over: then the loop closes
    it, and a second close would raise ``aclose(): asynchronous generator
    is already running`` in one of the two. A stream this close takes
    over leaves the loop's set first, as the loop's own close takes it
    out, so a shutdown sweep that starts meanwhile does not close it too."""
    if getattr(inner, "ag_frame", None) is None or getattr(inner, "ag_running", False):
        return
    live = _live_async_generators()
    try:
        if live is None:
            if _closed_by_the_loop():
                return
        elif inner not in live:
            return
        else:
            live.discard(inner)
    except Exception:  # noqa: BLE001 - fail open: close it as unpatched code would
        _log.debug("LangGraph stream close not checked against the loop", exc_info=True)
    await inner.aclose()


async def _aclose_inner(child: _Child, graph: Any, inner: Any) -> None:
    """Close an async run's stream as one of its steps."""
    tokens = _enter_step(child, graph)
    try:
        await _aclose(inner)
    finally:
        _exit_step(child, tokens)


def _astream_wrapper(
    original: Callable[..., AsyncIterator[Any]],
) -> Callable[..., AsyncIterator[Any]]:
    """``Pregel.astream``, as :func:`_stream_wrapper`; the posts go
    through the loop's executor (see :func:`_queue`)."""

    @functools.wraps(original)
    async def astream(
        self: Any, input: Any, config: Any = None, **kwargs: Any
    ) -> AsyncIterator[Any]:
        child = _open_run(self, config)
        if child is None:
            unwatched = original(self, input, config, **kwargs)
            token = _RUNNING_GRAPH.set(self)
            try:
                async for chunk in unwatched:
                    yield chunk
            finally:
                _reset_running_graph(token)
                # Closed here, as the consumer closes this stream, so the
                # run's own clean-up runs then and not at collection.
                await _aclose(unwatched)
            return
        output = _RunOutput(self, config, kwargs)
        child.start_post = _queue(child, _start, child, input)
        inner = original(self, input, config, **kwargs)
        try:
            await _wait(child.start_post)
            while True:
                tokens = _enter_step(child, self)
                try:
                    chunk = await inner.__anext__()
                except StopAsyncIteration:
                    break
                finally:
                    _exit_step(child, tokens)
                output.add(chunk)
                yield chunk
        except GeneratorExit:
            # Queued, not awaited: a generator being closed must not wait.
            try:
                await _aclose_inner(child, self, inner)
            finally:
                _queue(child, _end, child, _NO_RESULT, None)
            raise
        except BaseException as exc:
            try:
                await _aclose_inner(child, self, inner)
            finally:
                await _wait(_queue(child, _end, child, _NO_RESULT, exc))
            raise
        await _wait(_queue(child, _end, child, output.value))

    return astream


def _patch_runs() -> None:
    """Patch ``Pregel.stream`` and ``astream``. Idempotent."""
    if _Pregel is None or getattr(_Pregel, _RUNS_PATCHED_SENTINEL, False):
        return
    original_stream = getattr(_Pregel, _STREAM_METHOD)
    original_astream = getattr(_Pregel, _ASTREAM_METHOD)
    setattr(_Pregel, _STREAM_METHOD, _stream_wrapper(original_stream))
    setattr(_Pregel, _ASTREAM_METHOD, _astream_wrapper(original_astream))
    setattr(_Pregel, _ORIG_STREAM_ATTR, original_stream)
    setattr(_Pregel, _ORIG_ASTREAM_ATTR, original_astream)
    setattr(_Pregel, _RUNS_PATCHED_SENTINEL, True)


def _unpatch_runs() -> None:
    """Restore ``Pregel.stream`` and ``astream``. Idempotent."""
    if _Pregel is None or not getattr(_Pregel, _RUNS_PATCHED_SENTINEL, False):
        return
    for name, attr in ((_STREAM_METHOD, _ORIG_STREAM_ATTR), (_ASTREAM_METHOD, _ORIG_ASTREAM_ATTR)):
        original = getattr(_Pregel, attr, None)
        if original is not None:
            setattr(_Pregel, name, original)
            delattr(_Pregel, attr)
    delattr(_Pregel, _RUNS_PATCHED_SENTINEL)


def patch_langgraph_runs(*, quiet: bool = False) -> None:
    """Install the graph-run interceptor on ``langgraph.pregel.Pregel.stream``
    / ``astream`` alone, importing nothing from ``langgraph.graph``: an
    application on LangGraph's functional API imports only
    ``langgraph.pregel``, and the import of ``langgraph.graph`` imports it
    first. Idempotent. Silent no-op when ``langgraph`` is missing."""
    if not _ensure_runs_imported():
        if not quiet:
            _log.debug("langgraph not installed; graph-run patch skipped.")
        return
    try:
        _patch_runs()
    except Exception:  # noqa: BLE001 - fail open: runs go on unwatched
        _log.debug("LangGraph graph runs left unpatched", exc_info=True)


def unpatch_langgraph_runs() -> None:
    """Restore ``Pregel.stream`` and ``astream``. Idempotent."""
    if _ensure_runs_imported():
        _unpatch_runs()


# ----------------------------------------------------------------------
# Patch / unpatch
# ----------------------------------------------------------------------


def patch_langgraph_classes(*, quiet: bool = False) -> None:
    """Install the sub-agent interceptor on
    ``langgraph.graph.StateGraph.add_node`` and on
    ``langgraph.pregel.Pregel.stream`` / ``astream``.

    Idempotent. Silent no-op when ``langgraph`` is missing.
    """
    if not _ensure_imported():
        if not quiet:
            _log.debug("langgraph not installed; sub-agent patch skipped.")
        return
    assert _StateGraph is not None

    try:
        _patch_runs()
    except Exception:  # noqa: BLE001 - fail open: nodes are still wrapped
        _log.debug("LangGraph graph runs left unpatched", exc_info=True)
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
            wrapped = _wrap_node(self, node_name, node_action)
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
    """Restore the original ``StateGraph.add_node``, ``Pregel.stream`` and
    ``Pregel.astream``. Idempotent."""
    if not _ensure_imported():
        return
    assert _StateGraph is not None
    _unpatch_runs()
    if not getattr(_StateGraph, _PATCHED_SENTINEL, False):
        return
    orig = getattr(_StateGraph, f"{_PATCHED_SENTINEL}_orig_add_node", None)
    if orig is not None:
        _StateGraph.add_node = orig
        delattr(_StateGraph, f"{_PATCHED_SENTINEL}_orig_add_node")
    delattr(_StateGraph, _PATCHED_SENTINEL)
