"""Shared test fixtures for flightdeck-sensor unit tests."""

from __future__ import annotations

import errno
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
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

import flightdeck_sensor  # noqa: E402
from flightdeck_sensor.core.session import Session  # noqa: E402
from flightdeck_sensor.core.types import SensorConfig  # noqa: E402
from flightdeck_sensor.providers.anthropic import AnthropicProvider  # noqa: E402
from flightdeck_sensor.transport.client import ControlPlaneClient  # noqa: E402
from tests import network_guard  # noqa: E402
from tests.litellm_logging_worker import retire_litellm_logging_worker  # noqa: E402

if TYPE_CHECKING:
    from collections.abc import Generator, Iterator

# The session's own start, kept before any test module stubs it.
_REAL_SESSION_START = Session.start


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


# The running test's refused lookups while a test runs: the audit hook
# below, installed once for the whole process, reports into it.
_RUNNING_TEST_LOOKUPS: list[str] | None = None


def _record_for_the_running_test(kind: str, host: object) -> None:
    if kind == network_guard.LOOKUP and _RUNNING_TEST_LOOKUPS is not None:
        _RUNNING_TEST_LOOKUPS.append(repr(host))


sys.addaudithook(
    network_guard.audit_hook(
        _record_for_the_running_test, enabled=lambda: _RUNNING_TEST_LOOKUPS is not None
    )
)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The network guard (``tests/network_guard.py``) for each test:
    connections and datagrams only to loopback addresses, and name lookups
    only where they cannot leave the machine. A provider mock that stops
    matching (an SDK moving to a new HTTP library, a changed route) must
    fail the test, not send a request to the real API, and a lookup (a
    library fetching a tokenizer or a price list) must not leave the
    machine either. A refused lookup fails the test at its teardown, naming
    the host, even when the code that made it caught the error and carried
    on; a connection to an address off the machine is refused, as an
    unreachable server refuses it."""
    global _RUNNING_TEST_LOOKUPS
    refused: list[str] = []

    def _record(kind: str, host: object) -> None:
        if kind == network_guard.LOOKUP:
            refused.append(repr(host))

    for owner, name, replacement in network_guard.replacements(_record):
        monkeypatch.setattr(owner, name, replacement)
    _RUNNING_TEST_LOOKUPS = refused
    try:
        yield
    finally:
        _RUNNING_TEST_LOOKUPS = None
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


@dataclass(frozen=True)
class SentRequest:
    """One request urllib would have sent."""

    method: str
    url: urllib.parse.SplitResult
    headers: dict[str, str]


class ControlPlaneRequests:
    """The requests the sensor would have sent to its control plane, in
    the order it made them."""

    def __init__(self) -> None:
        self.sent: list[SentRequest] = []

    def to(self, method: str, path_end: str) -> list[SentRequest]:
        """The requests made with ``method`` whose path ends with ``path_end``."""
        return [r for r in self.sent if r.method == method and r.url.path.endswith(path_end)]

    def preflight_policy(self) -> SentRequest:
        """The policy fetch ``init()`` makes before the session starts:
        made at least once, and every attempt (a retry included) to the
        same URL with the same headers."""
        attempts = self.to("GET", "/v1/policy")
        assert attempts, f"no policy fetch among {[r.url.geturl() for r in self.sent]}"
        assert all(a == attempts[0] for a in attempts), attempts
        return attempts[0]


@pytest.fixture
def control_plane_requests(monkeypatch: pytest.MonkeyPatch) -> Iterator[ControlPlaneRequests]:
    """The sensor's control-plane traffic, stubbed at urllib's HTTP and
    HTTPS handlers, the layer below the request urllib builds: every
    request is recorded (method, URL, headers) and refused as an
    unreachable control plane refuses it, so the sensor fails open as it
    does then, and nothing is resolved or sent. The session's real start
    runs, its preflight requests included (a test module that stubs
    ``Session.start`` gets it back here), and the session is ended while
    the stub is in place, so its ``session_end`` is recorded too."""
    recorder = ControlPlaneRequests()

    def _refused(_handler: object, request: urllib.request.Request) -> Any:
        recorder.sent.append(
            SentRequest(
                request.get_method(),
                urllib.parse.urlsplit(request.full_url),
                dict(request.header_items()),
            )
        )
        raise urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "stubbed"))

    monkeypatch.setattr(urllib.request.HTTPHandler, "http_open", _refused)
    monkeypatch.setattr(urllib.request.HTTPSHandler, "https_open", _refused)
    monkeypatch.setattr(Session, "start", _REAL_SESSION_START)
    yield recorder
    flightdeck_sensor.teardown()


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
