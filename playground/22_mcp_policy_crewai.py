"""MCP Protection Policy -- CrewAI transitive coverage via mcpadapt.

CrewAI integrates MCP through the ``mcpadapt`` adapter. The sensor's
``ClientSession`` patch (D117) is on the canonical seam, so CrewAI's
MCP usage flows through the same call_tool wrapper that emits
POLICY_MCP_WARN / POLICY_MCP_BLOCK events for the direct mcp SDK
case. This demo provisions a flavor warn policy and runs a real
CrewAI agent with an MCP tool to verify the wrapper fires.

Self-skips when:
  - mcpadapt is not installed (``pip install mcpadapt``).
  - ``ANTHROPIC_API_KEY`` and ``OPENAI_API_KEY`` are not set
    (CrewAI requires both for its default LLM stack).

Real LLM API spend per run: small (one short conversation turn).
"""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.request
import uuid

if not os.environ.get("ANTHROPIC_API_KEY") or not os.environ.get("OPENAI_API_KEY"):
    print("SKIP: set ANTHROPIC_API_KEY + OPENAI_API_KEY to run this CrewAI demo")
    sys.exit(2)

# NOTE: ``mcpadapt.core`` does ``from mcp.client.stdio import
# stdio_client`` at MODULE import time, capturing a local binding
# before the sensor's ``patch()`` rewrites the ``mcp.client.stdio``
# attribute. Skip-check via ``find_spec`` (no actual import) at
# file top, then lazy-import the actual classes inside ``run_demo``,
# AFTER ``flightdeck_sensor.patch()`` has run. Demos 5 + 25 use the
# same pattern for the same reason.
import importlib.util as _ilu

for _modname in ("crewai", "mcpadapt.core", "mcpadapt.crewai_adapter"):
    if _ilu.find_spec(_modname) is None:
        print("SKIP: pip install crewai mcpadapt to run this example")
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


def run_demo() -> int:
    flavor = f"playground-mcp-policy-crewai-{uuid.uuid4().hex[:6]}"
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

    # Lazy-import after flightdeck_sensor.patch() has run — see
    # file-top note on the mcpadapt module-import binding gotcha.
    from crewai import Agent, Crew, Task  # type: ignore[import-not-found]
    from mcpadapt.core import MCPAdapt  # type: ignore[import-not-found]
    from mcpadapt.crewai_adapter import CrewAIAdapter  # type: ignore[import-not-found]

    server_params = mcp_server_params(server_module)
    with MCPAdapt(server_params, CrewAIAdapter()) as tools:
        agent = Agent(
            role="Echo Caller",
            goal="Call the echo tool exactly once and report what you got.",
            backstory="You exercise MCP tool calls under Flightdeck policy enforcement.",
            tools=tools,
            verbose=False,
        )
        # Workaround for an upstream mcpadapt schema-generation bug.
        # See README "Known framework constraints" for the full
        # operator-facing explanation.
        from flightdeck_sensor.compat.crewai_mcp import (
            crewai_mcp_schema_fixup,
        )
        crewai_mcp_schema_fixup(agent)
        task = Task(
            description=(
                "Use the echo tool to echo back the literal string "
                "'flightdeck-mcp-policy-crewai'. Report the response."
            ),
            expected_output="One short sentence with the echoed value.",
            agent=agent,
        )
        crew = Crew(agents=[agent], tasks=[task], verbose=False)
        crew.kickoff()

    flightdeck_sensor.unpatch()
    flightdeck_sensor.teardown()

    events = fetch_events_for_session(
        session_id,
        expect_event_types=["session_start", "policy_mcp_warn"],
    )
    warn_events = [e for e in events if e.get("event_type") == "policy_mcp_warn"]
    assert warn_events, (
        "no policy_mcp_warn event landed; CrewAI may not have invoked the MCP tool"
    )
    return 0


def main() -> int:
    try:
        wait_for_dev_stack()
    except RuntimeError as exc:
        print_result("mcp-policy-crewai", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = run_demo()
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-crewai",
            rc == 0,
            duration_ms,
            "CrewAI MCP tool call fired POLICY_MCP_WARN via mcpadapt path",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-crewai", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
