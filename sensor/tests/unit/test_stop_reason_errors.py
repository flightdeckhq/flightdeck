"""Non-success stop reasons file an llm_error beside the post_call.

Anthropic answers HTTP 200 with ``stop_reason="refusal"`` (safety
classifiers declined) or ``"model_context_window_exceeded"`` (context
window ran out). The post_call still lands with the billed usage; an
llm_error with the matching classification lands next to it, on the
plain-response path, the raw-stream path and the helper-stream path.
Success reasons and embeddings events emit no error.
"""

from __future__ import annotations

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

from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

KW = {"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": "hi"}]}


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


class _Plain:
    """Attribute bag for a reason the installed SDK's literal may not
    know yet; a bare MagicMock would answer every getattr."""

    def __init__(self, **attrs: object) -> None:
        self.__dict__.update(attrs)


def _post(session: Session, response: Any, **kwargs: Any) -> None:
    base._post_call(
        session,
        AnthropicProvider(),
        response,
        estimated=10,
        latency_ms=50,
        call_kwargs=dict(KW),
        estimated_via="tiktoken",
        **kwargs,
    )


# --------------------------------------------------------------------------
# Plain responses
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


def test_context_window_exceeded_response_lands_context_overflow_error() -> None:
    session = _session()
    usage = _Plain(input_tokens=900, output_tokens=1)
    _post(session, _Plain(stop_reason="model_context_window_exceeded", usage=usage, content=[]))
    errors = _events_of(session, "llm_error")
    assert len(errors) == 1
    assert errors[0]["error"]["error_type"] == "context_overflow"
    assert errors[0]["error"]["provider_error_code"] == "model_context_window_exceeded"
    assert len(_events_of(session, "post_call")) == 1


def test_success_stop_reasons_emit_no_error() -> None:
    for reason in ("end_turn", "max_tokens", "tool_use", None):
        session = _session()
        _post(session, _message(reason))
        assert _events_of(session, "llm_error") == [], reason
        assert len(_events_of(session, "post_call")) == 1


def test_error_message_names_the_reason_only_even_with_capture_on() -> None:
    session = _session(capture_prompts=True)
    _post(session, _message("refusal"))
    errors = _events_of(session, "llm_error")
    assert errors[0]["error"]["error_message"] == "stop_reason=refusal"
    assert "Hello" not in str(errors[0]["error"])


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


def test_provider_label_derives_from_the_adapter_class() -> None:
    assert base._provider_label(AnthropicProvider()) == "anthropic"
    assert base._provider_label(OpenAIProvider()) == "openai"
    assert base._provider_label(LitellmProvider()) == "litellm"


def test_openai_responses_file_no_stop_reason_error() -> None:
    session = _session()
    response = _Plain(stop_reason="refusal", usage=_Plain(prompt_tokens=1, completion_tokens=1))
    base._post_call(
        session,
        OpenAIProvider(),
        response,
        estimated=1,
        latency_ms=1,
        call_kwargs={"model": "gpt-5.5"},
    )
    assert _events_of(session, "llm_error") == []


# --------------------------------------------------------------------------
# Raw streams: the reason arrives on message_delta, there is no final
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
