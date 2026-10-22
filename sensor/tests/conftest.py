"""Shared test fixtures for flightdeck-sensor unit tests."""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

# litellm fetches its model-cost map from GitHub when it is imported
# unless told to use the bundled copy; the unit suite must not touch
# the network (nor stall on DNS). Set before any test module imports it.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")


def _sdk_uses_httpx2() -> bool:
    """Whether an installed provider SDK is built on ``httpx2`` (anthropic
    2.x, openai 3.x) rather than ``httpx``."""
    from importlib import metadata

    for dist in ("anthropic", "openai"):
        try:
            requires = metadata.requires(dist) or []
        except metadata.PackageNotFoundError:
            continue
        if any(req.split(";")[0].strip().startswith("httpx2") for req in requires):
            return True
    return False


# The tests mock provider traffic with respx and ``httpx.MockTransport``.
# SDKs built on ``httpx2`` reject an ``httpx`` client and are invisible
# to respx, so make ``import httpx`` resolve to ``httpx2`` before anything
# imports it; on SDKs still built on ``httpx`` nothing changes.
if _sdk_uses_httpx2():
    import httpx2

    httpx2.alias_httpx()

from flightdeck_sensor.core.types import SensorConfig  # noqa: E402
from flightdeck_sensor.providers.anthropic import AnthropicProvider  # noqa: E402
from flightdeck_sensor.transport.client import ControlPlaneClient  # noqa: E402

if TYPE_CHECKING:
    from collections.abc import Generator


# Hosts a unit test may connect to: the in-process control-plane stubs.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse every connection that leaves the machine. A provider mock
    that stops matching (an SDK moving to a new HTTP library, a changed
    route) must fail the test, not send a request to the real API."""
    import socket

    real_connect = socket.socket.connect

    def _connect(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and host not in _LOOPBACK_HOSTS:
            raise ConnectionRefusedError(f"unit tests may not connect to {address!r}")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", _connect)


@pytest.fixture(autouse=True)
def _no_ambient_provider_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests never reach a provider. Strip the API keys a developer's
    shell may carry and pin the Anthropic estimator's client to a stub
    whose ``count_tokens`` raises, so whatever the environment carries the
    estimate falls back to the heuristic and no request leaves the
    process."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)

    def _refuse(**_kwargs: Any) -> None:
        # A fresh exception on every call: a single shared instance would
        # keep the traceback, and with it the whole call stack, of the
        # latest call alive, pinning objects a test expects to be
        # collected (a response proxy abandoned inside an SDK context
        # manager, for one).
        raise RuntimeError("unit tests never count tokens remotely")

    refusing = MagicMock()
    refusing.messages.count_tokens.side_effect = _refuse
    monkeypatch.setattr(AnthropicProvider, "_client", refusing)


class _MockHandler(BaseHTTPRequestHandler):
    """Records POSTs and returns configurable responses."""

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        srv: Any = self.server
        srv.recorded_requests.append(
            {"path": self.path, "body": json.loads(body) if body else None}
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(srv.response_body).encode())

    def do_GET(self) -> None:
        srv: Any = self.server
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(srv.response_body).encode())

    def log_message(self, *_args: Any) -> None:
        pass


@pytest.fixture()
def mock_control_plane() -> Generator[dict[str, Any], None, None]:
    """Start a local HTTP server that records POSTs."""
    server: Any = HTTPServer(("127.0.0.1", 0), _MockHandler)
    server.recorded_requests = []
    server.response_body = {"status": "ok", "directive": None}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    addr = server.server_address
    yield {
        "server": server,
        "url": f"http://{addr[0]}:{addr[1]}",
        "requests": server.recorded_requests,
        "set_response": lambda r: setattr(server, "response_body", r),
    }
    server.shutdown()


@pytest.fixture()
def sensor_config() -> SensorConfig:
    """Return a SensorConfig with test defaults."""
    return SensorConfig(
        server="http://localhost:9999",
        token="test-token",
        agent_flavor="test-agent",
        agent_type="production",
        quiet=True,
    )


@pytest.fixture()
def mock_client(mock_control_plane: dict[str, Any]) -> ControlPlaneClient:
    """Return a ControlPlaneClient pointed at the mock server."""
    return ControlPlaneClient(
        server=mock_control_plane["url"],
        token="test-token",
        unavailable_policy="continue",
    )


class MockUsage:
    """Simple usage object with concrete int values."""

    def __init__(self, **kwargs: int) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


class MockResponse:
    """Simple response object with usage and model. Iterable for streaming mocks."""

    def __init__(self, usage: MockUsage, model: str, chunks: list[str] | None = None) -> None:
        self.usage = usage
        self.model = model
        self._chunks = chunks or []

    def __iter__(self) -> Any:
        return iter(self._chunks)


@pytest.fixture()
def mock_anthropic_response() -> MockResponse:
    """Mock Anthropic Message response with usage."""
    return MockResponse(
        usage=MockUsage(
            input_tokens=100,
            output_tokens=50,
            cache_read_input_tokens=10,
            cache_creation_input_tokens=5,
        ),
        model="claude-sonnet-4-20250514",
    )


@pytest.fixture()
def mock_openai_response() -> MockResponse:
    """Mock OpenAI ChatCompletion response with usage."""
    return MockResponse(
        usage=MockUsage(prompt_tokens=120, completion_tokens=60),
        model="gpt-4o",
    )
