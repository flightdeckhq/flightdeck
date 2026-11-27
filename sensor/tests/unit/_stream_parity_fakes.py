"""Provider fakes for the stream parity tests: an OpenAI server (chat
completions and legacy completions), an Anthropic messages server and a
Gemini ``streamGenerateContent`` server, each behind an
``httpx.MockTransport``, so no request leaves the process.

Each fake streams the way its provider does, so what litellm and the
OpenAI SDK make of the stream is what they make of the real one:

- OpenAI sends usage only when the request asks for it with
  ``stream_options.include_usage``; every chunk then carries
  ``"usage": null`` and one last chunk with empty ``choices`` carries the
  counts.
- Anthropic reports the input count on ``message_start`` and the output
  count on ``message_delta`` whatever the request says.
- Gemini sends ``usageMetadata`` on every chunk, the candidates count on
  the last.

Each fake reports counts no estimate produces, so a ``post_call`` that
carries them was metered from the provider's usage.
"""

from __future__ import annotations

import contextlib
import gc
import json
import sys
import threading
import warnings
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import httpx

from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Iterator

# (input, output) each fake reports.
OPENAI_USAGE = (11, 7)
ANTHROPIC_USAGE = (13, 5)
GEMINI_USAGE = (17, 3)

MESSAGES = [{"role": "user", "content": "hi"}]
SSE_HEADERS = {"content-type": "text/event-stream"}

# A chunk's creation time: litellm stamps the clock on some routes, so it
# differs between two runs of the same call and is not compared.
VOLATILE_FIELDS = frozenset({"created"})


def openai_usage_body() -> dict[str, Any]:
    """The ``usage`` OpenAI's last chunk carries when usage is asked for."""
    prompt, completion = OPENAI_USAGE
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "prompt_tokens_details": {"cached_tokens": 0, "audio_tokens": 0},
        "completion_tokens_details": {
            "reasoning_tokens": 0,
            "audio_tokens": 0,
            "accepted_prediction_tokens": 0,
            "rejected_prediction_tokens": 0,
        },
    }


def _sse(events: list[dict[str, Any]], *, done: bool, sep: str = "\n\n") -> bytes:
    body = "".join(f"data: {json.dumps(event)}{sep}" for event in events)
    return (body + ("data: [DONE]\n\n" if done else "")).encode()


class OpenAIServer:
    """Chat completions and legacy completions, streamed, honouring the
    request's ``stream_options.include_usage`` as OpenAI does. Records
    every request body."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content or b"{}")
        self.bodies.append(payload)
        usage_on = bool((payload.get("stream_options") or {}).get("include_usage"))
        path = request.url.path
        legacy = path.endswith("/completions") and not path.endswith("/chat/completions")
        head: dict[str, Any] = {
            "id": "cmpl-parity",
            "created": 1700000000,
            "model": "gpt-4o-mini-2024-07-18",
            "system_fingerprint": "fp_parity",
        }
        if legacy:
            head["object"] = "text_completion"
            choices: list[dict[str, Any]] = [
                {"text": "Hel", "index": 0, "logprobs": None, "finish_reason": None},
                {"text": "lo", "index": 0, "logprobs": None, "finish_reason": None},
                {"text": "", "index": 0, "logprobs": None, "finish_reason": "stop"},
            ]
        else:
            head["object"] = "chat.completion.chunk"
            head["service_tier"] = "default"
            choices = [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "", "refusal": None},
                    "logprobs": None,
                    "finish_reason": None,
                },
                {"index": 0, "delta": {"content": "Hel"}, "logprobs": None, "finish_reason": None},
                {"index": 0, "delta": {"content": "lo"}, "logprobs": None, "finish_reason": None},
                {"index": 0, "delta": {}, "logprobs": None, "finish_reason": "stop"},
            ]
        events = []
        for choice in choices:
            event = {**head, "choices": [choice]}
            if usage_on:
                event["usage"] = None
            events.append(event)
        if usage_on:
            events.append({**head, "choices": [], "usage": openai_usage_body()})
        return httpx.Response(200, content=_sse(events, done=True), headers=SSE_HEADERS)


class AnthropicServer:
    """The messages API, streamed: the input count on ``message_start``,
    the output count on ``message_delta``."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content or b"{}"))
        prompt, completion = ANTHROPIC_USAGE
        frames: list[tuple[str, dict[str, Any]]] = [
            (
                "message_start",
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_parity",
                        "type": "message",
                        "role": "assistant",
                        "model": "claude-3-5-haiku-20241022",
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": prompt, "output_tokens": 1},
                    },
                },
            ),
            (
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
            ),
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "Hel"},
                },
            ),
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "lo"},
                },
            ),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            (
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": completion},
                },
            ),
            ("message_stop", {"type": "message_stop"}),
        ]
        body = "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in frames)
        return httpx.Response(200, content=body.encode(), headers=SSE_HEADERS)


class GeminiServer:
    """``streamGenerateContent?alt=sse``: ``usageMetadata`` on every
    chunk, the candidates count on the last."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content or b"{}"))
        prompt, completion = GEMINI_USAGE
        events = [
            {
                "candidates": [
                    {"content": {"parts": [{"text": "Hel"}], "role": "model"}, "index": 0}
                ],
                "usageMetadata": {"promptTokenCount": prompt, "totalTokenCount": prompt},
                "modelVersion": "gemini-2.0-flash",
                "responseId": "resp-parity",
            },
            {
                "candidates": [
                    {
                        "content": {"parts": [{"text": "lo"}], "role": "model"},
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
                "responseId": "resp-parity",
            },
        ]
        return httpx.Response(
            200, content=_sse(events, done=False, sep="\r\n\r\n"), headers=SSE_HEADERS
        )


def make_session(*, capture_prompts: bool = False) -> Session:
    """A session with a recording queue and no token limit."""
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture_prompts,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _pool_worker(thread: threading.Thread) -> bool:
    """A ``concurrent.futures`` pool worker (litellm's logging executor):
    it lives as long as its pool, so it is never waited for."""
    target = getattr(thread, "_target", None)
    return getattr(target, "__module__", None) == "concurrent.futures.thread"


@contextlib.contextmanager
def collected() -> Iterator[set[str]]:
    """Collect, before the block's test ends, what the block left behind,
    and give the ``RuntimeWarning`` messages that collection raises.

    litellm makes a request coroutine it never awaits when an async-made
    stream that sends its request at its first read (Gemini's routes) is
    read with ``for``, with or without the sensor; collected, it warns
    "coroutine 'make_call' was never awaited". A failed read hands its
    exception, and through it the stream, to a logging thread litellm
    starts, and litellm 1.83 keeps the last call's pre-call and post-call
    records (its logging object, and through it that exception, and the
    locals of its last ``post_call``, through which a stream wrapper a
    Router made) in ``litellm.error_logs`` until the next call replaces
    them. So the threads the block started (bar pool workers) are waited
    for, those records are dropped, and everything is collected here,
    inside the test that made it: nothing of it lands in a later test (a
    module that turns warnings into errors would fail on it). The warning
    records are dropped once read: a "never awaited" record holds its
    coroutine."""
    before = set(threading.enumerate())
    found: set[str] = set()
    try:
        yield found
    finally:
        for thread in threading.enumerate():
            if thread not in before and not thread.daemon and not _pool_worker(thread):
                thread.join()
        error_logs = getattr(sys.modules.get("litellm"), "error_logs", None)
        if isinstance(error_logs, dict):
            error_logs.pop("PRE_CALL", None)
            error_logs.pop("POST_CALL", None)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            gc.collect()
        found.update(str(w.message) for w in caught if issubclass(w.category, RuntimeWarning))
        caught.clear()


@contextlib.contextmanager
def only_new_objects_collected() -> Iterator[None]:
    """For a module whose tests use :func:`collected`: what is alive when
    the module starts is collected once and frozen (``gc.freeze``), so each
    collection in its tests scans only what its tests made. A full
    collection with litellm loaded takes about a quarter of a second, and
    a parity row makes four."""
    gc.collect()
    gc.freeze()
    try:
        yield
    finally:
        gc.unfreeze()


def _plain(value: Any) -> Any:
    """JSON-normal form, so dumps compare by value."""
    return json.loads(json.dumps(value, default=repr))


def full_dump(chunk: Any, volatile: frozenset[str] = VOLATILE_FIELDS) -> Any:
    """Every field of a chunk, set or defaulted, less the volatile ones."""
    data = chunk.model_dump()
    return _plain({k: v for k, v in data.items() if k not in volatile})


def set_dump(chunk: Any, volatile: frozenset[str] = VOLATILE_FIELDS) -> Any:
    """The fields a chunk was built with (``model_dump(exclude_unset=True)``,
    what the SDK's ``to_dict()`` returns), and the top-level set field
    names, less the volatile ones."""
    data = chunk.model_dump(exclude_unset=True)
    names = sorted(set(chunk.model_fields_set) - volatile)
    return _plain({"fields": {k: v for k, v in data.items() if k not in volatile}, "set": names})
