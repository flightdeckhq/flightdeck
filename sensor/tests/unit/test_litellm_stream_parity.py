"""A litellm stream through the sensor shows the caller exactly what it
shows without the sensor, and is metered from the provider's counts
wherever they can be had without changing what any layer above sees.

Every row makes the same streamed call twice over the same fake provider
(``tests/unit/_stream_parity_fakes.py``; nothing leaves the process),
once with litellm and the OpenAI SDK unpatched and once through the
sensor, and compares, chunk by chunk, everything the caller can read:

- each chunk's full dump and the fields it was built with
  (``model_dump(exclude_unset=True)`` and ``model_fields_set``), in
  order;
- the exception, when the unsensored read raises: the sensored read
  raises the same type;
- every request body the provider received: the same, except that on an
  OpenAI-shaped route the provider is asked for usage
  (``stream_options.include_usage``) where litellm's body lacks the ask;
- the one ``post_call``'s counts, by the route's tier:

  - through the OpenAI SDK: the provider's, always;
  - OpenAI-shaped, sent by litellm's own HTTP handler: the provider's
    when litellm shows them, or when the litellm release keeps the usage
    chunk it does not show (1.104 does, 1.83 discards it), else the
    pre-call estimate;
  - not OpenAI-shaped (Anthropic, Gemini): the provider's when litellm
    shows them or keeps them on its stream's chunks (a ``CustomStreamWrapper``
    does; an async ``text_completion`` stream wraps a plain generator and
    keeps nothing), else the pre-call estimate.

Rows: routes x the caller's ``stream_options`` (none, usage asked, usage
refused) x the stream made by the sync or async entry point x read with
``for`` or ``async for``. Each SDK lane runs the whole table against its
litellm release, so a release that stops keeping what a fallback reads
turns its rows red rather than estimating silently.
"""

from __future__ import annotations

import asyncio
import gc
import importlib.metadata
import warnings
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
    from collections.abc import Callable, Iterator

litellm.suppress_debug_info = True


@pytest.fixture(autouse=True)
def _litellm_request_coroutines_collected() -> Iterator[None]:
    """A row that reads an async-made Gemini stream with ``for`` makes
    litellm create its request coroutine and never await it (it does so
    without the sensor too). It is collected here, its "never awaited"
    warning ignored, so that warning lands in this row rather than in a
    later test that turns warnings into errors."""
    yield
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        gc.collect()


# The route's tier: where the sensor can ask for usage and where it reads it.
OPENAI_SDK = "through the OpenAI SDK"
OPENAI_SHAPED = "OpenAI-shaped, litellm's own HTTP handler"
NOT_OPENAI_SHAPED = "not OpenAI-shaped"


def _litellm_release() -> tuple[int, ...]:
    return tuple(int(part) for part in importlib.metadata.version("litellm").split(".")[:2])


# Whether litellm keeps the usage chunk of an OpenAI-shaped stream whose
# caller did not ask for usage on its stream's chunks: measured on litellm
# 1.104.2 (kept) and 1.83.0 (discarded).
KEEPS_UNSHOWN_USAGE_CHUNK = _litellm_release() >= (1, 104)


@dataclass(frozen=True)
class Route:
    entry: str
    model: str
    server: Callable[[], Any]
    usage: tuple[int, int]
    tier: str
    extra: dict[str, Any] = field(default_factory=dict)


ROUTES = {
    "openai": Route("completion", "gpt-4o-mini", OpenAIServer, OPENAI_USAGE, OPENAI_SDK),
    "openai-compatible": Route(
        "completion",
        "openai/my-model",
        OpenAIServer,
        OPENAI_USAGE,
        OPENAI_SDK,
        {"api_base": "https://llm.internal.example/v1", "api_key": "test"},
    ),
    "text-chat-model": Route(
        "text_completion", "gpt-4o-mini", OpenAIServer, OPENAI_USAGE, OPENAI_SDK
    ),
    "text-legacy-model": Route(
        "text_completion", "gpt-3.5-turbo-instruct", OpenAIServer, OPENAI_USAGE, OPENAI_SDK
    ),
    # A model litellm counts with its bundled tokenizer: a llama model name
    # makes litellm fetch one from Hugging Face.
    "groq": Route(
        "completion",
        "groq/gemma2-9b-it",
        OpenAIServer,
        OPENAI_USAGE,
        OPENAI_SHAPED,
        {"api_key": "test"},
    ),
    "anthropic": Route(
        "completion",
        "anthropic/claude-3-5-haiku-20241022",
        AnthropicServer,
        ANTHROPIC_USAGE,
        NOT_OPENAI_SHAPED,
        {"api_key": "test"},
    ),
    "gemini": Route(
        "completion",
        "gemini/gemini-2.0-flash",
        GeminiServer,
        GEMINI_USAGE,
        NOT_OPENAI_SHAPED,
        {"api_key": "test"},
    ),
    "text-anthropic": Route(
        "text_completion",
        "anthropic/claude-3-5-haiku-20241022",
        AnthropicServer,
        ANTHROPIC_USAGE,
        NOT_OPENAI_SHAPED,
        {"api_key": "test"},
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
    if route.tier == OPENAI_SDK:
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
    own, with ``include_usage`` added on an OpenAI-shaped route where
    litellm's body does not already ask for it."""
    options = unsensored.get("stream_options")
    asked = isinstance(options, dict) and bool(options.get("include_usage"))
    if route.tier == NOT_OPENAI_SHAPED or asked:
        return unsensored
    return {**unsensored, "stream_options": {**(options or {}), "include_usage": True}}


def _metered_from_the_provider(route: Route, made: str, unsensored: Observed) -> bool:
    """Whether the route's tier gets the provider's counts for this row."""
    if route.tier == OPENAI_SDK or route.usage in unsensored.shown_usage:
        return True
    if route.tier == OPENAI_SHAPED:
        return KEEPS_UNSHOWN_USAGE_CHUNK
    # Not OpenAI-shaped: litellm keeps the provider's counts on the chunks
    # of its CustomStreamWrapper; an async text_completion stream wraps a
    # plain generator instead.
    return not (route.entry == "text_completion" and made == "async")


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
    # One call metered once, from the provider's counts where the tier gets
    # them, else from the pre-call estimate.
    (pre_call,) = events_of(session, "pre_call")
    (post_call,) = events_of(session, "post_call")
    tokens = (post_call["tokens_input"], post_call["tokens_output"])
    if _metered_from_the_provider(route, READS[read][0], unsensored):
        assert tokens == route.usage
    else:
        assert tokens == (pre_call["tokens_input"], 0)
