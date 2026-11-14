"""``init()`` with no arguments: server and token defaults and the
loopback gate on the dev token.

Resolution per value is environment variable, then kwarg, then default.
The token default (``tok_dev``) applies only when the server was
defaulted too and its host is loopback; a server the caller chose
without a token raises. Both the scrubbed-environment and the
environment-set cases are exercised so a shell that exports
``FLIGHTDECK_SERVER`` / ``FLIGHTDECK_TOKEN`` (dev loop, release
workflow) proves override precedence rather than masking it.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

import flightdeck_sensor
from flightdeck_sensor import config as _env
from flightdeck_sensor.core.exceptions import ConfigurationError

if TYPE_CHECKING:
    from collections.abc import Iterator
    from types import ModuleType

# The server values the sensor, the Claude Code plugin and the
# playground resolve alike.
_SERVER_URL_CASES = Path(__file__).resolve().parents[3] / "contracts" / "server_urls.json"

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
# One server value for the sensor and the Claude Code plugin: the base
# URL and the ingestion URL resolve to the same ingestion and API URLs
# ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("env_server", "expected"),
    [
        ("http://localhost:4000", "http://localhost:4000/ingest"),
        ("http://localhost:4000/", "http://localhost:4000/ingest"),
        ("http://localhost:4000/ingest", "http://localhost:4000/ingest"),
        ("http://localhost:4000/ingest/", "http://localhost:4000/ingest"),
        ("  http://localhost:4000/ingest\n", "http://localhost:4000/ingest"),
    ],
)
def test_env_server_ingest_suffix_normalisation(env_server: str, expected: str) -> None:
    with _clean_env():
        os.environ["FLIGHTDECK_SERVER"] = env_server
        os.environ["FLIGHTDECK_TOKEN"] = "tok"
        flightdeck_sensor.init(quiet=True)
    assert _config().server == expected


def _server_url_cases() -> list[dict[str, str]]:
    """The cases the sensor, the Claude Code plugin and the playground
    each resolve to the same ingestion and API URLs."""
    doc = json.loads(_SERVER_URL_CASES.read_text())
    return doc["cases"]  # type: ignore[no-any-return]


@pytest.mark.parametrize("case", _server_url_cases(), ids=lambda c: c["why"])
def test_resolve_server_urls_matches_the_plugin(case: dict[str, str]) -> None:
    assert flightdeck_sensor._resolve_server_urls(case["value"]) == (case["ingest"], case["api"])


def _playground_helpers() -> ModuleType | None:
    """``playground/_helpers.py``, loaded by path, or None when this
    checkout has no playground (an installed sensor's tests)."""
    path = _SERVER_URL_CASES.parents[1] / "playground" / "_helpers.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location("_playground_helpers", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("case", _server_url_cases(), ids=lambda c: c["why"])
def test_the_playground_resolves_the_shared_cases_alike(case: dict[str, str]) -> None:
    """The playground keeps its own copy of the rule (its GenAI venvs
    import ``_helpers`` without the sensor); it must agree with the
    sensor and the plugin on every case."""
    helpers = _playground_helpers()
    if helpers is None:
        pytest.skip("no playground/_helpers.py in this checkout")
    assert helpers.server_urls(case["value"]) == (case["ingest"], case["api"])


@pytest.mark.parametrize(
    ("server", "stripped"),
    [
        (
            "https://user:hunter2@flightdeck.example.com/ingest",
            "https://flightdeck.example.com/ingest",
        ),
        ("https://a@b@flightdeck.example.com/x", "https://flightdeck.example.com/x"),
        ("user:tok_secret@127.0.0.1:4901", "127.0.0.1:4901"),
        # An @ outside the authority is not userinfo.
        ("https://good.example#@evil.example", "https://good.example#@evil.example"),
        (
            "https://fd.example.com?ref=me@corp.example",
            "https://fd.example.com?ref=me@corp.example",
        ),
        ("https://fd.example.com/fd@corp", "https://fd.example.com/fd@corp"),
        ("localhost:4000?x=a@b", "localhost:4000?x=a@b"),
        # A backslash ends an http(s) authority, as the URL standard reads it.
        ("https://good.example\\@evil.example/x", "https://good.example/@evil.example/x"),
    ],
)
def test_without_userinfo_reads_the_authority_only(server: str, stripped: str) -> None:
    assert flightdeck_sensor._without_userinfo(server) == stripped


def test_an_at_sign_after_the_host_is_not_credentials(caplog: pytest.LogCaptureFixture) -> None:
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        flightdeck_sensor.init(server="https://good.example#@evil.example", token="tok", quiet=True)
    cfg = _config()
    assert cfg.server == "https://good.example/ingest"
    assert cfg.api_url == "https://good.example/api"
    assert not any("carries credentials" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize(
    ("server", "resolved"),
    [
        # Not a URL the sensor can use; the egress validation refuses
        # it, so it only has to come back recognisable, and without
        # credentials.
        ("localhost:4000", "localhost:4000"),
        ("example.com/ingest", "example.com/ingest"),
        ("ftp://example.com/ingest", "ftp://example.com/ingest"),
        ("http://[::1", "http://[::1"),
        ("http://localhost:99999/ingest", "http://localhost:99999/ingest"),
        ("user:tok_secret@127.0.0.1:4901", "127.0.0.1:4901"),
    ],
)
def test_resolve_server_urls_leaves_a_value_it_cannot_use(server: str, resolved: str) -> None:
    assert flightdeck_sensor._resolve_server_urls(server) == (resolved, resolved)


def test_credentials_in_the_server_url_are_dropped_with_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        flightdeck_sensor.init(
            server="https://user:hunter2@flightdeck.example.com/ingest", token="tok", quiet=True
        )
    cfg = _config()
    assert cfg.server == "https://flightdeck.example.com/ingest"
    assert cfg.api_url == "https://flightdeck.example.com/api"
    messages = [r.getMessage() for r in caplog.records]
    assert any("carries credentials; they are ignored" in m for m in messages)
    assert not any("hunter2" in m for m in messages)


def test_a_missing_token_error_does_not_repeat_the_url_credentials() -> None:
    with _clean_env(), pytest.raises(ConfigurationError) as raised:
        flightdeck_sensor.init(server="https://user:hunter2@flightdeck.example.com", quiet=True)
    assert "hunter2" not in str(raised.value)
    assert "https://flightdeck.example.com" in str(raised.value)


def test_the_override_warning_does_not_repeat_url_credentials(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with _clean_env(), caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        os.environ["FLIGHTDECK_SERVER"] = "https://env:hunter2@a.example.com"
        flightdeck_sensor.init(server="https://kw:swordfish@b.example.com", token="tok", quiet=True)
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "overrides the server=" in messages
    assert "hunter2" not in messages and "swordfish" not in messages
    assert _config().server == "https://a.example.com/ingest"


def test_a_blank_server_is_still_an_error() -> None:
    with _clean_env(), pytest.raises(ConfigurationError, match="server URL is required"):
        os.environ["FLIGHTDECK_SERVER"] = "  "
        flightdeck_sensor.init(token="tok", quiet=True)


@pytest.mark.parametrize(
    "server",
    [
        "https://flightdeck.example.com",
        "https://flightdeck.example.com/",
        "https://flightdeck.example.com/ingest",
    ],
)
def test_base_and_ingestion_forms_reach_the_same_endpoints(server: str) -> None:
    with _clean_env():
        flightdeck_sensor.init(server=server, token="tok", quiet=True)
    cfg = _config()
    assert cfg.server == "https://flightdeck.example.com/ingest"
    assert cfg.api_url == "https://flightdeck.example.com/api"


def test_a_host_named_ingest_keeps_its_api_on_that_host() -> None:
    """``https://ingest.example.com`` used to be read as an ingestion URL
    (its ``//ingest`` matched the path check): no ``/ingest`` was added,
    and the API URL became ``https://api.example.com``, another host,
    which then received the access token."""
    with _clean_env():
        os.environ["FLIGHTDECK_SERVER"] = "https://ingest.example.com"
        os.environ["FLIGHTDECK_TOKEN"] = "tok"
        flightdeck_sensor.init(quiet=True)
    cfg = _config()
    assert cfg.server == "https://ingest.example.com/ingest"
    assert cfg.api_url == "https://ingest.example.com/api"


def test_api_url_override_still_wins_over_the_derived_one() -> None:
    with _clean_env():
        os.environ["FLIGHTDECK_API_URL"] = "https://api.internal.example.com"
        flightdeck_sensor.init(server="https://flightdeck.example.com", token="tok", quiet=True)
    assert _config().api_url == "https://api.internal.example.com"


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
