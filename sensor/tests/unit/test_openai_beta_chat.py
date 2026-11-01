"""``client.beta.chat.completions.parse()`` / ``.stream()``: the structured
output path on ``client.beta``, intercepted like ``client.chat``.

``client.beta`` is the SDK's ``Beta`` / ``AsyncBeta`` resource, whose own
``chat`` cached_property hands out a ``Chat`` the client's ``chat``
descriptor never sees; the sensor patches it on the beta resource
classes. Driven with the real ``openai`` clients over respx, so the SDK
parses the structured output into the caller's model as it does without
the sensor.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

import httpx
import openai
import pydantic
import pytest
import respx
from openai.types.chat import ParsedChatCompletion

import flightdeck_sensor
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor import openai as openai_interceptor
from flightdeck_sensor.interceptor.openai import (
    SensorBeta,
    SensorChat,
    SensorOpenAI,
    patch_openai_classes,
    unpatch_openai_classes,
)

from .test_raw_stream_capture import (
    MESSAGES,
    OPENAI_URL,
    PROMPT,
    _assert_nothing_captured,
    _chat_frames,
    _events_of,
    _session,
    _sse,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from flightdeck_sensor.core.session import Session

pytestmark = pytest.mark.skipif(
    openai_interceptor._OrigBeta is None
    or openai_interceptor.BETA_CHAT_ATTR not in openai_interceptor._OrigBeta.__dict__,
    reason="the installed openai has no client.beta.chat",
)

CITY = "SECRET-CITY-b3c1"


class Weather(pydantic.BaseModel):
    city: str
    celsius: int


def _parsed_completion_body() -> dict[str, Any]:
    return {
        "id": "chatcmpl-beta-1",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": json.dumps({"city": CITY, "celsius": 21}),
                    "refusal": None,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17},
    }


def _client(is_async: bool, **kwargs: Any) -> Any:
    if is_async:
        return openai.AsyncOpenAI(api_key="sk-test", max_retries=0, **kwargs)
    return openai.OpenAI(api_key="sk-test", max_retries=0, **kwargs)


@pytest.fixture
def patched(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    patch_openai_classes(quiet=True)
    yield
    unpatch_openai_classes()


def _activate(monkeypatch: pytest.MonkeyPatch, capture: bool) -> Session:
    session = _session(capture)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    return session


def _parse(client: Any, is_async: bool) -> Any:
    call = client.beta.chat.completions.parse(
        model="gpt-4o-mini", messages=MESSAGES, response_format=Weather
    )
    if is_async:

        async def _await() -> Any:
            return await call

        return asyncio.run(_await())
    return call


@pytest.mark.parametrize("capture", [True, False], ids=["capture-on", "capture-off"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_beta_chat_parse_is_metered_once_and_returns_the_parsed_model(
    patched: None, monkeypatch: pytest.MonkeyPatch, capture: bool, is_async: bool
) -> None:
    session = _activate(monkeypatch, capture)
    with respx.mock(base_url=OPENAI_URL) as router:
        route = router.post("/chat/completions").mock(
            return_value=httpx.Response(200, json=_parsed_completion_body())
        )
        completion = _parse(_client(is_async), is_async)

    # The caller gets what the unpatched SDK returns.
    assert isinstance(completion, ParsedChatCompletion)
    assert completion.choices[0].message.parsed == Weather(city=CITY, celsius=21)
    assert route.call_count == 1
    sent = json.loads(route.calls.last.request.content)
    assert sent["response_format"]["type"] == "json_schema"

    assert len(_events_of(session, "pre_call")) == 1
    (post_call,) = _events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (12, 5)
    assert post_call["model"] == "gpt-4o-mini"
    if capture:
        assert post_call["content"]["messages"] == MESSAGES
        assert CITY in json.dumps(post_call["content"]["response"])
    else:
        _assert_nothing_captured(session)
        assert CITY not in json.dumps(_events_of(session, "post_call"))


def test_beta_chat_stream_helper_is_metered_once(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _activate(monkeypatch, False)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(
            return_value=_sse(_chat_frames(tool=False), done=True)
        )
        with _client(False).beta.chat.completions.stream(
            model="gpt-4o-mini", messages=MESSAGES
        ) as stream:
            final = stream.get_final_completion()
    assert final.choices[0].message.content == "Hi there"
    (post_call,) = _events_of(session, "post_call")
    assert post_call["tokens_output"] == 4
    assert post_call["streaming"]["final_outcome"] == "completed"
    _assert_nothing_captured(session)


def test_beta_chat_on_a_local_server_is_attributed_to_the_client_endpoint(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The beta resource carries no ``base_url``; the provider is built
    from the client it holds, as for ``client.chat``."""
    _activate(monkeypatch, False)
    client = _client(False, base_url="http://localhost:8123/v1")
    beta_chat, chat = client.beta.chat, client.chat
    assert isinstance(beta_chat, SensorChat)
    assert beta_chat._provider.platform == chat._provider.platform == "localhost"
    assert beta_chat._provider.local is True


def test_beta_chat_under_the_outer_mark_resolves_the_raw_completions(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _activate(monkeypatch, False)
    chat = _client(False).beta.chat
    with base.outer_intercept():
        assert not isinstance(chat.completions, openai_interceptor.SensorCompletions)
    assert isinstance(chat.completions, openai_interceptor.SensorCompletions)
    assert _events_of(session, "pre_call") == []


def test_patch_is_idempotent_and_unpatch_restores_the_sdk_beta_chat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    beta_cls = openai_interceptor._OrigBeta
    original = beta_cls.__dict__[openai_interceptor.BETA_CHAT_ATTR]
    patch_openai_classes(quiet=True)
    try:
        descriptor = beta_cls.__dict__[openai_interceptor.BETA_CHAT_ATTR]
        assert isinstance(descriptor, openai_interceptor._OpenAIBetaChatDescriptor)
        patch_openai_classes(quiet=True)
        assert beta_cls.__dict__[openai_interceptor.BETA_CHAT_ATTR] is descriptor
    finally:
        unpatch_openai_classes()
    assert beta_cls.__dict__[openai_interceptor.BETA_CHAT_ATTR] is original
    session = _activate(monkeypatch, False)
    assert not isinstance(_client(False).beta.chat, SensorChat)
    assert _events_of(session, "pre_call") == []


def test_no_active_session_leaves_beta_chat_to_the_sdk(patched: None) -> None:
    assert flightdeck_sensor._session is None
    assert not isinstance(_client(False).beta.chat, SensorChat)


def test_an_sdk_without_beta_chat_is_skipped_silently(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class _BetaWithoutChat:
        pass

    monkeypatch.setattr(openai_interceptor, "_OrigBeta", _BetaWithoutChat)
    monkeypatch.setattr(openai_interceptor, "_OrigAsyncBeta", None)
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.interceptor.openai"):
        patch_openai_classes(quiet=False)
        unpatch_openai_classes()
    assert not hasattr(_BetaWithoutChat, "_flightdeck_patched_beta_chat")
    assert not [r for r in caplog.records if "chat" in r.getMessage()]


def test_wrapped_client_beta_chat_parse_is_metered_once(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _activate(monkeypatch, False)
    client = flightdeck_sensor.wrap(_client(False))
    assert isinstance(client, SensorOpenAI)
    assert isinstance(client.beta, SensorBeta)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(
            return_value=httpx.Response(200, json=_parsed_completion_body())
        )
        completion = client.beta.chat.completions.parse(
            model="gpt-4o-mini", messages=MESSAGES, response_format=Weather
        )
    assert completion.choices[0].message.parsed.city == CITY
    (post_call,) = _events_of(session, "post_call")
    assert post_call["tokens_output"] == 5
    assert PROMPT not in json.dumps(post_call)


def test_wrapped_and_patched_client_beta_chat_is_wrapped_once(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _activate(monkeypatch, False)
    wrapped = SensorOpenAI(_client(False), session)
    chat = wrapped.beta.chat
    assert isinstance(chat, SensorChat)
    assert not isinstance(chat._real, SensorChat)
