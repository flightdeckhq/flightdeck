"""An OpenAI chat stream through the sensor shows the caller exactly what
it shows without the sensor.

Every row makes the same ``chat.completions.create(stream=True)`` call
twice over the same fake OpenAI server (``_stream_parity_fakes``;
nothing leaves the process), once with the SDK unpatched and once
through the sensor, and compares each chunk's full dump and the fields
it was built with (``to_dict()``, ``model_dump(exclude_unset=True)``
and ``model_fields_set``), in order. When the sensor asks for usage the
caller did not ask for, OpenAI adds a usage chunk and puts
``"usage": null`` on every other chunk: the caller sees neither. The
request differs only by the ``include_usage`` the sensor adds when the
caller's request lacks it, and the ``post_call`` carries the provider's
counts.

Rows: the caller's ``stream_options`` (none, usage asked, usage refused)
x a sync or async client x the stream iterated or read inside ``with``.
Each SDK lane runs the table against its openai release.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import openai
import pytest

import flightdeck_sensor
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes

from ._stream_parity_fakes import (
    MESSAGES,
    OPENAI_USAGE,
    OpenAIServer,
    events_of,
    full_dump,
    make_session,
    openai_usage_body,
    set_dump,
)

STREAM_OPTIONS: dict[str, dict[str, Any] | None] = {
    "no-stream-options": None,
    "usage-asked": {"include_usage": True},
    "usage-refused": {"include_usage": False},
}


def _read(server: OpenAIServer, kwargs: dict[str, Any], is_async: bool, with_block: bool) -> Any:
    transport = httpx.MockTransport(server)
    if not is_async:
        client = openai.OpenAI(api_key="test", http_client=httpx.Client(transport=transport))
        stream = client.chat.completions.create(**kwargs)
        if with_block:
            with stream as entered:
                return list(entered)
        return list(stream)

    async def _go() -> list[Any]:
        aclient = openai.AsyncOpenAI(
            api_key="test", http_client=httpx.AsyncClient(transport=transport)
        )
        astream = await aclient.chat.completions.create(**kwargs)
        if with_block:
            async with astream as entered:
                return [chunk async for chunk in entered]
        return [chunk async for chunk in astream]

    return asyncio.run(_go())


def _observe(setting: str, is_async: bool, with_block: bool) -> tuple[list[Any], OpenAIServer]:
    server = OpenAIServer()
    kwargs: dict[str, Any] = {"model": "gpt-4o-mini", "messages": MESSAGES, "stream": True}
    options = STREAM_OPTIONS[setting]
    if options is not None:
        kwargs["stream_options"] = dict(options)
    return _read(server, kwargs, is_async, with_block), server


def _expected_body(unsensored: dict[str, Any]) -> dict[str, Any]:
    options = unsensored.get("stream_options")
    if isinstance(options, dict) and options.get("include_usage"):
        return unsensored
    return {**unsensored, "stream_options": {**(options or {}), "include_usage": True}}


@pytest.mark.parametrize("with_block", [False, True], ids=["iterated", "with"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("setting", list(STREAM_OPTIONS))
def test_an_openai_chat_stream_shows_the_caller_what_it_shows_without_the_sensor(
    monkeypatch: pytest.MonkeyPatch, setting: str, is_async: bool, with_block: bool
) -> None:
    unsensored, plain_server = _observe(setting, is_async, with_block)

    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_openai_classes(quiet=True)
    try:
        sensored, sensed_server = _observe(setting, is_async, with_block)
    finally:
        unpatch_openai_classes()

    assert [full_dump(c) for c in sensored] == [full_dump(c) for c in unsensored]
    assert [set_dump(c) for c in sensored] == [set_dump(c) for c in unsensored]
    assert [c.to_dict() for c in sensored] == [c.to_dict() for c in unsensored]
    assert sensed_server.bodies == [_expected_body(b) for b in plain_server.bodies]

    (post_call,) = events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == OPENAI_USAGE


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("setting", list(STREAM_OPTIONS))
def test_the_stored_streamed_response_carries_the_providers_usage(
    monkeypatch: pytest.MonkeyPatch, setting: str, is_async: bool
) -> None:
    """With capture on, the response stored for a streamed call is the
    assembled completion with the usage the provider reported, whether the
    caller or the sensor asked for it."""
    session = make_session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_openai_classes(quiet=True)
    try:
        _observe(setting, is_async, with_block=False)
    finally:
        unpatch_openai_classes()

    (post_call,) = events_of(session, "post_call")
    response = post_call["content"]["response"]
    # The SDK's own dump of the usage chunk's counts, defaults included, as
    # the assembled completion holds it.
    expected = openai.types.CompletionUsage.model_validate(openai_usage_body()).model_dump()
    assert response["usage"] == json.loads(json.dumps(expected))
    assert response["choices"][0]["message"]["content"] == "Hello"
