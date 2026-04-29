"""Claude Code plugin smoke test. Manual; NOT in CI.

The Claude Code plugin is observation-only: it reads Claude Code's
transcript JSONL and POSTs events. The lifecycle smoke (this file's
``test_claude_cli_is_on_path``) only confirms the plugin's
prerequisite ``claude`` CLI is present and responsive -- a richer
end-to-end check that drives a real Claude Code session needs an
Anthropic API key plus a scripted harness, tracked on the README
Roadmap.

The MCP path (``mcp__<server>__<tool>`` PostToolUse hooks producing
``mcp_tool_call`` events with parsed server attribution) lives in
this file too -- the plugin is the only emission surface that
flightdeck observes outside the Python sensor, and its MCP coverage
is intentionally narrower than the Python frameworks (tool calls
only; resource reads, prompt fetches, and list operations are below
the hook layer).

Run via ``make smoke-claude-code``. CLI lifecycle tests are gated on
``CLAUDE_CLI_AVAILABLE=1`` so ``make smoke-all`` runs cleanly on a
box without the ``claude`` binary installed; MCP path tests run
against the dev stack directly via ``node`` and require Node 20+.
"""

from __future__ import annotations

import json
import os
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


# CLI lifecycle tests gate on CLAUDE_CLI_AVAILABLE so a box without
# the ``claude`` binary still runs cleanly. The MCP path tests below
# do not need the CLI -- they invoke the plugin script directly with
# ``node`` -- and have their own per-test gating (Node 20 + script
# present).
def _claude_cli_available() -> bool:
    return bool(os.environ.get("CLAUDE_CLI_AVAILABLE"))


def _node_available() -> bool:
    return shutil.which("node") is not None and PLUGIN_SCRIPT.exists()


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    wait_for_dev_stack()


def test_claude_cli_is_on_path() -> None:
    if not _claude_cli_available():
        pytest.skip(
            "Claude Code CLI smoke opt-in gated on CLAUDE_CLI_AVAILABLE=1. "
            "Install the ``claude`` CLI, enable the Flightdeck plugin, "
            "then re-run.",
        )
    # Can't automate a full Claude Code run from here without a
    # bearer token to Anthropic's API -- but we CAN confirm the
    # binary is present and the plugin scripts register.
    r = subprocess.run(["claude", "--version"], capture_output=True, text=True)
    assert r.returncode == 0, f"claude --version failed: {r.stderr}"
    # More comprehensive scenarios (drive a real prompt, assert
    # session_start + post_call + session_end lands) need a scripted
    # claude-session harness. The README Roadmap is the surface for
    # tracking that work.


# ---------------------------------------------------------------------------
# MCP path: ``mcp__<server>__<tool>`` PostToolUse hooks land as
# ``mcp_tool_call`` events with the parsed server name + arguments.
# ---------------------------------------------------------------------------


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
    assert node_bin is not None, "node not on PATH (test should have skipped)"
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
    """A ``PostToolUse`` hook on ``mcp__<server>__<tool>`` produces an
    ``mcp_tool_call`` event with the parsed server_name + tool_name and
    the captured arguments.
    """
    if not _node_available():
        pytest.skip(
            "Claude Code plugin MCP smoke requires Node 20+ on PATH and "
            f"plugin script at {PLUGIN_SCRIPT}",
        )
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
        f"arguments.path mismatch: {payload!r}"
    )


def test_plugin_mcp_tool_call_failure_carries_structured_error() -> None:
    """``PostToolUseFailure`` on an MCP-namespaced tool name produces an
    ``mcp_tool_call`` with the structured error block populated.
    """
    if not _node_available():
        pytest.skip(
            "Claude Code plugin MCP smoke requires Node 20+ on PATH and "
            f"plugin script at {PLUGIN_SCRIPT}",
        )
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
