"""LangChain -- ChatAnthropic + ChatOpenAI + OpenAIEmbeddings, plus an
MCP tool call via ``langchain-mcp-adapters`` and ChatGoogleGenerativeAI.

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

The Gemini section (``langchain-google-genai``, which builds a
``google.genai`` client the sensor's google-genai patch reaches) runs on a
session of its own: ``invoke``, ``ainvoke``, a call given a thinking
budget, and a ``bind_tools`` round (the call the model asks for, then its
answer to the result). It checks
one event pair per request the API billed, ``provider=google``, the model
that answered, the tokens each response reported (thoughts as reasoning),
each call's stored request and reply, and a ``tool_call`` per function the
model asked for. It skips without ``GEMINI_API_KEY`` (or
``GOOGLE_API_KEY``) or ``langchain-google-genai``. LangGraph and Deep
Agents call the LangChain chat model they are given, so their Gemini path
is this one.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request
import uuid
from typing import Any

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
    assert_gemini_calls,
    assert_reply_stored,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
    stored_content_of,
)

# A current, cheap model the Gemini API serves to a new key; it thinks
# when given a thinking budget.
GEMINI_MODEL = "gemini-3.1-flash-lite"
# Room for a short answer, and for the thinking call's thoughts.
GEMINI_MAX_TOKENS = 600
# The thinking call's budget: enough thoughts for a small sum.
GEMINI_THINKING_BUDGET = 256
# The plain calls' prompts, each a call's one user turn: invoke, ainvoke,
# and the thinking call.
GEMINI_PROMPTS = ("Name a colour. Answer in one word.", "Name a fruit. Answer in one word.")
THINKING_PROMPT = "What is 17 * 23? Answer with the number only."
WEATHER_PROMPT = "What is the weather in Paris? Use the get_weather tool."
# The requests the section makes, one each whatever the model answers:
# invoke, ainvoke, the thinking call, and the tool round's two (the call
# the model asks for, then its answer to the result).
GEMINI_REQUESTS = 5
# The calls asked to think: the thinking call.
GEMINI_THINKING_CALLS = 1
# The tool round's second request passes back the question, the model's
# call and the result: three contents.
TOOL_ROUND_CONTENTS = 3
MS_PER_S = 1000


def get_weather(city: str) -> str:
    """Returns the current weather in a city."""
    return f"sunny, 21 C in {city}"


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * MS_PER_S)


def _run_chat(session_id: str) -> None:
    """ChatAnthropic and ChatOpenAI send every non-streamed call through
    the SDK's raw view (``with_raw_response``); each post_call stores the
    reply and names the served model, as a plain SDK call does. Both ask
    for a model alias the API serves with a dated model."""
    t0 = time.monotonic()
    anthropic_reply = ChatAnthropic(model="claude-haiku-4-5", max_tokens=5).invoke("hi")
    print_result("ChatAnthropic.invoke", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    openai_reply = ChatOpenAI(model="gpt-4o-mini", max_tokens=5).invoke("hi")
    print_result("ChatOpenAI.invoke", True, int((time.monotonic() - t0) * 1000))

    for label, reply in (
        ("ChatAnthropic.invoke", anthropic_reply),
        ("ChatOpenAI.invoke", openai_reply),
    ):
        meta = reply.response_metadata
        served = meta.get("model_name") or meta.get("model")
        assert_reply_stored(session_id, label, meta["id"], served)


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
        "OpenAIEmbeddings.embed_documents",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["embeddings"],
        timeout_s=8.0,
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
    print_result(
        "embeddings capture round-trip",
        True,
        0,
        f"captured shape: list of {len(captured)} item(s)",
    )

    # Framework attribution lives on the SESSION row.
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        session_body = json.loads(r.read()).get("session") or {}
    fw = session_body.get("framework")
    print_result(
        "session.framework attribution",
        fw == "langchain",
        0,
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
        import mcp  # noqa: F401  -- presence check
        from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[import-untyped]
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
            "MultiServerMCPClient.get_tools",
            True,
            int((time.monotonic() - t0) * 1000),
            f"{len(tools)} tools exposed as LangChain tools",
        )
        echo = next((t for t in tools if t.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"langchain-mcp-adapters did not expose 'echo'; got {[t.name for t in tools]!r}",
            )
        t0 = time.monotonic()
        await echo.ainvoke({"text": "hello from langchain playground"})
        print_result(
            "echo.ainvoke",
            True,
            int((time.monotonic() - t0) * 1000),
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
    # MCP tool args are captured to event_content.tool_input (fetched via
    # /v1/events/:id/content), not inline in the event payload; the event
    # carries has_content=true to signal operators to fetch.
    args_ok = tcs[-1].get("has_content") is True and "arguments" not in payload
    print_result("mcp payload.server_name", server_ok, 0)
    print_result(
        "mcp payload.transport",
        transport_ok,
        0,
        f"transport={payload.get('transport')!r}",
    )
    print_result("mcp args captured to event_content (not inline)", args_ok, 0)
    if not (server_ok and transport_ok and args_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tcs[-1]!r}")


def _run_gemini() -> None:
    """``ChatGoogleGenerativeAI`` on a session of its own: ``invoke``,
    ``ainvoke``, a thinking call and a ``bind_tools`` round, each request
    one event pair with Gemini's stored body (see the module docstring)."""
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        print("  SKIP  Gemini section: GEMINI_API_KEY / GOOGLE_API_KEY is not set")
        return
    try:
        from langchain_core.messages import HumanMessage, ToolMessage
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        print("  SKIP  Gemini section: pip install langchain-google-genai")
        return

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langchain")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:03_langchain] gemini session_id={session_id}")
    llm = ChatGoogleGenerativeAI(model=GEMINI_MODEL, max_tokens=GEMINI_MAX_TOKENS)
    replies: list[Any] = []
    try:
        t0 = time.monotonic()
        replies.append(llm.invoke(GEMINI_PROMPTS[0]))
        print_result("ChatGoogleGenerativeAI.invoke", bool(replies[-1].text), _ms(t0))

        t0 = time.monotonic()
        replies.append(asyncio.run(llm.ainvoke(GEMINI_PROMPTS[1])))
        print_result("ChatGoogleGenerativeAI.ainvoke", bool(replies[-1].text), _ms(t0))

        t0 = time.monotonic()
        thinker = ChatGoogleGenerativeAI(
            model=GEMINI_MODEL,
            max_tokens=GEMINI_MAX_TOKENS,
            thinking_budget=GEMINI_THINKING_BUDGET,
            include_thoughts=True,
        )
        replies.append(thinker.invoke(THINKING_PROMPT))
        print_result(
            "ChatGoogleGenerativeAI.invoke with a thinking budget",
            bool(replies[-1].text),
            _ms(t0),
            repr(replies[-1].text),
        )

        t0 = time.monotonic()
        tooled = llm.bind_tools([get_weather])
        question = HumanMessage(WEATHER_PROMPT)
        call = tooled.invoke([question])
        asked = [c["name"] for c in call.tool_calls]
        results = [
            ToolMessage(get_weather(**c["args"]), tool_call_id=c["id"]) for c in call.tool_calls
        ]
        answer = tooled.invoke([question, call, *results])
        replies += [call, answer]
        print_result(
            "bind_tools: the call the model asks for, then its answer",
            "get_weather" in asked and bool(answer.text),
            _ms(t0),
            f"asked for {asked}",
        )
    finally:
        flightdeck_sensor.teardown()
    prompts = (*GEMINI_PROMPTS, THINKING_PROMPT)
    plain = dict(zip(prompts, replies[: len(prompts)], strict=True))
    if "get_weather" not in asked or not all(r.text for r in (*plain.values(), answer)):
        raise AssertionError(f"a Gemini call returned no answer or no call: {replies!r}")

    assert_gemini_calls(
        session_id,
        "ChatGoogleGenerativeAI",
        requests=GEMINI_REQUESTS,
        replies={prompt: reply.text for prompt, reply in plain.items()},
        asked=asked,
        thinking_calls=GEMINI_THINKING_CALLS,
        served_models={r.response_metadata.get("model_name") for r in replies},
    )
    # The round's second request passes the result back as Gemini spells
    # it: a functionResponse part after the model's functionCall.
    stored_content_of(session_id, "functionResponse", "input", least=TOOL_ROUND_CONTENTS)
    print_result("the tool round's result is stored as a functionResponse", True, 0)


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-langchain")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:03_langchain] session_id={session_id}")

    _run_chat(session_id)
    assert_event_landed(session_id, "post_call", timeout=8)

    _run_embeddings_and_attribution(session_id)

    _run_mcp(session_id)

    flightdeck_sensor.teardown()

    _run_gemini()


if __name__ == "__main__":
    main()
