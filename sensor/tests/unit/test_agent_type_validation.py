"""Unit tests for the D114 / D115 agent_type vocabulary lock at
``flightdeck_sensor.init``.

The sensor raises ConfigurationError for any value outside
{``coding``, ``production``} -- pre-v0.4.0 values (``autonomous``,
``supervised``, ``batch``, ``developer``) are a breaking change
documented in CHANGELOG.md.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

import pytest

import flightdeck_sensor
from flightdeck_sensor import ConfigurationError


@contextmanager
def _clean_env() -> Iterator[None]:
    """Strip every FLIGHTDECK_* / AGENT_* env var for the duration of
    the test so stale shell state cannot interfere with the invalid-
    input assertions. On exit, pops every matching key the test may
    have added AND restores whatever was there at entry -- the test
    must not leak env mutations into sibling tests.
    """
    saved = {
        k: v
        for k, v in os.environ.items()
        if k.startswith(("FLIGHTDECK_", "AGENT_"))
    }
    for k in list(saved):
        os.environ.pop(k, None)
    try:
        yield
    finally:
        # Strip anything the test added (including keys that were
        # not in `saved`) and then restore the original snapshot.
        for k in [
            k for k in os.environ
            if k.startswith(("FLIGHTDECK_", "AGENT_"))
        ]:
            os.environ.pop(k, None)
        os.environ.update(saved)


@contextmanager
def _no_session() -> Iterator[None]:
    """Reset the module-global _session so successful inits in later
    tests aren't blocked by a sticky singleton from an earlier test.
    Teardown calls teardown() if we accidentally landed a session.
    """
    flightdeck_sensor._session = None
    flightdeck_sensor._client = None
    try:
        yield
    finally:
        if flightdeck_sensor._session is not None:
            try:
                flightdeck_sensor.teardown()
            except Exception:
                flightdeck_sensor._session = None
                flightdeck_sensor._client = None


@pytest.mark.parametrize(
    "bad_value",
    # Empty string is intentionally excluded: the resolver treats "" as
    # "unset" and falls through to the default "production", matching
    # the standard ``x or default`` idiom used across init() for every
    # env-backed knob.
    ["autonomous", "supervised", "batch", "developer", "CODING", "random"],
)
def test_init_raises_on_invalid_agent_type(bad_value: str) -> None:
    with _clean_env(), _no_session():
        with pytest.raises(ConfigurationError) as exc:
            flightdeck_sensor.init(
                server="http://localhost:9999/ingest",
                token="tok_dev",
                agent_type=bad_value,
                quiet=True,
            )
        assert "agent_type" in str(exc.value)


def test_init_raises_on_invalid_env_agent_type() -> None:
    # Env-var wins precedence over kwarg default; an invalid env value
    # should raise even when the caller didn't set the kwarg.
    with _clean_env(), _no_session():
        os.environ["FLIGHTDECK_AGENT_TYPE"] = "batch"
        with pytest.raises(ConfigurationError):
            flightdeck_sensor.init(
                server="http://localhost:9999/ingest",
                token="tok_dev",
                quiet=True,
            )


@pytest.mark.parametrize("good_value", ["coding", "production"])
def test_init_accepts_locked_vocabulary(good_value: str, monkeypatch) -> None:
    with _clean_env(), _no_session():
        # Prevent the session_start POST from actually firing against
        # a live stack -- we only care that init() resolves identity
        # without raising. Patch Session.start to a no-op.
        monkeypatch.setattr(
            "flightdeck_sensor.core.session.Session.start",
            lambda self: None,
        )
        flightdeck_sensor.init(
            server="http://localhost:9999/ingest",
            token="tok_dev",
            agent_type=good_value,
            quiet=True,
        )
        cfg = flightdeck_sensor._session.config  # type: ignore[union-attr]
        assert cfg.agent_type == good_value
        assert cfg.client_type == "flightdeck_sensor"
        # agent_id is deterministic from the identity tuple; must
        # always be a canonical UUID string.
        assert len(cfg.agent_id) == 36
        assert cfg.agent_id.count("-") == 4
