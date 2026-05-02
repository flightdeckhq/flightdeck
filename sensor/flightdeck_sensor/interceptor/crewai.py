"""CrewAI sub-agent interceptor (D126).

Patches ``crewai.Agent.execute_task`` and ``aexecute_task`` (the
per-agent execution boundary) so each Crew member's turn lands as
its own child session in Flightdeck. Role attribution comes from
``Agent.role``; cross-agent message capture (incoming = task
description, outgoing = return value) rides on the existing
``capture_prompts`` gate.

Design choice on patch surface. CrewAI 1.14 exposes three layers
where execution could be wrapped:

* ``Crew.kickoff()`` — too coarse; one event per crew run, not per
  agent. Loses per-role attribution which is the whole point.
* ``Agent._execute_core()`` — the inner-most execution helper, but
  it's a private method whose signature changes across releases
  more freely than the public surface.
* ``Agent.execute_task(self, task, context=None, tools=None)`` —
  the public per-task method with stable signature since 1.14.
  This is the patch point.

The patch wraps both sync (``execute_task``) and async
(``aexecute_task``) variants so both ``Crew.kickoff()``-driven
sequential flows and ``crew.kickoff_async()``-driven concurrent
flows are observed equally.

Patch shape mirrors ``interceptor/litellm.py``: capture the
original method on import, replace the class attribute, mark the
class with a ``_flightdeck_subagent_patched`` sentinel for
idempotency. Class-level monkey-patch is correct here because
``execute_task`` is a regular instance method, not a
``cached_property`` resource (so the descriptor pattern from
``interceptor/anthropic.py`` doesn't apply).

Failure-mode posture is fail-open per Rule 28: if anything in the
interceptor's wrapper raises (event POST timeout, role attribute
missing, framework signature drift), the original
``execute_task`` still runs and the exception path emits a child
``session_end`` with ``state=error`` for the L8 row-level cue.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.types import SubagentMessage

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.crewai")

# Sentinel attribute name kept distinct from the LLM-facing
# ``_flightdeck_patched`` so a class can be patched for both LLM
# interception (when CrewAI uses native Anthropic / OpenAI providers
# under the hood) AND sub-agent observability without one
# overwriting the other.
_PATCHED_SENTINEL = "_flightdeck_subagent_patched"


# ----------------------------------------------------------------------
# Lazy framework import. Importing ``crewai`` at module load time
# pollutes ``sys.modules`` with the framework's transitive deps
# (langchain_core in particular), which trips the
# FrameworkCollector's bare-SDK-no-attribution invariant. Defer the
# import to patch / availability check so ``import flightdeck_sensor``
# stays free of framework side effects until the user actually opts
# in via ``patch()``.
# ----------------------------------------------------------------------

_CrewAIAgent: Any = None  # populated lazily by _ensure_imported()
_CREWAI_AVAILABLE: bool | None = None  # tri-state: None = not yet checked


def _ensure_imported() -> bool:
    """Resolve ``crewai.Agent`` once and cache the result. Returns
    True when CrewAI is installed and importable; False otherwise.
    The first call triggers the import (and therefore the framework's
    transitive sys.modules side effects); subsequent calls are O(1).
    """
    global _CrewAIAgent, _CREWAI_AVAILABLE
    if _CREWAI_AVAILABLE is not None:
        return _CREWAI_AVAILABLE
    try:
        from crewai import Agent as _Agent
        _CrewAIAgent = _Agent
        _CREWAI_AVAILABLE = True
    except ImportError:
        _CrewAIAgent = None
        _CREWAI_AVAILABLE = False
    return _CREWAI_AVAILABLE


def _current_session() -> Session | None:
    """Lazy lookup of the active flightdeck_sensor session.

    Matches the helper in every other interceptor file — imported
    at call time so the interceptor module can load even before
    ``flightdeck_sensor.init()`` has wired the singleton.
    """
    import flightdeck_sensor

    return flightdeck_sensor._session


def _capture_message(body: Any) -> SubagentMessage:
    """Wrap a captured body in a :class:`SubagentMessage` with the
    capture timestamp. The body is preserved verbatim — JSON
    serialisation happens at payload-build time (in
    :meth:`Session._build_subagent_payload`'s caller), so the
    framework's source shape (a CrewAI ``Task`` description string
    or the agent's return value) lands on the wire as the framework
    produced it.
    """
    return SubagentMessage(
        body=body,
        captured_at=datetime.now(timezone.utc).isoformat(),
    )


def _agent_role(agent: Any) -> str:
    """Return the agent's role string. Falls back to the empty
    string if the attribute is missing — when role is empty the
    derive_agent_id helper collapses to the 5-tuple form, which
    means the child session lands under the parent's own
    ``agent_id``. Not ideal but correct: a CrewAI Agent without a
    role is functionally indistinguishable from the parent at the
    identity level.
    """
    try:
        role = getattr(agent, "role", "") or ""
    except Exception:  # noqa: BLE001 — fail-open per Rule 28
        return ""
    return str(role)


def _agent_name(agent: Any, session: Session) -> str:
    """Compose the child's ``agent_name`` from the parent's plus
    the role suffix. Concise, identifies the role in fleet listings,
    and stays stable across runs (deterministic from the role
    string).
    """
    role = _agent_role(agent)
    parent_name = session.config.agent_name
    if not role:
        return parent_name
    return f"{parent_name}/{role}"


def _task_input_body(task: Any, context: Any, tools: Any) -> Any:
    """Extract the parent's input to the child for cross-agent
    message capture. Prefers the task description (CrewAI's
    canonical "what should this agent do" string); falls back to
    the task's expected_output if description is empty.
    """
    if task is None:
        return None
    description = getattr(task, "description", None)
    if description:
        return description
    expected = getattr(task, "expected_output", None)
    if expected:
        return expected
    # Last resort: best-effort string repr.
    try:
        return str(task)
    except Exception:  # noqa: BLE001
        return None


# ----------------------------------------------------------------------
# Patch / unpatch
# ----------------------------------------------------------------------


def patch_crewai_classes(*, quiet: bool = False) -> None:
    """Install the sub-agent interceptor on ``crewai.Agent``.

    Idempotent — a second call after the sentinel is set is a
    no-op. Silent no-op when ``crewai`` is not installed (matches
    every other interceptor's "missing-SDK" posture).
    """
    if not _ensure_imported():
        if not quiet:
            _log.debug("crewai not installed; sub-agent patch skipped.")
        return
    assert _CrewAIAgent is not None  # narrow for mypy

    if getattr(_CrewAIAgent, _PATCHED_SENTINEL, False):
        return

    original_sync = _CrewAIAgent.execute_task
    original_async = getattr(_CrewAIAgent, "aexecute_task", None)

    def _sync_wrapper(
        self: Any,
        task: Any,
        context: str | None = None,
        tools: list[Any] | None = None,
    ) -> Any:
        session = _current_session()
        if session is None:
            return original_sync(self, task, context=context, tools=tools)
        role = _agent_role(self)
        child_session_id = str(uuid.uuid4())
        child_agent_id = session.derive_subagent_id(role)
        child_agent_name = _agent_name(self, session)
        incoming = _capture_message(_task_input_body(task, context, tools))

        try:
            session.emit_subagent_session_start(
                child_session_id=child_session_id,
                child_agent_id=child_agent_id,
                child_agent_name=child_agent_name,
                agent_role=role,
                incoming_message=incoming,
            )
        except Exception:  # noqa: BLE001 — fail-open per Rule 28
            _log.debug("emit_subagent_session_start failed", exc_info=True)

        try:
            result = original_sync(self, task, context=context, tools=tools)
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

    async def _async_wrapper(
        self: Any,
        task: Any,
        context: str | None = None,
        tools: list[Any] | None = None,
    ) -> Any:
        session = _current_session()
        if session is None or original_async is None:
            return await original_async(self, task, context=context, tools=tools)  # type: ignore[misc]
        role = _agent_role(self)
        child_session_id = str(uuid.uuid4())
        child_agent_id = session.derive_subagent_id(role)
        child_agent_name = _agent_name(self, session)
        incoming = _capture_message(_task_input_body(task, context, tools))

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
            result = await original_async(self, task, context=context, tools=tools)
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

    _CrewAIAgent.execute_task = _sync_wrapper
    if original_async is not None:
        _CrewAIAgent.aexecute_task = _async_wrapper
    setattr(_CrewAIAgent, _PATCHED_SENTINEL, True)
    setattr(_CrewAIAgent, f"{_PATCHED_SENTINEL}_orig_sync", original_sync)
    if original_async is not None:
        setattr(_CrewAIAgent, f"{_PATCHED_SENTINEL}_orig_async", original_async)


def unpatch_crewai_classes() -> None:
    """Restore the original ``Agent.execute_task`` / ``aexecute_task``.

    Idempotent — safe to call without a preceding patch.
    """
    if not _ensure_imported():
        return
    assert _CrewAIAgent is not None
    if not getattr(_CrewAIAgent, _PATCHED_SENTINEL, False):
        return
    orig_sync = getattr(_CrewAIAgent, f"{_PATCHED_SENTINEL}_orig_sync", None)
    if orig_sync is not None:
        _CrewAIAgent.execute_task = orig_sync
        delattr(_CrewAIAgent, f"{_PATCHED_SENTINEL}_orig_sync")
    orig_async = getattr(_CrewAIAgent, f"{_PATCHED_SENTINEL}_orig_async", None)
    if orig_async is not None:
        _CrewAIAgent.aexecute_task = orig_async
        delattr(_CrewAIAgent, f"{_PATCHED_SENTINEL}_orig_async")
    delattr(_CrewAIAgent, _PATCHED_SENTINEL)
