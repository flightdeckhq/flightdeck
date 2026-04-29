"""CrewAI native providers + MCP tools via ``crewai-tools[mcp]``.

CrewAI 1.14.1's LLM factory routes `anthropic/` and `openai/` model
prefixes to native provider classes that construct
`anthropic.Anthropic()` and `openai.OpenAI()` directly.
`flightdeck_sensor.patch()` hooks those SDK classes, so CrewAI calls
land on the same interception path as direct SDK usage. Both chat
blocks below prove this end-to-end.

The MCP section uses ``crewai-tools[mcp]`` -- the user-facing API
surface for CrewAI MCP integration. ``crewai-tools[mcp]`` installs
``mcpadapt`` under the hood, which wraps an MCP ``ClientSession``;
the sensor patches ``ClientSession`` directly, so the tool call
produces an ``mcp_tool_call`` event regardless of the wrapper.
"""
from __future__ import annotations

import sys
import time
import uuid

try:
    from crewai import LLM
except ImportError:
    print("SKIP: pip install crewai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


def _run_chat(label: str, provider: str, model: str, contains: str) -> None:
    # Fresh session_id per block -- assertion queries filter by
    # session_id, so distinct ids keep the two blocks independent.
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai")
    flightdeck_sensor.patch(providers=[provider], quiet=True)
    print(f"[playground:06_crewai] {label} session_id={session_id}")
    t0 = time.monotonic()
    LLM(model=model).call("hi")
    print_result(
        f"crewai.LLM.call ({label})", True,
        int((time.monotonic() - t0) * 1000),
    )
    assert_event_landed(
        session_id, "post_call", timeout=8, model_contains=contains,
    )
    flightdeck_sensor.teardown()


def _run_mcp() -> None:
    """Demonstrate CrewAI MCP via ``crewai-tools[mcp]``. Skipped cleanly
    when the optional extra isn't installed."""
    try:
        from crewai_tools import MCPServerAdapter  # type: ignore[import-untyped]
        from mcp import StdioServerParameters  # type: ignore[import-untyped]
    except ImportError:
        print("SKIP MCP section: pip install 'crewai-tools[mcp]' mcp")
        return

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai-mcp")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:06_crewai] mcp session_id={session_id}")

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
    )
    with MCPServerAdapter(params) as tools:
        echo = next((t for t in tools if t.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"crewai-tools[mcp] did not expose 'echo'; got "
                f"{[t.name for t in tools]!r}",
            )
        t0 = time.monotonic()
        echo.run(text="hello from crewai playground")
        print_result(
            "echo.run", True, int((time.monotonic() - t0) * 1000),
        )

    assert_event_landed(session_id, "mcp_tool_call", timeout=8)
    flightdeck_sensor.teardown()


def main() -> None:
    _run_chat("anthropic", "anthropic", "anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5")
    _run_chat("openai", "openai", "openai/gpt-4o-mini", "gpt-4o-mini")
    _run_mcp()


if __name__ == "__main__":
    main()
