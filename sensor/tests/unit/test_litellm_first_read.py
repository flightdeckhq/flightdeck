"""litellm streams whose request leaves at their first read (Gemini's
routes; ``text_completion`` on a legacy completions model): the sensor
reports a request only when it is sent.

- With a session at the call, the policy check runs at the call, before
  anything can be sent, so a BLOCK refuses the call there; the
  ``pre_call`` and ``post_call`` are reported when the request leaves, at
  the first read, and a stream never read reports nothing.
- Made with no session active, the stream finds its session at its first
  read, which is the call: a blocking session refuses it with nothing
  sent, a session reports it, and with none it is litellm's own.

Also here: the reader of the usage litellm keeps on its stream, and the
OpenAI interceptor's hook acting only on litellm's own requests.
"""

from __future__ import annotations

import asyncio
import gc
import types
import warnings
from typing import TYPE_CHECKING, Any

import pytest

litellm = pytest.importorskip("litellm")

import httpx  # noqa: E402
import openai  # noqa: E402
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler, HTTPHandler  # noqa: E402

import flightdeck_sensor  # noqa: E402
from flightdeck_sensor.core.exceptions import BudgetExceededError  # noqa: E402
from flightdeck_sensor.core.policy import PolicyCache  # noqa: E402
from flightdeck_sensor.interceptor import base  # noqa: E402
from flightdeck_sensor.interceptor.litellm import (  # noqa: E402
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import (  # noqa: E402
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.providers.litellm import LitellmProvider  # noqa: E402

from ._stream_parity_fakes import (  # noqa: E402
    GEMINI_USAGE,
    MESSAGES,
    OPENAI_USAGE,
    GeminiServer,
    OpenAIServer,
    events_of,
    make_session,
    openai_usage_body,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from flightdeck_sensor.core.session import Session

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


# (entry, model, fake server, client kind, the counts it reports)
ROUTES = {
    "gemini completion": (
        "completion",
        "gemini/gemini-2.0-flash",
        GeminiServer,
        "litellm-http",
        GEMINI_USAGE,
    ),
    "legacy text_completion": (
        "text_completion",
        "gpt-3.5-turbo-instruct",
        OpenAIServer,
        "openai-sdk",
        OPENAI_USAGE,
    ),
}
_ROUTES = pytest.mark.parametrize("route", list(ROUTES))
_CLIENTS = pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])


@pytest.fixture
def patched() -> Iterator[None]:
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    yield
    unpatch_litellm_functions(quiet=True)
    unpatch_openai_classes()


def _blocking(session: Session) -> None:
    session.policy = PolicyCache(token_limit=1, block_at_pct=1)
    session._tokens_used = 10


def _make(route: str, is_async: bool) -> tuple[Any, Any]:
    """Make the stream (awaiting an async call), without reading it."""
    entry, model, server_cls, client_kind, _usage = ROUTES[route]
    server = server_cls()
    transport = httpx.MockTransport(server)
    if client_kind == "openai-sdk":
        client: Any = (
            openai.AsyncOpenAI(api_key="test", http_client=httpx.AsyncClient(transport=transport))
            if is_async
            else openai.OpenAI(api_key="test", http_client=httpx.Client(transport=transport))
        )
    else:
        client = AsyncHTTPHandler() if is_async else HTTPHandler()
        client.client = (httpx.AsyncClient if is_async else httpx.Client)(transport=transport)
    kwargs: dict[str, Any] = {"model": model, "stream": True, "client": client, "api_key": "test"}
    if entry == "text_completion":
        kwargs["prompt"] = "hi"
    else:
        kwargs["messages"] = MESSAGES
    if is_async:

        async def _call() -> Any:
            return await getattr(litellm, f"a{entry}")(**kwargs)

        return asyncio.run(_call()), server
    return getattr(litellm, entry)(**kwargs), server


def _read(stream: Any, is_async: bool) -> list[Any]:
    if is_async:

        async def _drain() -> list[Any]:
            return [chunk async for chunk in stream]

        return asyncio.run(_drain())
    return list(stream)


def _kinds(session: Session) -> list[str]:
    base.drain_deferred_settles(session)
    return [
        c.args[0]["event_type"]
        for c in session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
        if c.args[0]["event_type"] in ("pre_call", "post_call", "llm_error", "policy_block")
    ]


@_ROUTES
@_CLIENTS
@pytest.mark.usefixtures("patched")
def test_a_stream_never_read_sends_nothing_and_reports_nothing(
    monkeypatch: pytest.MonkeyPatch, route: str, is_async: bool
) -> None:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    stream, server = _make(route, is_async)
    del stream
    flightdeck_sensor_session_end(session)
    assert (len(server.bodies), _kinds(session)) == (0, [])


@_ROUTES
@_CLIENTS
@pytest.mark.usefixtures("patched")
def test_the_first_read_sends_the_request_and_reports_it_once(
    monkeypatch: pytest.MonkeyPatch, route: str, is_async: bool
) -> None:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    stream, server = _make(route, is_async)
    assert (len(server.bodies), _kinds(session)) == (0, [])
    _read(stream, is_async)
    assert (len(server.bodies), _kinds(session)) == (1, ["pre_call", "post_call"])
    (post_call,) = events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == ROUTES[route][4]


@_ROUTES
@_CLIENTS
@pytest.mark.usefixtures("patched")
def test_block_refuses_at_the_call_with_nothing_sent(
    monkeypatch: pytest.MonkeyPatch, route: str, is_async: bool
) -> None:
    session = make_session()
    _blocking(session)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    with pytest.raises(BudgetExceededError):
        _make(route, is_async)
    assert _kinds(session) == ["pre_call", "policy_block"]


@pytest.mark.parametrize("at_read", ["a blocking session", "a session", "no session"])
@_ROUTES
@_CLIENTS
@pytest.mark.usefixtures("patched")
def test_a_stream_made_with_no_session_finds_its_session_at_the_first_read(
    monkeypatch: pytest.MonkeyPatch, route: str, is_async: bool, at_read: str
) -> None:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    stream, server = _make(route, is_async)
    assert len(server.bodies) == 0
    if at_read != "no session":
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
    if at_read == "a blocking session":
        _blocking(session)
        with pytest.raises(BudgetExceededError):
            _read(stream, is_async)
        assert (len(server.bodies), _kinds(session)) == (0, ["pre_call", "policy_block"])
        return
    chunks = _read(stream, is_async)
    assert chunks
    if at_read == "a session":
        assert (len(server.bodies), _kinds(session)) == (1, ["pre_call", "post_call"])
    else:
        assert (len(server.bodies), _kinds(session)) == (1, [])


def flightdeck_sensor_session_end(session: Session) -> None:
    """Collect what the test let go and settle what the session holds."""
    import gc

    gc.collect()
    base.drain_deferred_settles(session)


# ----- the reader of the usage litellm keeps -------------------------------------


def _wrapper(chunks: Any) -> Any:
    cls = type("CustomStreamWrapper", (), {})
    wrapper = cls()
    wrapper.chunks = chunks
    return wrapper


def _usage_chunk(prompt: Any, completion: Any) -> Any:
    return types.SimpleNamespace(
        usage=types.SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion)
    )


def test_the_kept_usage_is_the_largest_of_each_count() -> None:
    kept = _wrapper([_usage_chunk(13, 1), types.SimpleNamespace(usage=None), _usage_chunk(0, 5)])
    usage = LitellmProvider().kept_usage(kept)
    assert usage is not None and (usage.input_tokens, usage.output_tokens) == (13, 5)


@pytest.mark.parametrize(
    "stream",
    [
        _wrapper(None),
        _wrapper("not a list"),
        _wrapper([_usage_chunk("13", 1)]),
        _wrapper([_usage_chunk(True, 1)]),
        _wrapper([_usage_chunk(13, None)]),
        _wrapper([types.SimpleNamespace()]),
        _wrapper([]),
        types.SimpleNamespace(chunks=[_usage_chunk(13, 5)]),  # not litellm's wrapper
        object(),
    ],
    ids=[
        "no chunks",
        "chunks not a list",
        "a count that is a string",
        "a count that is a bool",
        "a count missing",
        "a chunk with no usage attribute",
        "no chunk with usage",
        "another class",
        "no attributes",
    ],
)
def test_the_kept_usage_reader_gives_nothing_for_anything_else(stream: Any) -> None:
    assert LitellmProvider().kept_usage(stream) is None


def test_the_kept_usage_reader_never_raises() -> None:
    class _Raising:
        def __getattr__(self, name: str) -> Any:
            raise RuntimeError(name)

    wrapper = _wrapper([_Raising()])
    assert LitellmProvider().kept_usage(wrapper) is None


# ----- the OpenAI interceptor's hook acts on litellm's own requests only ----------


@pytest.mark.usefixtures("patched")
def test_a_request_made_under_a_litellm_call_by_other_code_is_left_alone() -> None:
    """A litellm callback or guardrail calling the OpenAI SDK while a
    litellm call is in flight sends its request as it wrote it."""
    server = OpenAIServer()
    client = openai.OpenAI(
        api_key="test", http_client=httpx.Client(transport=httpx.MockTransport(server))
    )
    with base.outer_intercept():
        chunks = list(
            client.chat.completions.create(model="gpt-4o-mini", messages=MESSAGES, stream=True)
        )
    assert "stream_options" not in server.bodies[-1]
    assert all(getattr(c, "usage", None) is None for c in chunks)


@pytest.mark.usefixtures("patched")
def test_the_stored_response_carries_the_usage_object_the_provider_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On an OpenAI-compatible base litellm does not ask for usage, so the
    OpenAI hook asks and takes the usage chunk out before litellm reads
    the stream: litellm's assembled response has no provider usage, and
    the stored response carries the usage object the provider returned,
    as it returned it."""
    session = make_session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    server = OpenAIServer()
    client = openai.OpenAI(
        api_key="test", http_client=httpx.Client(transport=httpx.MockTransport(server))
    )
    chunks = list(
        litellm.completion(
            model="openai/my-model",
            api_base="https://llm.internal.example/v1",
            api_key="test",
            client=client,
            messages=MESSAGES,
            stream=True,
        )
    )
    assert all(getattr(c, "usage", None) is None for c in chunks)
    (post_call,) = events_of(session, "post_call")
    returned = openai.types.CompletionUsage.model_validate(openai_usage_body())
    assert post_call["content"]["response"]["usage"] == returned.model_dump(mode="json")
