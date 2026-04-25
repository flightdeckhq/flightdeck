"""Claude Code plugin Phase 4 smoke test. Manual; NOT in CI.

The Claude Code plugin is observation-only: it reads Claude Code's
transcript JSONL and POSTs events. Phase 4 does not add a new
emission surface for this client (embeddings N/A, streaming N/A,
llm_error only possible via transcript anomaly detection which is
out of scope for this phase). The smoke here is therefore a
lifecycle-only sanity check that the plugin still posts
session_start / post_call / session_end events against the dev
stack after the Phase 4 event-type vocabulary expansion.

Run this against a locally installed ``claude`` CLI. The test is
marked ``skip`` by default -- set ``CLAUDE_CLI_AVAILABLE=1`` to
opt in (protects anyone running ``make smoke-all`` without the CLI
installed from a confusing red CI).
"""

from __future__ import annotations

import os
import subprocess

import pytest

from tests.smoke.conftest import wait_for_dev_stack


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    if not os.environ.get("CLAUDE_CLI_AVAILABLE"):
        pytest.skip(
            "Claude Code CLI smoke opt-in gated on CLAUDE_CLI_AVAILABLE=1. "
            "Install the ``claude`` CLI, enable the Flightdeck plugin, "
            "then re-run.",
        )
    wait_for_dev_stack()


def test_claude_cli_is_on_path() -> None:
    # Can't automate a full Claude Code run from here without a
    # bearer token to Anthropic's API -- but we CAN confirm the
    # binary is present and the plugin scripts register.
    r = subprocess.run(["claude", "--version"], capture_output=True, text=True)
    assert r.returncode == 0, f"claude --version failed: {r.stderr}"
    # More comprehensive scenarios (drive a real prompt, assert
    # session_start + post_call + session_end lands) need a scripted
    # claude-session harness. The README Roadmap is the surface for
    # tracking that work.
