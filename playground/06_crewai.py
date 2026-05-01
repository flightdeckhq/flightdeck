"""CrewAI native providers + MCP tools via ``mcpadapt``.

CrewAI 1.14.1's LLM factory routes `anthropic/` and `openai/` model
prefixes to native provider classes that construct
`anthropic.Anthropic()` and `openai.OpenAI()` directly.
`flightdeck_sensor.patch()` hooks those SDK classes, so CrewAI calls
land on the same interception path as direct SDK usage. Both chat
blocks below prove this end-to-end.

The MCP section uses ``mcpadapt`` directly. ``mcpadapt`` is the
production path for CrewAI tools and is what ``crewai-tools[mcp]``
installs under the hood; importing ``mcpadapt`` directly here gives
us a version canary that fires when a future ``crewai-tools`` upgrade
silently bumps to an incompatible mcpadapt release. D5 / D120 pin
mcpadapt in the sensor's optional ``[dev]`` extras for the same reason.
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
from _helpers import (
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
)


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
    """Demonstrate CrewAI MCP via ``mcpadapt`` directly. Skipped cleanly
    when the optional dep isn't installed.

    Using ``mcpadapt.core.MCPAdapt + mcpadapt.crewai_adapter.CrewAIAdapter``
    rather than the user-facing ``crewai_tools.MCPServerAdapter`` makes
    this script a *version-drift canary*: a future ``crewai-tools``
    upgrade that silently bumps to an incompatible ``mcpadapt`` release
    breaks the demo loudly here, even when the user-facing API still
    appears to work.
    """
    try:
        from mcpadapt.core import MCPAdapt  # type: ignore[import-untyped]
        from mcpadapt.crewai_adapter import CrewAIAdapter  # type: ignore[import-untyped]
        import mcp  # noqa: F401
    except ImportError:
        print("SKIP MCP section: pip install mcp mcpadapt")
        return

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai-mcp")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:06_crewai] mcp session_id={session_id}")

    params = mcp_server_params("playground._mcp_reference_server")
    with MCPAdapt(params, CrewAIAdapter()) as tools:
        echo = next((t for t in tools if t.name == "echo"), None)
        if echo is None:
            raise AssertionError(
                f"mcpadapt CrewAIAdapter did not expose 'echo'; got "
                f"{[t.name for t in tools]!r}",
            )
        t0 = time.monotonic()
        echo.run(text="hello from crewai playground")
        print_result(
            "echo.run", True, int((time.monotonic() - t0) * 1000),
        )

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
    args_ok = (payload.get("arguments") or {}).get("text") == "hello from crewai playground"
    tool_ok = tcs[-1].get("tool_name") == "echo"
    print_result("mcp payload.server_name", server_ok, 0)
    print_result("mcp payload.arguments round-trip", args_ok, 0)
    print_result("mcp tool_name=echo", tool_ok, 0)
    if not (server_ok and args_ok and tool_ok):
        raise AssertionError(f"mcp_tool_call payload mismatch: {tcs[-1]!r}")
    flightdeck_sensor.teardown()


def main() -> None:
    _run_chat("anthropic", "anthropic", "anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5")
    _run_chat("openai", "openai", "openai/gpt-4o-mini", "gpt-4o-mini")
    _run_mcp()


if __name__ == "__main__":
    main()
