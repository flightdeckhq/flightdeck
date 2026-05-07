"""MCP Protection Policy — LlamaIndex transitive coverage via llama-index-tools-mcp.

LlamaIndex integrates MCP through ``llama-index-tools-mcp``, a
DIFFERENT adapter package than the ``langchain-mcp-adapters`` that
demos 22 (CrewAI via mcpadapt) and 23/24 (LangGraph + LangChain via
langchain-mcp-adapters) exercise. Drift surface is independent: a
LlamaIndex-internal change to how ``BasicMCPClient`` /
``McpToolSpec`` invokes the underlying MCP ``ClientSession`` could
silently bypass the sensor's ``ClientSession.call_tool`` patch
(D117). This demo exercises the explicit FunctionAgent path so a
future SDK shift is caught by the playground gate.

Three sub-scenarios run back-to-back per Step 6.5 PR Part A spec:

  1. WARN  — flavor deny entry with enforcement=warn. Tool call
     completes; ``policy_mcp_warn`` event lands.
  2. BLOCK — flavor deny entry with enforcement=block. Tool call
     emits ``policy_mcp_block``. LlamaIndex's FunctionAgent may
     surface the ``MCPPolicyBlocked`` raise as a tool error
     internally rather than propagating; the contract is that
     the EVENT lands, not that the exception reaches the caller.
  3. ALLOW — flavor allow entry. Tool call completes;
     ``mcp_tool_call`` event lands; NO policy event lands.

Self-skips when:
  - llama-index / llama-index-tools-mcp / llama-index-llms-anthropic
    not installed.
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
    print("SKIP: set ANTHROPIC_API_KEY to run this LlamaIndex demo")
    sys.exit(2)

# NOTE: ``llama_index.tools.mcp`` does ``from mcp.client.stdio import
# stdio_client`` at MODULE import time, capturing a local binding
# before the sensor's ``patch()`` rewrites the ``mcp.client.stdio``
# attribute. Once that module is imported the cached binding stays
# and there's no way for the sensor to reach in and update it.
# Skip-check via ``find_spec`` (no actual import) so the module
# stays uninstantiated until inside the per-scenario function, AFTER
# ``flightdeck_sensor.patch()`` has run. Demo 5 uses the same lazy-
# import pattern for the same reason.
import importlib.util as _ilu

for _modname in (
    "llama_index.core.agent.workflow",
    "llama_index.llms.anthropic",
    "llama_index.tools.mcp",
):
    if _ilu.find_spec(_modname) is None:
        print(
            "SKIP: pip install llama-index llama-index-llms-anthropic "
            "llama-index-tools-mcp to run this example"
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


async def _run_llamaindex_agent(prompt_text: str) -> None:
    """Drive one LlamaIndex FunctionAgent turn against the in-process
    MCP reference server. Imports BasicMCPClient / McpToolSpec /
    FunctionAgent / Anthropic INSIDE the function so the sensor's
    ``stdio_client`` patch is in scope at the moment llama-index
    captures its module-local binding (see note at file top)."""
    from llama_index.core.agent.workflow import FunctionAgent  # type: ignore[import-untyped]
    from llama_index.llms.anthropic import Anthropic  # type: ignore[import-untyped]
    from llama_index.tools.mcp import (  # type: ignore[import-untyped]
        BasicMCPClient,
        McpToolSpec,
    )

    server_module = "playground._mcp_reference_server"
    params = mcp_server_params(server_module)
    client = BasicMCPClient(
        command_or_url=params.command,
        args=list(params.args),
        env=dict(params.env or {}),
    )
    spec = McpToolSpec(client=client)
    tools = await spec.to_tool_list_async()
    llm = Anthropic(model="claude-sonnet-4-5", max_tokens=400)
    agent = FunctionAgent(
        tools=tools,
        llm=llm,
        system_prompt=(
            "You exercise MCP tools under Flightdeck policy enforcement. "
            "Call the tool the user asks for."
        ),
    )
    await agent.run(prompt_text)


async def _scenario_warn() -> str | None:
    """Returns None on PASS, or an error message on FAIL."""
    flavor = f"playground-mcp-policy-llamaindex-warn-{uuid.uuid4().hex[:6]}"
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
        await _run_llamaindex_agent(
            "Call the echo tool with the text 'flightdeck-llamaindex-warn'."
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
    flavor = f"playground-mcp-policy-llamaindex-block-{uuid.uuid4().hex[:6]}"
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

    try:
        # FunctionAgent may surface the MCPPolicyBlocked raise as
        # an internal tool error — caught by the agent loop, fed
        # back to the LLM as observation, then either retried or
        # the loop concludes with an error message. The contract
        # is the EVENT, not the exception propagation; just run
        # and check the event afterwards.
        try:
            await _run_llamaindex_agent(
                "Call the echo tool with the text 'flightdeck-llamaindex-block'."
            )
        except flightdeck_sensor.MCPPolicyBlocked:
            # Some agent versions DO let the raise propagate. That's
            # also a valid path — the event still lands.
            pass
        except Exception as exc:  # noqa: BLE001
            # FunctionAgent tends to wrap exceptions; walk the chain
            # for MCPPolicyBlocked. If we can't find it, the event
            # check below is still authoritative — so swallow.
            cur: BaseException | None = exc
            while cur is not None:
                if isinstance(cur, flightdeck_sensor.MCPPolicyBlocked):
                    break
                cur = cur.__cause__ or cur.__context__
    finally:
        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

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
    flavor = f"playground-mcp-policy-llamaindex-allow-{uuid.uuid4().hex[:6]}"
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
        await _run_llamaindex_agent(
            "Call the echo tool with the text 'flightdeck-llamaindex-allow'."
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
        print_result("mcp-policy-llamaindex", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-llamaindex",
            rc == 0,
            duration_ms,
            "LlamaIndex agent fired warn + block + allow flows via llama-index-tools-mcp",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-llamaindex", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
