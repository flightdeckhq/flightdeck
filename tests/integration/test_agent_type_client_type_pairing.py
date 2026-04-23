"""Regression guard for the semantic pairing of ``agent_type`` and
``client_type`` in integration test fixtures.

Phase 2 post-smoke Path A cleanup: a manual run of
``test_ui_demo.py`` left the dev DB with an anomalous agent row
(``agent_type=coding`` + ``client_type=flightdeck_sensor``). The
pair is mechanically allowed by the ingestion validator (D116) but
semantically nonsensical -- coding agents in D115 are the Claude Code
plugin, sensor-routed events are SDK workloads. The combination
produced a visible Fleet sidebar bug: a CODING AGENT badge next to a
SENSOR pill on the same row, with two near-identical rows for the
same agent_name.

This test fails if any integration test fixture tries to emit the
illegal combination. Fails at import time if the constants file
shape changes in a way that breaks the grep.
"""

from __future__ import annotations

import pathlib
import re

import pytest


def _load(name: str) -> str:
    here = pathlib.Path(__file__).resolve().parent
    return (here / name).read_text()


# Canonical pairings. Any additional client_type values added in the
# future need a matching allowed agent_type set declared here.
ALLOWED_PAIRS = {
    "claude_code": {"coding"},
    "flightdeck_sensor": {"production"},
}


def test_conftest_default_pair_is_canonical() -> None:
    """``conftest.py`` default client_type must pair with its default
    agent_type. Pre-Phase-2 the defaults were coding + flightdeck_sensor
    which was the anomaly-producing pair."""
    conftest = _load("conftest.py")
    m_at = re.search(r'DEFAULT_AGENT_TYPE\s*=\s*"([^"]+)"', conftest)
    m_ct = re.search(r'DEFAULT_CLIENT_TYPE\s*=\s*"([^"]+)"', conftest)
    assert m_at is not None, "conftest.py must declare DEFAULT_AGENT_TYPE"
    assert m_ct is not None, "conftest.py must declare DEFAULT_CLIENT_TYPE"
    agent_type = m_at.group(1)
    client_type = m_ct.group(1)
    assert client_type in ALLOWED_PAIRS, (
        f"DEFAULT_CLIENT_TYPE={client_type!r} not in the known pairing table; "
        "extend ALLOWED_PAIRS above if a new client_type is legitimate."
    )
    assert agent_type in ALLOWED_PAIRS[client_type], (
        f"conftest defaults an illegal pair: agent_type={agent_type!r}, "
        f"client_type={client_type!r}. Canonical pairs: {ALLOWED_PAIRS!r}."
    )


def test_ui_demo_agents_list_uses_canonical_pairs() -> None:
    """``test_ui_demo.py::AGENTS`` is the specific fixture whose
    manual-run produced the Phase 2 Chrome-smoke anomaly. Assert each
    entry declares a legitimate agent_type / client_type pair."""
    ui_demo = _load("test_ui_demo.py")
    # The AGENTS list entries carry explicit ``client_type`` +
    # ``agent_type`` fields. A simple linewise regex across the list
    # block is enough because each entry is on its own line.
    m = re.search(r"^AGENTS\s*=\s*\[\n(.*?)^\]", ui_demo, re.DOTALL | re.MULTILINE)
    assert m is not None, "test_ui_demo.py::AGENTS list not found"
    body = m.group(1)
    entries = [line for line in body.splitlines() if '"flavor"' in line]
    assert len(entries) > 0, "no agent entries parsed from AGENTS list"
    for line in entries:
        at_match = re.search(r'"agent_type":\s*"([^"]+)"', line)
        ct_match = re.search(r'"client_type":\s*"([^"]+)"', line)
        assert at_match is not None, f"entry lacks agent_type: {line!r}"
        assert ct_match is not None, (
            f"entry lacks client_type -- conftest default of "
            f"flightdeck_sensor would apply, which is the pre-fix "
            f"anti-pattern: {line!r}"
        )
        agent_type = at_match.group(1)
        client_type = ct_match.group(1)
        assert client_type in ALLOWED_PAIRS, (
            f"unknown client_type={client_type!r} in AGENTS entry: {line!r}"
        )
        assert agent_type in ALLOWED_PAIRS[client_type], (
            f"illegal pairing agent_type={agent_type!r} + "
            f"client_type={client_type!r} in AGENTS entry: {line!r}. "
            f"Canonical pairs: {ALLOWED_PAIRS!r}."
        )


@pytest.mark.parametrize(
    "relative_path",
    [
        "test_analytics.py",
        "test_directives.py",
        "test_enforcement.py",
        "test_framework_patching.py",
        "test_killswitch.py",
        "test_pipeline.py",
        "test_policy.py",
        "test_prompt_capture.py",
        "test_search.py",
        "test_session_attachment.py",
        "test_session_context.py",
        "test_session_states.py",
        "test_ws_broadcast.py",
        "test_ui_demo.py",
    ],
)
def test_no_test_file_emits_the_anomalous_pair(relative_path: str) -> None:
    """No integration test file should pass the literal string
    ``agent_type="coding"`` in a context that omits ``client_type``
    (which would cause the conftest default to apply and produce the
    anomalous pair). The regex checks for the bare ``agent_type=coding``
    keyword-arg form and its dict-literal sibling, then asserts either
    (a) it does not appear at all, or (b) every occurrence is paired
    with ``client_type="claude_code"`` within the nearest 120 chars.
    """
    src = _load(relative_path)
    # Find every ``agent_type="coding"`` or ``"agent_type": "coding"``
    # occurrence. Skip matches inside comments (# ...) and docstrings
    # -- those are commentary about the rule itself, not emit sites.
    pattern = re.compile(
        r'(?:agent_type\s*=\s*"coding"|"agent_type"\s*:\s*"coding")'
    )
    for match in pattern.finditer(src):
        # Find the start-of-line for this match; skip if the line is
        # inside a comment.
        line_start = src.rfind("\n", 0, match.start()) + 1
        line_end = src.find("\n", match.end())
        if line_end == -1:
            line_end = len(src)
        line = src[line_start:line_end]
        if line.lstrip().startswith("#"):
            continue
        # Look for a ``client_type`` declaration within 120 chars
        # either direction. If the caller passed client_type
        # explicitly, the anomaly cannot happen.
        window = src[max(0, match.start() - 200):min(len(src), match.end() + 200)]
        assert 'client_type="claude_code"' in window or '"client_type": "claude_code"' in window, (
            f"{relative_path}: ``agent_type=\"coding\"`` emitted without "
            f"an explicit ``client_type=\"claude_code\"`` nearby. Under "
            f"conftest's defaults this produces the Phase 2 anomaly "
            f"(agent_type=coding + client_type=flightdeck_sensor). "
            f"Fix: pass client_type=\"claude_code\" on the make_event "
            f"call. Offending context:\n{window!r}"
        )
