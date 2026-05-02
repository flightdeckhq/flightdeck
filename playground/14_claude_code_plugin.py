"""Claude Code plugin -- MCP-emission demo via synthetic PostToolUse hooks.

The Claude Code plugin is observation-only: when Claude Code itself
invokes an ``mcp__<server>__<tool>``-named tool, the PostToolUse hook
fires and ``plugin/hooks/scripts/observe_cli.mjs`` POSTs an
``mcp_tool_call`` event with the parsed server name + arguments. Same
shape applies to the failure path (``PostToolUseFailure``) which
populates the structured error block.

This script pipes synthetic hook events to ``observe_cli.mjs`` over
stdin to exercise both paths against the dev stack -- no real Claude
Code session needed. Two demonstrations:

1. SUCCESS: ``mcp__filesystem__read_file`` PostToolUse → emits an
   mcp_tool_call event with ``server_name=filesystem`` and
   ``tool_name=read_file``.
2. FAILURE: ``mcp__github__create_issue`` PostToolUseFailure → emits
   mcp_tool_call with ``payload.error.error_class=PluginToolError``
   and the error message preserved.

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


PLUGIN_SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "plugin" / "hooks" / "scripts" / "observe_cli.mjs"
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
        f"no {event_type} landed within {timeout_s}s on {API_URL}; "
        f"observed {last!r}",
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
    print_result("observe_cli.mjs PostToolUse", True,
                 int((time.monotonic() - t0) * 1000))

    event = _wait_for_event(session_id, "mcp_tool_call")
    payload = event.get("payload") or {}
    server_ok = payload.get("server_name") == "filesystem"
    tool_ok = event.get("tool_name") == "read_file"
    args_ok = (payload.get("arguments") or {}).get("path") == "/etc/hosts"
    print_result("plugin mcp_tool_call.server_name=filesystem", server_ok, 0)
    print_result("plugin mcp_tool_call.tool_name=read_file", tool_ok, 0)
    print_result("plugin mcp_tool_call.arguments round-trip", args_ok, 0)
    if not (server_ok and tool_ok and args_ok):
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
    print_result("observe_cli.mjs PostToolUseFailure", True,
                 int((time.monotonic() - t0) * 1000))

    event = _wait_for_event(session_id, "mcp_tool_call")
    err = (event.get("payload") or {}).get("error") or {}
    class_ok = err.get("error_class") == "PluginToolError"
    msg_ok = "Unauthorized" in (err.get("message") or "")
    print_result("plugin failure error_class=PluginToolError", class_ok, 0,
                 f"error_class={err.get('error_class')!r}")
    print_result("plugin failure error.message preserved", msg_ok, 0)
    if not (class_ok and msg_ok):
        raise AssertionError(f"plugin failure payload mismatch: {err!r}")


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


if __name__ == "__main__":
    main()
