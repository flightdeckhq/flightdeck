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
  (``stream_options.include_usage: true``) where the body sent without
  the sensor does not ask, an explicit ``include_usage: false`` included
  (``extra_body`` is merged over the arguments key by key, by the OpenAI
  SDK and by litellm's own handler, so its ``stream_options`` decides);
  the one exception is a call to litellm's own handler whose
  ``stream_options`` asks while its ``extra_body`` refuses, which litellm
  would show the usage chunk the ask causes;
- the one ``post_call``'s counts: the provider's exact counts on every
  row, except the rows on the named list (:func:`_estimated`), which
  carry the pre-call estimate. Nothing else: the fakes report counts no
  estimate and no count of litellm's own produces, so a row metered from
  litellm's own count fails.

Rows: routes x the caller's ``stream_options`` (none, usage asked, usage
refused) x, on the OpenAI-shaped routes, the caller's ``extra_body``
(none, its ``stream_options`` asking, refusing, or with other keys only,
other keys only) x the stream made by the sync or async entry point x
read with ``for`` or ``async for``. Each SDK lane runs the whole table
against its litellm release, so a release that stops keeping what a
fallback reads turns its rows red rather than estimating silently.
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

AZURE_ENDPOINT = "https://fd-parity.openai.azure.com"
AZURE_API_VERSION = "2024-10-21"


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
    azure: bool = False


_AZURE = {"api_key": "test", "api_version": AZURE_API_VERSION, "api_base": AZURE_ENDPOINT}

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
    "azure": Route(
        "completion",
        "azure/my-deployment",
        OpenAIServer,
        OPENAI_USAGE,
        OPENAI_SDK,
        _AZURE,
        azure=True,
    ),
    "azure-text": Route(
        "text_completion",
        "azure_text/my-instruct",
        OpenAIServer,
        OPENAI_USAGE,
        OPENAI_SDK,
        _AZURE,
        azure=True,
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

# The caller's ``stream_options`` argument.
STREAM_OPTIONS: dict[str, dict[str, Any] | None] = {
    "no-stream-options": None,
    "usage-asked": {"include_usage": True},
    "usage-refused": {"include_usage": False},
}

# The caller's ``extra_body``, on the OpenAI-shaped routes.
EXTRA_BODIES: dict[str, dict[str, Any] | None] = {
    "no-extra-body": None,
    "extra-asks": {"stream_options": {"include_usage": True}},
    "extra-refuses": {"stream_options": {"include_usage": False}},
    "extra-other-stream-options": {"stream_options": {"continuous_usage_stats": True}},
    "extra-other-keys": {"parity_tag": "x"},
}

# (the entry point that makes the stream, how the caller reads it)
READS = {
    "sync-made-for": ("sync", "for"),
    "sync-made-async-for": ("sync", "async for"),
    "async-made-async-for": ("async", "async for"),
    "async-made-for": ("async", "for"),
}


def _rows() -> list[Any]:
    rows = []
    for route_name, route in ROUTES.items():
        extras = list(EXTRA_BODIES) if route.tier != NOT_OPENAI_SHAPED else ["no-extra-body"]
        for setting in STREAM_OPTIONS:
            for extra in extras:
                for read in READS:
                    rows.append(
                        pytest.param(
                            route_name,
                            setting,
                            extra,
                            read,
                            id=f"{route_name}-{setting}-{extra}-{read}",
                        )
                    )
    return rows


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
    if route.azure:
        options = {
            "api_key": "test",
            "api_version": AZURE_API_VERSION,
            "azure_endpoint": AZURE_ENDPOINT,
        }
        if is_async:
            return openai.AsyncAzureOpenAI(
                **options, http_client=httpx.AsyncClient(transport=transport)
            )
        return openai.AzureOpenAI(**options, http_client=httpx.Client(transport=transport))
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


def _observe(
    route: Route,
    stream_options: dict[str, Any] | None,
    extra_body: dict[str, Any] | None,
    read: str,
) -> Observed:
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
    if extra_body is not None:
        kwargs["extra_body"] = {
            k: dict(v) if isinstance(v, dict) else v for k, v in extra_body.items()
        }
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


def _asks(options: Any) -> bool:
    return isinstance(options, dict) and bool(options.get("include_usage"))


def _sent_options(stream_options: Any, extra_body: Any) -> Any:
    """The ``stream_options`` the body carries: ``extra_body``'s when it
    has one (merged over the arguments key by key), else the argument."""
    if isinstance(extra_body, dict) and "stream_options" in extra_body:
        return extra_body["stream_options"]
    return stream_options


def _refused_in_extra_body(route: Route, stream_options: Any, extra_body: Any) -> bool:
    """A call to litellm's own handler whose ``stream_options`` asks for
    usage while its ``extra_body`` refuses it: the sensor leaves its body
    alone, since litellm would show that caller the usage chunk an ask
    causes."""
    return (
        route.tier == OPENAI_SHAPED
        and _asks(stream_options)
        and not _asks(_sent_options(stream_options, extra_body))
    )


def _expected_body(
    route: Route, stream_options: Any, extra_body: Any, unsensored: dict[str, Any]
) -> dict[str, Any]:
    """The request body the provider receives through the sensor: the one
    it receives without, with ``include_usage: true`` on an OpenAI-shaped
    route where that body does not ask for usage (an explicit ``false``
    included), the other keys of its ``stream_options`` kept."""
    options = unsensored.get("stream_options")
    if (
        route.tier == NOT_OPENAI_SHAPED
        or _asks(options)
        or _refused_in_extra_body(route, stream_options, extra_body)
    ):
        return unsensored
    return {
        **unsensored,
        "stream_options": {**(options if isinstance(options, dict) else {}), "include_usage": True},
    }


def _estimated(
    route: Route, stream_options: Any, extra_body: Any, made: str, unsensored: Observed
) -> bool:
    """The named list: the rows metered from the pre-call estimate. Every
    other row carries the provider's exact counts.

    - Through the OpenAI SDK: none; the provider is always asked at the
      SDK and its counts handed over.
    - OpenAI-shaped, litellm's own handler: a call whose ``stream_options``
      asks while its ``extra_body`` refuses (the provider is not asked);
      and, where litellm does not show the usage (the caller's
      ``stream_options`` does not ask), a litellm release that discards
      the usage chunk it does not show (1.83).
    - Not OpenAI-shaped: an async ``text_completion`` stream whose usage
      litellm does not show; it wraps a plain generator and keeps nothing.
    """
    if route.tier == OPENAI_SDK:
        return False
    if route.tier == OPENAI_SHAPED:
        if _refused_in_extra_body(route, stream_options, extra_body):
            return True
        return not _asks(stream_options) and not KEEPS_UNSHOWN_USAGE_CHUNK
    if route.usage in unsensored.shown_usage:
        return False
    return route.entry == "text_completion" and made == "async"


@pytest.fixture
def unpatched() -> None:
    assert not getattr(litellm, "_flightdeck_patched", False), "litellm left patched"


@pytest.mark.usefixtures("unpatched")
@pytest.mark.parametrize(("route_name", "setting", "extra", "read"), _rows())
def test_a_litellm_stream_shows_the_caller_what_it_shows_without_the_sensor(
    monkeypatch: pytest.MonkeyPatch, route_name: str, setting: str, extra: str, read: str
) -> None:
    route = ROUTES[route_name]
    stream_options = STREAM_OPTIONS[setting]
    extra_body = EXTRA_BODIES[extra]
    unsensored = _observe(route, stream_options, extra_body, read)
    control = _observe(route, stream_options, extra_body, read)

    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    try:
        sensored = _observe(route, stream_options, extra_body, read)
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
    assert sensored.bodies == [
        _expected_body(route, stream_options, extra_body, body) for body in unsensored.bodies
    ]

    if unsensored.error is not None:
        return
    # One call metered once: the provider's exact counts, or the pre-call
    # estimate on the named list. Nothing else.
    (pre_call,) = events_of(session, "pre_call")
    (post_call,) = events_of(session, "post_call")
    tokens = (post_call["tokens_input"], post_call["tokens_output"])
    if _estimated(route, stream_options, extra_body, READS[read][0], unsensored):
        assert tokens == (pre_call["tokens_input"], 0)
    else:
        assert tokens == route.usage
