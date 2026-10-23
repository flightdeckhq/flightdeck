"""Canonical names of interceptor targets accepted by
:func:`flightdeck_sensor.patch`.

The :class:`Provider` enum is the single source of truth for the
``providers=`` argument to ``patch()``. Each member IS a string
(``Provider.ANTHROPIC == "anthropic"`` evaluates ``True``) so it works
anywhere a raw string was accepted before -- existing user code
that passes ``patch(providers=["anthropic"])`` keeps working without
edits, and a partially-migrated codebase can mix
``patch(providers=[Provider.ANTHROPIC, "openai"])`` cleanly.

``Provider`` is a ``StrEnum``, so ``str()`` and f-strings of a member
also give the plain value (``"anthropic"``), not ``Provider.ANTHROPIC``.
"""

from __future__ import annotations

from enum import StrEnum


class Provider(StrEnum):
    """Interceptor targets ``flightdeck_sensor.patch()`` knows how to
    install hooks for.

    Members:

    * ``Provider.ANTHROPIC`` — resource-level patch on the SDK's
      ``Messages`` / ``AsyncMessages`` classes, which every ``anthropic``
      client class hands out.
    * ``Provider.OPENAI`` — class-level patch on ``openai.OpenAI`` and
      ``openai.AsyncOpenAI``.
    * ``Provider.LITELLM`` — module-level patch on ``litellm.completion``,
      ``litellm.acompletion``, ``litellm.embedding`` and
      ``litellm.aembedding``.
    * ``Provider.MCP`` — class-level patch on
      ``mcp.client.session.ClientSession`` plus the four transport
      factories.
    * ``Provider.CREWAI`` — context-manager wrap around
      ``crewai.Agent.execute_task`` / ``aexecute_task`` for
      sub-agent observability.
    * ``Provider.LANGGRAPH`` — wrap around the registered callable
      on ``StateGraph.add_node`` for sub-agent observability;
      agent-bearing predicate is default-on per node, narrowable
      via the optional regex override
      ``init(langgraph_agent_node_pattern=…)``.

    Each member's ``.value`` is the canonical string name. The string
    name is what ``patch()`` matches against internally, so passing
    ``Provider.ANTHROPIC`` and passing ``"anthropic"`` are equivalent.
    """

    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    LITELLM = "litellm"
    MCP = "mcp"
    CREWAI = "crewai"
    LANGGRAPH = "langgraph"
