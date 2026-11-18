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
from tests.litellm_logging_worker import retire_litellm_logging_worker  # noqa: E402

if TYPE_CHECKING:
    from collections.abc import Generator, Iterator


@pytest.fixture(autouse=True)
def _litellm_logging_worker_retired() -> Iterator[None]:
    """After each test, retire litellm's global logging worker if the test
    left it bound to a closed event loop (a sync litellm call with
    ``fallbacks`` does, and so does an async one run with ``asyncio.run``),
    so the coroutines it held are dropped inside that
    test rather than in the next test to use litellm, which may be in a
    module that turns ``RuntimeWarning`` into an error (see
    ``tests/litellm_logging_worker.py``). Before litellm's worker module is
    imported this is one dictionary lookup."""
    yield
    retire_litellm_logging_worker()


# Hosts a unit test may connect to: the in-process control-plane stubs.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def _host_text(host: object) -> str | None:
    if isinstance(host, bytes):
        return host.decode("ascii", errors="replace")
    return host if isinstance(host, str) else None


def _is_loopback_name(host: object) -> bool:
    """``localhost`` (or a name under it) or a loopback address."""
    import ipaddress

    text = _host_text(host)
    if text is None:
        return False
    lowered = text.lower().rstrip(".")
    if lowered == "localhost" or lowered.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(lowered.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _resolves_without_dns(host: object) -> bool:
    """Whether a forward lookup of ``host`` stays on the machine: no host
    (a passive lookup for binding), a loopback name, or an address
    literal, which the resolver returns without asking anyone (connecting
    to it is refused separately unless it is loopback)."""
    import ipaddress

    if host is None or _is_loopback_name(host):
        return True
    text = _host_text(host)
    if text is None:
        return False
    try:
        ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return False
    return True


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Refuse every connection that leaves the machine, and every name
    lookup that would. A provider mock that stops matching (an SDK moving
    to a new HTTP library, a changed route) must fail the test, not send a
    request to the real API; and a lookup (a library fetching a tokenizer
    or a price list) must not leave the machine either. A refused lookup
    fails the test even when the code that made it catches the error and
    carries on."""
    import socket

    real_connect = socket.socket.connect

    def _connect(self: socket.socket, address: Any) -> Any:
        # Only internet sockets leave the machine; a Unix socket's address
        # is a path.
        if self.family in (socket.AF_INET, socket.AF_INET6):
            host = address[0] if isinstance(address, tuple) else address
            if host not in _LOOPBACK_HOSTS:
                raise ConnectionRefusedError(f"unit tests may not connect to {address!r}")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", _connect)

    refused: list[str] = []
    real_getaddrinfo = socket.getaddrinfo
    real_gethostbyname = socket.gethostbyname
    real_gethostbyname_ex = socket.gethostbyname_ex
    real_gethostbyaddr = socket.gethostbyaddr

    def _refuse(host: object) -> None:
        refused.append(repr(host))
        raise socket.gaierror(socket.EAI_NONAME, f"unit tests may not resolve {host!r}")

    def _getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if not _resolves_without_dns(host):
            _refuse(host)
        return real_getaddrinfo(host, *args, **kwargs)

    def _gethostbyname(host: Any) -> Any:
        if not _resolves_without_dns(host):
            _refuse(host)
        return real_gethostbyname(host)

    def _gethostbyname_ex(host: Any) -> Any:
        if not _resolves_without_dns(host):
            _refuse(host)
        return real_gethostbyname_ex(host)

    def _gethostbyaddr(host: Any) -> Any:
        # A reverse lookup asks a name server even for an address literal.
        if not _is_loopback_name(host):
            _refuse(host)
        return real_gethostbyaddr(host)

    monkeypatch.setattr(socket, "getaddrinfo", _getaddrinfo)
    monkeypatch.setattr(socket, "gethostbyname", _gethostbyname)
    monkeypatch.setattr(socket, "gethostbyname_ex", _gethostbyname_ex)
    monkeypatch.setattr(socket, "gethostbyaddr", _gethostbyaddr)
    yield
    if refused:
        pytest.fail(
            f"the test resolved names that leave the machine: {', '.join(sorted(set(refused)))}",
            pytrace=False,
        )


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
    # google-genai reads its key and its Vertex AI switch from these.
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"):
        monkeypatch.delenv(name, raising=False)

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
