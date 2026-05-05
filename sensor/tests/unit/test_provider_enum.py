"""Tests for the :class:`flightdeck_sensor.Provider` enum (D125).

Covers the enum-as-canonical-API decision:

* The enum has exactly four members and each member's value matches
  the string the ``patch()`` body branches against. This is the
  regression guard against enum drift vs interceptor branch drift.
* Every member IS a string (``Provider.ANTHROPIC == "anthropic"``
  evaluates ``True``) so the enum and string paths are equivalent.
* ``patch()`` accepts ``list[Provider]``, ``list[str]``, and mixed
  lists. The string path is the backward-compat contract; the
  enum path is the canonical going-forward API; the mixed path
  matters for callers mid-migration.
* Unknown raw strings are silently ignored (no
  ``ConfigurationError``) -- preserved verbatim from the
  pre-D125 string-only contract.

The file does NOT migrate the existing ``test_patch.py`` away from
strings -- those tests are the backward-compat proof that strings
keep working. New coverage lives here.

Filename ``test_provider_enum.py`` rather than ``test_providers.py``
because the existing ``test_providers.py`` covers the unrelated
payload-extraction Provider classes (``AnthropicProvider`` /
``OpenAIProvider``); these are tests for the public API enum.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch as mock_patch

import pytest

import flightdeck_sensor
from flightdeck_sensor import Provider


@pytest.fixture(autouse=True)
def _reset_sensor() -> None:
    """Each test gets a clean sensor session. ``patch()`` requires
    a live session, so we init one here, run the test, and tear down
    afterwards. The patch-side mocks below replace the actual
    interceptor entry points so no real SDK class is mutated.
    """
    flightdeck_sensor.teardown()
    flightdeck_sensor.init(
        server="http://localhost:4000/ingest",
        token="tok_test",
        quiet=True,
    )
    yield
    flightdeck_sensor.teardown()


# ---------------------------------------------------------------------
# Enum shape
# ---------------------------------------------------------------------


def test_provider_has_exactly_six_members() -> None:
    """Adding a new interceptor target requires editing the enum AND
    a new branch in ``patch()``; this test ensures one doesn't drift
    without the other (the test in
    ``test_provider_values_match_patch_branches`` catches the
    value-side drift; this one catches the count-side).

    D126 added two sub-agent targets (CREWAI, LANGGRAPH). AutoGen
    support is on the Roadmap and ships in a future PR alongside
    LLM-call interception for it.
    """
    assert set(Provider) == {
        Provider.ANTHROPIC,
        Provider.OPENAI,
        Provider.LITELLM,
        Provider.MCP,
        Provider.CREWAI,
        Provider.LANGGRAPH,
    }
    assert len(Provider) == 6


def test_provider_values_match_patch_branches() -> None:
    """Each member's string value matches what ``patch()`` checks for
    internally. Adding a new interceptor target means adding a new
    member here; this test fails if the enum and the branches drift
    apart."""
    assert Provider.ANTHROPIC.value == "anthropic"
    assert Provider.OPENAI.value == "openai"
    assert Provider.LITELLM.value == "litellm"
    assert Provider.MCP.value == "mcp"
    # D126 sub-agent targets.
    assert Provider.CREWAI.value == "crewai"
    assert Provider.LANGGRAPH.value == "langgraph"


def test_provider_member_is_a_string() -> None:
    """``(str, Enum)`` mixin makes every member IS-A str, so existing
    code that treats the value as a string keeps working when an
    enum member is passed in its place."""
    assert isinstance(Provider.ANTHROPIC, str)
    assert Provider.ANTHROPIC == "anthropic"
    assert "anthropic" == Provider.ANTHROPIC
    # Hash equivalence is what makes ``"anthropic" in
    # {Provider.ANTHROPIC}`` work without explicit normalisation.
    assert hash(Provider.ANTHROPIC) == hash("anthropic")


# ---------------------------------------------------------------------
# patch() argument acceptance
# ---------------------------------------------------------------------


def _patched_branches() -> dict[str, MagicMock]:
    """Open patches on every interceptor entry-point function so
    tests can assert which branches fired without mutating real SDK
    classes. The caller wraps the dict in a ``with`` block via
    ``contextlib.ExitStack`` to enter all four mocks at once.
    """
    return {
        "anthropic": mock_patch(
            "flightdeck_sensor.patch_anthropic_classes",
        ),
        "openai": mock_patch(
            "flightdeck_sensor.patch_openai_classes",
        ),
        "litellm": mock_patch(
            "flightdeck_sensor.patch_litellm_functions",
        ),
        "mcp": mock_patch(
            "flightdeck_sensor.patch_mcp_classes",
        ),
    }


def _enter_all(branches: dict[str, MagicMock]) -> dict[str, MagicMock]:
    """Enter every context manager and return the resulting mocks
    keyed by canonical provider name."""
    return {name: ctx.__enter__() for name, ctx in branches.items()}


def _exit_all(branches: dict[str, MagicMock]) -> None:
    for ctx in branches.values():
        ctx.__exit__(None, None, None)


def test_patch_accepts_list_of_provider_enum() -> None:
    """Canonical enum-based call shape: ``patch(providers=[Provider.X,
    Provider.Y])`` calls the right interceptor branches and skips the
    others."""
    branches = _patched_branches()
    mocks = _enter_all(branches)
    try:
        flightdeck_sensor.patch(
            providers=[Provider.ANTHROPIC, Provider.MCP],
            quiet=True,
        )
    finally:
        _exit_all(branches)
    assert mocks["anthropic"].called
    assert mocks["mcp"].called
    assert not mocks["openai"].called
    assert not mocks["litellm"].called


def test_patch_accepts_list_of_str_backward_compat() -> None:
    """Backward-compat: existing user code that wrote
    ``patch(providers=["anthropic", "openai"])`` keeps working
    unchanged. The behavior is bit-for-bit identical to the
    enum-based call."""
    branches = _patched_branches()
    mocks = _enter_all(branches)
    try:
        flightdeck_sensor.patch(
            providers=["anthropic", "openai"],
            quiet=True,
        )
    finally:
        _exit_all(branches)
    assert mocks["anthropic"].called
    assert mocks["openai"].called
    assert not mocks["litellm"].called
    assert not mocks["mcp"].called


def test_patch_accepts_mixed_provider_and_str_list() -> None:
    """Operators mid-migration shouldn't have to choose -- a list of
    mixed enum members and raw strings is a fully-supported call
    shape."""
    branches = _patched_branches()
    mocks = _enter_all(branches)
    try:
        flightdeck_sensor.patch(
            providers=[Provider.ANTHROPIC, "openai", Provider.MCP],
            quiet=True,
        )
    finally:
        _exit_all(branches)
    assert mocks["anthropic"].called
    assert mocks["openai"].called
    assert mocks["mcp"].called
    assert not mocks["litellm"].called


def test_patch_default_none_patches_every_provider() -> None:
    """``providers=None`` (the default) patches every member of
    ``Provider``. The enum is the single source of truth for the
    default set."""
    branches = _patched_branches()
    mocks = _enter_all(branches)
    try:
        flightdeck_sensor.patch(quiet=True)
    finally:
        _exit_all(branches)
    assert mocks["anthropic"].called
    assert mocks["openai"].called
    assert mocks["litellm"].called
    assert mocks["mcp"].called


def test_patch_unknown_string_is_silently_ignored() -> None:
    """Backward-compat: pre-D125 ``patch()`` silently no-op'd on
    unknown provider strings. The enum doesn't tighten this -- a
    typo or a stale provider name still produces no patch and no
    raise. Validating would be a behavior change; users with stale
    string lists shouldn't see a sudden error on a sensor upgrade.

    A future tightening to raise ConfigurationError on unknown
    strings is out of scope for D125 and would warrant its own
    decision entry.
    """
    branches = _patched_branches()
    mocks = _enter_all(branches)
    try:
        # No raise; no branches fire either since the only entry is
        # unknown.
        flightdeck_sensor.patch(providers=["definitely-not-real"], quiet=True)
    finally:
        _exit_all(branches)
    assert not mocks["anthropic"].called
    assert not mocks["openai"].called
    assert not mocks["litellm"].called
    assert not mocks["mcp"].called


def test_provider_importable_from_top_level() -> None:
    """``from flightdeck_sensor import Provider`` resolves; ``Provider``
    is in ``__all__``. Public-API surface lock."""
    import flightdeck_sensor as fd
    assert hasattr(fd, "Provider")
    assert fd.Provider is Provider
    assert "Provider" in fd.__all__
