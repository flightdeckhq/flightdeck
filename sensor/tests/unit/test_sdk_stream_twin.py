"""``base.sdk_stream_twin``: an SDK stream handed back as an instance of
its own class, sharing the stream's attribute dictionary, its iteration
and its request-sending methods read through the guard.

The fake stream below has the shape of litellm's ``CustomStreamWrapper``:
it iterates both ways, keeps all its state in its instance dictionary,
has a finalizer, and a lazily-sent one sends its request when first read
or when fetched (``fetch_sync_stream`` / ``fetch_stream``).
"""

from __future__ import annotations

import asyncio
import copy
import functools
import gc
import pickle
from typing import TYPE_CHECKING, Any

import pytest

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.litellm import _handed_over
from flightdeck_sensor.providers.litellm import LitellmProvider

from ._stream_parity_fakes import events_of, make_session

if TYPE_CHECKING:
    from collections.abc import Iterator

    from flightdeck_sensor.core.session import Session

KWARGS: dict[str, Any] = {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]}
SENDING = ("fetch_sync_stream", "fetch_stream")


class SDKStream:
    """A stream in the shape of litellm's."""

    finalized = 0

    def __init__(
        self, chunks: list[str], *, lazy: bool = False, fail: BaseException | None = None
    ) -> None:
        self.given = list(chunks)
        self.position = 0
        self.sent = not lazy
        self.fail = fail
        self.marks_at_send: list[Any] = []
        self._hidden_params: dict[str, Any] = {"model_id": "deployment-1"}

    def __iter__(self) -> SDKStream:
        return self

    def __next__(self) -> str:
        self.fetch_sync_stream()
        if self.position >= len(self.given):
            raise StopIteration
        self.position += 1
        return self.given[self.position - 1]

    def __aiter__(self) -> SDKStream:
        return self

    async def __anext__(self) -> str:
        await self.fetch_stream()
        if self.position >= len(self.given):
            raise StopAsyncIteration
        self.position += 1
        return self.given[self.position - 1]

    def fetch_sync_stream(self) -> SDKStream:
        if not self.sent:
            self.marks_at_send.append(base.current_outer_call())
            if self.fail is not None:
                raise self.fail
            self.sent = True
        return self

    async def fetch_stream(self) -> SDKStream:
        return self.fetch_sync_stream()

    def __del__(self) -> None:
        type(self).finalized += 1


class SlottedStream:
    """A stream that keeps its state in slots: it cannot share it."""

    __slots__ = ("given",)

    def __init__(self, chunks: list[str]) -> None:
        self.given = iter(chunks)

    def __iter__(self) -> SlottedStream:
        return self

    def __next__(self) -> str:
        return next(self.given)


class IterableOnly:
    """Iterable but no iterator: ``iter()`` gives another object, which a
    twin's ``__iter__`` would not read through the guard."""

    def __init__(self, chunks: list[str]) -> None:
        self.given = list(chunks)

    def __iter__(self) -> Iterator[str]:
        return iter(self.given)


@pytest.fixture
def session() -> Session:
    return make_session()


def _guard(
    session: Session, stream: Any, *, made_async: bool = False
) -> tuple[base.GuardedStream | base.GuardedAsyncStream, base.OuterCall]:
    mark = base.OuterCall()
    provider = LitellmProvider()
    provider.outer_call = mark
    options: dict[str, Any] = {
        "read_within": functools.partial(base.outer_intercept, mark),
        "sent_on_first_read": lambda s: not getattr(s, "sent", True),
    }
    if made_async:
        guard = base.call_stream_async(
            base._returning(stream), dict(KWARGS), session, provider, **options
        )

        async def _open() -> None:
            await guard.open()

        asyncio.run(_open())
        return guard, mark
    return (
        base.call_stream(
            base._returning(stream), dict(KWARGS), session, provider, **options
        ).open(),
        mark,
    )


def test_the_twin_is_an_instance_of_the_sdk_class_sharing_its_attributes(
    session: Session,
) -> None:
    stream = SDKStream(["a", "b"])
    guard, _mark = _guard(session, stream)
    twin = base.sdk_stream_twin(guard, sending=SENDING)
    assert isinstance(twin, SDKStream)
    assert type(twin) is not SDKStream
    assert (type(twin).__name__, type(twin).__qualname__) == ("SDKStream", "SDKStream")
    assert type(twin).__module__ == SDKStream.__module__
    assert repr(twin).split(" object at ", 1)[0] == repr(stream).split(" object at ", 1)[0]
    assert base.guard_of(twin) is guard
    # One attribute dictionary, holding nothing of the sensor's.
    assert vars(twin) is vars(stream)
    assert set(vars(twin)) == {
        "given",
        "position",
        "sent",
        "fail",
        "marks_at_send",
        "_hidden_params",
    }
    assert twin._hidden_params is stream._hidden_params
    twin._hidden_params = {"additional_headers": {}}
    assert stream._hidden_params == {"additional_headers": {}}
    stream.extra = 1
    assert twin.extra == 1
    # Built once per class.
    assert type(base.sdk_stream_twin(guard, sending=SENDING)) is type(twin)


@pytest.mark.parametrize("how", ["for", "async for"])
@pytest.mark.parametrize("made_async", [False, True], ids=["sync-made", "async-made"])
def test_reading_the_twin_either_way_is_metered_once(
    session: Session, how: str, made_async: bool
) -> None:
    stream = SDKStream(["a", "b", "c"])
    guard, _mark = _guard(session, stream, made_async=made_async)
    twin = base.sdk_stream_twin(guard, sending=SENDING)
    if how == "for":
        chunks = list(twin)
    else:

        async def _drain() -> list[str]:
            return [chunk async for chunk in twin]

        chunks = asyncio.run(_drain())
    assert chunks == ["a", "b", "c"]
    assert stream.position == 3
    (post_call,) = events_of(session, "post_call")
    assert post_call["streaming"]["chunk_count"] == 3
    assert post_call["streaming"]["final_outcome"] == "completed"


@pytest.mark.parametrize("is_async", [False, True], ids=["fetch_sync_stream", "fetch_stream"])
def test_a_fetch_sends_the_request_through_the_guard(session: Session, is_async: bool) -> None:
    """A stream that sends its request at its first read reports its call
    when the request leaves: a fetch is that moment, and it runs under the
    call's mark."""
    stream = SDKStream(["a"], lazy=True)
    guard, mark = _guard(session, stream, made_async=is_async)
    twin = base.sdk_stream_twin(guard, sending=SENDING)
    assert events_of(session, "pre_call") == []
    if is_async:
        assert asyncio.run(twin.fetch_stream()) is stream
    else:
        assert twin.fetch_sync_stream() is stream
    assert stream.marks_at_send == [mark]
    assert len(events_of(session, "pre_call")) == 1
    assert list(twin) == ["a"]
    assert len(events_of(session, "pre_call")) == 1
    assert len(events_of(session, "post_call")) == 1


@pytest.mark.parametrize("is_async", [False, True], ids=["fetch_sync_stream", "fetch_stream"])
def test_a_fetch_that_fails_is_the_calls_llm_error(session: Session, is_async: bool) -> None:
    failure = ConnectionError("refused")
    stream = SDKStream(["a"], lazy=True, fail=failure)
    guard, _mark = _guard(session, stream, made_async=is_async)
    twin = base.sdk_stream_twin(guard, sending=SENDING)
    with pytest.raises(ConnectionError) as raised:
        if is_async:
            asyncio.run(twin.fetch_stream())
        else:
            twin.fetch_sync_stream()
    assert raised.value is failure
    assert len(events_of(session, "pre_call")) == 1
    assert len(events_of(session, "llm_error")) == 1
    assert events_of(session, "post_call") == []


def test_a_twin_dropped_mid_read_is_settled_without_the_cyclic_collector(
    session: Session,
) -> None:
    """The guard is in a slot of the twin, outside the shared dictionary,
    so the stream holds no reference back to it: dropping the twin frees
    the guard, and the stream with it, at once. The stream's own finalizer
    runs once."""
    before = SDKStream.finalized
    gc.disable()
    try:
        stream = SDKStream(["a", "b"])
        guard, _mark = _guard(session, stream)
        twin = base.sdk_stream_twin(guard, sending=SENDING)
        assert next(twin) == "a"
        del guard, stream, twin
        base.drain_deferred_settles(session)
        (post_call,) = events_of(session, "post_call")
        assert post_call["streaming"]["final_outcome"] == "aborted"
        assert post_call["streaming"]["chunk_count"] == 1
        assert SDKStream.finalized == before + 1
    finally:
        gc.enable()


def test_a_copy_reads_as_the_sdk_streams_copy(session: Session) -> None:
    stream = SDKStream(["a", "b"])
    guard, _mark = _guard(session, stream)
    twin = base.sdk_stream_twin(guard, sending=SENDING)
    copied = copy.copy(twin)
    assert type(copied) is type(twin)
    assert vars(copied) is not vars(twin)
    assert list(copied) == ["a", "b"]
    assert stream.position == 0
    assert list(twin) == ["a", "b"]
    # The copy shares the call's accounting: one call, reported once.
    assert len(events_of(session, "post_call")) == 1


def test_a_deep_copy_or_a_pickle_is_the_sdk_streams(session: Session) -> None:
    stream = SDKStream(["a"])
    guard, _mark = _guard(session, stream)
    twin = base.sdk_stream_twin(guard, sending=SENDING)
    deep = copy.deepcopy(twin)
    assert type(deep) is SDKStream
    assert deep.given == ["a"]
    restored = pickle.loads(pickle.dumps(twin))
    assert type(restored) is SDKStream
    assert restored._hidden_params == stream._hidden_params


@pytest.mark.parametrize("stream_type", [SlottedStream, IterableOnly])
def test_a_class_that_cannot_share_its_state_or_is_no_iterator_is_not_twinned(
    session: Session, stream_type: type
) -> None:
    """Such a stream is handed over as :func:`base.protocol_view` hands it:
    a slotted iterator as a view with its name and iteration protocol, an
    iterable that is no iterator as the guard, both read through the
    guard."""
    guard, _mark = _guard(session, stream_type(["a", "b"]))
    assert base.sdk_stream_twin(guard, sending=SENDING) is None
    handed = _handed_over(guard)
    assert base.guard_of(handed) is guard
    if stream_type is SlottedStream:
        assert type(handed).__name__ == "SlottedStream"
    assert list(handed) == ["a", "b"]
    assert len(events_of(session, "post_call")) == 1
