"""LlamaIndex -- Anthropic.complete + OpenAI.complete, plus an MCP
tool call via ``llama-index-tools-mcp``.

LlamaIndex's `llama-index-llms-*` packages construct Anthropic() /
OpenAI() clients internally. Class-level patching in the sensor means
`.complete(...)` emits post_call events without any LlamaIndex-side
wiring. ``llama-index-tools-mcp`` provides a ``BasicMCPClient`` and
``McpToolSpec`` that convert MCP tools into LlamaIndex
``FunctionTool`` instances; under the hood both call the official mcp
SDK's ``ClientSession``, which the sensor patches directly.
"""
from __future__ import annotations

import asyncio
import sys
import time
import uuid

try:
    from llama_index.llms.anthropic import Anthropic as LlamaAnthropic
    from llama_index.llms.openai import OpenAI as LlamaOpenAI
except ImportError:
    print("SKIP: pip install llama-index-llms-anthropic llama-index-llms-openai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
)


def _run_chat() -> None:
    t0 = time.monotonic()
    LlamaAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5).complete("hi")
    print_result(
        "LlamaAnthropic.complete", True,
        int((time.monotonic() - t0) * 1000),
    )

    t0 = time.monotonic()
    LlamaOpenAI(model="gpt-4o-mini", max_tokens=5).complete("hi")
    print_result(
        "LlamaOpenAI.complete", True,
        int((time.monotonic() - t0) * 1000),
    )


def _run_mcp(session_id: str) -> None:
    """McpToolSpec converts the reference server's tools into LlamaIndex
    FunctionTools. Skipped cleanly when ``llama-index-tools-mcp`` is
    not installed."""
    try:
        from llama_index.tools.mcp import (  # type: ignore[import-untyped]
            BasicMCPClient,
            McpToolSpec,
        )
        import mcp  # noqa: F401  -- presence check
    except ImportError:
        print("SKIP MCP section: pip install mcp llama-index-tools-mcp")
        return

    # BasicMCPClient passes ``env`` to the spawned subprocess but does
    # not expose ``cwd``. PYTHONPATH carries the same hook so the
    # ``python -m playground._mcp_reference_server`` lookup resolves.
    params = mcp_server_params("playground._mcp_reference_server")

    async def run() -> None:
        client = BasicMCPClient(
            command_or_url=params.command,
            args=list(params.args),
            env=dict(params.env or {}),
        )
        spec = McpToolSpec(client=client)
        tools = await spec.to_tool_list_async()
        echo = next((t for t in tools if t.metadata.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"llama-index-tools-mcp did not expose 'echo'; got "
                f"{[t.metadata.name for t in tools]!r}",
            )
        t0 = time.monotonic()
        await echo.acall(text="hello from llamaindex playground")
        print_result(
            "echo.acall", True, int((time.monotonic() - t0) * 1000),
        )

    asyncio.run(run())

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["mcp_tool_call"],
        timeout_s=20.0,
    )
    tcs = [e for e in events if e["event_type"] == "mcp_tool_call"]
    if not tcs:
        raise AssertionError(f"no mcp_tool_call observed; events={events!r}")
    payload = tcs[-1].get("payload") or {}
    server_ok = payload.get("server_name") == "flightdeck-mcp-reference"
    args_ok = (payload.get("arguments") or {}).get("text") == "hello from llamaindex playground"
    tool_ok = tcs[-1].get("tool_name") == "echo"
    print_result("mcp payload.server_name", server_ok, 0)
    print_result("mcp payload.arguments round-trip", args_ok, 0)
    print_result("mcp tool_name=echo", tool_ok, 0)
    if not (server_ok and args_ok and tool_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tcs[-1]!r}")


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-llamaindex")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:05_llamaindex] session_id={session_id}")

    _run_chat()
    assert_event_landed(session_id, "post_call", timeout=8)

    _run_mcp(session_id)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
