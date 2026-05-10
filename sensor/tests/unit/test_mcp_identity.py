"""Unit tests for ``flightdeck_sensor.interceptor.mcp_identity``.

Loads the cross-language fixture vectors at
``tests/fixtures/mcp_identity_vectors.json`` and asserts the Python
implementation produces byte-identical output for every vector. The
Node twin (``plugin/tests/mcp_identity.test.mjs``) loads the same
fixture; drift between the two surfaces fails one job loudly in CI.

Plus standalone tests for edge cases not in fixtures: empty inputs,
Unicode in name, type errors. See DECISIONS.md D127.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flightdeck_sensor.interceptor.mcp_identity import (
    canonicalize_url,
    fingerprint,
    fingerprint_short,
)

# Locate the cross-language fixture file. The test runs from
# ``sensor/`` with cwd set there by pytest, so traverse up to the
# repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_VECTORS_PATH = _REPO_ROOT / "tests" / "fixtures" / "mcp_identity_vectors.json"


def _load_vectors() -> dict:
    with open(_VECTORS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


_VECTORS_DOC = _load_vectors()
_VECTORS = _VECTORS_DOC["vectors"]


@pytest.fixture(autouse=True)
def _set_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the env vars the env-var-resolution vectors expect, and
    explicitly unset the missing-var vector's variable so the
    "stays literal" assertion is deterministic."""
    for key, val in _VECTORS_DOC["env_overrides"].items():
        monkeypatch.setenv(key, val)
    monkeypatch.delenv("FLIGHTDECK_TEST_MISSING", raising=False)


@pytest.mark.parametrize("vec", _VECTORS, ids=lambda v: v["id"])
def test_canonicalize_url_matches_vector(vec: dict) -> None:
    """``canonicalize_url`` produces the exact canonical form the
    fixture declares."""
    assert canonicalize_url(vec["raw_url"]) == vec["canonical_url"]


@pytest.mark.parametrize("vec", _VECTORS, ids=lambda v: v["id"])
def test_fingerprint_full_matches_vector(vec: dict) -> None:
    """``fingerprint`` produces the exact 64-char hex hash the
    fixture declares."""
    assert fingerprint(vec["canonical_url"], vec["name"]) == vec["fingerprint_full"]


@pytest.mark.parametrize("vec", _VECTORS, ids=lambda v: v["id"])
def test_fingerprint_short_matches_vector(vec: dict) -> None:
    """``fingerprint_short`` produces the exact 16-char hex display
    fingerprint the fixture declares."""
    assert fingerprint_short(vec["canonical_url"], vec["name"]) == vec["fingerprint_short"]


# ----- Standalone edge cases ----------------------------------------


def test_canonicalize_empty_string_is_stdio_empty() -> None:
    """An empty input is treated as stdio with an empty body."""
    assert canonicalize_url("") == "stdio://"


def test_canonicalize_whitespace_only_is_stdio_empty() -> None:
    """Whitespace-only input collapses to an empty stdio body."""
    assert canonicalize_url("   \t  \n ") == "stdio://"


def test_canonicalize_explicit_stdio_prefix() -> None:
    """Input that already carries the ``stdio://`` prefix is
    canonicalised as stdio without double-prefixing."""
    raw = "stdio://npx package"
    assert canonicalize_url(raw) == "stdio://npx package"


def test_fingerprint_separator_prevents_collision() -> None:
    """The 0x00 separator distinguishes
    (https://a.com, bservice) from (https://a.combservice, '').
    Without the separator both would hash the same string."""
    a = fingerprint("https://a.com", "bservice")
    b = fingerprint("https://a.combservice", "")
    assert a != b


def test_fingerprint_unicode_name() -> None:
    """Non-ASCII names hash deterministically — UTF-8 encoding of
    the concatenated payload is part of the contract."""
    canon = "https://example.com"
    one = fingerprint(canon, "ñame")
    two = fingerprint(canon, "ñame")
    assert one == two
    assert len(one) == 64


def test_fingerprint_short_is_prefix_of_full() -> None:
    """``fingerprint_short`` is the 16-char prefix of
    ``fingerprint`` for any input pair."""
    canon = "https://example.com/api"
    name = "test"
    assert fingerprint_short(canon, name) == fingerprint(canon, name)[:16]


def test_canonicalize_url_rejects_non_string() -> None:
    """Non-string input is a programming error; raise rather than
    silently converting."""
    with pytest.raises(TypeError):
        canonicalize_url(None)  # type: ignore[arg-type]


def test_fingerprint_rejects_non_string_canonical() -> None:
    with pytest.raises(TypeError):
        fingerprint(None, "name")  # type: ignore[arg-type]


def test_fingerprint_rejects_non_string_name() -> None:
    with pytest.raises(TypeError):
        fingerprint("https://example.com", None)  # type: ignore[arg-type]


def test_canonicalize_http_default_port_explicit_match() -> None:
    """Direct test of HTTP default-port stripping (mirrors fixture
    ``http-default-port-stripped`` but with http:// instead of
    https:// to lock both default ports)."""
    assert canonicalize_url("http://example.com:80/api") == "http://example.com/api"


def test_canonicalize_stdio_env_var_dollar_form() -> None:
    """The ``$VAR`` shape (no braces) resolves the same way as
    ``${VAR}``."""
    import os

    os.environ["FLIGHTDECK_TEST_DOLLAR_FORM"] = "/x"
    try:
        assert canonicalize_url("cmd $FLIGHTDECK_TEST_DOLLAR_FORM/data") == "stdio://cmd /x/data"
    finally:
        del os.environ["FLIGHTDECK_TEST_DOLLAR_FORM"]
