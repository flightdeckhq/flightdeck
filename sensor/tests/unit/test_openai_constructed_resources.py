"""The OpenAI class patch on SDKs whose client builds its resources in the
constructor (``self.chat = resources.Chat(self)``, openai before 1.78),
where there is no ``cached_property`` for the patch to replace.

Three groups of tests:

* the data descriptor itself, on a stand-in client class with that
  layout, so its semantics are pinned whatever SDK is installed;
* the real SDK installed in the lane, driven over respx: a plain,
  streamed and async chat call and an embeddings call are each metered
  once. The framework and SDK-majors lanes run them on the lazy
  ``cached_property`` layout, the OpenAI-floor lane (openai 1.26) on the
  constructor-built one;
* the floor: an SDK whose chat ``create`` takes no ``stream_options`` is
  left unpatched, with a warning.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import sys
import types
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor import openai as openai_interceptor
from flightdeck_sensor.interceptor.openai import (
    SensorChat,
    SensorEmbeddings,
    _OpenAIConstructedResourceDescriptor,
    _patch_one_resource,
    _unpatch_one_resource,
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Iterator

# Whether the installed SDK's client builds ``chat`` in its constructor.
EAGER_SDK = "chat" not in openai.OpenAI.__dict__

MODEL = "gpt-4o-mini"
USAGE = {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}
OPENAI_URL = "https://api.openai.com/v1"
MESSAGES = [{"role": "user", "content": "hello"}]


# Self-contained rather than shared with the other OpenAI test modules:
# the OpenAI-floor CI lane installs openai alone, and those modules
# import anthropic.
def _session(capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def _events_of(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    events = [c.args[0] for c in queue.enqueue.call_args_list]
    return [e for e in events if e.get("event_type") == event_type]


def _sse(frames: list[dict[str, Any]]) -> httpx.Response:
    body = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames)
    body += "data: [DONE]\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


# ----- the descriptor, on a stand-in client ----------------------------------


class _Resource:
    """Stands in for an SDK resource (``Chat``, ``Embeddings``)."""

    def __init__(self, client: Any) -> None:
        self._client = client


class _EagerClient:
    """A client class with the layout of openai before 1.78: each resource
    is annotated on the class and assigned in ``__init__``."""

    chat: _Resource
    embeddings: _Resource

    def __init__(self) -> None:
        self.chat = _Resource(self)
        self.embeddings = _Resource(self)


_SENTINEL = "_flightdeck_test_sentinel"


def _patch_stand_in(cls: type, attr_name: str = "chat", wrapper_cls: type = SensorChat) -> None:
    _patch_one_resource(
        cls,
        attr_name=attr_name,
        sentinel_attr=_SENTINEL,
        descriptor_cls=openai_interceptor._OpenAIChatDescriptor,
        is_async=False,
        quiet=True,
        wrapper_cls=wrapper_cls,
    )


@pytest.fixture
def stand_in() -> Iterator[type]:
    """A fresh stand-in client class per test, so a patch never leaks."""

    class Client(_EagerClient):
        pass

    # Annotations are read from the class itself, as on the SDK's client.
    Client.__annotations__ = dict(_EagerClient.__annotations__)
    yield Client


def _activate(monkeypatch: pytest.MonkeyPatch, capture: bool = True) -> Session:
    session = _session(capture)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    return session


def test_patch_installs_a_data_descriptor_for_a_resource_built_in_the_constructor(
    stand_in: type,
) -> None:
    _patch_stand_in(stand_in)

    descriptor = stand_in.__dict__["chat"]
    assert isinstance(descriptor, _OpenAIConstructedResourceDescriptor)
    assert getattr(stand_in, _SENTINEL) == openai_interceptor._CONSTRUCTED_RESOURCE
    # A data descriptor, so Python consults it before the instance dict.
    assert hasattr(type(descriptor), "__set__")


def test_a_session_gets_the_same_sensor_proxy_over_the_clients_own_resource(
    stand_in: type, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_stand_in(stand_in)
    session = _activate(monkeypatch)
    client = stand_in()
    raw = client.__dict__["chat"]

    proxy = client.chat
    assert isinstance(proxy, SensorChat)
    assert proxy._real is raw
    assert proxy._session is session
    assert client.chat is proxy


def test_no_session_hands_out_the_resource_and_keeps_no_proxy(stand_in: type) -> None:
    _patch_stand_in(stand_in)
    assert flightdeck_sensor._session is None
    client = stand_in()

    assert client.chat is client.__dict__["chat"]
    assert openai_interceptor._CONSTRUCTED_PROXIES_ATTR not in client.__dict__


def test_a_new_session_gets_a_new_proxy(stand_in: type, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_stand_in(stand_in)
    _activate(monkeypatch)
    client = stand_in()
    first = client.chat

    second_session = _activate(monkeypatch)
    second = client.chat
    assert second is not first
    assert second._session is second_session


def test_reassigning_the_resource_rebuilds_the_proxy(
    stand_in: type, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_stand_in(stand_in)
    _activate(monkeypatch)
    client = stand_in()
    first = client.chat

    replacement = _Resource(client)
    client.chat = replacement
    assert client.__dict__["chat"] is replacement
    assert client.chat._real is replacement
    assert client.chat is not first


def test_a_client_built_before_the_patch_is_metered_from_its_next_access(
    stand_in: type, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = stand_in()
    raw = client.chat  # built and touched before the patch
    _patch_stand_in(stand_in)
    _activate(monkeypatch)

    assert isinstance(client.chat, SensorChat)
    assert client.chat._real is raw


def test_delete_removes_the_resource(stand_in: type) -> None:
    _patch_stand_in(stand_in)
    client = stand_in()
    del client.chat
    assert "chat" not in client.__dict__
    with pytest.raises(AttributeError):
        _ = client.chat
    with pytest.raises(AttributeError):
        del client.chat


def test_unpatch_deletes_the_descriptor_and_every_client_keeps_its_resource(
    stand_in: type, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_stand_in(stand_in)
    _activate(monkeypatch)
    client = stand_in()
    raw = client.__dict__["chat"]
    assert isinstance(client.chat, SensorChat)

    _unpatch_one_resource(stand_in, attr_name="chat", sentinel_attr=_SENTINEL)
    assert "chat" not in stand_in.__dict__
    assert not hasattr(stand_in, _SENTINEL)
    assert client.chat is raw
    assert stand_in().chat.__class__ is _Resource


def test_patch_is_idempotent(stand_in: type) -> None:
    _patch_stand_in(stand_in)
    descriptor = stand_in.__dict__["chat"]
    _patch_stand_in(stand_in)
    assert stand_in.__dict__["chat"] is descriptor


def test_a_resource_the_class_does_not_declare_is_left_alone(stand_in: type) -> None:
    # ``responses`` before openai 1.66: neither a descriptor nor an
    # annotation on the client class.
    _patch_stand_in(stand_in, attr_name="responses")
    assert "responses" not in stand_in.__dict__
    assert not hasattr(stand_in, _SENTINEL)


def test_each_resource_gets_its_own_proxy_class(
    stand_in: type, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_one_resource(
        stand_in,
        attr_name="embeddings",
        sentinel_attr="_flightdeck_test_embeddings",
        descriptor_cls=openai_interceptor._OpenAIEmbeddingsDescriptor,
        is_async=True,
        quiet=True,
        wrapper_cls=SensorEmbeddings,
    )
    _activate(monkeypatch)
    proxy = stand_in().embeddings
    assert isinstance(proxy, SensorEmbeddings)
    assert proxy._is_async is True


# ----- the installed SDK -----------------------------------------------------


@pytest.fixture
def patched() -> Iterator[None]:
    patch_openai_classes(quiet=True)
    yield
    unpatch_openai_classes()


def _completion() -> dict[str, Any]:
    return {
        "id": "chatcmpl-eager-1",
        "object": "chat.completion",
        "created": 1,
        "model": MODEL,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hi"},
                "finish_reason": "stop",
            }
        ],
        "usage": USAGE,
    }


def _chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-eager-1",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _stream_response() -> httpx.Response:
    usage_chunk = {**_chunk({}), "choices": [], "usage": USAGE}
    return _sse([_chunk({"role": "assistant", "content": "hi"}), _chunk({}, "stop"), usage_chunk])


def _client(is_async: bool) -> Any:
    if is_async:
        return openai.AsyncOpenAI(api_key="sk-test", max_retries=0)
    return openai.OpenAI(api_key="sk-test", max_retries=0)


def _run(call: Any, is_async: bool) -> Any:
    if not is_async:
        return call
    return asyncio.run(_awaited(call))


async def _awaited(call: Any) -> Any:
    return await call


def _assert_one_metered_call(session: Session) -> None:
    post_calls = _events_of(session, "post_call")
    assert len(post_calls) == 1
    assert post_calls[0]["tokens_input"] == USAGE["prompt_tokens"]
    assert post_calls[0]["tokens_output"] == USAGE["completion_tokens"]


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_chat_create_is_metered_once(
    patched: None, monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    session = _activate(monkeypatch)
    with respx.mock(base_url=OPENAI_URL) as router:
        route = router.post("/chat/completions").mock(
            return_value=httpx.Response(200, json=_completion())
        )
        completion = _run(
            _client(is_async).chat.completions.create(model=MODEL, messages=MESSAGES),
            is_async,
        )

    assert completion.choices[0].message.content == "hi"
    assert route.call_count == 1
    _assert_one_metered_call(session)


def test_streamed_chat_is_metered_from_its_usage_chunk(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _activate(monkeypatch)
    with respx.mock(base_url=OPENAI_URL) as router:
        route = router.post("/chat/completions").mock(return_value=_stream_response())
        stream = _client(False).chat.completions.create(model=MODEL, messages=MESSAGES, stream=True)
        text = "".join(chunk.choices[0].delta.content or "" for chunk in stream)

    assert text == "hi"
    sent = json.loads(route.calls.last.request.content)
    assert sent["stream_options"] == {"include_usage": True}
    _assert_one_metered_call(session)


def test_async_streamed_chat_is_metered_from_its_usage_chunk(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _activate(monkeypatch)

    async def _consume() -> str:
        stream = await _client(True).chat.completions.create(
            model=MODEL, messages=MESSAGES, stream=True
        )
        return "".join([chunk.choices[0].delta.content or "" async for chunk in stream])

    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=_stream_response())
        text = asyncio.run(_consume())

    assert text == "hi"
    _assert_one_metered_call(session)


def test_embeddings_are_metered_once(patched: None, monkeypatch: pytest.MonkeyPatch) -> None:
    session = _activate(monkeypatch)
    body = {
        "object": "list",
        "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}],
        "model": "text-embedding-3-small",
        "usage": {"prompt_tokens": 4, "total_tokens": 4},
    }
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/embeddings").mock(return_value=httpx.Response(200, json=body))
        _client(False).embeddings.create(model="text-embedding-3-small", input="x")

    events = _events_of(session, "embeddings")
    assert len(events) == 1
    assert events[0]["tokens_input"] == 4


def test_the_raw_view_on_the_resource_is_metered_once(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = _activate(monkeypatch)
    with respx.mock(base_url=OPENAI_URL) as router:
        router.post("/chat/completions").mock(return_value=httpx.Response(200, json=_completion()))
        raw = _client(False).chat.completions.with_raw_response.create(
            model=MODEL, messages=MESSAGES
        )

    assert raw.parse().choices[0].message.content == "hi"
    _assert_one_metered_call(session)


def test_the_chat_resource_is_one_object_per_session(
    patched: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _activate(monkeypatch)
    client = _client(False)
    assert isinstance(client.chat, SensorChat)
    assert client.chat is client.chat


def test_unpatch_hands_back_the_sdks_own_chat_resource(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_openai_classes(quiet=True)
    _activate(monkeypatch)
    client = _client(False)
    assert isinstance(client.chat, SensorChat)
    unpatch_openai_classes()

    assert not isinstance(_client(False).chat, SensorChat)
    if EAGER_SDK:
        # The resource lives in the instance dict, so an existing client
        # gets its own back too.
        assert not isinstance(client.chat, SensorChat)
        assert "chat" not in openai.OpenAI.__dict__


@pytest.mark.skipif(not EAGER_SDK, reason="the installed openai builds chat lazily")
def test_a_client_built_before_the_patch_is_metered(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(False)
    _ = client.chat  # touched before the patch
    patch_openai_classes(quiet=True)
    try:
        session = _activate(monkeypatch)
        with respx.mock(base_url=OPENAI_URL) as router:
            router.post("/chat/completions").mock(
                return_value=httpx.Response(200, json=_completion())
            )
            client.chat.completions.create(model=MODEL, messages=MESSAGES)
        _assert_one_metered_call(session)
    finally:
        unpatch_openai_classes()


def test_every_client_resource_the_sdk_has_is_patched(patched: None) -> None:
    """Layout canary: ``chat`` and ``embeddings`` (and ``responses`` where
    the SDK has it) are patched on both client classes, whichever layout
    the installed SDK uses. An SDK that moves its resources somewhere the
    patch does not look fails here rather than going unmetered."""
    expected = {
        "chat": openai_interceptor._OpenAIChatDescriptor,
        "embeddings": openai_interceptor._OpenAIEmbeddingsDescriptor,
    }
    if hasattr(openai.OpenAI(api_key="sk-test"), "responses"):
        expected["responses"] = openai_interceptor._OpenAIResponsesDescriptor
    for cls in (openai.OpenAI, openai.AsyncOpenAI):
        for name, lazy_descriptor in expected.items():
            descriptor = cls.__dict__.get(name)
            want = _OpenAIConstructedResourceDescriptor if EAGER_SDK else lazy_descriptor
            assert isinstance(descriptor, want), f"{cls.__name__}.{name}: {descriptor!r}"


def test_the_installed_sdk_is_at_or_above_the_floor() -> None:
    assert openai_interceptor._OPENAI_AVAILABLE
    assert openai_interceptor._chat_create_takes_stream_options(openai)


# ----- the floor -------------------------------------------------------------


def _stub_openai(create: Any) -> types.ModuleType:
    """A stand-in ``openai`` module whose chat ``create`` is ``create``."""

    class Completions:
        pass

    Completions.create = create  # type: ignore[attr-defined]
    stub = types.ModuleType("openai")
    stub.__version__ = "1.25.0"  # type: ignore[attr-defined]
    stub.OpenAI = type("OpenAI", (), {})  # type: ignore[attr-defined]
    stub.AsyncOpenAI = type("AsyncOpenAI", (), {})  # type: ignore[attr-defined]
    stub.resources = types.SimpleNamespace(  # type: ignore[attr-defined]
        chat=types.SimpleNamespace(Completions=Completions)
    )
    return stub


def _old_create(self: Any, *, messages: Any, model: Any, stream: Any = None) -> Any:
    raise AssertionError("never called")


def _new_create(
    self: Any, *, messages: Any, model: Any, stream: Any = None, stream_options: Any = None
) -> Any:
    raise AssertionError("never called")


def test_stream_options_detection() -> None:
    assert openai_interceptor._chat_create_takes_stream_options(_stub_openai(_new_create))
    assert not openai_interceptor._chat_create_takes_stream_options(_stub_openai(_old_create))
    assert not openai_interceptor._chat_create_takes_stream_options(types.ModuleType("openai"))


def _load_interceptor_against(stub: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> Any:
    """A fresh copy of the interceptor module, imported with ``stub`` as
    ``openai``; the module the sensor uses is untouched."""
    monkeypatch.setitem(sys.modules, "openai", stub)
    spec = importlib.util.spec_from_file_location(
        "_flightdeck_openai_interceptor_floor_copy", openai_interceptor.__file__
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_an_sdk_below_the_floor_is_left_unpatched_with_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    stub = _stub_openai(_old_create)
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.interceptor.openai"):
        module = _load_interceptor_against(stub, monkeypatch)

    assert module._OPENAI_AVAILABLE is False
    assert module._OrigOpenAI is None
    assert module._OrigAsyncOpenAI is None
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("1.25.0" in m and "openai>=1.26" in m for m in warnings), warnings

    module.patch_openai_classes(quiet=True)
    assert "chat" not in stub.OpenAI.__dict__


def test_an_sdk_at_the_floor_loads_without_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    stub = _stub_openai(_new_create)
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor.interceptor.openai"):
        module = _load_interceptor_against(stub, monkeypatch)

    assert module._OPENAI_AVAILABLE is True
    assert module._OrigOpenAI is stub.OpenAI
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
