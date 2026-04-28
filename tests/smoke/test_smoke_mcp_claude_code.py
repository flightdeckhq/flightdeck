"""Phase 5 MCP smoke test — Claude Code plugin. Manual; NOT in CI.

The plugin's MCP path is exercised the same way Claude Code itself
exercises it: an MCP-namespaced tool name (``mcp__<server>__<tool>``)
arriving on a ``PostToolUse`` hook payload. The plugin parses the
namespace, looks up the server fingerprint from ``.mcp.json`` /
``~/.claude.json``, builds an ``mcp_tool_call`` event, and POSTs it to
``$FLIGHTDECK_SERVER/ingest/v1/events``.

This smoke runs the real ``node`` subprocess against the dev stack —
the same path Claude Code uses in production. It does NOT require
the ``claude`` CLI to be installed (the plugin script is invoked
directly), making this smoke pluggable into ``make smoke-all`` on
any box with Node 20+.

Run with ``make smoke-mcp-claude-code``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from tests.smoke.conftest import (
    API_TOKEN,
    API_URL,
    INGESTION_URL,
    wait_for_dev_stack,
)


PLUGIN_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "plugin" / "hooks" / "scripts" / "observe_cli.mjs"
)


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    if shutil.which("node") is None:
        pytest.skip("Claude Code plugin smoke requires Node 20+ on PATH")
    if not PLUGIN_SCRIPT.exists():
        pytest.skip(f"plugin script not present at {PLUGIN_SCRIPT}")
    wait_for_dev_stack()


def _run_plugin(hook_event: dict, *, session_id: str) -> None:
    """Pipe a hook event JSON to the plugin script over stdin and
    wait for the process to exit. The plugin script is fire-and-forget
    HTTP — it POSTs to the dev stack and exits 0 on success or on
    silent failure (logs to stderr).

    Inherits the caller's PATH (so ``node`` from nvm / homebrew /
    distro-package all resolve) plus pins the env vars the plugin
    looks at. Pinning a synthetic PATH here would break on every
    box where ``node`` lives outside the canonical /usr/bin set.
    """
    import os as _os
    env = {
        "PATH": _os.environ.get("PATH", "/usr/bin:/usr/local/bin:/bin"),
        "FLIGHTDECK_SERVER": INGESTION_URL.removesuffix("/ingest"),
        "FLIGHTDECK_TOKEN": API_TOKEN,
        "CLAUDE_SESSION_ID": session_id,
        "FLIGHTDECK_CAPTURE_PROMPTS": "true",
        "FLIGHTDECK_CAPTURE_TOOL_INPUTS": "true",
    }
    node_bin = shutil.which("node")
    assert node_bin is not None, "node not on PATH (smoke fixture should have skipped)"
    r = subprocess.run(
        [node_bin, str(PLUGIN_SCRIPT)],
        input=json.dumps(hook_event),
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )
    assert r.returncode == 0, (
        f"plugin exited non-zero: code={r.returncode} "
        f"stdout={r.stdout!r} stderr={r.stderr!r}"
    )


def _wait_for_event(
    session_id: str, event_type: str, timeout_s: float = 15.0,
) -> dict:
    """Poll ``/v1/events?session_id=...`` until an event of the given
    type lands or the timeout elapses. Returns the matched event.
    """
    import httpx  # type: ignore[import-untyped]
    deadline = time.monotonic() + timeout_s
    last: list[dict] = []
    while time.monotonic() < deadline:
        r = httpx.get(
            f"{API_URL}/v1/events",
            params={
                "session_id": session_id,
                "from": "2020-01-01T00:00:00Z",
                "limit": 100,
            },
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            timeout=5.0,
        )
        if r.status_code == 200:
            last = r.json().get("events", [])
            for e in last:
                if e["event_type"] == event_type:
                    return e
        time.sleep(0.4)
    raise AssertionError(
        f"no {event_type} landed within {timeout_s}s; observed {last!r}"
    )


def test_plugin_mcp_tool_call_lands_with_server_attribution() -> None:
    """A ``PostToolUse`` hook on ``mcp__<server>__<tool>`` produces
    an ``mcp_tool_call`` event with the parsed server_name + tool_name
    and the captured arguments.
    """
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
    _run_plugin(hook_event, session_id=session_id)

    event = _wait_for_event(session_id, "mcp_tool_call")
    payload = event.get("payload") or {}
    assert payload.get("server_name") == "filesystem", (
        f"server_name mismatch: {payload!r}"
    )
    assert event.get("tool_name") == "read_file", (
        f"tool_name on row mismatch: {event!r}"
    )
    args = payload.get("arguments") or {}
    assert args.get("path") == "/etc/hosts", (
        f"arguments.path mismatch (sanitiser bypass per D4): {payload!r}"
    )


def test_plugin_mcp_tool_call_failure_carries_structured_error() -> None:
    """``PostToolUseFailure`` on an MCP-namespaced tool name produces
    an ``mcp_tool_call`` with the structured error block populated.
    """
    session_id = str(uuid.uuid4())
    hook_event = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": session_id,
        "tool_name": "mcp__github__create_issue",
        "tool_input": {"repo": "x/y"},
        "error": "401 Unauthorized — token expired",
    }
    _run_plugin(hook_event, session_id=session_id)

    event = _wait_for_event(session_id, "mcp_tool_call")
    payload = event.get("payload") or {}
    err = payload.get("error") or {}
    assert err.get("error_class") == "PluginToolError", (
        f"error_class mismatch: {err!r}"
    )
    assert "Unauthorized" in (err.get("message") or ""), (
        f"error message lost the cause: {err!r}"
    )
