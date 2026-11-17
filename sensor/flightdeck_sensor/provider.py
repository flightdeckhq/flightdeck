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
    * ``Provider.LLAMA_INDEX`` — a span handler on LlamaIndex's root
      instrumentation dispatcher that reports each agent of an agent
      workflow run as a child session (start, end, hand-offs); the
      agents' calls stay on the sensor's session.
    * ``Provider.CLAUDE_AGENT_SDK`` — wrap around
      ``claude_agent_sdk.query`` and ``ClaudeSDKClient``, reporting each
      Agent SDK run as its own session from the SDK's message stream.
    * ``Provider.OPENAI_AGENTS`` — wrap around the OpenAI Agents SDK's
      ``AgentRunner.run`` / ``run_streamed`` and its guardrails: a child
      session per agent and per agent used as a tool, hand-offs and
      guardrail tripwires. Patched only when ``agents`` comes from the
      ``openai-agents`` distribution.
    * ``Provider.GOOGLE_GENAI`` — class-level patch on the request methods
      of ``google.genai.models.Models`` / ``AsyncModels``
      (``_generate_content``, ``_generate_content_stream``,
      ``_embed_content``), which every google-genai client, its chats and
      Vertex AI mode send Gemini calls through; one event per request the
      provider bills, each automatic-function-calling round included.
    * ``Provider.GOOGLE_ADK`` — a plugin the sensor puts first in every
      Google ADK runner (``google.adk.runners.Runner.__init__``) and a
      wrap around ``Runner.run_async`` / ``run_live``: a child session per
      sub-agent run (an agent reached by transfer, a workflow agent's
      sub-agent, an ``AgentTool``'s agent) and the hand-offs; the root
      agent of a top-level run is the sensor's session.

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
    LLAMA_INDEX = "llama_index"
    CLAUDE_AGENT_SDK = "claude_agent_sdk"
    OPENAI_AGENTS = "openai_agents"
    GOOGLE_GENAI = "google_genai"
    GOOGLE_ADK = "google_adk"
