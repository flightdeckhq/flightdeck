"""MCP Protection Policy -- warn enforcement (D130 / D131).

Provisions a flavor policy via the step-3 control-plane API:
allowlist mode + a deny entry whose enforcement is ``warn``. Then
opens an MCP ClientSession, calls a tool against the matched
server, and asserts a ``policy_mcp_warn`` event landed in the
events table with the expected payload shape.

Real API keys are NOT required -- the policy decision fires
client-side at ``call_tool`` invocation time and emits the event
through the standard pipeline. The MCP reference server lives in-
tree (``playground/_mcp_reference_server.py``); no live LLM call is
needed to exercise the warn path.

Rule 40d: self-skips (exit 2) when the dev stack isn't reachable.
Rule 40a.A / 40a.B: declared flavor + ``capture_prompts=True``
defaults via ``init_sensor``.
"""

from __future__ import annotations

import asyncio
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


def provision_flavor_policy(flavor: str, body: dict) -> None:
    """Idempotent: delete any prior flavor policy then POST a fresh
    one with the supplied entries. The DELETE is best-effort (404 is
    fine when nothing existed before)."""
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
    flavor = f"playground-mcp-policy-warn-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())

    # 1. Compute the canonical URL the sensor will see at call_tool
    # time so the provisioned policy entry matches byte-for-byte.
    # mcp_server_params builds StdioServerParameters with
    # command=sys.executable + args=["-m", "<module>"], and the
    # sensor's transport wrapper extracts those into a stdio URL.
    server_module = "playground._mcp_reference_server"
    raw_stdio_url = f"{sys.executable} -m {server_module}"
    # MUST match the FastMCP serverInfo.name the reference server
    # returns at initialize() (declared in _mcp_reference_server.py
    # as _SERVER_NAME). Mismatch produces a different fingerprint and
    # the policy lookup falls through to mode-default rather than
    # firing the warn.
    server_name_for_policy = "flightdeck-mcp-reference"

    # 2. Provision a flavor policy: deny+warn against the matched
    # server. Flavor entry takes precedence (D135 step 1) so the
    # global mode is irrelevant for this demo.
    provision_flavor_policy(
        flavor,
        {
            "block_on_uncertainty": False,
            "entries": [
                {
                    "server_url": raw_stdio_url,
                    "server_name": server_name_for_policy,
                    "entry_kind": "deny",
                    "enforcement": "warn",
                }
            ],
        },
    )

    # 2. Init sensor with the provisioned flavor; preflight will
    # populate the MCP policy cache from the control plane.
    # Force enforce mode so the soft-launch warn-only override
    # doesn't mask warn vs block in this demo (warn fires either way).
    os.environ["FLIGHTDECK_MCP_POLICY_DEFAULT"] = "enforce"
    init_sensor(session_id, flavor=flavor)

    flightdeck_sensor.patch(quiet=True)

    # 3. Open an MCP session against the reference server and call
    # a tool. The MCP server-side ``initialize`` response carries
    # ``serverInfo.name``; mcp_server_params builds the stdio
    # transport whose URL marker matches the policy entry above. The
    # sensor's call_tool wrapper hits the policy cache, finds the
    # flavor entry, decides warn → POLICY_MCP_WARN emits and the
    # tool call proceeds.
    params = mcp_server_params(server_module)
    async with _mcp_stdio.stdio_client(params) as (read, write):  # noqa: SIM117
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("echo", arguments={"text": "hi"})
            assert result is not None, "tool call should succeed under warn"

    flightdeck_sensor.unpatch()
    flightdeck_sensor.teardown()

    # 4. Verify the warn event landed via the events query API.
    time.sleep(1.5)  # playground polling — sleep is acceptable in manual demos
    events = fetch_events_for_session(session_id)
    warn_events = [e for e in events if e.get("event_type") == "policy_mcp_warn"]
    if not warn_events:
        return 1

    payload = warn_events[0].get("payload") or {}
    assert payload.get("decision_path") in (
        "flavor_entry",
        "global_entry",
        "mode_default",
    ), f"missing decision_path: {payload}"
    assert payload.get("server_name") == server_name_for_policy
    assert payload.get("tool_name") == "echo"
    return 0


def main() -> int:
    try:
        wait_for_dev_stack()
    except RuntimeError as exc:
        print_result("mcp-policy-warn", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-warn",
            rc == 0,
            duration_ms,
            "policy_mcp_warn event landed; flavor entry deny+warn enforcement",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-warn", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
