"""Child process for test_lazy_patch.py.

Usage: ``_lazy_patch_child.py <capture server url> <sdk> <order>``

``order`` is ``after`` (import flightdeck_sensor, ``init()`` and
``patch()``, record which SDKs are loaded, then import <sdk>),
``before`` (import <sdk> first), ``reload`` (as ``after``, then reload
<sdk> before using it), ``interceptor`` (as ``after``, but import the
sensor's interceptor module for <sdk> first, which imports <sdk>) or
``tool_call`` (as ``after`` with prompt capture on, and the one call,
through openai, is answered with a tool call). Then the child uses <sdk>
once against the capture server, ends the session and prints one JSON
report line:

- ``loaded_after_patch``: the patchable SDKs in ``sys.modules`` right
  after ``patch()``, in the ``after`` order (before <sdk> is imported);
- ``loaded_at_end``: the patchable SDKs in ``sys.modules`` once the
  call is made;
- ``session_id``: the sensor session's id;
- ``patched``: whether <sdk>'s patch sentinel is in place after its import;
- ``network``: hosts other than loopback the process tried to resolve or
  connect to (every such attempt is refused);
- ``network_at_patch``: those it tried before <sdk> was used (through
  the imports, ``init()`` and ``patch()``);
- ``price_fetch_at_patch``: whether anything tried to reach litellm's
  price list before <sdk> was imported.

<sdk> ``none`` imports nothing after ``patch()``.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
from typing import Any, TypedDict

# Every SDK patch() can patch, by the module whose import triggers it.
PATCHABLE = (
    "anthropic",
    "openai",
    "litellm",
    "mcp",
    "crewai",
    "langgraph.graph",
    "llama_index.core",
    "claude_agent_sdk",
    "agents",
)
_LOOPBACK = ("127.0.0.1", "::1", "localhost")
# The host litellm downloads its price list from when it is imported.
LITELLM_PRICE_LIST_HOST = "raw.githubusercontent.com"

network: list[str] = []


def _guard(event: str, args: tuple[Any, ...]) -> None:
    """Refuse, and record, every attempt to leave the machine: a child
    must only ever reach the capture server."""
    host: Any = None
    if event == "socket.getaddrinfo":
        host = args[0]
    elif event == "socket.connect" and isinstance(args[1], tuple):
        host = args[1][0]
    if host is not None and str(host) not in _LOOPBACK:
        network.append(str(host))
        raise ConnectionRefusedError(f"child processes may not connect to {host!r}")


def _loaded() -> list[str]:
    return [name for name in PATCHABLE if name in sys.modules]


class _GraphState(TypedDict):
    count: int


def _use(sdk: str, server: str) -> bool:
    """Make one call through ``sdk`` and return whether its patch is in
    place."""
    if sdk == "openai":
        import openai

        client = openai.OpenAI(base_url=f"{server}/v1", api_key="test-key")
        client.chat.completions.create(
            model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}]
        )
        return hasattr(openai.OpenAI, "_flightdeck_patched")
    if sdk == "anthropic":
        import anthropic
        from anthropic.resources.messages.messages import Messages

        anthropic.Anthropic(base_url=server, api_key="test-key").messages.create(
            model="claude-haiku-4-5",
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        return "_flightdeck_patched" in Messages.__dict__
    if sdk == "litellm":
        import litellm

        litellm.completion(
            model="openai/gpt-4o-mini",
            api_base=f"{server}/v1",
            api_key="test-key",
            messages=[{"role": "user", "content": "hi"}],
        )
        return getattr(litellm.completion, "_flightdeck_wrapper", False) is True
    if sdk == "mcp":
        asyncio.run(_call_mcp_tool())
        from mcp.client.session import ClientSession

        return getattr(ClientSession, "_flightdeck_patched", False) is True
    if sdk == "langgraph.graph":
        from langgraph.graph import StateGraph

        graph = StateGraph(_GraphState)
        graph.add_node("worker", lambda state: {"count": state["count"] + 1})
        graph.set_entry_point("worker")
        graph.set_finish_point("worker")
        graph.compile().invoke({"count": 1})
        return getattr(StateGraph, "_flightdeck_subagent_patched", False) is True
    if sdk == "crewai":
        from crewai import Agent

        return getattr(Agent, "_flightdeck_subagent_patched", False) is True
    if sdk == "llama_index.core":
        return asyncio.run(_run_llama_index_agent(server))
    if sdk == "claude_agent_sdk":
        import claude_agent_sdk

        return getattr(claude_agent_sdk.ClaudeSDKClient, "_flightdeck_patched", False) is True
    if sdk == "agents":
        import openai
        from agents import Agent, OpenAIChatCompletionsModel, Runner, set_tracing_disabled
        from agents.run import AgentRunner

        # Tracing would export the run to OpenAI.
        set_tracing_disabled(True)
        model = OpenAIChatCompletionsModel(
            model="gpt-4o-mini",
            openai_client=openai.AsyncOpenAI(base_url=f"{server}/v1", api_key="test-key"),
        )
        Runner.run_sync(Agent(name="worker", model=model), "hi")
        return AgentRunner.__dict__.get("_flightdeck_openai_agents_patched", False) is True
    raise ValueError(sdk)


async def _run_llama_index_agent(server: str) -> bool:
    """Run a LlamaIndex agent once and return whether the sensor's span
    handler is on the root dispatcher."""
    from llama_index.core.agent.workflow import FunctionAgent
    from llama_index.core.instrumentation import get_dispatcher
    from llama_index.llms.openai import OpenAI

    llm = OpenAI(model="gpt-4o-mini", api_base=f"{server}/v1", api_key="test-key")
    await FunctionAgent(name="worker", llm=llm, streaming=False).run(user_msg="hi")
    return any(type(h).__name__ == "FlightdeckSpanHandler" for h in get_dispatcher().span_handlers)


def _tool_call(server: str) -> bool:
    """One OpenAI chat call offering a tool, which the capture server
    answers with a call to it, so the sensor emits a captured
    ``tool_call``. Returns whether openai's patch is in place."""
    import openai

    client = openai.OpenAI(base_url=f"{server}/v1", api_key="test-key")
    client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "weather in Paris?"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ],
    )
    return hasattr(openai.OpenAI, "_flightdeck_patched")


async def _call_mcp_tool() -> None:
    """One tool call to an in-process MCP server: through ``mcp.Client`` on
    mcp 2.x, through an in-memory session on 1.x."""
    import mcp

    client_cls = getattr(mcp, "Client", None)
    if client_cls is not None:
        from mcp.server.mcpserver import MCPServer

        server = MCPServer("probe-server")
        server.tool()(echo)
        async with client_cls(server) as client:
            await client.call_tool("echo", {"text": "hi"})
        return
    from mcp.server.fastmcp import FastMCP
    from mcp.shared.memory import create_connected_server_and_client_session

    fast = FastMCP("probe-server")
    fast.tool()(echo)
    async with create_connected_server_and_client_session(fast._mcp_server) as session:
        await session.call_tool("echo", {"text": "hi"})


def echo(text: str) -> str:
    """The MCP tool the child calls; a tool takes its function's name."""
    return text


def main() -> None:
    server, sdk, order = sys.argv[1], sys.argv[2], sys.argv[3]
    sys.addaudithook(_guard)

    if order == "before" and sdk != "none":
        importlib.import_module(sdk)

    import flightdeck_sensor

    flightdeck_sensor.init(
        server=server,
        token="tok",
        quiet=True,
        agent_type="coding",
        capture_prompts=order == "tool_call",
    )
    flightdeck_sensor.patch(quiet=True)
    loaded_after_patch = _loaded()
    network_at_patch = list(network)
    price_fetch_at_patch = LITELLM_PRICE_LIST_HOST in network

    patched = False
    if sdk != "none":
        if order == "reload":
            importlib.reload(importlib.import_module(sdk))
        elif order == "interceptor":
            # The module that patches <sdk> is imported first, and its own
            # import of <sdk> is the SDK's first import.
            target = next(t for t in flightdeck_sensor._SDK_TARGETS if t.module == sdk)
            importlib.import_module(target.interceptor_module)
        patched = _tool_call(server) if order == "tool_call" else _use(sdk, server)
    session = flightdeck_sensor._session
    assert session is not None
    session_id = session.config.session_id
    flightdeck_sensor.teardown()

    report = {
        "loaded_after_patch": loaded_after_patch,
        "loaded_at_end": _loaded(),
        "session_id": session_id,
        "patched": patched,
        "network": network,
        "network_at_patch": network_at_patch,
        "price_fetch_at_patch": price_fetch_at_patch,
    }
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
