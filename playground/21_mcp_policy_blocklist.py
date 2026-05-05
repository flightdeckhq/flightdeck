"""MCP Protection Policy -- blocklist mode + global deny entry.

Exercises the global-policy mutation path: PUT /v1/mcp-policies/global
to add a deny entry against the reference MCP server, run a tool
call, assert the block fires via ``decision_path="global_entry"``,
then restore the global to its empty state so subsequent demos
don't see the lingering deny.

Demonstrates that the global-policy entry takes precedence over
the mode default (D135 step 2). Even though blocklist mode would
normally allow unmatched URLs, an explicit global deny still
blocks.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

try:
    import mcp.client.stdio as _mcp_stdio
    from mcp.client.session import ClientSession
except ImportError:
    print("SKIP: pip install mcp to run this example")
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


def get_global_policy() -> dict:
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/global",
        headers={"Authorization": "Bearer tok_dev"},
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read())


def put_global_policy(body: dict) -> None:
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/global",
        data=json.dumps(body).encode(),
        headers=_admin_headers(content_type="application/json"),
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"unexpected status {resp.status}")


async def run_demo() -> int:
    flavor = f"playground-mcp-blocklist-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    server_module = "playground._mcp_reference_server"
    raw_stdio_url = f"{sys.executable} -m {server_module}"
    server_name = "flightdeck-mcp-reference"

    # 1. Snapshot current global so we can restore at end.
    initial_global = get_global_policy()
    initial_mode = initial_global.get("mode") or "blocklist"

    # 2. PUT global with blocklist mode + a deny entry against the
    # reference server. The deny+block enforcement takes precedence
    # over the permissive mode default.
    put_global_policy(
        {
            "mode": "blocklist",
            "block_on_uncertainty": False,
            "entries": [
                {
                    "server_url": raw_stdio_url,
                    "server_name": server_name,
                    "entry_kind": "deny",
                    "enforcement": "block",
                }
            ],
        }
    )

    try:
        os.environ["FLIGHTDECK_MCP_POLICY_DEFAULT"] = "enforce"
        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(quiet=True)

        blocked_exc: flightdeck_sensor.MCPPolicyBlocked | None = None
        params = mcp_server_params(server_module)
        async with _mcp_stdio.stdio_client(params) as (read, write):  # noqa: SIM117
            async with ClientSession(read, write) as session:
                await session.initialize()
                try:
                    await session.call_tool("echo", arguments={"text": "hi"})
                except flightdeck_sensor.MCPPolicyBlocked as exc:
                    blocked_exc = exc

        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

        assert blocked_exc is not None, "expected block from global deny entry"
        assert blocked_exc.decision_path == "global_entry", (
            f"expected global_entry, got {blocked_exc.decision_path}"
        )

        # Verify the policy_mcp_block event landed.
        time.sleep(1.0)  # playground polling — sleep is acceptable in manual demos
        events = fetch_events_for_session(session_id)
        block_events = [e for e in events if e.get("event_type") == "policy_mcp_block"]
        assert block_events, "policy_mcp_block event did not land"
        return 0
    finally:
        # 3. Restore global to its initial empty-blocklist state.
        put_global_policy(
            {
                "mode": initial_mode,
                "block_on_uncertainty": False,
                "entries": [],
            }
        )


def main() -> int:
    try:
        wait_for_dev_stack()
    except RuntimeError as exc:
        print_result("mcp-policy-blocklist", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-blocklist",
            rc == 0,
            duration_ms,
            "global deny entry overrides blocklist mode default",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-blocklist", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
