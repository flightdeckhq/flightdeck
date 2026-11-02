"""Helpers for tests that run the sensor in a child process.

Signal delivery and first-import behaviour can only be observed in a
process of their own: a real SIGTERM ends the process it is sent to, and
the test process has imported every SDK long before a test runs. The
child posts its events to :class:`CaptureServer`, which also answers the
provider API calls the child makes, so nothing leaves the machine.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import flightdeck_sensor

# A child that has not finished by then has hung; the tests' own bounds
# are far below it, so reaching it is a failure, never a slow pass.
CHILD_TIMEOUT_SECS = 60.0

# Environment a child must not inherit: the developer's Flightdeck
# settings (they would send its events to a real stack, under their
# flavor) and provider credentials and endpoints (a child must only ever
# reach the capture server).
_SCRUBBED_PREFIXES = ("FLIGHTDECK_", "ANTHROPIC_", "OPENAI_", "LITELLM_")
_SCRUBBED_NAMES = frozenset({"AGENT_FLAVOR", "AGENT_TYPE"})

_SENSOR_ROOT = str(Path(flightdeck_sensor.__file__).resolve().parents[1])

# How long a hanging capture server holds a response: longer than any
# shutdown bound of the sensor's, so only the server's own exit ends it.
HANG_SECS = 60.0

# Canned provider answers. Shaped like the real APIs' responses so the
# SDKs parse them into their own types and the sensor meters them.
_CHAT_COMPLETION_USAGE = {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
_MESSAGE_USAGE = {"input_tokens": 7, "output_tokens": 3}


def child_env(**extra: str) -> dict[str, str]:
    """The environment for a child: this one without the scrubbed
    variables, with the sensor under test importable first, plus
    ``extra``."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(_SCRUBBED_PREFIXES) and key not in _SCRUBBED_NAMES
    }
    env["PYTHONPATH"] = os.pathsep.join(p for p in (_SENSOR_ROOT, env.get("PYTHONPATH")) if p)
    env.update(extra)
    return env


def start_child(script: str, *args: str, env: dict[str, str]) -> subprocess.Popen[str]:
    """Start ``script`` (a file next to this one) with the test's Python."""
    return subprocess.Popen(
        [sys.executable, str(Path(__file__).with_name(script)), *args],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def read_until(proc: subprocess.Popen[str], marker: str) -> list[str]:
    """Read the child's stdout up to a line equal to ``marker`` and
    return the lines before it; fail with its output when it exits
    first."""
    assert proc.stdout is not None
    seen: list[str] = []
    for line in proc.stdout:
        if line.strip() == marker:
            return seen
        seen.append(line.strip())
    proc.wait(timeout=CHILD_TIMEOUT_SECS)
    stderr = proc.stderr.read() if proc.stderr is not None else ""
    raise AssertionError(f"child exited ({proc.returncode}) before {marker!r}: {seen} {stderr}")


def finish(proc: subprocess.Popen[str]) -> tuple[int, str, str]:
    """Wait for the child (killing it if it outlives CHILD_TIMEOUT_SECS)
    and return its exit code and remaining output."""
    try:
        out, err = proc.communicate(timeout=CHILD_TIMEOUT_SECS)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        raise AssertionError(f"child hung and was killed: {out} {err}") from None
    return proc.returncode, out, err


class CaptureServer:
    """Stands in for the Flightdeck control plane and the provider APIs.

    Records every event posted to ``.../v1/events`` in arrival order, and
    answers OpenAI chat completions, Anthropic messages (and their token
    counts) and the sensor's heartbeat. Other GETs (the policy preflight)
    get 404, which the sensor treats as no policy.

    With ``hang_after_start`` it records every event after session_start
    and then holds the response until the server exits: a control plane
    that accepts and never answers. While ``unavailable`` is set it
    answers every event with 503 and records none: a control plane that
    is down, which a test can bring back by clearing the flag.
    """

    def __init__(self, *, hang_after_start: bool = False, unavailable: bool = False) -> None:
        self.events: list[dict[str, Any]] = []
        self.unavailable = unavailable
        self._lock = threading.Lock()
        self._hang_after_start = hang_after_start
        self._release = threading.Event()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host!s}:{port}"

    def event_types(self, session_id: str | None = None) -> list[str]:
        with self._lock:
            return [
                str(e.get("event_type"))
                for e in self.events
                if session_id is None or e.get("session_id") == session_id
            ]

    def __enter__(self) -> CaptureServer:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._release.set()  # let held responses go, so closing waits for none
        self._server.shutdown()
        self._server.server_close()

    def _record(self, event: dict[str, Any]) -> None:
        with self._lock:
            self.events.append(event)

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        capture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                path = self.path.split("?", 1)[0]
                if path.endswith("/v1/events") and capture.unavailable:
                    self.send_response(503)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif path.endswith("/v1/events"):
                    capture._record(body)
                    if capture._hang_after_start and body.get("event_type") != "session_start":
                        capture._release.wait(HANG_SECS)
                    self._reply({"status": "ok", "directive": None})
                elif path.endswith("/chat/completions"):
                    self._reply(
                        {
                            "id": "chatcmpl-capture",
                            "object": "chat.completion",
                            "created": 1_700_000_000,
                            "model": body.get("model", "gpt-4o-mini"),
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {"role": "assistant", "content": "hi"},
                                    "finish_reason": "stop",
                                }
                            ],
                            "usage": _CHAT_COMPLETION_USAGE,
                        }
                    )
                elif path.endswith("/v1/messages/count_tokens"):
                    self._reply({"input_tokens": _MESSAGE_USAGE["input_tokens"]})
                elif path.endswith("/v1/messages"):
                    self._reply(
                        {
                            "id": "msg_capture",
                            "type": "message",
                            "role": "assistant",
                            "model": body.get("model", "claude-haiku-4-5"),
                            "content": [{"type": "text", "text": "hi"}],
                            "stop_reason": "end_turn",
                            "stop_sequence": None,
                            "usage": _MESSAGE_USAGE,
                        }
                    )
                elif path.endswith("/marker"):
                    # A child reporting a step of its own, recorded in line
                    # with its events so the tests can check their order.
                    capture._record(body)
                    self._reply({})
                else:
                    self._reply({})

            def do_GET(self) -> None:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def _reply(self, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: Any) -> None:
                pass

        return Handler
