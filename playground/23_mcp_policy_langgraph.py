"""MCP Protection Policy -- LangGraph transitive coverage via langchain-mcp-adapters.

LangGraph integrates MCP through ``langchain-mcp-adapters``. The
sensor's ``ClientSession`` patch (D117) is the protocol-level seam,
so LangGraph's MCP usage flows through the same call_tool wrapper.
This demo provisions a flavor warn policy and runs a real LangGraph
``create_react_agent`` with an MCP tool to verify the wrapper fires.

Self-skips when:
  - langchain-mcp-adapters / langgraph are not installed.
  - ``ANTHROPIC_API_KEY`` is not set.

Real Anthropic spend per run: small (one or two short turns).
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
    print("SKIP: set ANTHROPIC_API_KEY to run this LangGraph demo")
    sys.exit(2)

try:
    import mcp.client.stdio as _mcp_stdio
    from langchain_anthropic import ChatAnthropic  # type: ignore[import-not-found]
    from langchain_mcp_adapters.tools import load_mcp_tools  # type: ignore[import-not-found]
    from langgraph.prebuilt import create_react_agent  # type: ignore[import-not-found]
    from mcp.client.session import ClientSession
except ImportError:
    print(
        "SKIP: pip install langchain-mcp-adapters langgraph langchain-anthropic to run this example"
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
    headers = {"Authorization": "Bearer tok_admin_dev"}
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


async def run_demo() -> int:
    flavor = f"playground-mcp-policy-langgraph-{uuid.uuid4().hex[:6]}"
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

    os.environ["FLIGHTDECK_MCP_POLICY_DEFAULT"] = "enforce"
    init_sensor(session_id, flavor=flavor)
    flightdeck_sensor.patch(quiet=True)

    params = mcp_server_params(server_module)
    async with _mcp_stdio.stdio_client(params) as (read, write):  # noqa: SIM117
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)
            llm = ChatAnthropic(model="claude-sonnet-4-5", max_tokens=400)
            agent = create_react_agent(llm, tools)
            await agent.ainvoke(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": (
                                "Call the echo tool with the text "
                                "'flightdeck-mcp-policy-langgraph'."
                            ),
                        }
                    ],
                }
            )

    flightdeck_sensor.unpatch()
    flightdeck_sensor.teardown()

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["session_start", "policy_mcp_warn"],
    )
    warn_events = [e for e in events if e.get("event_type") == "policy_mcp_warn"]
    assert warn_events, (
        "no policy_mcp_warn event landed; LangGraph may not have invoked the MCP tool"
    )
    return 0


def main() -> int:
    try:
        wait_for_dev_stack()
    except RuntimeError as exc:
        print_result("mcp-policy-langgraph", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-langgraph",
            rc == 0,
            duration_ms,
            "LangGraph MCP tool call fired POLICY_MCP_WARN via langchain-mcp-adapters path",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-langgraph", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
