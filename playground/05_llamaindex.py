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
import os
import sys
import time
import uuid
from pathlib import Path

try:
    from llama_index.llms.anthropic import Anthropic as LlamaAnthropic
    from llama_index.llms.openai import OpenAI as LlamaOpenAI
except ImportError:
    print("SKIP: pip install llama-index-llms-anthropic llama-index-llms-openai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result

_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


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

    # PYTHONPATH so ``python -m tests.smoke.fixtures.mcp_reference_server``
    # resolves when this script is run from ``playground/`` (run_all.py
    # cwd). BasicMCPClient passes ``env`` through to the spawned process
    # but does not expose a ``cwd`` parameter, so PYTHONPATH is the only
    # lever — fortunately enough on its own for module-style spawns.
    server_env = dict(os.environ)
    server_env["PYTHONPATH"] = (
        _PROJECT_ROOT + os.pathsep + server_env.get("PYTHONPATH", "")
    )

    async def run() -> None:
        client = BasicMCPClient(
            command_or_url=sys.executable,
            args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
            env=server_env,
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
    assert_event_landed(session_id, "mcp_tool_call", timeout=8)


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
