"""LlamaIndex smoke test. Runs manually; NOT in CI.

LlamaIndex's ``llama-index-llms-*`` packages construct ``Anthropic()``
/ ``OpenAI()`` clients internally. Class-level patching in the sensor
means ``.complete(...)`` emits ``post_call`` events without any
LlamaIndex-side wiring. MCP coverage rides on
``llama-index-tools-mcp``: under the hood it uses the official mcp
SDK's ``ClientSession``, which the sensor patches directly.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)


def _sensor_session():
    return make_sensor_session(flavor="smoke-llamaindex")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    wait_for_dev_stack()


# ---------------------------------------------------------------------------
# Chat path: regression guard against LlamaIndex upgrades that change
# how the LLM clients are constructed internally.
# ---------------------------------------------------------------------------


def test_llamaindex_anthropic_complete() -> None:
    require_env("ANTHROPIC_API_KEY")
    pytest.importorskip("llama_index.llms.anthropic")
    from llama_index.llms.anthropic import Anthropic as LlamaAnthropic  # type: ignore[import-untyped]

    sess = _sensor_session()
    LlamaAnthropic(model="claude-haiku-4-5-20251001", max_tokens=8).complete("hi")
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


def test_llamaindex_openai_complete() -> None:
    require_env("OPENAI_API_KEY")
    pytest.importorskip("llama_index.llms.openai")
    from llama_index.llms.openai import OpenAI as LlamaOpenAI  # type: ignore[import-untyped]

    sess = _sensor_session()
    LlamaOpenAI(model="gpt-4o-mini", max_tokens=8).complete("hi")
    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(e["event_type"] == "post_call" for e in events), events


# ---------------------------------------------------------------------------
# MCP path: convert reference-server tools into LlamaIndex
# FunctionTools via McpToolSpec, invoke one, assert the sensor saw
# the call.
# ---------------------------------------------------------------------------


def test_llamaindex_mcp_tool_routes_call_through_sensor() -> None:
    pytest.importorskip("mcp")
    pytest.importorskip("llama_index.tools.mcp")

    import sys
    from llama_index.tools.mcp import (  # type: ignore[import-untyped]
        BasicMCPClient,
        McpToolSpec,
    )

    sess = _sensor_session()

    async def run() -> None:
        client = BasicMCPClient(
            command_or_url=sys.executable,
            args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
        )
        spec = McpToolSpec(client=client)
        tools = await spec.to_tool_list_async()
        echo = next((t for t in tools if t.metadata.name == "echo"), None)
        assert echo is not None, (
            f"llama-index-tools-mcp did not expose 'echo'; got "
            f"{[t.metadata.name for t in tools]!r}"
        )
        await echo.acall(text="hello llamaindex smoke")

    asyncio.run(run())

    events = fetch_events_for_session(
        sess.config.session_id,
        expect_event_types=["mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    assert tcs, f"no mcp_tool_call observed; events={events!r}"
    payload = tcs[-1].get("payload") or {}
    assert tcs[-1].get("tool_name") == "echo"
    assert payload.get("server_name") == "flightdeck-mcp-reference"
    assert (payload.get("arguments") or {}).get("text") == "hello llamaindex smoke"
