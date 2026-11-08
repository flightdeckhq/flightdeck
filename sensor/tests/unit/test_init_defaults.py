"""``init()`` with no arguments: server and token defaults and the
loopback gate on the dev token.

Resolution per value is kwarg, then environment variable, then default.
The token default (``tok_dev``) applies only when the server was
defaulted too and its host is loopback; a server the caller chose
without a token raises. Both the scrubbed-environment and the
environment-set cases are exercised so a shell that exports
``FLIGHTDECK_SERVER`` / ``FLIGHTDECK_TOKEN`` (dev loop, release
workflow) proves override precedence rather than masking it.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import TYPE_CHECKING

import pytest

import flightdeck_sensor
from flightdeck_sensor import config as _env
from flightdeck_sensor.core.exceptions import ConfigurationError

if TYPE_CHECKING:
    from collections.abc import Iterator

_SCRUB = (
    "FLIGHTDECK_SERVER",
    "FLIGHTDECK_TOKEN",
    "FLIGHTDECK_API_URL",
    "FLIGHTDECK_CAPTURE_TOOL_INPUTS",
    "FLIGHTDECK_ALLOW_INSECURE_TRANSPORT",
)


@contextmanager
def _clean_env() -> Iterator[None]:
    saved = {k: os.environ.get(k) for k in _SCRUB}
    for k in _SCRUB:
        os.environ.pop(k, None)
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@pytest.fixture(autouse=True)
def _no_session(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Every test starts without a sensor singleton and never opens a
    socket: ``Session.start`` is stubbed, and ``teardown`` runs after."""
    flightdeck_sensor.teardown()
    monkeypatch.setattr("flightdeck_sensor.core.session.Session.start", lambda self: None)
    yield
    flightdeck_sensor.teardown()


def _config() -> flightdeck_sensor.SensorConfig:
    assert flightdeck_sensor._session is not None
    return flightdeck_sensor._session.config


def _dev_token_warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING and "local dev token" in r.getMessage()
    ]


# ---------------------------------------------------------------------
# Defaults, environment scrubbed
# ---------------------------------------------------------------------


def test_no_args_resolves_localhost_and_dev_token_with_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        flightdeck_sensor.init(quiet=True)
    cfg = _config()
    assert cfg.server == "http://localhost:4000/ingest"
    assert cfg.token == "tok_dev"
    assert cfg.api_url == "http://localhost:4000/api"
    warnings = _dev_token_warnings(caplog)
    assert len(warnings) == 1, warnings
    assert "tok_dev" in warnings[0]
    assert "FLIGHTDECK_TOKEN" in warnings[0]
    assert "http://localhost:4000/ingest" in warnings[0]


def test_defaults_match_the_config_constants() -> None:
    assert _env.DEFAULT_SERVER == "http://localhost:4000/ingest"
    assert _env.DEFAULT_DEV_TOKEN == "tok_dev"


def test_explicit_server_without_token_raises_naming_env_vars() -> None:
    with _clean_env(), pytest.raises(ConfigurationError) as exc_info:
        flightdeck_sensor.init(server="https://flightdeck.example.com/ingest", quiet=True)
    message = str(exc_info.value)
    assert "FLIGHTDECK_TOKEN" in message
    assert "https://flightdeck.example.com/ingest" in message
    assert "server= kwarg" in message
    assert flightdeck_sensor._session is None


def test_configuration_error_is_a_value_error() -> None:
    with _clean_env(), pytest.raises(ValueError):
        flightdeck_sensor.init(server="https://flightdeck.example.com/ingest", quiet=True)


@pytest.mark.parametrize(
    "server",
    [
        "http://localhost:4000/ingest",
        "http://127.0.0.1:4000",
        "http://[::1]:4000/ingest",
    ],
)
def test_explicit_loopback_server_without_token_still_raises(server: str) -> None:
    """The dev token is for the default server only: a caller who chose
    a server, loopback included, must choose the token."""
    with _clean_env(), pytest.raises(ConfigurationError, match="FLIGHTDECK_TOKEN"):
        flightdeck_sensor.init(server=server, quiet=True)


def test_explicit_token_with_default_server_does_not_warn(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        flightdeck_sensor.init(token="ftd_explicit", quiet=True)
    cfg = _config()
    assert cfg.server == "http://localhost:4000/ingest"
    assert cfg.token == "ftd_explicit"
    assert _dev_token_warnings(caplog) == []


def test_empty_token_kwarg_is_an_error_not_a_default() -> None:
    with _clean_env(), pytest.raises(ConfigurationError, match="token is required"):
        flightdeck_sensor.init(token="", quiet=True)


def test_empty_server_kwarg_is_still_an_error() -> None:
    with _clean_env(), pytest.raises(ConfigurationError, match="server URL is required"):
        flightdeck_sensor.init(server="", token="tok", quiet=True)


# ---------------------------------------------------------------------
# Environment variables: fill a missing kwarg and override a passed one
# ---------------------------------------------------------------------


def test_env_token_with_default_server(caplog: pytest.LogCaptureFixture) -> None:
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        os.environ["FLIGHTDECK_TOKEN"] = "ftd_from_env"
        flightdeck_sensor.init(quiet=True)
    cfg = _config()
    assert cfg.server == "http://localhost:4000/ingest"
    assert cfg.token == "ftd_from_env"
    assert _dev_token_warnings(caplog) == []


def test_env_server_without_any_token_raises_naming_env_source() -> None:
    """A server from the environment is a chosen server too; no dev
    token for it, and the error says where the server came from."""
    with _clean_env(), pytest.raises(ConfigurationError) as exc_info:
        os.environ["FLIGHTDECK_SERVER"] = "https://flightdeck.example.com"
        flightdeck_sensor.init(quiet=True)
    message = str(exc_info.value)
    assert "FLIGHTDECK_SERVER environment variable" in message
    assert "FLIGHTDECK_TOKEN" in message


def test_env_server_on_loopback_without_token_raises() -> None:
    with _clean_env(), pytest.raises(ConfigurationError, match="FLIGHTDECK_TOKEN"):
        os.environ["FLIGHTDECK_SERVER"] = "http://localhost:4000"
        flightdeck_sensor.init(quiet=True)


def test_env_server_and_env_token_with_no_args() -> None:
    with _clean_env():
        os.environ["FLIGHTDECK_SERVER"] = "http://localhost:4100"
        os.environ["FLIGHTDECK_TOKEN"] = "ftd_env"
        flightdeck_sensor.init(quiet=True)
    cfg = _config()
    assert cfg.server == "http://localhost:4100/ingest"
    assert cfg.token == "ftd_env"


def test_env_overrides_both_kwargs(caplog: pytest.LogCaptureFixture) -> None:
    """The documented rule: the environment wins over a passed kwarg,
    with the server override warned about by name."""
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        os.environ["FLIGHTDECK_SERVER"] = "http://localhost:5000/ingest"
        os.environ["FLIGHTDECK_TOKEN"] = "ftd_env_wins"
        flightdeck_sensor.init(
            server="http://localhost:9999/ingest",
            token="ftd_kwarg_loses",
            quiet=True,
        )
    cfg = _config()
    assert cfg.server == "http://localhost:5000/ingest"
    assert cfg.token == "ftd_env_wins"
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "localhost:5000" in joined and "localhost:9999" in joined
    assert _dev_token_warnings(caplog) == []


def test_empty_env_token_does_not_fall_through_to_dev_token() -> None:
    """``FLIGHTDECK_TOKEN=""`` is a blank token, not an absent one."""
    with _clean_env(), pytest.raises(ConfigurationError, match="token is required"):
        os.environ["FLIGHTDECK_TOKEN"] = ""
        flightdeck_sensor.init(quiet=True)


# ---------------------------------------------------------------------
# ``/ingest`` normalisation is unchanged for the defaulted and env paths
# ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("env_server", "expected"),
    [
        ("http://localhost:4000", "http://localhost:4000/ingest"),
        ("http://localhost:4000/", "http://localhost:4000/ingest"),
        ("http://localhost:4000/ingest", "http://localhost:4000/ingest"),
        ("http://localhost:4000/ingest/", "http://localhost:4000/ingest/"),
    ],
)
def test_env_server_ingest_suffix_normalisation(env_server: str, expected: str) -> None:
    with _clean_env():
        os.environ["FLIGHTDECK_SERVER"] = env_server
        os.environ["FLIGHTDECK_TOKEN"] = "tok"
        flightdeck_sensor.init(quiet=True)
    assert _config().server == expected


# ---------------------------------------------------------------------
# Loopback detection
# ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:4000/ingest",
        "http://LOCALHOST:4000",
        "http://dev.localhost:4000",
        "http://127.0.0.1:4000/ingest",
        "http://127.1.2.3:4000",
        "http://[::1]:4000/ingest",
        "http://[::ffff:127.0.0.1]:4000",
    ],
)
def test_is_loopback_server_true(url: str) -> None:
    assert flightdeck_sensor._is_loopback_server(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "https://flightdeck.example.com/ingest",
        "http://flightdeck.internal:4000",
        "http://10.0.0.5:4000/ingest",
        "http://192.168.1.10:4000",
        "http://[fd00::1]:4000",
        "http://8.8.8.8:4000",
        "not a url",
        "",
    ],
)
def test_is_loopback_server_false(url: str) -> None:
    assert flightdeck_sensor._is_loopback_server(url) is False


def test_dev_token_never_defaults_for_non_loopback_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defensive: if the default server constant were ever pointed at a
    non-loopback host, the dev token must not follow it."""
    monkeypatch.setattr(_env, "DEFAULT_SERVER", "https://flightdeck.example.com/ingest")
    with _clean_env(), pytest.raises(ConfigurationError, match="FLIGHTDECK_TOKEN"):
        flightdeck_sensor.init(quiet=True)
