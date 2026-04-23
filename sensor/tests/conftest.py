"""Shared test fixtures for flightdeck-sensor unit tests."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Generator

import pytest

from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.transport.client import ControlPlaneClient


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

    def __init__(
        self, usage: MockUsage, model: str, chunks: list[str] | None = None
    ) -> None:
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
