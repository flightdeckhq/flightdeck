"""Regression guard for the semantic pairing of ``agent_type`` and
``client_type`` in integration test fixtures.

Background: a manual run of
``test_ui_demo.py`` left the dev DB with an anomalous agent row
(``agent_type=coding`` + ``client_type=flightdeck_sensor``). The
pair is mechanically allowed by the ingestion validator but outside
the client type registry's expected pairing (each client type's
expected agent_type, read from contracts/client_types.json): the sensor
is expected to send production, the hook-based coding agents coding.
The combination
produced a visible Fleet sidebar bug: a CODING AGENT badge next to a
SENSOR pill on the same row, with two near-identical rows for the
same agent_name.

This test fails if any integration test fixture tries to emit the
illegal combination, and fails loudly if the constants file or the
fixture modules change shape in a way these checks cannot read.
"""

from __future__ import annotations

import ast
import json
import pathlib
import re

import pytest

# The names these checks read from the fixture modules.
AGENTS_LIST_NAME = "AGENTS"
AGENT_TYPE_KEY = "agent_type"
CLIENT_TYPE_KEY = "client_type"
# The coding emit site that, inheriting the sensor default
# client_type, produced the anomaly; it must name a coding client.
CODING_AGENT_TYPE = "coding"
CLAUDE_CODE_CLIENT_TYPE = "claude_code"


def _load(name: str) -> str:
    here = pathlib.Path(__file__).resolve().parent
    return (here / name).read_text()


def _load_shared(name: str) -> str:
    """Load a file from ``tests/shared/`` (sibling package).

    ``DEFAULT_AGENT_TYPE`` / ``DEFAULT_CLIENT_TYPE`` and friends moved
    out of ``conftest.py`` into ``tests/shared/fixtures.py``
    so the E2E fixture seeder can reuse the same event-builder contract
    without depending on pytest. The canonical-pair regression guard
    follows the constants to their new home.
    """
    here = pathlib.Path(__file__).resolve().parent
    return (here / ".." / "shared" / name).resolve().read_text()


# Canonical pairings: each client type and the agent_type it is
# expected to send, read from the client type registry
# (contracts/client_types.json, its one source). Fails, not skips, when
# the file is missing.
_REGISTRY = json.loads(
    (
        pathlib.Path(__file__).resolve().parents[2] / "contracts" / "client_types.json"
    ).read_text()
)
ALLOWED_PAIRS = {e["id"]: {e["agent_type"]} for e in _REGISTRY["client_types"]}


def test_conftest_default_pair_is_canonical() -> None:
    """Default client_type must pair with its default agent_type.
    The defaults used to be coding + flightdeck_sensor, which was
    the anomaly-producing pair.

    The constants live in ``tests/shared/fixtures.py`` and are
    re-imported by ``conftest.py``. The test greps
    the shared module for the literal declarations AND verifies
    ``conftest.py`` continues to import those names, so a future
    refactor cannot accidentally re-shadow them with a non-canonical
    default.
    """
    shared = _load_shared("fixtures.py")
    m_at = re.search(r'DEFAULT_AGENT_TYPE\s*=\s*"([^"]+)"', shared)
    m_ct = re.search(r'DEFAULT_CLIENT_TYPE\s*=\s*"([^"]+)"', shared)
    assert m_at is not None, "tests/shared/fixtures.py must declare DEFAULT_AGENT_TYPE"
    assert m_ct is not None, "tests/shared/fixtures.py must declare DEFAULT_CLIENT_TYPE"
    agent_type = m_at.group(1)
    client_type = m_ct.group(1)
    assert client_type in ALLOWED_PAIRS, (
        f"DEFAULT_CLIENT_TYPE={client_type!r} is not in the client type registry "
        "(contracts/client_types.json)."
    )
    assert agent_type in ALLOWED_PAIRS[client_type], (
        f"shared fixtures default an illegal pair: agent_type={agent_type!r}, "
        f"client_type={client_type!r}. Canonical pairs: {ALLOWED_PAIRS!r}."
    )

    # conftest.py must still re-export these names so every integration
    # test that does ``from .conftest import DEFAULT_AGENT_TYPE`` gets
    # the canonical value. A future refactor that drops the import
    # would silently revert tests to whatever local default applied
    # before -- this assertion makes that failure loud.
    conftest = _load("conftest.py")
    assert "DEFAULT_AGENT_TYPE" in conftest, (
        "conftest.py must re-export DEFAULT_AGENT_TYPE from shared.fixtures"
    )
    assert "DEFAULT_CLIENT_TYPE" in conftest, (
        "conftest.py must re-export DEFAULT_CLIENT_TYPE from shared.fixtures"
    )


def _agents_list_entries(source: str) -> list[dict[str, str]]:
    """The dict literals assigned to the module-level ``AGENTS`` list.

    Only the ``agent_type`` and ``client_type`` values are read, and
    each must be a string literal; other keys are ignored so the
    fixture can carry non-string fields without tripping this guard.
    Any other shape in an entry is reported as a failure of this guard
    rather than skipped.
    """
    module = ast.parse(source)
    for node in module.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(t, ast.Name) and t.id == AGENTS_LIST_NAME for t in node.targets
        ):
            continue
        assert isinstance(node.value, ast.List), (
            f"{AGENTS_LIST_NAME} is not a list literal"
        )
        entries: list[dict[str, str]] = []
        for element in node.value.elts:
            assert isinstance(element, ast.Dict), (
                f"{AGENTS_LIST_NAME} entry is not a dict: {ast.dump(element)}"
            )
            entry: dict[str, str] = {}
            for key, value in zip(element.keys, element.values, strict=True):
                assert isinstance(key, ast.Constant) and isinstance(key.value, str), (
                    f"{AGENTS_LIST_NAME} entry has a key that is not a string literal: "
                    f"{ast.dump(element)}"
                )
                if key.value not in (AGENT_TYPE_KEY, CLIENT_TYPE_KEY):
                    continue
                assert isinstance(value, ast.Constant) and isinstance(
                    value.value, str
                ), (
                    f"{AGENTS_LIST_NAME} entry's {key.value!r} is not a string literal: "
                    f"{ast.dump(value)}"
                )
                entry[key.value] = value.value
            entries.append(entry)
        return entries
    raise AssertionError(f"test_ui_demo.py::{AGENTS_LIST_NAME} list not found")


def test_ui_demo_agents_list_uses_canonical_pairs() -> None:
    """``test_ui_demo.py::AGENTS`` is the specific fixture whose
    manual-run produced the Chrome-smoke anomaly. Assert each
    entry declares a legitimate agent_type / client_type pair."""
    # The AGENTS list entries carry explicit ``client_type`` +
    # ``agent_type`` fields. The list is read from the module's syntax
    # tree, so the check does not depend on how the formatter lays the
    # entries out.
    entries = _agents_list_entries(_load("test_ui_demo.py"))
    assert len(entries) > 0, "no agent entries parsed from AGENTS list"
    for entry in entries:
        agent_type = entry.get(AGENT_TYPE_KEY)
        client_type = entry.get(CLIENT_TYPE_KEY)
        assert agent_type is not None, f"entry lacks {AGENT_TYPE_KEY}: {entry!r}"
        assert client_type is not None, (
            f"entry lacks {CLIENT_TYPE_KEY} -- conftest default of "
            f"flightdeck_sensor would apply, which is the "
            f"anti-pattern this test guards against: {entry!r}"
        )
        assert client_type in ALLOWED_PAIRS, (
            f"unknown {CLIENT_TYPE_KEY}={client_type!r} in AGENTS entry: {entry!r}"
        )
        assert agent_type in ALLOWED_PAIRS[client_type], (
            f"illegal pairing {AGENT_TYPE_KEY}={agent_type!r} + "
            f"{CLIENT_TYPE_KEY}={client_type!r} in AGENTS entry: {entry!r}. "
            f"Canonical pairs: {ALLOWED_PAIRS!r}."
        )


def _coding_emit_sites(source: str) -> list[tuple[int, str | None]]:
    """Every ``agent_type="coding"`` emit site in ``source`` with the
    ``client_type`` declared alongside it.

    A site is a call keyword (``make_event(..., agent_type="coding")``)
    or a dict-literal entry (``{"agent_type": "coding"}``). The paired
    value is the literal ``client_type`` in the same call or dict, or
    None when it is absent or not a string literal. Reading the syntax
    tree skips comments and docstrings and does not depend on how the
    formatter lays the call out.
    """

    def _literal(node: ast.expr | None) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    sites: list[tuple[int, str | None]] = []
    for node in ast.walk(ast.parse(source)):
        fields: dict[str, ast.expr]
        if isinstance(node, ast.Call):
            fields = {kw.arg: kw.value for kw in node.keywords if kw.arg is not None}
        elif isinstance(node, ast.Dict):
            fields = {
                key.value: value
                for key, value in zip(node.keys, node.values, strict=True)
                if isinstance(key, ast.Constant) and isinstance(key.value, str)
            }
        else:
            continue
        if _literal(fields.get(AGENT_TYPE_KEY)) == CODING_AGENT_TYPE:
            sites.append((node.lineno, _literal(fields.get(CLIENT_TYPE_KEY))))
    return sites


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
    anomalous pair). Every keyword-arg or dict-literal emit site is
    read from the module's syntax tree and must declare
    ``client_type="claude_code"`` in the same call or dict literal.
    """
    for lineno, client_type in _coding_emit_sites(_load(relative_path)):
        assert client_type == CLAUDE_CODE_CLIENT_TYPE, (
            f'{relative_path}:{lineno}: ``{AGENT_TYPE_KEY}="{CODING_AGENT_TYPE}"`` '
            f'emitted without an explicit ``{CLIENT_TYPE_KEY}="{CLAUDE_CODE_CLIENT_TYPE}"`` '
            f"in the same call or dict literal. Under conftest's defaults this "
            f"produces the anomaly (agent_type=coding + client_type=flightdeck_sensor). "
            f'Fix: pass {CLIENT_TYPE_KEY}="{CLAUDE_CODE_CLIENT_TYPE}" on the make_event call.'
        )
