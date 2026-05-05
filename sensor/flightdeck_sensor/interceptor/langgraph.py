"""LangGraph sub-agent interceptor (D126).

Patches ``langgraph.graph.StateGraph.add_node`` so that every node
the user registers gets wrapped with sub-agent observability:
each node invocation lands as its own child session, with role
attribution from the node name and cross-agent message capture
of the inbound / outbound state dicts (gated by
``capture_prompts``).

Design choice on patch surface. LangGraph's natural unit of
"agent" is a node — a callable registered against a graph that
takes the graph state and returns a state delta. Three patch
surfaces were considered:

* ``Pregel.invoke()`` / ``StateGraph.compile()`` — too coarse
  (one event per graph run, not per node) and loses per-node
  attribution.
* Decorating user functions before they're passed to
  ``add_node`` — pushes the burden onto the user, which the
  zero-config posture rules out.
* ``StateGraph.add_node(node, action=…)`` — wraps the registered
  callable at registration time. Every subsequent invocation goes
  through the wrapper. The graph's own dispatch (sync /
  async) is preserved because we hand back a callable of the same
  shape. This is the patch point.

Agent-bearing predicate. D126 specifies "nodes whose body
invokes a patched LLM client OR whose name matches the regex
supplied via ``init(langgraph_agent_node_pattern=…)``". Detecting
"body invokes a patched LLM client" cleanly requires either
runtime instrumentation (set a thread-local before calling the
node, check it after) or static AST inspection (brittle to
indirect calls). v1 takes the simpler path:

* If ``langgraph_agent_node_pattern`` is set: emit child events
  ONLY for nodes whose name matches the regex.
* If unset: emit child events for EVERY node, accepting false
  positives on data-transform nodes that don't invoke an LLM.
  Operators with noisy graphs use the regex to narrow the set.

The "wrap every node" default is louder than D126's text might
suggest but it's the conservative shape: under-emission silently
hides agent activity (a real bug); over-emission shows extra
rows in the fleet view (cosmetic). The pattern override lets
operators tune.

Failure-mode posture is fail-open per Rule 28: a wrapper raise
during emit doesn't break node execution.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable

from flightdeck_sensor.core.types import SubagentMessage

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.langgraph")

_PATCHED_SENTINEL = "_flightdeck_subagent_patched"


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


def _ensure_imported() -> bool:
    global _StateGraph, _LANGGRAPH_AVAILABLE
    if _LANGGRAPH_AVAILABLE is not None:
        return _LANGGRAPH_AVAILABLE
    try:
        from langgraph.graph import StateGraph
        _StateGraph = StateGraph
        _LANGGRAPH_AVAILABLE = True
    except ImportError:
        _StateGraph = None
        _LANGGRAPH_AVAILABLE = False
    return _LANGGRAPH_AVAILABLE


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
    """Return True if the named node should emit sub-agent events.

    See module docstring for the predicate semantics. Default-on
    when no pattern is set; pattern-narrowed when one is.
    """
    if _agent_node_pattern is None:
        return True
    return bool(_agent_node_pattern.search(node_name))


def _current_session() -> Session | None:
    import flightdeck_sensor

    return flightdeck_sensor._session


def _capture_message(body: Any) -> SubagentMessage:
    return SubagentMessage(
        body=body,
        captured_at=datetime.now(timezone.utc).isoformat(),
    )


def _agent_name(node_name: str, session: Session) -> str:
    """Compose the child's ``agent_name`` from the parent's plus
    the node-name suffix. Same shape as the CrewAI interceptor.
    """
    parent_name = session.config.agent_name
    if not node_name:
        return parent_name
    return f"{parent_name}/{node_name}"


def _wrap_node_action(node_name: str, action: Callable[..., Any]) -> Callable[..., Any]:
    """Return a wrapper that emits child session_start before and
    session_end after the node action. Preserves sync / async by
    runtime-detecting the original callable's coroutine status —
    LangGraph supports both, and we don't want to force-cast the
    user's node into one shape.
    """
    import asyncio

    role = node_name

    def _sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return action(*args, **kwargs)
        child_session_id = str(uuid.uuid4())
        child_agent_id = session.derive_subagent_id(role)
        child_agent_name = _agent_name(node_name, session)
        incoming = _capture_message(args[0] if args else kwargs)

        try:
            session.emit_subagent_session_start(
                child_session_id=child_session_id,
                child_agent_id=child_agent_id,
                child_agent_name=child_agent_name,
                agent_role=role,
                incoming_message=incoming,
            )
        except Exception:  # noqa: BLE001
            _log.debug("emit_subagent_session_start failed", exc_info=True)

        try:
            result = action(*args, **kwargs)
        except Exception as exc:
            try:
                session.emit_subagent_session_end(
                    child_session_id=child_session_id,
                    child_agent_id=child_agent_id,
                    child_agent_name=child_agent_name,
                    agent_role=role,
                    state="error",
                    error={"type": type(exc).__name__, "message": str(exc)},
                )
            except Exception:  # noqa: BLE001
                _log.debug("emit_subagent_session_end (error) failed", exc_info=True)
            raise

        try:
            outgoing = _capture_message(result)
            session.emit_subagent_session_end(
                child_session_id=child_session_id,
                child_agent_id=child_agent_id,
                child_agent_name=child_agent_name,
                agent_role=role,
                outgoing_message=outgoing,
            )
        except Exception:  # noqa: BLE001
            _log.debug("emit_subagent_session_end failed", exc_info=True)
        return result

    async def _async_wrapper(*args: Any, **kwargs: Any) -> Any:
        session = _current_session()
        if session is None:
            return await action(*args, **kwargs)
        child_session_id = str(uuid.uuid4())
        child_agent_id = session.derive_subagent_id(role)
        child_agent_name = _agent_name(node_name, session)
        incoming = _capture_message(args[0] if args else kwargs)

        try:
            session.emit_subagent_session_start(
                child_session_id=child_session_id,
                child_agent_id=child_agent_id,
                child_agent_name=child_agent_name,
                agent_role=role,
                incoming_message=incoming,
            )
        except Exception:  # noqa: BLE001
            _log.debug("emit_subagent_session_start (async) failed", exc_info=True)

        try:
            result = await action(*args, **kwargs)
        except Exception as exc:
            try:
                session.emit_subagent_session_end(
                    child_session_id=child_session_id,
                    child_agent_id=child_agent_id,
                    child_agent_name=child_agent_name,
                    agent_role=role,
                    state="error",
                    error={"type": type(exc).__name__, "message": str(exc)},
                )
            except Exception:  # noqa: BLE001
                _log.debug("emit_subagent_session_end (async, error) failed", exc_info=True)
            raise

        try:
            outgoing = _capture_message(result)
            session.emit_subagent_session_end(
                child_session_id=child_session_id,
                child_agent_id=child_agent_id,
                child_agent_name=child_agent_name,
                agent_role=role,
                outgoing_message=outgoing,
            )
        except Exception:  # noqa: BLE001
            _log.debug("emit_subagent_session_end (async) failed", exc_info=True)
        return result

    if asyncio.iscoroutinefunction(action):
        return _async_wrapper
    return _sync_wrapper


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
        #   add_node("name", callable_action)
        #   add_node(callable_action)        # name == action.__name__
        # Normalize so the wrap site works against (name, action).
        if isinstance(node, str):
            node_name = node
            node_action = action
        else:
            node_action = node
            node_name = getattr(node, "__name__", str(node))

        if node_action is None or not callable(node_action):
            # Pass through — node is not a wrappable callable (e.g.
            # a string-only registration that LangGraph rejects
            # natively).
            return original_add_node(self, node, action=action, **kwargs)

        if not _is_agent_bearing(node_name):
            return original_add_node(self, node, action=action, **kwargs)

        wrapped = _wrap_node_action(node_name, node_action)
        if isinstance(node, str):
            return original_add_node(self, node_name, action=wrapped, **kwargs)
        return original_add_node(self, wrapped, **kwargs)

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
