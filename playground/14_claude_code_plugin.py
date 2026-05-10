"""Claude Code plugin -- MCP-emission demo via synthetic PostToolUse hooks
plus D126 sub-agent SubagentStart / SubagentStop emission demo.

The Claude Code plugin is observation-only: when Claude Code itself
invokes an ``mcp__<server>__<tool>``-named tool, the PostToolUse hook
fires and ``plugin/hooks/scripts/observe_cli.mjs`` POSTs an
``mcp_tool_call`` event with the parsed server name + arguments. Same
shape applies to the failure path (``PostToolUseFailure``) which
populates the structured error block.

D126 extends the same plugin to emit child ``session_start`` /
``session_end`` events when Claude Code spawns a Task subagent. The
plugin's ``SubagentStart`` / ``SubagentStop`` dispatch derives a
deterministic child ``session_id`` via
``uuid5(NAMESPACE_FLIGHTDECK, "flightdeck:subagent://<outer>/<tool_use_id>")``
and stamps ``parent_session_id`` back at the outer session.
``agent_role`` carries the subagent's type (e.g. ``"Explore"``) and
``incoming_message`` / ``outgoing_message`` round-trip the parent's
prompt and the child's response when ``capture_prompts=true``.

This script pipes synthetic hook events to ``observe_cli.mjs`` over
stdin to exercise all three paths against the dev stack -- no real
Claude Code session needed. Three demonstrations:

1. SUCCESS: ``mcp__filesystem__read_file`` PostToolUse → emits an
   mcp_tool_call event with ``server_name=filesystem`` and
   ``tool_name=read_file``.
2. FAILURE: ``mcp__github__create_issue`` PostToolUseFailure → emits
   mcp_tool_call with ``payload.error.error_class=PluginToolError``
   and the error message preserved.
3. SUBAGENT: synthetic ``SubagentStart`` + ``SubagentStop`` pair on
   an ``Explore`` Task subagent → emits a child ``session_start``
   then ``session_end`` whose ``parent_session_id`` points back at
   the outer session, ``agent_role="Explore"``, and
   ``incoming_message.body`` / ``outgoing_message.body`` carry the
   Task prompt + response. Same correlator (``tool_use_id``) on both
   hooks → same child session_id (D126 deterministic uuid5
   derivation).

Skipped cleanly when ``node`` is missing or the plugin script isn't
present (e.g. shallow clone of the repo without the plugin/ directory).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from _helpers import (
    API_TOKEN,
    API_URL,
    INGESTION_URL,
    fetch_events_for_session,
    print_result,
    wait_for_dev_stack,
)


# Namespace UUID shared between the plugin (agent_id.mjs) and the
# Python sensor for every uuid5 derivation. Re-deriving the child
# session_id locally lets us target the right session for assertions
# without having to scan every recently-emitted event.
NAMESPACE_FLIGHTDECK = uuid.UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")


def _child_session_id(outer_session_id: str, correlator: str) -> str:
    """Mirror of ``_subagentChildSessionId`` in observe_cli.mjs.

    Same namespace, same path prefix, same input order — re-derives
    the deterministic child session id so the assertion poll can hit
    the exact session the plugin emitted to without guessing.
    """
    return str(
        uuid.uuid5(
            NAMESPACE_FLIGHTDECK,
            f"flightdeck:subagent://{outer_session_id}/{correlator}",
        )
    )


PLUGIN_SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "plugin"
    / "hooks"
    / "scripts"
    / "observe_cli.mjs"
)


def _run_plugin(hook_event: dict, *, session_id: str) -> None:
    """Pipe a hook event JSON to the plugin script over stdin and wait
    for the process to exit. The plugin script is fire-and-forget HTTP
    -- it POSTs to the dev stack and exits 0 on success or on silent
    failure (logs to stderr).

    Inherits the caller's PATH (so ``node`` from nvm / homebrew /
    distro-package all resolve) plus pins the env vars the plugin
    looks at. Pinning a synthetic PATH here would break on every box
    where ``node`` lives outside the canonical /usr/bin set.
    """
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/usr/local/bin:/bin"),
        "FLIGHTDECK_SERVER": INGESTION_URL.removesuffix("/ingest"),
        "FLIGHTDECK_TOKEN": API_TOKEN,
        "CLAUDE_SESSION_ID": session_id,
        "FLIGHTDECK_CAPTURE_PROMPTS": "true",
        "FLIGHTDECK_CAPTURE_TOOL_INPUTS": "true",
    }
    node_bin = shutil.which("node")
    assert node_bin is not None, "node not on PATH (script should have skipped)"
    r = subprocess.run(
        [node_bin, str(PLUGIN_SCRIPT)],
        input=json.dumps(hook_event),
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )
    if r.returncode != 0:
        raise AssertionError(
            f"plugin exited non-zero: code={r.returncode} "
            f"stdout={r.stdout!r} stderr={r.stderr!r}"
        )


def _wait_for_event(session_id: str, event_type: str, timeout_s: float = 15.0) -> dict:
    """Poll until an event of the given type lands on this session."""
    deadline = time.monotonic() + timeout_s
    last: list[dict] = []
    while time.monotonic() < deadline:
        last = fetch_events_for_session(session_id, timeout_s=1.0)
        for e in last:
            if e.get("event_type") == event_type:
                return e
        time.sleep(0.4)
    raise AssertionError(
        f"no {event_type} landed within {timeout_s}s on {API_URL}; observed {last!r}",
    )


def _demo_success() -> None:
    """``mcp__filesystem__read_file`` PostToolUse → mcp_tool_call event
    with server_name=filesystem + tool_name=read_file + arguments."""
    session_id = str(uuid.uuid4())
    hook_event = {
        "hook_event_name": "PostToolUse",
        "session_id": session_id,
        "tool_name": "mcp__filesystem__read_file",
        "tool_input": {"path": "/etc/hosts"},
        "tool_response": {
            "content": [{"type": "text", "text": "127.0.0.1 localhost"}],
        },
    }
    print(f"[playground:14_claude_code_plugin] success session_id={session_id}")
    t0 = time.monotonic()
    _run_plugin(hook_event, session_id=session_id)
    print_result(
        "observe_cli.mjs PostToolUse", True, int((time.monotonic() - t0) * 1000)
    )

    event = _wait_for_event(session_id, "mcp_tool_call")
    payload = event.get("payload") or {}
    server_ok = payload.get("server_name") == "filesystem"
    tool_ok = event.get("tool_name") == "read_file"
    # Phase 7 Step 3.b (D150): tool args migrated from inline
    # payload.arguments to event_content.tool_input. The plugin
    # path mirrors the sensor: has_content=true signals operators
    # to fetch via /v1/events/:id/content; payload no longer
    # carries arguments inline.
    has_content_ok = event.get("has_content") is True
    no_inline_args = "arguments" not in payload
    print_result("plugin mcp_tool_call.server_name=filesystem", server_ok, 0)
    print_result("plugin mcp_tool_call.tool_name=read_file", tool_ok, 0)
    print_result("plugin mcp_tool_call.has_content=True (D150)", has_content_ok, 0)
    print_result("plugin mcp_tool_call no inline arguments (D150)", no_inline_args, 0)
    if not (server_ok and tool_ok and has_content_ok and no_inline_args):
        raise AssertionError(f"plugin mcp_tool_call payload mismatch: {event!r}")


def _demo_failure() -> None:
    """``PostToolUseFailure`` on an MCP-namespaced tool → mcp_tool_call
    with structured error block populated."""
    session_id = str(uuid.uuid4())
    hook_event = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": session_id,
        "tool_name": "mcp__github__create_issue",
        "tool_input": {"repo": "x/y"},
        "error": "401 Unauthorized — token expired",
    }
    print(f"[playground:14_claude_code_plugin] failure session_id={session_id}")
    t0 = time.monotonic()
    _run_plugin(hook_event, session_id=session_id)
    print_result(
        "observe_cli.mjs PostToolUseFailure", True, int((time.monotonic() - t0) * 1000)
    )

    event = _wait_for_event(session_id, "mcp_tool_call")
    err = (event.get("payload") or {}).get("error") or {}
    class_ok = err.get("error_class") == "PluginToolError"
    msg_ok = "Unauthorized" in (err.get("message") or "")
    print_result(
        "plugin failure error_class=PluginToolError",
        class_ok,
        0,
        f"error_class={err.get('error_class')!r}",
    )
    print_result("plugin failure error.message preserved", msg_ok, 0)
    if not (class_ok and msg_ok):
        raise AssertionError(f"plugin failure payload mismatch: {err!r}")


def _demo_subagent() -> None:
    """SubagentStart + SubagentStop on a synthetic ``Explore`` Task →
    child ``session_start`` + ``session_end`` events with
    ``parent_session_id`` pointing back at the outer session.

    The two hooks share a ``tool_use_id`` correlator so the plugin
    derives the same child ``session_id`` for both — this is the D126
    pairing contract. With ``capture_prompts=true`` (the playground
    default), the parent's prompt rides on
    ``payload.incoming_message.body`` and the child's response rides
    on ``payload.outgoing_message.body`` (sub-8 KiB → inline; the
    overflow path is exercised separately in
    17_subagents_langgraph.py to keep this demo's blast radius
    limited to the plugin dispatch).
    """
    outer_session_id = str(uuid.uuid4())
    correlator = "toolu_" + uuid.uuid4().hex[:16]
    child_session_id = _child_session_id(outer_session_id, correlator)

    incoming_prompt = (
        "Find every TODO(D126) comment under sensor/ and report the file + "
        "line for each. Skip vendored deps."
    )
    outgoing_response = (
        "Found 0 TODO(D126) comments under sensor/. The D126 implementation "
        "is complete (per CHANGELOG)."
    )

    print(
        f"[playground:14_claude_code_plugin] subagent "
        f"outer_session_id={outer_session_id} "
        f"child_session_id={child_session_id} correlator={correlator}",
    )

    start_event = {
        "hook_event_name": "SubagentStart",
        "session_id": outer_session_id,
        "subagent_type": "Explore",
        "tool_use_id": correlator,
        "tool_input": {"prompt": incoming_prompt},
    }
    t0 = time.monotonic()
    _run_plugin(start_event, session_id=outer_session_id)
    print_result(
        "observe_cli.mjs SubagentStart",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    stop_event = {
        "hook_event_name": "SubagentStop",
        "session_id": outer_session_id,
        "subagent_type": "Explore",
        "tool_use_id": correlator,
        "tool_response": outgoing_response,
    }
    t0 = time.monotonic()
    _run_plugin(stop_event, session_id=outer_session_id)
    print_result(
        "observe_cli.mjs SubagentStop",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    # The plugin emits to the CHILD session_id (uuid5 derived). The
    # outer session is never POSTed to here -- SubagentStart /
    # SubagentStop are child-session emissions only. Poll the child
    # for both events.
    start_landed = _wait_for_event(child_session_id, "session_start")
    end_landed = _wait_for_event(child_session_id, "session_end")

    start_payload = start_landed.get("payload") or {}
    end_payload = end_landed.get("payload") or {}

    parent_ok = (
        start_payload.get("parent_session_id") == outer_session_id
        and end_payload.get("parent_session_id") == outer_session_id
    )
    role_ok = (
        start_payload.get("agent_role") == "Explore"
        and end_payload.get("agent_role") == "Explore"
    )
    same_child_ok = (
        start_landed.get("session_id") == child_session_id
        and end_landed.get("session_id") == child_session_id
    )
    incoming = start_payload.get("incoming_message") or {}
    incoming_ok = incoming.get("body") == incoming_prompt
    outgoing = end_payload.get("outgoing_message") or {}
    outgoing_ok = outgoing.get("body") == outgoing_response

    print_result(
        "subagent parent_session_id round-trip",
        parent_ok,
        0,
        f"start={start_payload.get('parent_session_id')!r} "
        f"end={end_payload.get('parent_session_id')!r}",
    )
    print_result(
        "subagent agent_role=Explore on both events",
        role_ok,
        0,
        f"start={start_payload.get('agent_role')!r} "
        f"end={end_payload.get('agent_role')!r}",
    )
    print_result(
        "subagent same child session_id on Start + Stop",
        same_child_ok,
        0,
        f"start={start_landed.get('session_id')!r} "
        f"end={end_landed.get('session_id')!r}",
    )
    print_result(
        "subagent incoming_message.body round-trip",
        incoming_ok,
        0,
        f"got body={incoming.get('body')!r}",
    )
    print_result(
        "subagent outgoing_message.body round-trip",
        outgoing_ok,
        0,
        f"got body={outgoing.get('body')!r}",
    )

    if not (parent_ok and role_ok and same_child_ok and incoming_ok and outgoing_ok):
        raise AssertionError(
            f"plugin SubagentStart/SubagentStop payload mismatch — "
            f"start_payload={start_payload!r} end_payload={end_payload!r}",
        )


def main() -> None:
    if shutil.which("node") is None:
        print("SKIP: Claude Code plugin demo requires Node 20+ on PATH")
        sys.exit(2)
    if not PLUGIN_SCRIPT.exists():
        print(f"SKIP: plugin script not present at {PLUGIN_SCRIPT}")
        sys.exit(2)

    wait_for_dev_stack()
    _demo_success()
    _demo_failure()
    _demo_subagent()


if __name__ == "__main__":
    main()
