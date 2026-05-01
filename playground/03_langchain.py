"""LangChain -- ChatAnthropic + ChatOpenAI + OpenAIEmbeddings, plus an
MCP tool call via ``langchain-mcp-adapters``.

LangChain constructs Anthropic() / OpenAI() clients internally. Because
`flightdeck_sensor.patch()` mutates those classes at import time, every
LangChain `ChatAnthropic(...).invoke(...)` call emits pre/post events
with no framework-specific wiring.

Embeddings: ``langchain_openai.OpenAIEmbeddings`` rides through the
OpenAI patch transitively; the captured ``input`` reflects what the
SDK actually saw on the wire (a list of integer token-ID arrays after
LangChain pre-tokenises) -- not a normalised reconstruction of the
caller's string. Operators see exactly what hit OpenAI.

Framework attribution: the worker writes ``framework`` onto the
session row when ``record_framework`` fires; LangChain calls land
with ``session.framework == "langchain"`` regardless of the
underlying SDK. This script verifies the attribution end-to-end.

The MCP section uses ``langchain-mcp-adapters``: the adapter wraps an
MCP ``ClientSession`` and exposes its tools as native LangChain tools.
The sensor patches ``ClientSession`` directly so every adapter-routed
tool invocation produces an ``mcp_tool_call`` event with the
``transport=stdio`` attribution intact.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.request
import uuid

try:
    from langchain_anthropic import ChatAnthropic
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
except ImportError:
    print("SKIP: pip install langchain-anthropic langchain-openai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    API_TOKEN,
    API_URL,
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
)


def _run_chat() -> None:
    t0 = time.monotonic()
    ChatAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5).invoke("hi")
    print_result("ChatAnthropic.invoke", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    ChatOpenAI(model="gpt-4o-mini", max_tokens=5).invoke("hi")
    print_result("ChatOpenAI.invoke", True, int((time.monotonic() - t0) * 1000))


def _run_embeddings_and_attribution(session_id: str) -> None:
    """Embeddings event + capture round-trip + framework attribution.

    Three contracts in one block:
      1. ``OpenAIEmbeddings.embed_documents`` produces an
         ``embeddings`` event.
      2. ``has_content=True`` and the captured ``input`` is a
         non-empty list (LangChain pre-tokenised it before calling
         OpenAI's API; we capture exactly what the SDK saw).
      3. ``session.framework == "langchain"`` -- higher-level
         framework wins over the underlying SDK transport.
    """
    payload = "playground langchain transitive"
    t0 = time.monotonic()
    OpenAIEmbeddings(model="text-embedding-3-small").embed_documents([payload])
    print_result(
        "OpenAIEmbeddings.embed_documents", True,
        int((time.monotonic() - t0) * 1000),
    )

    events = fetch_events_for_session(
        session_id, expect_event_types=["embeddings"], timeout_s=8.0,
    )
    embed = next((e for e in events if e.get("event_type") == "embeddings"), None)
    if embed is None:
        raise AssertionError(f"no embeddings event observed; events={events!r}")

    if not embed.get("has_content"):
        raise AssertionError(f"embeddings event missing has_content: {embed!r}")
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{embed['id']}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        body = json.loads(r.read())
    captured = body.get("input")
    if not isinstance(captured, list) or not captured:
        raise AssertionError(
            f"expected non-empty list input; got {captured!r}",
        )
    print_result("embeddings capture round-trip", True, 0,
                 f"captured shape: list of {len(captured)} item(s)")

    # Framework attribution lives on the SESSION row.
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        session_body = json.loads(r.read()).get("session") or {}
    fw = session_body.get("framework")
    print_result(
        "session.framework attribution", fw == "langchain", 0,
        f"framework={fw!r}",
    )
    if fw != "langchain":
        raise AssertionError(
            f"expected session.framework='langchain', got {fw!r}",
        )


def _run_mcp(session_id: str) -> None:
    """Optional MCP demo using langchain-mcp-adapters. Skipped cleanly
    when the adapter (or the ``mcp`` SDK) isn't installed."""
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]
        import mcp  # noqa: F401  -- presence check
    except ImportError:
        print("SKIP MCP section: pip install mcp langchain-mcp-adapters")
        return

    # MCP-adapter sessions module captures ``stdio_client`` at import
    # time via ``from mcp.client.stdio import stdio_client``. patch()
    # has already run at script entry (init_sensor → patch), so the
    # local binding inside langchain-mcp-adapters resolves to the
    # wrapped factory and per-event ``transport`` attribution lands.
    params = mcp_server_params("playground._mcp_reference_server")

    async def run() -> None:
        client = MultiServerMCPClient(
            {
                "flightdeck-ref": {
                    "command": params.command,
                    "args": list(params.args),
                    "transport": "stdio",
                    "cwd": params.cwd,
                    "env": dict(params.env or {}),
                },
            },
        )
        t0 = time.monotonic()
        tools = await client.get_tools()
        print_result(
            "MultiServerMCPClient.get_tools", True,
            int((time.monotonic() - t0) * 1000),
            f"{len(tools)} tools exposed as LangChain tools",
        )
        echo = next((t for t in tools if t.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"langchain-mcp-adapters did not expose 'echo'; "
                f"got {[t.name for t in tools]!r}",
            )
        t0 = time.monotonic()
        await echo.ainvoke({"text": "hello from langchain playground"})
        print_result(
            "echo.ainvoke", True, int((time.monotonic() - t0) * 1000),
        )

    asyncio.run(run())

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["mcp_tool_list", "mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    if not tcs:
        raise AssertionError(f"no mcp_tool_call observed; events={events!r}")
    payload = tcs[-1].get("payload") or {}
    server_ok = payload.get("server_name") == "flightdeck-mcp-reference"
    transport_ok = payload.get("transport") == "stdio"
    args_ok = (payload.get("arguments") or {}).get("text") == "hello from langchain playground"
    print_result("mcp payload.server_name", server_ok, 0)
    print_result("mcp payload.transport", transport_ok, 0,
                 f"transport={payload.get('transport')!r}")
    print_result("mcp arguments round-trip", args_ok, 0)
    if not (server_ok and transport_ok and args_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {payload!r}")


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langchain")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:03_langchain] session_id={session_id}")

    _run_chat()
    assert_event_landed(session_id, "post_call", timeout=8)

    _run_embeddings_and_attribution(session_id)

    _run_mcp(session_id)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
