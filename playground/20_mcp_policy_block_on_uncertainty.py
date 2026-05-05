"""MCP Protection Policy -- block-on-uncertainty failsafe (D129 / D135).

Exercises the operator failsafe path: control plane unreachable
+ ``init(mcp_block_on_uncertainty=True)``. The sensor's preflight
fails (cannot fetch policy), the cache stays empty, and unmatched
URLs in mode-default fall-through resolve to **block** instead of
allow. ``decision_path="mode_default"`` and ``scope="local_failsafe"``
attribute the block to the local override.

Why this matters: a paranoid deployment doesn't fall open silently
when the control plane has a hiccup. The default is fail-open per
Rule 28; opt-in via the kwarg trades availability for a tighter
security boundary.

Run independently of the dev stack — points the sensor at an
invalid API URL on purpose. The MCP reference server still runs
locally so call_tool can reach the wrapper.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid

try:
    import mcp.client.stdio as _mcp_stdio
    from mcp.client.session import ClientSession
except ImportError:
    print("SKIP: pip install mcp to run this example")
    sys.exit(2)

from _helpers import (
    init_sensor,
    mcp_server_params,
    print_result,
)

import flightdeck_sensor


async def run_demo() -> int:
    flavor = f"playground-mcp-bou-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    server_module = "playground._mcp_reference_server"

    # Force enforce mode (so soft-launch doesn't downgrade) AND
    # point the sensor at an invalid api_url so the preflight
    # policy fetch fails. The mcp_block_on_uncertainty=True kwarg
    # is the failsafe that blocks unmatched URLs anyway.
    os.environ["FLIGHTDECK_MCP_POLICY_DEFAULT"] = "enforce"
    init_sensor(
        session_id,
        flavor=flavor,
        api_url="http://localhost:65535/api",  # nothing listens on this port
        mcp_block_on_uncertainty=True,
    )

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

    assert blocked_exc is not None, "block-on-uncertainty failsafe did not fire"
    assert blocked_exc.decision_path == "mode_default", (
        f"expected mode_default, got {blocked_exc.decision_path}"
    )
    return 0


def main() -> int:
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-block-on-uncertainty",
            rc == 0,
            duration_ms,
            "MCPPolicyBlocked raised via local_failsafe with empty cache",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-block-on-uncertainty",
            False,
            duration_ms,
            str(exc),
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
