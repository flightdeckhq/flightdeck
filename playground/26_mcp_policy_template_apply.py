"""MCP Protection Policy -- template apply (D138).

Exercises ``POST /v1/mcp-policies/{flavor}/apply_template`` across
the three shipped templates. Each scenario uses its own fresh
flavor + sensor session so the runs don't bleed into each other.

Scenarios:

  S1 ``strict-baseline`` + global ``allowlist``:
     Template ships ``block_on_uncertainty=true``, zero entries.
     Combined with global ``allowlist`` mode, every unlisted server
     blocks at resolution step 3 and the BOU branch emits
     ``policy_mcp_block``. We temporarily flip global to allowlist,
     apply the template, drive the reference MCP server through the
     sensor, expect the block + audit event, then restore global.

  S2 ``permissive-dev`` over default global ``blocklist``:
     Template ships ``block_on_uncertainty=false``, zero entries.
     Functionally equivalent to "no flavor policy" under blocklist
     mode — every unlisted server resolves to allow at step 3.
     Drive the reference server, expect NO ``policy_mcp_block`` to
     land within the poll window.

  S3 ``strict-with-common-allows`` + resolve API verification:
     Template ships three pre-populated allow entries (filesystem,
     github, slack) with URLs that don't match the in-tree
     reference server. Rather than spawn the actual upstream MCP
     servers (which would need ``npx @modelcontextprotocol/server-
     filesystem`` etc.), we verify the apply landed structurally:
     the flavor policy now has BOU=true + 3 entries with the right
     names + URLs, and ``GET /v1/mcp-policies/resolve`` against one
     of those URLs returns ``decision=allow``,
     ``decision_path=flavor_entry`` (D135 step 1).

Why no ``ANTHROPIC_API_KEY`` gate: the sensor's MCP policy
decision fires at ``call_tool`` time, not at LLM-call time. The
demo never invokes a model. Skip applies only when the dev stack
isn't reachable.

Rule 40d: self-skips (exit 2) when the dev stack isn't reachable.
Rule 40a.A / 40a.B: declared flavor + ``capture_prompts=True``
defaults via ``init_sensor``.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.error
import urllib.parse
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


# ---------------------------------------------------------------------
# API helpers — admin-token mutations + small read shims.
# ---------------------------------------------------------------------


def _admin_headers(content_type: str | None = None) -> dict[str, str]:
    headers = {"Authorization": "Bearer tok_admin_dev"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _viewer_headers() -> dict[str, str]:
    return {"Authorization": "Bearer tok_dev"}


def fetch_global_policy() -> dict:
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/global",
        headers=_viewer_headers(),
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read())


def put_global_policy(
    mode: str, block_on_uncertainty: bool, entries: list[dict]
) -> None:
    body = json.dumps(
        {"mode": mode, "block_on_uncertainty": block_on_uncertainty, "entries": entries}
    ).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/global",
        data=body,
        headers=_admin_headers(content_type="application/json"),
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"PUT global -> {resp.status}")


def create_flavor_policy(flavor: str, block_on_uncertainty: bool = False) -> None:
    """Create an empty flavor policy. apply_template requires the flavor
    policy row to exist (returns 404 otherwise per D138)."""
    body = json.dumps(
        {"block_on_uncertainty": block_on_uncertainty, "entries": []}
    ).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/{flavor}",
        data=body,
        headers=_admin_headers(content_type="application/json"),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"POST flavor -> {resp.status}")


def delete_flavor_policy(flavor: str) -> None:
    """Best-effort cleanup; 404 is fine when the flavor was never created."""
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/{flavor}",
        headers=_admin_headers(),
        method="DELETE",
    )
    try:
        urllib.request.urlopen(req, timeout=2)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise


def apply_template(flavor: str, template_name: str) -> dict:
    body = json.dumps({"template": template_name}).encode()
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/{flavor}/apply_template",
        data=body,
        headers=_admin_headers(content_type="application/json"),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read())


def fetch_flavor_policy(flavor: str) -> dict:
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/{flavor}",
        headers=_viewer_headers(),
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read())


def resolve(flavor: str, server_url: str, server_name: str) -> dict:
    qs = urllib.parse.urlencode(
        {"flavor": flavor, "server_url": server_url, "server_name": server_name}
    )
    req = urllib.request.Request(
        f"{API_URL}/v1/mcp-policies/resolve?{qs}",
        headers=_viewer_headers(),
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------------
# MCP-server reference values — same shape as 19_mcp_policy_block.py.
# ---------------------------------------------------------------------

SERVER_MODULE = "playground._mcp_reference_server"
RAW_STDIO_URL = f"{sys.executable} -m {SERVER_MODULE}"
SERVER_NAME_FOR_POLICY = "flightdeck-mcp-reference"


# ---------------------------------------------------------------------
# Scenario 1 — strict-baseline + allowlist global → block + audit.
# ---------------------------------------------------------------------


def _snapshot_global() -> tuple[str, bool, list[dict]]:
    """Capture global mode + BOU + entries-as-mutations for restore."""
    g = fetch_global_policy()
    mode = g.get("mode") or "blocklist"
    bou = bool(g.get("block_on_uncertainty"))
    entries = [
        {
            "server_url": e["server_url"],
            "server_name": e["server_name"],
            "entry_kind": e["entry_kind"],
            "enforcement": e.get("enforcement"),
        }
        for e in (g.get("entries") or [])
    ]
    return mode, bou, entries


async def scenario_strict_baseline() -> tuple[bool, str]:
    flavor = f"playground-template-strict-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    snap_mode, snap_bou, snap_entries = _snapshot_global()
    try:
        # S1 needs allowlist global so the BOU branch in D135 step 3
        # fires; otherwise BOU is ignored and no audit event lands.
        put_global_policy("allowlist", snap_bou, snap_entries)
        create_flavor_policy(flavor)
        result = apply_template(flavor, "strict-baseline")
        if not result.get("block_on_uncertainty"):
            return False, "apply did not persist BOU=true on flavor"

        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(quiet=True)

        params = mcp_server_params(SERVER_MODULE)
        blocked: flightdeck_sensor.MCPPolicyBlocked | None = None
        async with _mcp_stdio.stdio_client(params) as (read, write):  # noqa: SIM117
            async with ClientSession(read, write) as session:
                await session.initialize()
                try:
                    await session.call_tool("echo", arguments={"text": "hi"})
                except flightdeck_sensor.MCPPolicyBlocked as exc:
                    blocked = exc

        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

        if blocked is None:
            return False, "MCPPolicyBlocked was not raised"
        if blocked.decision_path != "mode_default":
            return False, (
                f"decision_path={blocked.decision_path!r}; expected 'mode_default' "
                f"(BOU branch on allowlist mode with no flavor entry)"
            )

        events = fetch_events_for_session(
            session_id,
            expect_event_types=["session_start", "policy_mcp_block"],
        )
        block_events = [e for e in events if e.get("event_type") == "policy_mcp_block"]
        if not block_events:
            return False, "policy_mcp_block did not land on the events stream"
        return True, f"flavor={flavor}, BOU+allowlist branch fired"
    finally:
        delete_flavor_policy(flavor)
        put_global_policy(snap_mode, snap_bou, snap_entries)


# ---------------------------------------------------------------------
# Scenario 2 — permissive-dev under blocklist → no block.
# ---------------------------------------------------------------------


async def scenario_permissive_dev() -> tuple[bool, str]:
    flavor = f"playground-template-permissive-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    snap_mode, snap_bou, snap_entries = _snapshot_global()
    try:
        # S2 explicitly sets blocklist so the demo is robust against
        # whatever state a prior run left global in. Under blocklist +
        # no flavor entries + BOU=false the resolution returns allow
        # at D135 step 3 with no audit event.
        put_global_policy("blocklist", snap_bou, snap_entries)
        create_flavor_policy(flavor)
        result = apply_template(flavor, "permissive-dev")
        if result.get("block_on_uncertainty"):
            return False, "apply did not persist BOU=false on flavor"

        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(quiet=True)

        params = mcp_server_params(SERVER_MODULE)
        async with _mcp_stdio.stdio_client(params) as (read, write):  # noqa: SIM117
            async with ClientSession(read, write) as session:
                await session.initialize()
                # Under blocklist mode + no flavor entries +
                # BOU=false, the call should proceed without raising.
                await session.call_tool("echo", arguments={"text": "hi"})

        flightdeck_sensor.unpatch()
        flightdeck_sensor.teardown()

        # Negative assertion: poll briefly and confirm no
        # policy_mcp_block landed. fetch_events_for_session returns
        # whatever it observed at timeout when the expected list
        # isn't satisfied — perfect for a "should NOT appear" check.
        events = fetch_events_for_session(
            session_id,
            expect_event_types=["session_start", "policy_mcp_block"],
            timeout_s=4.0,
        )
        block_events = [e for e in events if e.get("event_type") == "policy_mcp_block"]
        if block_events:
            return False, f"unexpected policy_mcp_block landed: {block_events[0]}"
        return True, f"flavor={flavor}, blocklist + permissive-dev allowed silently"
    finally:
        delete_flavor_policy(flavor)
        put_global_policy(snap_mode, snap_bou, snap_entries)


# ---------------------------------------------------------------------
# Scenario 3 — strict-with-common-allows + resolve API state check.
# ---------------------------------------------------------------------


async def scenario_strict_with_common_allows() -> tuple[bool, str]:
    flavor = f"playground-template-allows-{uuid.uuid4().hex[:6]}"
    try:
        create_flavor_policy(flavor)
        result = apply_template(flavor, "strict-with-common-allows")
        if not result.get("block_on_uncertainty"):
            return False, "apply did not persist BOU=true on flavor"

        # Re-fetch via GET so we exercise the read path that the
        # dashboard polls after a template apply, not just the POST
        # response shape.
        policy = fetch_flavor_policy(flavor)
        entries = policy.get("entries") or []
        names = sorted(e.get("server_name") for e in entries)
        expected_names = ["filesystem", "github", "slack"]
        if names != expected_names:
            return False, (
                f"entries names={names}; expected {expected_names} "
                f"(template ships three pre-populated allow entries)"
            )

        # Pick the github entry — its URL is HTTPS and doesn't drag
        # the test into npm/stdio canonicalisation quirks.
        github_entry = next(e for e in entries if e["server_name"] == "github")
        decision = resolve(
            flavor=flavor,
            server_url=github_entry["server_url"],
            server_name="github",
        )
        if decision.get("decision") != "allow":
            return (
                False,
                f"resolve decision={decision.get('decision')!r}; expected 'allow'",
            )
        if decision.get("decision_path") != "flavor_entry":
            return False, (
                f"resolve decision_path={decision.get('decision_path')!r}; "
                f"expected 'flavor_entry' (D135 step 1 — flavor entry wins)"
            )
        return True, (
            f"flavor={flavor}, 3 entries materialized, github URL resolves "
            f"as flavor_entry/allow"
        )
    finally:
        delete_flavor_policy(flavor)


# ---------------------------------------------------------------------
# Driver — each scenario owns its global-state snapshot + restore so
# the demo is robust against whatever mode a prior run left.
# ---------------------------------------------------------------------


async def run_demo() -> int:
    failures: list[str] = []

    passed, detail = await scenario_strict_baseline()
    print_result("template-apply-strict-baseline", passed, 0, detail)
    if not passed:
        failures.append("strict-baseline")

    passed, detail = await scenario_permissive_dev()
    print_result("template-apply-permissive-dev", passed, 0, detail)
    if not passed:
        failures.append("permissive-dev")

    passed, detail = await scenario_strict_with_common_allows()
    print_result("template-apply-strict-with-common-allows", passed, 0, detail)
    if not passed:
        failures.append("strict-with-common-allows")

    return 0 if not failures else 1


def main() -> int:
    try:
        wait_for_dev_stack()
    except RuntimeError as exc:
        print_result("mcp-policy-template-apply", False, 0, str(exc))
        return 2
    t0 = time.monotonic()
    try:
        rc = asyncio.run(run_demo())
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result(
            "mcp-policy-template-apply",
            rc == 0,
            duration_ms,
            "all three template scenarios exercised end-to-end",
        )
        return rc
    except AssertionError as exc:
        duration_ms = int((time.monotonic() - t0) * 1000)
        print_result("mcp-policy-template-apply", False, duration_ms, str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
