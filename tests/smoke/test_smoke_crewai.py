"""CrewAI smoke test. Runs manually; NOT in CI.

CrewAI 1.14+ routes ``anthropic/`` and ``openai/`` model prefixes to
native provider classes that construct ``anthropic.Anthropic()`` /
``openai.OpenAI()`` directly. The sensor's class-level patch hooks
those SDK classes, so CrewAI calls land on the same interception path
as direct SDK usage. Model strings that don't match a native-provider
prefix (e.g. ``openrouter/``, ``deepseek/``) fall through to litellm
and inherit the litellm-Anthropic gap documented in the README.

MCP coverage uses ``mcpadapt`` directly. ``mcpadapt`` is the
production path for CrewAI tools and is what ``crewai-tools[mcp]``
installs under the hood; importing ``mcpadapt`` directly here gives
us a version canary that fires when a future ``crewai-tools`` upgrade
silently bumps to an incompatible mcpadapt release. D5 pins mcpadapt
in the sensor's optional ``[mcp-crewai]`` extras for the same reason.
"""

from __future__ import annotations

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)


def _sensor_session(flavor: str = "smoke-crewai"):
    return make_sensor_session(flavor=flavor)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    wait_for_dev_stack()


# ---------------------------------------------------------------------------
# Chat path: regression guard against CrewAI upgrades that re-route
# native provider construction.
# ---------------------------------------------------------------------------


def test_crewai_anthropic_call() -> None:
    require_env("ANTHROPIC_API_KEY")
    pytest.importorskip("crewai")
    from crewai import LLM  # type: ignore[import-untyped]

    sess = _sensor_session("smoke-crewai-anthropic")
    LLM(model="anthropic/claude-haiku-4-5-20251001").call("say ok")

    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(
        e["event_type"] == "post_call" and "claude-haiku-4-5" in (e.get("model") or "")
        for e in events
    ), events


def test_crewai_openai_call() -> None:
    require_env("OPENAI_API_KEY")
    pytest.importorskip("crewai")
    from crewai import LLM  # type: ignore[import-untyped]

    sess = _sensor_session("smoke-crewai-openai")
    LLM(model="openai/gpt-4o-mini").call("say ok")

    events = fetch_events_for_session(
        sess.config.session_id, expect_event_types=["post_call"],
    )
    assert any(
        e["event_type"] == "post_call" and "gpt-4o-mini" in (e.get("model") or "")
        for e in events
    ), events


# ---------------------------------------------------------------------------
# MCP path: mcpadapt wraps the reference server with the CrewAIAdapter
# so its tools become CrewAI BaseTool instances. Invoking ``echo``
# synchronously through the CrewAI interface produces an mcp_tool_call
# event.
# ---------------------------------------------------------------------------


def test_crewai_mcp_tool_routes_call_through_sensor() -> None:
    pytest.importorskip("mcp")
    pytest.importorskip("mcpadapt")
    pytest.importorskip("crewai")

    import sys
    from mcp import StdioServerParameters  # type: ignore[import-untyped]
    from mcpadapt.core import MCPAdapt  # type: ignore[import-untyped]
    from mcpadapt.crewai_adapter import CrewAIAdapter  # type: ignore[import-untyped]

    sess = _sensor_session("smoke-crewai-mcp")

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "tests.smoke.fixtures.mcp_reference_server"],
    )
    with MCPAdapt(params, CrewAIAdapter()) as tools:
        echo = next((t for t in tools if t.name == "echo"), None)
        assert echo is not None, (
            f"mcpadapt CrewAIAdapter did not expose 'echo'; got "
            f"{[t.name for t in tools]!r}"
        )
        echo.run(text="hello crewai smoke")

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
    assert (payload.get("arguments") or {}).get("text") == "hello crewai smoke"
