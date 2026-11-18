"""A litellm stream through the sensor shows the caller exactly what it
shows without the sensor.

Every row makes the same streamed call twice over the same fake provider
(``tests/unit/_stream_parity_fakes.py``; nothing leaves the process),
once with litellm and the OpenAI SDK unpatched and once through the
sensor, and compares, chunk by chunk, everything the caller can read:

- each chunk's full dump and the fields it was built with
  (``model_dump(exclude_unset=True)`` and ``model_fields_set``), in
  order;
- the exception, when the unsensored read raises: the sensored read
  raises the same type;
- every request body the provider received: the same, except that on a
  route litellm sends through the OpenAI SDK the sensor adds
  ``stream_options.include_usage`` where litellm's body lacks it;
- the one ``post_call``: the provider's counts wherever the provider's
  usage reaches the sensor (every route through the OpenAI SDK, and any
  route where litellm shows the usage to the caller), else the pre-call
  estimate.

Rows: routes (OpenAI's own base, an OpenAI-compatible base, Anthropic,
Gemini, groq as one of the OpenAI-shaped providers litellm sends with its
own HTTP handler, and ``text_completion`` on a chat model and on a legacy
completions model) x the caller's ``stream_options`` (none, usage asked,
usage refused) x the stream made by the sync or async entry point x read
with ``for`` or ``async for``. Each SDK lane runs the whole table against
its litellm release.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import pytest

litellm = pytest.importorskip("litellm")

import httpx  # noqa: E402
import openai  # noqa: E402
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler, HTTPHandler  # noqa: E402

import flightdeck_sensor  # noqa: E402
from flightdeck_sensor.interceptor.litellm import (  # noqa: E402
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import (  # noqa: E402
    patch_openai_classes,
    unpatch_openai_classes,
)

from ._stream_parity_fakes import (  # noqa: E402
    ANTHROPIC_USAGE,
    GEMINI_USAGE,
    MESSAGES,
    OPENAI_USAGE,
    VOLATILE_FIELDS,
    AnthropicServer,
    GeminiServer,
    OpenAIServer,
    events_of,
    full_dump,
    make_session,
    set_dump,
)

if TYPE_CHECKING:
    from collections.abc import Callable

litellm.suppress_debug_info = True


@dataclass(frozen=True)
class Route:
    entry: str
    model: str
    server: Callable[[], Any]
    usage: tuple[int, int]
    # Whether litellm sends the request through the OpenAI SDK, the layer
    # where the sensor asks the provider for usage.
    through_openai_sdk: bool
    extra: dict[str, Any] = field(default_factory=dict)


ROUTES = {
    "openai": Route("completion", "gpt-4o-mini", OpenAIServer, OPENAI_USAGE, True),
    "openai-compatible": Route(
        "completion",
        "openai/my-model",
        OpenAIServer,
        OPENAI_USAGE,
        True,
        {"api_base": "https://llm.internal.example/v1", "api_key": "test"},
    ),
    "anthropic": Route(
        "completion",
        "anthropic/claude-3-5-haiku-20241022",
        AnthropicServer,
        ANTHROPIC_USAGE,
        False,
        {"api_key": "test"},
    ),
    "gemini": Route(
        "completion",
        "gemini/gemini-2.0-flash",
        GeminiServer,
        GEMINI_USAGE,
        False,
        {"api_key": "test"},
    ),
    "groq": Route(
        "completion",
        "groq/llama-3.1-8b-instant",
        OpenAIServer,
        OPENAI_USAGE,
        False,
        {"api_key": "test"},
    ),
    "text-chat-model": Route("text_completion", "gpt-4o-mini", OpenAIServer, OPENAI_USAGE, True),
    "text-legacy-model": Route(
        "text_completion", "gpt-3.5-turbo-instruct", OpenAIServer, OPENAI_USAGE, True
    ),
}

STREAM_OPTIONS: dict[str, dict[str, Any] | None] = {
    "no-stream-options": None,
    "usage-asked": {"include_usage": True},
    "usage-refused": {"include_usage": False},
}

# (the entry point that makes the stream, how the caller reads it)
READS = {
    "sync-made-for": ("sync", "for"),
    "sync-made-async-for": ("sync", "async for"),
    "async-made-async-for": ("async", "async for"),
    "async-made-for": ("async", "for"),
}


@dataclass
class Observed:
    full: list[Any] = field(default_factory=list)
    set_fields: list[Any] = field(default_factory=list)
    error: type[BaseException] | None = None
    bodies: list[dict[str, Any]] = field(default_factory=list)
    shown_usage: list[tuple[Any, Any]] = field(default_factory=list)
    chunks: list[Any] = field(default_factory=list)


def _client(route: Route, server: Any, is_async: bool) -> Any:
    transport = httpx.MockTransport(server)
    if route.through_openai_sdk:
        if is_async:
            return openai.AsyncOpenAI(
                api_key="test", http_client=httpx.AsyncClient(transport=transport)
            )
        return openai.OpenAI(api_key="test", http_client=httpx.Client(transport=transport))
    handler: Any = AsyncHTTPHandler() if is_async else HTTPHandler()
    handler.client = (httpx.AsyncClient if is_async else httpx.Client)(transport=transport)
    return handler


def _read(entry: str, made: str, how: str, kwargs: dict[str, Any]) -> list[Any]:
    if made == "sync":
        stream = getattr(litellm, entry)(**kwargs)
        if how == "for":
            return list(stream)

        async def _drain() -> list[Any]:
            return [chunk async for chunk in stream]

        return asyncio.run(_drain())

    async def _make() -> Any:
        return await getattr(litellm, f"a{entry}")(**kwargs)

    if how == "for":
        return list(asyncio.run(_make()))

    async def _make_and_drain() -> list[Any]:
        made_stream = await _make()
        return [chunk async for chunk in made_stream]

    return asyncio.run(_make_and_drain())


def _observe(route: Route, stream_options: dict[str, Any] | None, read: str) -> Observed:
    made, how = READS[read]
    server = route.server()
    kwargs: dict[str, Any] = {
        "model": route.model,
        "stream": True,
        "client": _client(route, server, made == "async"),
        **route.extra,
    }
    if route.entry == "text_completion":
        kwargs["prompt"] = "hi"
    else:
        kwargs["messages"] = MESSAGES
    if stream_options is not None:
        kwargs["stream_options"] = dict(stream_options)
    observed = Observed()
    try:
        observed.chunks = _read(route.entry, made, how, kwargs)
    except Exception as exc:
        observed.error = type(exc)
    observed.bodies = list(server.bodies)
    for chunk in observed.chunks:
        usage = getattr(chunk, "usage", None)
        observed.shown_usage.append(
            (getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None))
        )
    return observed


def _dumps(observed: Observed, volatile: frozenset[str]) -> None:
    observed.full = [full_dump(c, volatile) for c in observed.chunks]
    observed.set_fields = [set_dump(c, volatile) for c in observed.chunks]


def _volatile(first: Observed, second: Observed) -> frozenset[str]:
    """Top-level fields that differ between two unsensored runs of the same
    call (an id litellm generates per call), plus the creation time."""
    keys = set(VOLATILE_FIELDS)
    for a, b in zip(first.chunks, second.chunks, strict=False):
        da, db = a.model_dump(), b.model_dump()
        keys |= {k for k in set(da) | set(db) if da.get(k) != db.get(k)}
    return frozenset(keys)


def _expected_body(route: Route, unsensored: dict[str, Any]) -> dict[str, Any]:
    """The request body the provider receives through the sensor: litellm's
    own, with ``include_usage`` added only at the OpenAI SDK and only where
    litellm's body does not already ask for it."""
    options = unsensored.get("stream_options")
    if not route.through_openai_sdk or (isinstance(options, dict) and options.get("include_usage")):
        return unsensored
    return {**unsensored, "stream_options": {**(options or {}), "include_usage": True}}


@pytest.fixture
def unpatched() -> None:
    assert not getattr(litellm, "_flightdeck_patched", False), "litellm left patched"


@pytest.mark.usefixtures("unpatched")
@pytest.mark.parametrize("read", list(READS))
@pytest.mark.parametrize("setting", list(STREAM_OPTIONS))
@pytest.mark.parametrize("route_name", list(ROUTES))
def test_a_litellm_stream_shows_the_caller_what_it_shows_without_the_sensor(
    monkeypatch: pytest.MonkeyPatch, route_name: str, setting: str, read: str
) -> None:
    route = ROUTES[route_name]
    stream_options = STREAM_OPTIONS[setting]
    unsensored = _observe(route, stream_options, read)
    control = _observe(route, stream_options, read)

    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    try:
        sensored = _observe(route, stream_options, read)
    finally:
        unpatch_litellm_functions(quiet=True)
        unpatch_openai_classes()

    volatile = _volatile(unsensored, control)
    _dumps(unsensored, volatile)
    _dumps(sensored, volatile)

    # The caller's loop: the same chunks, or the same exception.
    if unsensored.error is not None:
        assert sensored.error is unsensored.error
    else:
        assert sensored.error is None
        assert sensored.full == unsensored.full
        assert sensored.set_fields == unsensored.set_fields

    # The request the provider received.
    assert sensored.bodies == [_expected_body(route, body) for body in unsensored.bodies]

    if unsensored.error is not None:
        return
    # One call metered once: the provider's counts where its usage reaches
    # the sensor, else the pre-call estimate.
    (pre_call,) = events_of(session, "pre_call")
    (post_call,) = events_of(session, "post_call")
    tokens = (post_call["tokens_input"], post_call["tokens_output"])
    if route.through_openai_sdk or route.usage in unsensored.shown_usage:
        assert tokens == route.usage
    else:
        assert tokens == (pre_call["tokens_input"], 0)
