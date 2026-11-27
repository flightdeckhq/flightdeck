"""A litellm ``Router`` through the sensor: the caller of every Router
entry point sees exactly what it sees without the sensor, and each request
a deployment attempt sends is reported once.

A Router calls litellm's patched entry points for each deployment
attempt and inspects what they return: it wraps a ``CustomStreamWrapper``
(on litellm 1.104 an ``aresponses`` stream too) in a stream wrapper of
its own that runs its fallbacks when the stream fails before its first
chunk, reads the stream's ``_hidden_params``, and on 1.104 sends a
lazily-sent stream's request itself (``fetch_sync_stream`` /
``fetch_stream``). Every row makes the same Router call twice over the
loopback fake provider (``tests/unit/_router_fakes.py``), once with
litellm and the OpenAI SDK unpatched and once through the sensor (both
patched, as ``flightdeck_sensor.patch()`` patches them), and compares
everything the caller can observe:

- the object the Router returned: its litellm classes, by qualified name
  (the Router builds its stream wrapper's class per call), and
  ``isinstance`` against each module-level one;
- each chunk's full dump and the fields it was built with, in order; or
  the exception's type when the unsensored read raises;
- the requests the provider received: as many, to the same paths, with
  the same bodies but for the usage the sensor asks for on the OpenAI
  SDK route (``tests/unit/test_litellm_stream_parity.py`` covers that
  ask).

Through the sensor, each request the provider received is one
``pre_call`` and one ``post_call`` or ``llm_error`` once the streams are
collected, and a stream read to its end carries the provider's counts. A
fallback the Router runs after an attempt failed is a second request and
a second call: the failed attempt's ``llm_error``, the fallback's
``post_call``.

Not covered: litellm's sync ``Router.completion`` answers a stream that
fails before its first chunk by calling the failed model group again
until Python's recursion limit (litellm 1.83 and 1.104, with or without
the sensor), so its mid-stream fallback rows are async only.
"""

from __future__ import annotations

import asyncio
import gc
import importlib.metadata
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import pytest

litellm = pytest.importorskip("litellm")

import flightdeck_sensor  # noqa: E402
from flightdeck_sensor.interceptor import base  # noqa: E402
from flightdeck_sensor.interceptor.litellm import (  # noqa: E402
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import (  # noqa: E402
    patch_openai_classes,
    unpatch_openai_classes,
)

from ._router_fakes import (  # noqa: E402
    CUT_MODEL,
    ERROR_EVENT_MODEL,
    FAILING_MODEL,
    TEXT,
    USAGE,
    FakeProvider,
)
from ._stream_parity_fakes import (  # noqa: E402
    VOLATILE_FIELDS,
    collected,
    events_of,
    full_dump,
    make_session,
    only_new_objects_collected,
    set_dump,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from flightdeck_sensor.core.session import Session

litellm.suppress_debug_info = True

MESSAGES = [{"role": "user", "content": "hi"}]
# A Router's model group for a legacy completions model is the litellm
# model itself: litellm's sync Router.text_completion sends the group name
# as the model (with or without the sensor).
TEXT_MODEL = "text-completion-openai/fd-instruct"


def _litellm_release() -> tuple[int, ...]:
    return tuple(int(part) for part in importlib.metadata.version("litellm").split(".")[:2])


# litellm 1.104's sync Router.completion sends a lazily-sent stream's
# request itself (fetch_sync_stream), so a request it refuses fails inside
# the Router's fallback handling; 1.83's sync Router meets that failure
# mid-stream and calls the failed group again until the recursion limit.
SYNC_ROUTER_FETCHES = _litellm_release() >= (1, 104)
# litellm 1.104 raises MidStreamFallbackError for a stream cut before its
# first chunk, which the Router answers with its fallback; 1.83 hands the
# caller one None chunk and ends the stream, with or without the sensor.
CUT_STREAM_FALLS_BACK = _litellm_release() >= (1, 104)


@pytest.fixture(scope="module")
def provider() -> Iterator[FakeProvider]:
    with FakeProvider() as fake:
        yield fake


@pytest.fixture(scope="module", autouse=True)
def _collections_scan_what_the_tests_made() -> Iterator[None]:
    with only_new_objects_collected():
        yield


def _router(base_url: str) -> Any:
    openai_route = {"api_base": f"{base_url}/v1", "api_key": "test"}
    gemini_route = {"api_base": base_url, "api_key": "test"}
    deployments: list[tuple[str, str, dict[str, Any]]] = [
        ("chat", "openai/fd-chat", openai_route),
        ("cut", f"openai/{CUT_MODEL}", openai_route),
        ("error-event", f"openai/{ERROR_EVENT_MODEL}", openai_route),
        ("unavailable", f"openai/{FAILING_MODEL}", openai_route),
        (TEXT_MODEL, TEXT_MODEL, openai_route),
        ("embedder", "openai/text-embedding-3-small", openai_route),
        ("gemini", "gemini/gemini-2.0-flash", gemini_route),
        ("gemini-unavailable", f"gemini/{FAILING_MODEL}", gemini_route),
    ]
    return litellm.Router(
        model_list=[
            {"model_name": name, "litellm_params": {"model": model, **route}}
            for name, model, route in deployments
        ],
        fallbacks=[
            {"cut": ["chat"]},
            {"error-event": ["chat"]},
            {"unavailable": ["chat"]},
            {"gemini-unavailable": ["gemini"]},
        ],
        num_retries=0,
    )


@dataclass(frozen=True)
class Call:
    entry: str
    kwargs: dict[str, Any]
    # The requests a call that answers sends: one, or two for a fallback.
    requests: int = 1


CALLS = {
    "chat stream": Call("completion", {"model": "chat", "messages": MESSAGES, "stream": True}),
    "chat": Call("completion", {"model": "chat", "messages": MESSAGES}),
    "gemini stream": Call("completion", {"model": "gemini", "messages": MESSAGES, "stream": True}),
    "text stream": Call("text_completion", {"model": TEXT_MODEL, "prompt": "hi", "stream": True}),
    "responses stream": Call("responses", {"model": "chat", "input": "hi", "stream": True}),
    "responses": Call("responses", {"model": "chat", "input": "hi"}),
    "embedding": Call("embedding", {"model": "embedder", "input": ["hi", "there"]}),
    "unavailable, then the fallback, stream": Call(
        "completion", {"model": "unavailable", "messages": MESSAGES, "stream": True}, 2
    ),
    "gemini unavailable, then the fallback, stream": Call(
        "completion", {"model": "gemini-unavailable", "messages": MESSAGES, "stream": True}, 2
    ),
    "error event mid-stream, then the fallback": Call(
        "completion", {"model": "error-event", "messages": MESSAGES, "stream": True}, 2
    ),
    "cut mid-stream, then the fallback": Call(
        "completion", {"model": "cut", "messages": MESSAGES, "stream": True}, 2
    ),
}

# (the entry point that makes the stream, how the caller reads it)
READS = {
    "sync-made-for": ("sync", "for"),
    "sync-made-async-for": ("sync", "async for"),
    "async-made-async-for": ("async", "async for"),
    "async-made-for": ("async", "for"),
}
WHOLE = {"sync": ("sync", None), "async": ("async", None)}

# A mid-stream failure: litellm's sync Router recurses (see the module
# docstring), so only the async Router is read.
_MID_STREAM = {"error event mid-stream, then the fallback", "cut mid-stream, then the fallback"}


def _rows() -> list[Any]:
    rows = []
    for name, call in CALLS.items():
        reads = READS if call.kwargs.get("stream") else WHOLE
        for read in reads:
            marks: list[Any] = []
            made = reads[read][0]
            if name in _MID_STREAM and made == "sync":
                continue
            if name == "gemini unavailable, then the fallback, stream" and made == "sync":
                marks.append(
                    pytest.mark.skipif(
                        not SYNC_ROUTER_FETCHES,
                        reason="litellm 1.83's sync Router recurses on a mid-stream failure",
                    )
                )
            if name == "cut mid-stream, then the fallback":
                marks.append(
                    pytest.mark.skipif(
                        not CUT_STREAM_FALLS_BACK,
                        reason="litellm 1.83 ends a stream cut before its first chunk",
                    )
                )
            rows.append(pytest.param(name, read, id=f"{name}-{read}", marks=marks))
    return rows


@dataclass
class Observed:
    classes: list[str] = field(default_factory=list)
    module_classes: list[type] = field(default_factory=list)
    module: str | None = None
    repr_type: str | None = None
    returned: Any = None
    error: type[BaseException] | None = None
    chunks: list[Any] = field(default_factory=list)
    full: list[Any] = field(default_factory=list)
    set_fields: list[Any] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    bodies: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _litellm_classes(value: Any) -> list[type]:
    """litellm's classes in the value's type's MRO; the sensor's class,
    which carries litellm's name and module, is left out."""
    return [
        c
        for c in type(value).__mro__
        if c.__module__.split(".")[0] == "litellm" and not issubclass(c, base.HandedToCaller)
    ]


def _is_stream(value: Any) -> bool:
    return hasattr(type(value), "__next__") or hasattr(type(value), "__anext__")


def _make(router: Any, call: Call, made: str) -> Any:
    if made == "sync":
        return getattr(router, call.entry)(**call.kwargs)

    async def _await() -> Any:
        return await getattr(router, f"a{call.entry}")(**call.kwargs)

    return _await


def _read(router: Any, call: Call, made: str, how: str | None, observed: Observed) -> None:
    """Make the call and read what it returns the way ``how`` says,
    recording the returned object's classes before reading."""

    def _note(value: Any) -> Any:
        observed.module_classes = [
            c for c in _litellm_classes(value) if "<locals>" not in c.__qualname__
        ]
        observed.classes = [c.__qualname__ for c in _litellm_classes(value)]
        observed.module = type(value).__module__
        observed.repr_type = repr(value).split(" object at ", 1)[0] if _is_stream(value) else None
        observed.returned = value
        return value

    async def _drain(value: Any) -> list[Any]:
        return [chunk async for chunk in value]

    if made == "sync":
        value = _note(_make(router, call, made))
        if how == "for":
            observed.chunks = list(value)
        elif how == "async for":
            observed.chunks = asyncio.run(_drain(value))
        return

    make = _make(router, call, made)
    if how == "async for":

        async def _make_and_drain() -> list[Any]:
            return await _drain(_note(await make()))

        observed.chunks = asyncio.run(_make_and_drain())
        return
    value = _note(asyncio.run(make()))
    if how == "for":
        observed.chunks = list(value)


def _observe(provider: FakeProvider, name: str, read: str) -> Observed:
    call = CALLS[name]
    made, how = READS.get(read) or WHOLE[read]
    provider.clear()
    # litellm keeps the SDK clients a Router builds in a process-wide
    # cache; a client an earlier run built and used before the sensor
    # patched the SDK keeps the resources it bound then. Each run builds
    # its own.
    litellm.in_memory_llm_clients_cache.flush_cache()
    observed = Observed()
    with collected() as left:
        try:
            _read(_router(provider.base), call, made, how, observed)
        except Exception as exc:
            observed.error = type(exc)
        # What the call returned is collected here, so a stream left unread
        # is settled before the events are read.
        observed.returned = None
    observed.warnings = sorted(left)
    observed.paths = provider.paths()
    observed.bodies = provider.bodies()
    return observed


def _volatile(first: Observed, second: Observed) -> frozenset[str]:
    """Top-level fields that differ between two unsensored runs of the same
    call (an id litellm generates per call), plus the creation time."""
    keys = set(VOLATILE_FIELDS)
    for a, b in zip(first.chunks, second.chunks, strict=False):
        if a is None or b is None:
            continue
        da, db = a.model_dump(), b.model_dump()
        keys |= {k for k in set(da) | set(db) if da.get(k) != db.get(k)}
    return frozenset(keys)


def _dumps(observed: Observed, volatile: frozenset[str]) -> None:
    # A Router's stream wrapper hands the caller a None chunk where a
    # fallback answered without a stream.
    observed.full = [None if c is None else full_dump(c, volatile) for c in observed.chunks]
    observed.set_fields = [None if c is None else set_dump(c, volatile) for c in observed.chunks]


def _without_the_ask(body: dict[str, Any]) -> dict[str, Any]:
    """The body less a ``stream_options`` that only asks for usage."""
    if body.get("stream_options") == {"include_usage": True}:
        return {k: v for k, v in body.items() if k != "stream_options"}
    return body


@pytest.fixture
def unpatched() -> None:
    assert not getattr(litellm, "_flightdeck_patched", False), "litellm left patched"


@pytest.mark.usefixtures("unpatched")
@pytest.mark.parametrize(("name", "read"), _rows())
def test_a_router_call_is_what_it_is_without_the_sensor_and_each_request_is_reported(
    monkeypatch: pytest.MonkeyPatch, provider: FakeProvider, name: str, read: str
) -> None:
    call = CALLS[name]
    unsensored = _observe(provider, name, read)
    control = _observe(provider, name, read)

    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    try:
        sensored = _observe(provider, name, read)
    finally:
        unpatch_litellm_functions(quiet=True)
        unpatch_openai_classes()
    base.drain_deferred_settles(session)

    # What the Router returned, before it was read.
    if unsensored.classes:
        assert sensored.classes == unsensored.classes
        assert [c.__qualname__ for c in sensored.module_classes] == [
            c.__qualname__ for c in unsensored.module_classes
        ]
        assert sensored.module == unsensored.module
        assert sensored.repr_type == unsensored.repr_type

    # The caller's loop: the same chunks, or the same exception.
    volatile = _volatile(unsensored, control)
    _dumps(unsensored, volatile)
    _dumps(sensored, volatile)
    assert sensored.error is unsensored.error
    assert sensored.full == unsensored.full
    assert sensored.set_fields == unsensored.set_fields
    assert sensored.warnings == unsensored.warnings

    # The requests the provider received.
    assert sensored.paths == unsensored.paths
    assert [_without_the_ask(b) for b in sensored.bodies] == [
        _without_the_ask(b) for b in unsensored.bodies
    ]
    if unsensored.error is None:
        assert len(unsensored.paths) == call.requests

    # One call per request: a pre_call, and a post_call or an llm_error.
    pre_calls = events_of(session, "pre_call")
    ends = (
        events_of(session, "post_call")
        + events_of(session, "embeddings")
        + events_of(session, "llm_error")
    )
    requests = len(sensored.paths)
    if requests == 0:
        # Nothing left: a stream whose request leaves at its first read,
        # and that read raised first. litellm's error is reported as the
        # call's (see ARCHITECTURE, "a first read that raises before the
        # request leaves").
        assert len(pre_calls) == len(ends) <= 1
        return
    assert len(pre_calls) == requests
    assert len(ends) == requests
    if unsensored.error is None:
        # The answered call carries the provider's counts; an attempt
        # before it is its llm_error.
        (answered,) = events_of(session, "post_call") + events_of(session, "embeddings")
        assert answered["tokens_input"] == USAGE[0]
        if answered["event_type"] == "post_call":
            assert answered["tokens_output"] == USAGE[1]
        assert len(events_of(session, "llm_error")) == call.requests - 1


def _session_and_sensor(monkeypatch: pytest.MonkeyPatch) -> Session:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    return session


@pytest.fixture
def sensored(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    session = _session_and_sensor(monkeypatch)
    try:
        yield session
    finally:
        unpatch_litellm_functions(quiet=True)
        unpatch_openai_classes()


def test_the_stream_an_attempt_returns_is_litellms_own(
    provider: FakeProvider, sensored: Session
) -> None:
    """What a Router attempt gets back from ``litellm.completion`` is a
    ``CustomStreamWrapper`` with litellm's own attributes: the Router's
    wrapper reads its ``_hidden_params`` and its chunks list."""
    from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper

    stream = litellm.completion(
        model="openai/fd-chat",
        messages=MESSAGES,
        stream=True,
        api_base=f"{provider.base}/v1",
        api_key="test",
    )
    assert isinstance(stream, CustomStreamWrapper)
    assert type(stream).__name__ == "CustomStreamWrapper"
    assert type(stream).__module__ == CustomStreamWrapper.__module__
    assert repr(stream).startswith(f"<{CustomStreamWrapper.__module__}.CustomStreamWrapper object")
    guard = base.guard_of(stream)
    assert isinstance(guard, base.GuardedStream)
    assert vars(stream) is vars(guard._stream)
    assert stream._hidden_params is guard._stream._hidden_params
    assert "".join(c.choices[0].delta.content or "" for c in stream) == "".join(TEXT)
    assert stream.chunks is guard._stream.chunks
    (post_call,) = events_of(sensored, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == USAGE


@pytest.mark.skipif(not SYNC_ROUTER_FETCHES, reason="litellm 1.83's Router does not fetch")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_router_fetch_sends_the_request_and_reports_it_then(
    provider: FakeProvider, sensored: Session, is_async: bool
) -> None:
    """A Gemini stream sends its request at its first read; litellm
    1.104's Router sends it itself before handing the stream back, so the
    ``pre_call`` is reported then, before the caller reads anything."""
    provider.clear()
    router = _router(provider.base)
    if is_async:

        async def _make() -> Any:
            return await router.acompletion(model="gemini", messages=MESSAGES, stream=True)

        async def _make_and_read() -> list[Any]:
            stream = await _make()
            assert len(provider.paths()) == 1
            assert len(events_of(sensored, "pre_call")) == 1
            return [chunk async for chunk in stream]

        chunks = asyncio.run(_make_and_read())
    else:
        stream = router.completion(model="gemini", messages=MESSAGES, stream=True)
        assert len(provider.paths()) == 1
        assert len(events_of(sensored, "pre_call")) == 1
        assert events_of(sensored, "post_call") == []
        chunks = list(stream)
    assert "".join(c.choices[0].delta.content or "" for c in chunks) == "".join(TEXT)
    (post_call,) = events_of(sensored, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == USAGE


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_router_stream_made_with_no_session_is_litellms_own(
    monkeypatch: pytest.MonkeyPatch, provider: FakeProvider, is_async: bool
) -> None:
    """With the sensor patched and no session, a Router stream whose
    request leaves at its first read is litellm's own and reports
    nothing: the Router wraps it, and its fetch and reads go to litellm."""
    from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper

    monkeypatch.setattr(flightdeck_sensor, "_session", None)
    patch_litellm_functions(quiet=True)
    try:
        router = _router(provider.base)
        if is_async:

            async def _read() -> tuple[Any, list[Any]]:
                stream = await router.acompletion(model="gemini", messages=MESSAGES, stream=True)
                return stream, [chunk async for chunk in stream]

            stream, chunks = asyncio.run(_read())
        else:
            stream = router.completion(model="gemini", messages=MESSAGES, stream=True)
            chunks = list(stream)
    finally:
        unpatch_litellm_functions(quiet=True)
    assert isinstance(stream, CustomStreamWrapper)
    assert type(stream).__qualname__.endswith("FallbackStreamWrapper")
    assert "".join(c.choices[0].delta.content or "" for c in chunks) == "".join(TEXT)
    del stream
    gc.collect()
