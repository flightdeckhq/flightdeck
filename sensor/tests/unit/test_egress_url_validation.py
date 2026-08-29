"""H-01 — control-plane egress URL validation.

The sensor rejects non-HTTP(S) schemes outright and refuses plaintext
``http://`` to a non-local control plane unless the operator explicitly
opts in (``allow_insecure_transport`` / ``FLIGHTDECK_ALLOW_INSECURE_TRANSPORT``).
Local / loopback / private hosts are always allowed over http. When an
env var overrides an explicitly-passed ``server`` / ``api_url``, init()
warns naming both values (silent override is the vuln).
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import TYPE_CHECKING

import pytest

import flightdeck_sensor
from flightdeck_sensor.core.types import SensorConfig, validate_egress_url

if TYPE_CHECKING:
    from collections.abc import Iterator


@contextmanager
def _clean_env() -> Iterator[None]:
    saved = {k: v for k, v in os.environ.items() if k.startswith(("FLIGHTDECK_", "AGENT_"))}
    for k in list(saved):
        os.environ.pop(k, None)
    try:
        yield
    finally:
        for k in [k for k in os.environ if k.startswith(("FLIGHTDECK_", "AGENT_"))]:
            os.environ.pop(k, None)
        os.environ.update(saved)


@contextmanager
def _no_session() -> Iterator[None]:
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


# ------------------------------------------------------------------
# Helper-level (validate_egress_url) tests
# ------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com",
        "ws://example.com/ingest",
        "example.com/ingest",  # scheme-less
        "",  # empty
    ],
)
def test_rejects_non_http_schemes(url: str) -> None:
    with pytest.raises(ValueError, match="http:// or https://"):
        validate_egress_url(url, field_name="server")


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:9999/ingest",
        "http://localhost/ingest",
        "http://sub.localhost/ingest",
        "http://127.0.0.1:4000/ingest",
        "http://127.5.5.5/ingest",
        "http://10.0.0.4/ingest",
        "http://192.168.1.10:4000/ingest",
        "http://172.16.0.1/ingest",
        "http://[::1]/ingest",
    ],
)
def test_allows_http_for_local_and_private_hosts(url: str) -> None:
    # Must not raise.
    validate_egress_url(url, field_name="server")


@pytest.mark.parametrize(
    "url",
    [
        "http://stack.internal/ingest",
        "http://example.com/ingest",
        "http://8.8.8.8/ingest",
    ],
)
def test_rejects_http_for_non_local_host_without_optin(url: str) -> None:
    with pytest.raises(ValueError, match="insecure http"):
        validate_egress_url(url, field_name="server")


@pytest.mark.parametrize(
    "url",
    [
        "http://stack.internal/ingest",
        "http://example.com/ingest",
    ],
)
def test_allows_http_non_local_with_optin(url: str) -> None:
    validate_egress_url(url, field_name="server", allow_insecure_transport=True)


@pytest.mark.parametrize(
    "url",
    [
        "https://stack.internal/ingest",
        "https://example.com/ingest",
    ],
)
def test_allows_https_for_any_host(url: str) -> None:
    validate_egress_url(url, field_name="server")


# ------------------------------------------------------------------
# SensorConfig-level tests
# ------------------------------------------------------------------


def test_config_rejects_non_local_http_by_default() -> None:
    with pytest.raises(ValueError):
        SensorConfig(server="http://stack.internal/ingest", token="tok")


def test_config_allows_non_local_http_with_optin() -> None:
    cfg = SensorConfig(
        server="http://stack.internal/ingest",
        token="tok",
        allow_insecure_transport=True,
    )
    assert cfg.server == "http://stack.internal/ingest"


def test_config_validates_api_url_too() -> None:
    # server is https (fine) but api_url is a bad scheme → still rejected.
    with pytest.raises(ValueError, match="api_url"):
        SensorConfig(
            server="https://stack.internal/ingest",
            token="tok",
            api_url="ftp://stack.internal/api",
        )


def test_config_defaults_secure_transport_off() -> None:
    cfg = SensorConfig(server="https://x.example/ingest", token="tok")
    assert cfg.allow_insecure_transport is False


# ------------------------------------------------------------------
# init()-level tests
# ------------------------------------------------------------------


def test_init_rejects_non_local_http() -> None:
    with _clean_env(), _no_session(), pytest.raises(ValueError):
        flightdeck_sensor.init(
            server="http://stack.internal/ingest",
            token="tok",
            quiet=True,
        )


def test_init_env_flag_enables_insecure(monkeypatch: pytest.MonkeyPatch) -> None:
    with _clean_env(), _no_session():
        monkeypatch.setattr(
            "flightdeck_sensor.core.session.Session.start",
            lambda self: None,
        )
        os.environ["FLIGHTDECK_ALLOW_INSECURE_TRANSPORT"] = "true"
        flightdeck_sensor.init(
            server="http://stack.internal/ingest",
            token="tok",
            quiet=True,
        )
        assert flightdeck_sensor._session is not None
        assert flightdeck_sensor._session.config.allow_insecure_transport is True


def test_init_warns_on_env_server_override(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with _clean_env(), _no_session():
        monkeypatch.setattr(
            "flightdeck_sensor.core.session.Session.start",
            lambda self: None,
        )
        os.environ["FLIGHTDECK_SERVER"] = "http://localhost:5000/ingest"
        with caplog.at_level("WARNING"):
            flightdeck_sensor.init(
                server="http://localhost:9999/ingest",
                token="tok",
                quiet=True,
            )
        # Both the env value and the passed value are named in the warning.
        joined = "\n".join(r.getMessage() for r in caplog.records)
        assert "FLIGHTDECK_SERVER" in joined
        assert "localhost:5000" in joined
        assert "localhost:9999" in joined
        # Env precedence still holds.
        assert flightdeck_sensor._session is not None
        assert flightdeck_sensor._session.config.server == "http://localhost:5000/ingest"


def test_init_no_warn_when_env_matches_or_absent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with _clean_env(), _no_session():
        monkeypatch.setattr(
            "flightdeck_sensor.core.session.Session.start",
            lambda self: None,
        )
        with caplog.at_level("WARNING"):
            flightdeck_sensor.init(
                server="http://localhost:9999/ingest",
                token="tok",
                quiet=True,
            )
        joined = "\n".join(r.getMessage() for r in caplog.records)
        assert "overrides the server" not in joined
