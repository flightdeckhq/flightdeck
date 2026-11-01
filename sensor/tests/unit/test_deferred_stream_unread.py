"""A streamed call made through an SDK view whose event stream is never
read is still reported, exactly once, as an aborted stream with no
chunks on the pre-call estimate.

Covers the streaming view (``with_streaming_response``) closed with its
stream parsed but unread or never parsed at all, on the sync and async
clients, for OpenAI chat, OpenAI Responses and Anthropic; an async raw
view (``with_raw_response``) stream that is parsed and never iterated,
settled at the session's end or once dropped; and a stream read to its
end, which must not be reported a second time at close.

Driven with the real ``openai`` / ``anthropic`` clients over respx-served
server-sent events (the helpers of ``test_raw_stream_capture``), so the
SDK builds every response and stream object the sensor sees.
"""

from __future__ import annotations

import gc
from typing import TYPE_CHECKING, Any

import pytest
import respx

from flightdeck_sensor.interceptor import base, raw_views
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider

from .test_raw_stream_capture import (
    _ANTHROPIC_KW,
    ANTHROPIC_URL,
    MESSAGES,
    OPENAI_URL,
    PROMPT,
    _anthropic_frames,
    _anthropic_messages,
    _assert_nothing_captured,
    _chat_frames,
    _completions,
    _events_of,
    _responses,
    _responses_frames,
    _run,
    _session,
    _sse,
)

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_CHAT_KW: dict[str, Any] = {"model": "gpt-4o-mini", "messages": MESSAGES}
_RESPONSES_KW: dict[str, Any] = {"model": "gpt-4o-mini", "input": PROMPT}


def _view_and_route(resource: str, session: Session, capture: bool, *, is_async: bool) -> Any:
    """``(view create, request kwargs, the route to mock, its SSE body,
    the request's pre-call estimate)`` for one resource."""
    if resource == "chat":
        view = _completions(session, capture, is_async=is_async).with_streaming_response
        kwargs = _CHAT_KW
        path, body = "/chat/completions", _sse(_chat_frames(tool=False), done=True)
        estimate = OpenAIProvider().estimate_tokens(kwargs)[0]
    else:
        view = _responses(session, capture, is_async=is_async).with_streaming_response
        kwargs = _RESPONSES_KW
        path, body = "/responses", _sse(_responses_frames())
        estimate = OpenAIProvider().estimate_tokens(kwargs)[0]
    return view, kwargs, path, body, estimate


def _assert_unread_stream_reported(session: Session, estimate: int) -> dict[str, Any]:
    """Exactly one post_call: an aborted stream with no chunks, carrying
    the pre-call estimate; nothing else was emitted for the call."""
    (post_call,) = _events_of(session, "post_call")
    streaming = post_call["streaming"]
    assert streaming["chunk_count"] == 0
    assert streaming["final_outcome"] == "aborted"
    assert streaming["abort_reason"] == "client_aborted"
    assert streaming["ttft_ms"] is None
    assert post_call["tokens_input"] == estimate
    assert post_call["tokens_output"] == 0
    assert _events_of(session, "llm_error") == []
    assert _events_of(session, "tool_call") == []
    return post_call


# ----- streaming view: parsed, never read -------------------------------------


@pytest.mark.parametrize("resource", ["chat", "responses"])
@pytest.mark.parametrize("capture", [True, False], ids=["capture-on", "capture-off"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_streaming_view_closed_with_its_stream_parsed_but_unread_is_reported(
    resource: str, capture: bool, is_async: bool
) -> None:
    session = _session(capture)
    view, kwargs, path, body, estimate = _view_and_route(
        resource, session, capture, is_async=is_async
    )
    parsed: list[Any] = []
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post(path).mock(return_value=body)
        if is_async:

            async def _open_and_leave() -> None:
                async with view.create(stream=True, **kwargs) as response:
                    parsed.append(await response.parse())

            _run(_open_and_leave())
        else:
            with view.create(stream=True, **kwargs) as response:
                parsed.append(response.parse())

    assert isinstance(parsed[0], base.GuardedAsyncStream if is_async else base.GuardedStream)
    post_call = _assert_unread_stream_reported(session, estimate)
    if capture:
        assert post_call["has_content"] is True
    else:
        _assert_nothing_captured(session)


# ----- streaming view: never parsed -------------------------------------------


@pytest.mark.parametrize("resource", ["chat", "responses"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_streaming_view_closed_without_parse_is_reported_as_an_unread_stream(
    resource: str, is_async: bool
) -> None:
    session = _session(False)
    view, kwargs, path, body, estimate = _view_and_route(
        resource, session, False, is_async=is_async
    )
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post(path).mock(return_value=body)
        if is_async:

            async def _open_and_leave() -> None:
                async with view.create(stream=True, **kwargs):
                    pass

            _run(_open_and_leave())
        else:
            with view.create(stream=True, **kwargs):
                pass

    _assert_unread_stream_reported(session, estimate)
    _assert_nothing_captured(session)


def test_streaming_view_plain_call_closed_without_parse_has_no_streaming_block() -> None:
    """Without ``stream=True`` the response is not a stream: the estimate
    stands and no streaming block is invented."""
    session = _session(False)
    view, kwargs, path, _body, estimate = _view_and_route(
        "responses", session, False, is_async=False
    )
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post(path).mock(return_value=_sse([]))
        with view.create(**kwargs):
            pass
    (post_call,) = _events_of(session, "post_call")
    assert "streaming" not in post_call
    assert post_call["tokens_input"] == estimate


# ----- streaming view: read, then closed -------------------------------------


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_streaming_view_stream_read_to_the_end_is_not_reported_again_at_close(
    is_async: bool,
) -> None:
    session = _session(False)
    completions = _completions(session, False, is_async=is_async)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(
            return_value=_sse(_chat_frames(tool=False), done=True)
        )
        if is_async:

            async def _read() -> list[Any]:
                async with completions.with_streaming_response.create(
                    stream=True, **_CHAT_KW
                ) as response:
                    stream = await response.parse()
                    chunks = [c async for c in stream]
                    # A second parse() hands back the same, settled guard.
                    assert await response.parse() is stream
                    return chunks

            chunks = _run(_read())
        else:
            with completions.with_streaming_response.create(stream=True, **_CHAT_KW) as response:
                chunks = list(response.parse())
    assert len(chunks) == 3
    (post_call,) = _events_of(session, "post_call")
    assert post_call["streaming"]["final_outcome"] == "completed"
    assert post_call["tokens_output"] == 4


# ----- async raw view: parsed, never iterated -------------------------------


def _async_raw_stream(session: Session) -> Any:
    """An async client's raw-view ``create(stream=True)``, parsed (the
    raw view parses synchronously and yields an ``AsyncStream``)."""

    async def _create() -> Any:
        raw = await _completions(session, False, is_async=True).with_raw_response.create(
            stream=True, **_CHAT_KW
        )
        assert isinstance(raw, raw_views.DeferredResponse)
        return raw.parse()

    return _run(_create())


def test_async_raw_view_stream_never_iterated_is_reported_at_session_end() -> None:
    session = _session(False)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        stream = _async_raw_stream(session)
        assert isinstance(stream, base.GuardedAsyncStream)
        assert _events_of(session, "post_call") == []
        base.settle_open_guards(session)
        base.settle_open_guards(session)  # a second pass finds it settled
    _assert_unread_stream_reported(session, OpenAIProvider().estimate_tokens(_CHAT_KW)[0])


def test_async_raw_view_stream_dropped_unread_is_reported_at_the_next_drain() -> None:
    session = _session(False)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_sse(_chat_frames(), done=True))
        stream = _async_raw_stream(session)
        del stream
        gc.collect()
        assert _events_of(session, "post_call") == []  # a finalizer never settles inline
        base.drain_deferred_settles(session)
    _assert_unread_stream_reported(session, OpenAIProvider().estimate_tokens(_CHAT_KW)[0])


# ----- Anthropic --------------------------------------------------------------


@pytest.mark.parametrize("capture", [True, False], ids=["capture-on", "capture-off"])
def test_anthropic_async_streaming_view_stream_parsed_but_unread_is_reported(
    capture: bool,
) -> None:
    session = _session(capture)
    messages = _anthropic_messages(capture, session, is_async=True)

    async def _open_and_leave() -> None:
        async with messages.with_streaming_response.create(
            stream=True, **_ANTHROPIC_KW
        ) as response:
            await response.parse()

    with respx.mock(base_url=ANTHROPIC_URL) as router:
        router.post("/v1/messages").mock(return_value=_sse(_anthropic_frames()))
        _run(_open_and_leave())

    _assert_unread_stream_reported(session, AnthropicProvider().estimate_tokens(_ANTHROPIC_KW)[0])
    if not capture:
        _assert_nothing_captured(session)
