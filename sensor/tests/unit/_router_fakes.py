"""A provider fake on a loopback HTTP server for the litellm Router tests.

A Router builds its own clients from each deployment's ``litellm_params``,
so its deployments point ``api_base`` at this server rather than taking a
mock transport; nothing leaves the machine. The server speaks, by path:

- ``/v1/chat/completions``: OpenAI chat, streamed or not, with the usage
  chunk only when the request asks for it (``stream_options``), as OpenAI
  does;
- ``/v1/completions``: OpenAI legacy completions, the same way;
- ``/v1/responses``: the OpenAI Responses API, streamed or not, the usage
  on the terminal ``response.completed`` event;
- ``/v1/embeddings``: OpenAI embeddings;
- ``/v1beta/models/<model>:streamGenerateContent``: Gemini, streamed, with
  ``usageMetadata`` on every chunk.

The model in the request picks how it answers: a model named
:data:`CUT_MODEL` gets a stream that opens and is cut before its first
chunk (a mid-stream failure litellm's stream wrapper turns into a
``MidStreamFallbackError``, which a Router answers with its fallbacks), and
:data:`FAILING_MODEL` gets an HTTP 503 before any stream. Each answer
carries counts no estimate produces, so a ``post_call`` that carries them
was metered from the provider's usage. Every request is recorded.
"""

from __future__ import annotations

import contextlib
import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

# (input, output) the fake reports, OpenAI and Gemini shapes alike.
USAGE = (23, 9)
# The deployment model a stream is cut for, before its first chunk.
CUT_MODEL = "fd-cut"
# The deployment model refused with an HTTP 503 before any stream.
FAILING_MODEL = "fd-unavailable"
# The deployment model whose stream opens with an error event (OpenAI's
# ``data: {"error": ...}``), before its first chunk.
ERROR_EVENT_MODEL = "fd-error-event"
# The text every answer carries, split into two chunks when streamed.
TEXT = ("Hel", "lo")


@dataclass(frozen=True)
class Received:
    path: str
    body: dict[str, Any]


def _openai_usage() -> dict[str, Any]:
    prompt, completion = USAGE
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    }


def _sse(events: list[Any], *, done: bool) -> bytes:
    body = "".join(f"data: {json.dumps(event)}\n\n" for event in events)
    return (body + ("data: [DONE]\n\n" if done else "")).encode()


def _named_sse(events: list[dict[str, Any]]) -> bytes:
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
    ).encode()


def _chat_stream(model: str, usage: bool) -> bytes:
    head = {"id": "chatcmpl-fd", "object": "chat.completion.chunk", "created": 1700000000}
    head["model"] = model
    deltas: list[tuple[dict[str, Any], str | None]] = [
        ({"role": "assistant", "content": ""}, None),
        ({"content": TEXT[0]}, None),
        ({"content": TEXT[1]}, None),
        ({}, "stop"),
    ]
    events: list[dict[str, Any]] = []
    for delta, finish in deltas:
        event = {**head, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if usage:
            event["usage"] = None
        events.append(event)
    if usage:
        events.append({**head, "choices": [], "usage": _openai_usage()})
    return _sse(events, done=True)


def _chat(model: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-fd",
        "object": "chat.completion",
        "created": 1700000000,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "".join(TEXT)},
                "finish_reason": "stop",
            }
        ],
        "usage": _openai_usage(),
    }


def _legacy_stream(model: str, usage: bool) -> bytes:
    head = {"id": "cmpl-fd", "object": "text_completion", "created": 1700000000, "model": model}
    events: list[dict[str, Any]] = [
        {**head, "choices": [{"text": text, "index": 0, "logprobs": None, "finish_reason": None}]}
        for text in TEXT
    ]
    events.append(
        {**head, "choices": [{"text": "", "index": 0, "logprobs": None, "finish_reason": "stop"}]}
    )
    if usage:
        for event in events:
            event["usage"] = None
        events.append({**head, "choices": [], "usage": _openai_usage()})
    return _sse(events, done=True)


def _response(model: str, status: str) -> dict[str, Any]:
    prompt, completion = USAGE
    done = status == "completed"
    return {
        "id": "resp_fd",
        "object": "response",
        "created_at": 1700000000,
        "status": status,
        "model": model,
        "output": [
            {
                "type": "message",
                "id": "msg_fd",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "".join(TEXT), "annotations": []}],
            }
        ]
        if done
        else [],
        "usage": {
            "input_tokens": prompt,
            "output_tokens": completion,
            "total_tokens": prompt + completion,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        }
        if done
        else None,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }


def _responses_stream(model: str) -> bytes:
    events: list[dict[str, Any]] = [
        {
            "type": "response.created",
            "sequence_number": 0,
            "response": _response(model, "in_progress"),
        },
    ]
    for number, text in enumerate(TEXT, start=1):
        events.append(
            {
                "type": "response.output_text.delta",
                "sequence_number": number,
                "item_id": "msg_fd",
                "output_index": 0,
                "content_index": 0,
                "delta": text,
            }
        )
    events.append(
        {
            "type": "response.completed",
            "sequence_number": len(TEXT) + 1,
            "response": _response(model, "completed"),
        }
    )
    return _named_sse(events)


def _gemini_stream() -> bytes:
    prompt, completion = USAGE
    events = [
        {
            "candidates": [
                {"content": {"parts": [{"text": TEXT[0]}], "role": "model"}, "index": 0}
            ],
            "usageMetadata": {"promptTokenCount": prompt, "totalTokenCount": prompt},
            "modelVersion": "gemini-2.0-flash",
        },
        {
            "candidates": [
                {
                    "content": {"parts": [{"text": TEXT[1]}], "role": "model"},
                    "finishReason": "STOP",
                    "index": 0,
                }
            ],
            "usageMetadata": {
                "promptTokenCount": prompt,
                "candidatesTokenCount": completion,
                "totalTokenCount": prompt + completion,
            },
            "modelVersion": "gemini-2.0-flash",
        },
    ]
    return _sse(events, done=False)


def _embeddings(count: int) -> dict[str, Any]:
    prompt, _ = USAGE
    return {
        "object": "list",
        "data": [
            {"object": "embedding", "index": index, "embedding": [0.25, -0.5, 0.125]}
            for index in range(count)
        ],
        "model": "text-embedding-3-small",
        "usage": {"prompt_tokens": prompt, "total_tokens": prompt},
    }


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _Server

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        path = self.path.split("?", 1)[0]
        self.server.fake.record(Received(path, body))
        model = str(body.get("model") or path.rsplit("/", 1)[-1].split(":", 1)[0])
        if model.endswith(FAILING_MODEL):
            self._json(503, {"error": {"message": "overloaded", "type": "server_error"}})
            return
        streamed = bool(body.get("stream")) or path.endswith(":streamGenerateContent")
        if streamed and model.endswith(CUT_MODEL):
            self._cut()
            return
        if streamed and model.endswith(ERROR_EVENT_MODEL):
            error = {
                "error": {"message": "overloaded", "type": "server_error", "code": "overloaded"}
            }
            self._stream(_sse([error], done=False))
            return
        usage = bool((body.get("stream_options") or {}).get("include_usage"))
        if path.endswith(":streamGenerateContent"):
            self._stream(_gemini_stream())
        elif path.endswith("/chat/completions"):
            if streamed:
                self._stream(_chat_stream(model, usage))
            else:
                self._json(200, _chat(model))
        elif path.endswith("/completions"):
            self._stream(_legacy_stream(model, usage))
        elif path.endswith("/responses"):
            if streamed:
                self._stream(_responses_stream(model))
            else:
                self._json(200, _response(model, "completed"))
        elif path.endswith("/embeddings"):
            given = body.get("input")
            self._json(200, _embeddings(len(given) if isinstance(given, list) else 1))
        else:
            self._json(404, {"error": {"message": f"no route {path}"}})

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _stream(self, data: bytes) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _cut(self) -> None:
        """A stream that opens and is cut before its first event: the
        declared body never arrives."""
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", "4096")
        self.end_headers()
        self.wfile.write(b"data: {")
        self.wfile.flush()
        self.close_connection = True


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    fake: FakeProvider

    def handle_error(self, request: Any, client_address: Any) -> None:
        """A client that leaves before its answer is written (a stream the
        caller stopped reading) is no failure of the fake's."""


class FakeProvider:
    """The loopback server; ``base`` is its ``http://127.0.0.1:<port>``."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.received: list[Received] = []
        self._server = _Server(("127.0.0.1", 0), _Handler)
        self._server.fake = self
        self.base = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def record(self, request: Received) -> None:
        with self._lock:
            self.received.append(request)

    def bodies(self) -> list[dict[str, Any]]:
        with self._lock:
            return [r.body for r in self.received]

    def paths(self) -> list[str]:
        with self._lock:
            return [r.path for r in self.received]

    def clear(self) -> None:
        with self._lock:
            self.received.clear()

    def __enter__(self) -> FakeProvider:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()


@contextlib.contextmanager
def fake_provider() -> Iterator[FakeProvider]:
    with FakeProvider() as fake:
        yield fake
