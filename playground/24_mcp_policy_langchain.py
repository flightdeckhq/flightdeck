"""MCP Protection Policy — LangChain explicit coverage via langchain-mcp-adapters.

LangChain integrates MCP through the same ``langchain-mcp-adapters``
package that demo 23 (LangGraph) uses transitively. Rule 40d
requires explicit per-framework coverage because LangChain agents
set up differently than LangGraph state machines (``AgentExecutor``
+ ``create_tool_calling_agent`` + ``ChatPromptTemplate`` vs
LangGraph's ``create_react_agent`` graph). Strict per-invocation-
pattern coverage protects against a future SDK upgrade silently
breaking the LangChain wire-up while LangGraph stays green.

Three sub-scenarios run back-to-back per Step 6.5 PR Part A spec:

  1. WARN  — flavor deny entry with enforcement=warn. Tool call
     completes; ``policy_mcp_warn`` event lands.
  2. BLOCK — flavor deny entry with enforcement=block. Tool call
     raises ``flightdeck_sensor.MCPPolicyBlocked``;
     ``policy_mcp_block`` event lands.
  3. ALLOW — flavor allow entry. Tool call completes;
     ``mcp_tool_call`` event lands; NO policy event lands.

Self-skips when:
  - langchain-mcp-adapters / langchain / langchain-anthropic not
    installed.
  - ``ANTHROPIC_API_KEY`` is not set.

Real Anthropic spend per run: small (six short turns).
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

if not os.environ.get("ANTHROPIC_API_KEY"):
    print("SKIP: set ANTHROPIC_API_KEY to run this LangChain demo")
    sys.exit(2)

try:
    import mcp.client.stdio as _mcp_stdio
    from langchain.agents import AgentExecutor, create_tool_calling_agent  # type: ignore[import-not-found]
    from langchain_anthropic import ChatAnthropic  # type: ignore[import-not-found]
    from langchain_core.prompts import ChatPromptTemplate  # type: ignore[import-not-found]
    from langchain_mcp_adapters.tools import load_mcp_tools  # type: ignore[import-not-found]
    from mcp.client.session import ClientSession
except ImportError:
    print(
        "SKIP: pip install langchain langchain-mcp-adapters langchain-anthropic "
        "to run this example"
    )
    sys.exit(2)

from _helpers import (
    API_URL,
    fetch_events_for_session,
    init_sensor,
    mcp_server_params,
    print_result,
    wait_for_dev_stack,
)

import flightdeck_sensor


def _admin_headers(content_type: str | None = None) -> dict[str, str]:
    headers = {"Authorization": "Bearer tok_dev"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def provision_flavor_policy(flavor: str, body: dict) -> None:
    import json as _json

    delete_req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/{flavor}",
        headers=_admin_headers(),
        method="DELETE",
    )
    try:
        urllib.request.urlopen(delete_req, timeout=2)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise

    post_req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/{flavor}",
        data=_json.dumps(body).encode(),
        headers=_admin_headers(content_type="application/json"),
        method="POST",
    )
    with urllib.request.urlopen(post_req, timeout=3) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"unexpected status {resp.status}")


async def _run_langchain_agent(prompt_text: str) -> None:
    """Drive one LangChain agent turn against the in-process MCP
    reference server. Caller wraps the call to catch
    ``MCPPolicyBlocked`` for the block case."""
    server_module = "playground._mcp_reference_server"
    params = mcp_server_params(server_module)
    async with _mcp_stdio.stdio_client(params) as (read, write):  # noqa: SIM117
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)
            llm = ChatAnthropic(model="claude-sonnet-4-5", max_tokens=400)
            prompt = ChatPromptTemplate.from_messages(
                [
                    (
                        "system",
                        "You exercise MCP tools under Flightdeck policy "
                        "enforcement. Call the tool the user asks for.",
                    ),
                    ("user", "{input}"),
                    ("placeholder", "{agent_scratchpad}"),
                ]
            )
            agent = create_tool_calling_agent(llm, tools, prompt)
            executor = AgentExecutor(agent=agent, tools=tools, verbose=False)
            await executor.ainvoke({"input": prompt_text})


async def _scenario_warn() -> str | None:
    """Returns None on PASS, or an error message on FAIL."""
    flavor = f"playground-mcp-policy-langchain-warn-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    server_module = "playground._mcp_reference_server"
    raw_stdio_url = f"{sys.executable} -m {server_module}"
    server_name = "flightdeck-mcp-reference"

    provision_flavor_policy(
        flavor,
        {
            "block_on_uncertainty": False,
            "entries": [
                {
                    "server_url": raw_stdio_url,
                    "server_name": server_name,
                    "entry_kind": "deny",
                    "enforcement": "warn",
                }
            ],
        },
    )
    init_sensor(session_id, flavor=flavor)
    flightdeck_sensor.patch(quiet=True)
    try:
        await _run_langchain_agent(
            "Call the echo tool with the text 'flightdeck-langchain-warn'."
        )
    finally:
        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["session_start", "policy_mcp_warn"],
    )
    warn_events = [e for e in events if e.get("event_type") == "policy_mcp_warn"]
    if not warn_events:
        return "WARN scenario: no policy_mcp_warn event landed"
    return None


async def _scenario_block() -> str | None:
    flavor = f"playground-mcp-policy-langchain-block-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    server_module = "playground._mcp_reference_server"
    raw_stdio_url = f"{sys.executable} -m {server_module}"
    server_name = "flightdeck-mcp-reference"

    provision_flavor_policy(
        flavor,
        {
            "block_on_uncertainty": False,
            "entries": [
                {
                    "server_url": raw_stdio_url,
                    "server_name": server_name,
                    "entry_kind": "deny",
                    "enforcement": "block",
                }
            ],
        },
    )
    init_sensor(session_id, flavor=flavor)
    flightdeck_sensor.patch(quiet=True)

    blocked_observed = False
    try:
        try:
            await _run_langchain_agent(
                "Call the echo tool with the text 'flightdeck-langchain-block'."
            )
        except flightdeck_sensor.MCPPolicyBlocked:
            blocked_observed = True
        except Exception as exc:  # noqa: BLE001
            # LangChain's AgentExecutor wraps tool exceptions in its
            # own error type before re-raising. Walk __cause__ /
            # __context__ chain to find the MCPPolicyBlocked.
            cur: BaseException | None = exc
            while cur is not None:
                if isinstance(cur, flightdeck_sensor.MCPPolicyBlocked):
                    blocked_observed = True
                    break
                cur = cur.__cause__ or cur.__context__
            if not blocked_observed:
                # Re-raise unrelated exception so the demo fails loudly.
                raise
    finally:
        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

    if not blocked_observed:
        return "BLOCK scenario: MCPPolicyBlocked was not raised"

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["session_start", "policy_mcp_block"],
    )
    block_events = [e for e in events if e.get("event_type") == "policy_mcp_block"]
    if not block_events:
        return "BLOCK scenario: no policy_mcp_block event landed"
    payload = block_events[0].get("payload") or {}
    if payload.get("decision_path") not in ("flavor_entry",):
        return (
            f"BLOCK scenario: decision_path={payload.get('decision_path')!r}, "
            "expected flavor_entry"
        )
    return None


async def _scenario_allow() -> str | None:
    flavor = f"playground-mcp-policy-langchain-allow-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    server_module = "playground._mcp_reference_server"
    raw_stdio_url = f"{sys.executable} -m {server_module}"
    server_name = "flightdeck-mcp-reference"

    provision_flavor_policy(
        flavor,
        {
            "block_on_uncertainty": False,
            "entries": [
                {
                    "server_url": raw_stdio_url,
                    "server_name": server_name,
                    "entry_kind": "allow",
                    "enforcement": None,
                }
            ],
        },
    )
    init_sensor(session_id, flavor=flavor)
    flightdeck_sensor.patch(quiet=True)
    try:
        await _run_langchain_agent(
            "Call the echo tool with the text 'flightdeck-langchain-allow'."
        )
    finally:
        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["session_start", "mcp_tool_call"],
    )
    tool_calls = [e for e in events if e.get("event_type") == "mcp_tool_call"]
    if not tool_calls:
        return "ALLOW scenario: no mcp_tool_call event landed"
    policy_events = [
        e
        for e in events
        if e.get("event_type") in ("policy_mcp_warn", "policy_mcp_block")
    ]
    if policy_events:
        return (
            "ALLOW scenario: unexpected policy event "
            f"{policy_events[0].get('event_type')!r}; allow entry should "
            "fire neither warn nor block"
        )
    return None


async def run_demo() -> int:
    for label, scenario in [
        ("warn", _scenario_warn),
        ("block", _scenario_block),
        ("allow", _scenario_allow),
    ]:
        err = await scenario()
        if err is not None:
            raise AssertionError(f"[{label}] {err}")
    return 0


def main() -> int:
    try:
        wait_for_dev_stack()
    except RuntimeError as exc:
        print_result("mcp-policy-langchain", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-langchain",
            rc == 0,
            duration_ms,
            "LangChain agent fired warn + block + allow flows via langchain-mcp-adapters",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-langchain", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
