"""Non-success stop reasons file an llm_error beside the post_call.

A provider can answer HTTP 200 with a stop reason that still means the
call did not succeed: Anthropic's ``refusal`` (safety classifiers
declined) and ``model_context_window_exceeded`` (context window ran
out), OpenAI's and litellm's ``content_filter`` finish reason, an OpenAI
structured-output refusal, a Responses call left ``incomplete`` by the
content filter. The post_call still lands with the billed usage; an
llm_error with the matching classification lands next to it, on the
plain-response path, the raw-stream path and the helper-stream path.
Success and truncation reasons and embeddings events emit no error.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

from anthropic.types import (
    Message,
    RawContentBlockDeltaEvent,
    RawContentBlockStartEvent,
    RawContentBlockStopEvent,
    RawMessageDeltaEvent,
    RawMessageStartEvent,
    RawMessageStopEvent,
)
from litellm.types.utils import ModelResponse
from openai.types.chat import ChatCompletion, ChatCompletionChunk
from openai.types.responses import Response

from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

KW = {"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": "hi"}]}
OPENAI_KW = {"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}]}


def _session(capture_prompts: bool = False) -> Session:
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
    session.policy = PolicyCache(token_limit=None)
    return session


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


def _message(stop_reason: str | None, output_tokens: int = 5) -> Message:
    return Message.model_validate(
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [{"type": "text", "text": "Hello"}],
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {"input_tokens": 12, "output_tokens": output_tokens},
        }
    )


def _chat_completion(finish_reason: str, refusal: str | None = None) -> ChatCompletion:
    return ChatCompletion.model_validate(
        {
            "id": "c",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-5.5",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish_reason,
                    "message": {"role": "assistant", "content": "Hello", "refusal": refusal},
                }
            ],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        }
    )


def _responses_response(status: str, reason: str | None) -> Response:
    return Response.model_validate(
        {
            "id": "r",
            "object": "response",
            "created_at": 1.0,
            "model": "gpt-5.5",
            "status": status,
            "output": [],
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
            "incomplete_details": {"reason": reason} if reason else None,
            "usage": {
                "input_tokens": 3,
                "output_tokens": 2,
                "total_tokens": 5,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        }
    )


class _Plain:
    """Attribute bag for a reason the installed SDK's literal may not
    know yet; a bare MagicMock would answer every getattr."""

    def __init__(self, **attrs: object) -> None:
        self.__dict__.update(attrs)


def _post(session: Session, response: Any, provider: Any = None, **kwargs: Any) -> None:
    provider = provider or AnthropicProvider()
    call_kwargs = dict(OPENAI_KW if isinstance(provider, OpenAIProvider | LitellmProvider) else KW)
    base._post_call(
        session,
        provider,
        response,
        estimated=10,
        latency_ms=50,
        call_kwargs=call_kwargs,
        estimated_via="tiktoken",
        **kwargs,
    )


# --------------------------------------------------------------------------
# Anthropic plain responses
# --------------------------------------------------------------------------


def test_refusal_response_lands_post_call_and_content_filter_error() -> None:
    session = _session()
    _post(session, _message("refusal"))

    posts = _events_of(session, "post_call")
    assert len(posts) == 1
    assert posts[0]["tokens_input"] == 12
    assert posts[0]["tokens_output"] == 5

    errors = _events_of(session, "llm_error")
    assert len(errors) == 1
    error = errors[0]
    assert error["model"] == "claude-haiku-4-5"
    assert error["latency_ms"] == 50
    assert error["terminal"] is True
    assert error["retry_attempt"] == 1
    assert error["error"] == {
        "error_type": "content_filter",
        "provider": "anthropic",
        "http_status": 200,
        "provider_error_code": "refusal",
        "error_message": "stop_reason=refusal",
        "request_id": None,
        "retry_after": None,
        "is_retryable": False,
    }


def test_stop_reason_error_points_at_its_post_call() -> None:
    # originating_event_id pairs the error with the billed call.
    session = _session()
    _post(session, _message("refusal"))
    post_id = _events_of(session, "post_call")[0]["id"]
    assert _events_of(session, "llm_error")[0]["originating_event_id"] == post_id


def test_stop_reason_error_carries_the_responses_request_id() -> None:
    session = _session()
    usage = _Plain(input_tokens=1, output_tokens=1)
    # The SDK stamps the parsed object; a raw wrapper exposes headers.
    _post(session, _Plain(stop_reason="refusal", usage=usage, content=[], _request_id="req_s"))
    _post(
        session,
        _Plain(stop_reason="refusal", usage=usage, content=[], headers={"request-id": "req_h"}),
    )
    errors = _events_of(session, "llm_error")
    assert [e["error"]["request_id"] for e in errors] == ["req_s", "req_h"]
    # Distinct request ids are distinct attempts, not one retry chain.
    assert [e["retry_attempt"] for e in errors] == [1, 1]


def test_context_window_exceeded_response_lands_context_overflow_error() -> None:
    session = _session()
    usage = _Plain(input_tokens=900, output_tokens=1)
    _post(session, _Plain(stop_reason="model_context_window_exceeded", usage=usage, content=[]))
    errors = _events_of(session, "llm_error")
    assert len(errors) == 1
    assert errors[0]["error"]["error_type"] == "context_overflow"
    assert errors[0]["error"]["provider_error_code"] == "model_context_window_exceeded"
    assert len(_events_of(session, "post_call")) == 1


def test_success_and_truncation_stop_reasons_emit_no_error() -> None:
    for reason in ("end_turn", "max_tokens", "tool_use", None):
        session = _session()
        _post(session, _message(reason))
        assert _events_of(session, "llm_error") == [], reason
        assert len(_events_of(session, "post_call")) == 1


def test_error_message_names_the_reason_only_even_with_capture_on() -> None:
    session = _session(capture_prompts=True)
    _post(session, _message("refusal"), provider=AnthropicProvider(capture_prompts=True))
    posts = _events_of(session, "post_call")
    assert posts[0]["has_content"] is True
    errors = _events_of(session, "llm_error")
    assert errors[0]["error"]["error_message"] == "stop_reason=refusal"
    assert errors[0].get("content") is None
    assert errors[0].get("has_content") is not True
    assert "Hello" not in json.dumps(errors[0])


def test_stop_reason_argument_overrides_the_response() -> None:
    # The stream guard passes what the events announced; it wins over a
    # response object that cannot tell (a raw stream).
    session = _session()
    _post(session, _message("end_turn"), stop_reason="refusal")
    assert [e["error"]["error_type"] for e in _events_of(session, "llm_error")] == [
        "content_filter"
    ]


def test_embeddings_events_never_file_a_stop_reason_error() -> None:
    session = _session()
    _post(session, _message("refusal"), event_type=EventType.EMBEDDINGS)
    assert _events_of(session, "llm_error") == []
    assert len(_events_of(session, "embeddings")) == 1


def test_provider_name_comes_from_the_adapter() -> None:
    assert base._provider_name(AnthropicProvider()) == "anthropic"
    assert base._provider_name(OpenAIProvider()) == "openai"
    assert base._provider_name(LitellmProvider()) == "litellm"
    assert base._provider_name(_Plain()) == "unknown"  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# OpenAI and litellm plain responses
# --------------------------------------------------------------------------


def test_openai_chat_content_filter_lands_content_filter_error() -> None:
    session = _session()
    _post(session, _chat_completion("content_filter"), provider=OpenAIProvider())
    errors = _events_of(session, "llm_error")
    assert len(errors) == 1
    assert errors[0]["error"]["error_type"] == "content_filter"
    assert errors[0]["error"]["provider"] == "openai"
    assert errors[0]["error"]["provider_error_code"] == "content_filter"
    assert errors[0]["error"]["http_status"] == 200
    assert errors[0]["terminal"] is True
    assert len(_events_of(session, "post_call")) == 1


def test_openai_structured_output_refusal_lands_content_filter_error() -> None:
    session = _session()
    _post(
        session,
        _chat_completion("stop", refusal="I can't help with that."),
        provider=OpenAIProvider(),
    )
    errors = _events_of(session, "llm_error")
    assert [e["error"]["provider_error_code"] for e in errors] == ["refusal"]
    assert errors[0]["error"]["error_type"] == "content_filter"
    assert "I can't help" not in json.dumps(errors[0])


def test_openai_truncated_and_normal_chat_responses_emit_no_error() -> None:
    for reason in ("stop", "length", "tool_calls"):
        session = _session()
        _post(session, _chat_completion(reason), provider=OpenAIProvider())
        assert _events_of(session, "llm_error") == [], reason


def test_openai_responses_incomplete_by_content_filter_lands_error() -> None:
    session = _session()
    _post(session, _responses_response("incomplete", "content_filter"), provider=OpenAIProvider())
    errors = _events_of(session, "llm_error")
    assert [e["error"]["error_type"] for e in errors] == ["content_filter"]
    assert errors[0]["error"]["provider_error_code"] == "content_filter"


def test_openai_responses_truncated_or_completed_emit_no_error() -> None:
    for status, reason in (("incomplete", "max_output_tokens"), ("completed", None)):
        session = _session()
        _post(session, _responses_response(status, reason), provider=OpenAIProvider())
        assert _events_of(session, "llm_error") == [], (status, reason)


def test_openai_ignores_an_anthropic_shaped_stop_reason() -> None:
    session = _session()
    response = _Plain(stop_reason="refusal", usage=_Plain(prompt_tokens=1, completion_tokens=1))
    _post(session, response, provider=OpenAIProvider())
    assert _events_of(session, "llm_error") == []


def test_litellm_content_filter_lands_content_filter_error() -> None:
    session = _session()
    filtered = ModelResponse(
        choices=[
            {
                "index": 0,
                "finish_reason": "content_filter",
                "message": {"role": "assistant", "content": ""},
            }
        ],
        usage={"prompt_tokens": 3, "completion_tokens": 0, "total_tokens": 3},
    )
    _post(session, filtered, provider=LitellmProvider())
    errors = _events_of(session, "llm_error")
    assert len(errors) == 1
    assert errors[0]["error"]["error_type"] == "content_filter"
    assert errors[0]["error"]["provider"] == "litellm"
    done = ModelResponse(
        choices=[
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "hi"}}
        ]
    )
    session = _session()
    _post(session, done, provider=LitellmProvider())
    assert _events_of(session, "llm_error") == []


# --------------------------------------------------------------------------
# Raw streams: the reason arrives on a streamed event, there is no final
# message object to read it from.
# --------------------------------------------------------------------------


class _FakeStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __enter__(self) -> _FakeStream:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __iter__(self) -> Any:
        return iter(self._events)

    def close(self) -> None:
        pass


def _refusal_events() -> list[Any]:
    return [
        RawMessageStartEvent.model_validate(
            {"type": "message_start", "message": _message(None, 1).model_dump()}
        ),
        RawContentBlockStartEvent.model_validate(
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            }
        ),
        RawContentBlockDeltaEvent.model_validate(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "I can't"},
            }
        ),
        RawContentBlockStopEvent.model_validate({"type": "content_block_stop", "index": 0}),
        RawMessageDeltaEvent.model_validate(
            {
                "type": "message_delta",
                "delta": {"stop_reason": "refusal", "stop_sequence": None},
                "usage": {"output_tokens": 4},
            }
        ),
        RawMessageStopEvent.model_validate({"type": "message_stop"}),
    ]


def _openai_chat_chunks(finish_reason: str) -> list[ChatCompletionChunk]:
    def chunk(payload: dict[str, Any]) -> ChatCompletionChunk:
        return ChatCompletionChunk.model_validate(
            {
                "id": "c",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "gpt-5.5",
                **payload,
            }
        )

    return [
        chunk({"choices": [{"index": 0, "delta": {"content": "Hel"}, "finish_reason": None}]}),
        chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]}),
        chunk(
            {
                "choices": [],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
            }
        ),
    ]


def test_raw_stream_refusal_lands_content_filter_error_after_settle() -> None:
    session = _session()
    guard = base.call_stream(
        lambda **kw: _FakeStream(_refusal_events()), dict(KW), session, AnthropicProvider()
    )
    with guard as stream:
        for _ in stream:
            pass

    posts = _events_of(session, "post_call")
    assert len(posts) == 1
    assert posts[0]["tokens_output"] == 4
    errors = _events_of(session, "llm_error")
    assert len(errors) == 1
    assert errors[0]["error"]["error_type"] == "content_filter"
    assert errors[0]["error"]["provider_error_code"] == "refusal"
    assert errors[0]["error"]["http_status"] == 200


def test_raw_stream_end_turn_emits_no_error() -> None:
    events = _refusal_events()
    events[4] = RawMessageDeltaEvent.model_validate(
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 4},
        }
    )
    session = _session()
    guard = base.call_stream(
        lambda **kw: _FakeStream(events), dict(KW), session, AnthropicProvider()
    )
    with guard as stream:
        for _ in stream:
            pass
    assert _events_of(session, "llm_error") == []
    assert len(_events_of(session, "post_call")) == 1


def test_openai_chat_stream_content_filter_lands_error_after_settle() -> None:
    session = _session()
    guard = base.call_stream(
        lambda **kw: _FakeStream(_openai_chat_chunks("content_filter")),
        dict(OPENAI_KW, stream=True),
        session,
        OpenAIProvider(),
    )
    with guard as stream:
        for _ in stream:
            pass
    assert len(_events_of(session, "post_call")) == 1
    errors = _events_of(session, "llm_error")
    assert [e["error"]["error_type"] for e in errors] == ["content_filter"]
    assert errors[0]["error"]["provider"] == "openai"


def test_openai_chat_stream_length_emits_no_error() -> None:
    session = _session()
    guard = base.call_stream(
        lambda **kw: _FakeStream(_openai_chat_chunks("length")),
        dict(OPENAI_KW, stream=True),
        session,
        OpenAIProvider(),
    )
    with guard as stream:
        for _ in stream:
            pass
    assert _events_of(session, "llm_error") == []


def test_stream_guard_survives_a_failing_stop_reason_hook() -> None:
    provider = AnthropicProvider()
    provider.stop_reason_from_stream_chunk = MagicMock(  # type: ignore[method-assign]
        side_effect=RuntimeError("hook broke")
    )
    session = _session()
    guard = base.call_stream(
        lambda **kw: _FakeStream(_refusal_events()), dict(KW), session, provider
    )
    with guard as stream:
        for _ in stream:
            pass
    # The post_call still lands; the reason is lost with the hook.
    assert len(_events_of(session, "post_call")) == 1
    assert _events_of(session, "llm_error") == []


def test_stop_reason_error_caps_an_oversized_request_id() -> None:
    session = _session()
    usage = _Plain(input_tokens=1, output_tokens=1)
    oversized = "r" * 200_000
    stamped = _Plain(stop_reason="refusal", usage=usage, content=[], _request_id=oversized)
    _post(session, stamped)
    from_headers = _Plain(
        stop_reason="refusal", usage=usage, content=[], headers={"request-id": oversized}
    )
    _post(session, from_headers)
    errors = _events_of(session, "llm_error")
    assert base._REQUEST_ID_MAX_LEN == 128
    assert [len(e["error"]["request_id"]) for e in errors] == [128, 128]
    # Both carry the same capped key, so the second is the chain's retry.
    assert [e["retry_attempt"] for e in errors] == [1, 2]
