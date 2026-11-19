"""The OpenAI interceptor's litellm request hook: it acts only on the
provider request litellm's own request code sends through the SDK while
that litellm call is in flight, and the counts it hands over belong to
that one call.

- Any other SDK call made under a litellm call's mark (a litellm
  callback, guardrail or health check; code of the caller's own) is sent
  as written and leaves the call's slot alone.
- Each request the hook takes starts the slot afresh, so an earlier
  attempt's counts never reach the call's report; a litellm fallback
  reports the model that answered with its counts.
- A litellm call made inside another (from code litellm runs while the
  outer request is being sent, or from the caller's loop between reads,
  or concurrently in tasks and threads) has a slot of its own.
- What is stored: the provider's usage object as returned (capture on);
  nothing stored or logged with capture off.
- A direct call to the SDK's legacy ``completions.create`` (no litellm
  call in flight) is sent and read exactly as without the sensor, with
  or without a session, and reports nothing, as before the hook.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

import pytest

litellm = pytest.importorskip("litellm")

import httpx  # noqa: E402
import openai  # noqa: E402

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

from ._stream_parity_fakes import (  # noqa: E402
    MESSAGES,
    OPENAI_USAGE,
    OpenAIServer,
    collected,
    events_of,
    full_dump,
    make_session,
    only_new_objects_collected,
    openai_usage_body,
    set_dump,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

litellm.suppress_debug_info = True

COMPAT = {"api_base": "https://llm.internal.example/v1", "api_key": "test"}


@pytest.fixture(scope="module", autouse=True)
def _collections_scan_what_the_tests_made() -> Iterator[None]:
    with only_new_objects_collected():
        yield


@pytest.fixture(autouse=True)
def _nothing_left_for_a_later_test() -> Iterator[None]:
    """What a test made is collected before it ends (``collected``): a
    test that leaves anything that warns when collected fails here rather
    than a later test that turns warnings into errors."""
    with collected() as left:
        yield
    assert not left, left


@pytest.fixture
def patched() -> Iterator[None]:
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    yield
    unpatch_litellm_functions(quiet=True)
    unpatch_openai_classes()


class CountingServer:
    """An OpenAI-compatible chat server that streams the request's model
    back with ``usage`` counts of its own: the usage chunk when asked, or,
    with ``on_every_chunk``, usage on every chunk (as vLLM's continuous
    usage stats do). ``fail_mid_stream`` ends the stream with an error
    event after two chunks. ``during`` runs while the request is served."""

    def __init__(
        self,
        usage: tuple[int, int],
        *,
        on_every_chunk: bool = False,
        fail_mid_stream: bool = False,
        during: Callable[[], Any] | None = None,
    ) -> None:
        self.usage = usage
        self.on_every_chunk = on_every_chunk
        self.fail_mid_stream = fail_mid_stream
        self.during = during
        self.bodies: list[dict[str, Any]] = []

    def _usage(self, completion: int) -> dict[str, int]:
        prompt = self.usage[0]
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
        }

    def _response(self, body: dict[str, Any]) -> httpx.Response:
        model = body["model"]
        asked = bool((body.get("stream_options") or {}).get("include_usage"))
        head = {"id": "c", "created": 1, "object": "chat.completion.chunk", "model": model}
        events: list[dict[str, Any]] = []
        pieces = [("Hel", None), ("lo", None)]
        if not self.fail_mid_stream:
            pieces.append(("", "stop"))
        for n, (text, reason) in enumerate(pieces, start=1):
            event: dict[str, Any] = {
                **head,
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": reason}],
            }
            if self.on_every_chunk:
                event["usage"] = self._usage(n)
            elif asked:
                event["usage"] = None
            events.append(event)
        if self.fail_mid_stream:
            events.append({"error": {"message": "mid-stream failure", "type": "server_error"}})
        elif asked and not self.on_every_chunk:
            events.append({**head, "choices": [], "usage": self._usage(self.usage[1])})
        data = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
        return httpx.Response(
            200, content=data.encode(), headers={"content-type": "text/event-stream"}
        )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        if self.during is not None:
            self.during()
        return self._response(body)


class AsyncCountingServer(CountingServer):
    """:class:`CountingServer` for an async client: ``during`` is awaited."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:  # type: ignore[override]
        body = json.loads(request.content)
        self.bodies.append(body)
        if self.during is not None:
            await self.during()
        return self._response(body)


def _client(server: Any, is_async: bool) -> Any:
    transport = httpx.MockTransport(server)
    if is_async:
        return openai.AsyncOpenAI(
            api_key="test", http_client=httpx.AsyncClient(transport=transport), max_retries=0
        )
    return openai.OpenAI(
        api_key="test", http_client=httpx.Client(transport=transport), max_retries=0
    )


def _post_calls_by_model(session: Any) -> dict[str, tuple[int, int]]:
    return {
        e["model"]: (e["tokens_input"], e["tokens_output"]) for e in events_of(session, "post_call")
    }


# ----- only litellm's provider request code is touched ----------------------


def _function_in(module: str, name: str, *, is_async: bool) -> Callable[..., Any]:
    """A function whose frame reads as ``module.name``: the code the hook
    sees as the caller of the SDK."""
    if is_async:
        source = (
            f"async def {name}(create, kwargs):\n"
            "    stream = await create(**kwargs)\n"
            "    return [chunk async for chunk in stream]\n"
        )
    else:
        source = f"def {name}(create, kwargs):\n    return list(create(**kwargs))\n"
    namespace: dict[str, Any] = {"__name__": module}
    exec(compile(source, f"<{module}>", "exec"), namespace)  # noqa: S102
    return namespace[name]  # type: ignore[no-any-return]


# (module, function) of SDK callers that are not litellm's provider request.
NOT_THE_REQUEST = {
    "a litellm guardrail": ("litellm.proxy.guardrails.guardrail_hooks.custom", "moderate"),
    "a litellm health check": ("litellm.proxy.health_check", "_perform_health_check"),
    "a non-request function of a request module": ("litellm.llms.azure.azure", "get_headers"),
    "a litellm callback": ("litellm.integrations.custom_logger", "log_pre_api_call"),
    "the caller's own code": ("myapp.agent", "summarise"),
}
THE_REQUEST = {
    "litellm's chat request": (
        "litellm.llms.openai.openai",
        "make_sync_openai_chat_completion_request",
        "make_openai_chat_completion_request",
    ),
    "litellm's legacy completion request": (
        "litellm.llms.openai.completion.handler",
        "streaming",
        "async_streaming",
    ),
}


def _request_kwargs(legacy: bool) -> dict[str, Any]:
    if legacy:
        return {"model": "gpt-3.5-turbo-instruct", "prompt": "hi", "stream": True}
    return {"model": "gpt-4o-mini", "messages": MESSAGES, "stream": True}


def _send_under_a_mark(
    module: str, name: str, *, legacy: bool, is_async: bool
) -> tuple[list[Any], OpenAIServer, base.OuterCall]:
    server = OpenAIServer()
    client = _client(server, is_async)
    create = client.completions.create if legacy else client.chat.completions.create
    sender = _function_in(module, name, is_async=is_async)
    mark = base.OuterCall()
    with base.outer_intercept(mark):
        if is_async:
            chunks = asyncio.run(sender(create, _request_kwargs(legacy)))
        else:
            chunks = sender(create, _request_kwargs(legacy))
    return chunks, server, mark


@pytest.mark.usefixtures("patched")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("legacy", [False, True], ids=["chat", "legacy"])
@pytest.mark.parametrize("caller", list(NOT_THE_REQUEST))
def test_an_sdk_call_under_a_litellm_call_that_is_not_its_request_is_left_alone(
    caller: str, legacy: bool, is_async: bool
) -> None:
    """Sent as written, read as the SDK reads it, and the call's slot is
    left as it was."""
    module, name = NOT_THE_REQUEST[caller]
    chunks, server, mark = _send_under_a_mark(module, name, legacy=legacy, is_async=is_async)
    (body,) = server.bodies
    assert "stream_options" not in body
    assert all(getattr(c, "usage", None) is None for c in chunks)
    assert (mark.usage, mark.returned_usage, mark.sent_through_sdk) == (None, None, False)


@pytest.mark.usefixtures("patched")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("request_code", list(THE_REQUEST))
def test_litellms_provider_request_is_asked_for_usage_and_hands_it_over(
    request_code: str, is_async: bool
) -> None:
    """The control for the test above: the same SDK call from litellm's
    provider request code is asked for usage, the usage chunk is taken
    out, and the counts are left on the call's slot."""
    module, sync_name, async_name = THE_REQUEST[request_code]
    legacy = request_code == "litellm's legacy completion request"
    chunks, server, mark = _send_under_a_mark(
        module, async_name if is_async else sync_name, legacy=legacy, is_async=is_async
    )
    (body,) = server.bodies
    assert body["stream_options"] == {"include_usage": True}
    assert all(getattr(c, "usage", None) is None for c in chunks)
    assert mark.sent_through_sdk is True
    assert mark.usage is not None
    assert (mark.usage.input_tokens, mark.usage.output_tokens) == OPENAI_USAGE
    assert mark.returned_usage == openai_usage_body()


@pytest.mark.usefixtures("patched")
def test_each_request_starts_the_calls_slot_afresh() -> None:
    """A request that failed mid-stream after reporting usage on its chunks,
    then a second request under the same call: the slot holds the second
    request's counts only."""
    request = _function_in(
        "litellm.llms.openai.openai", "make_sync_openai_chat_completion_request", is_async=False
    )
    failing = CountingServer((99, 0), on_every_chunk=True, fail_mid_stream=True)
    answering = CountingServer(OPENAI_USAGE)
    mark = base.OuterCall()
    with base.outer_intercept(mark):
        with pytest.raises(openai.APIError):
            request(_client(failing, False).chat.completions.create, _request_kwargs(False))
        assert mark.usage is not None
        assert (mark.usage.input_tokens, mark.usage.output_tokens) == (99, 2)
        request(_client(answering, False).chat.completions.create, _request_kwargs(False))
    assert mark.usage is not None
    assert (mark.usage.input_tokens, mark.usage.output_tokens) == OPENAI_USAGE
    assert mark.returned_usage == {
        "prompt_tokens": 11,
        "completion_tokens": 7,
        "total_tokens": 18,
    }


# ----- litellm fallbacks ------------------------------------------------------


def _fallback_call(first: CountingServer, answering: CountingServer) -> dict[str, Any]:
    return {
        "model": "openai/first",
        "messages": MESSAGES,
        "stream": True,
        "num_retries": 0,
        "client": _client(first, True),
        **COMPAT,
        "fallbacks": [{"model": "openai/second", "client": _client(answering, True), **COMPAT}],
    }


async def _drain(stream: Any) -> str:
    return "".join([(c.choices[0].delta.content or "") async for c in stream if c.choices])


@pytest.mark.usefixtures("patched")
def test_a_fallback_after_a_failed_request_reports_the_model_that_answered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first attempt fails at its request; the fallback answers. One
    call: one ``pre_call`` and one ``post_call``, with the answering
    model and its counts, and no ``llm_error`` for the failed attempt."""

    class Refusing(CountingServer):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            self.bodies.append(json.loads(request.content))
            return httpx.Response(500, json={"error": {"message": "x", "type": "server_error"}})

    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    first, answering = Refusing((99, 99), on_every_chunk=True), CountingServer(OPENAI_USAGE)

    async def _go() -> str:
        return await _drain(await litellm.acompletion(**_fallback_call(first, answering)))

    assert asyncio.run(_go()) == "Hello"
    assert [b["model"] for b in first.bodies + answering.bodies] == ["first", "second"]
    assert len(events_of(session, "pre_call")) == 1
    assert events_of(session, "llm_error") == []
    assert _post_calls_by_model(session) == {"second": OPENAI_USAGE}


@pytest.mark.usefixtures("patched")
def test_a_stream_that_fails_mid_way_reports_its_own_partial_counts_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """litellm does not fall back once its stream is handed over: the
    caller gets the error after the chunks it read, as without the
    sensor, and the call's ``llm_error`` carries the partial counts that
    attempt reported, nothing else."""
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    first = CountingServer((99, 0), on_every_chunk=True, fail_mid_stream=True)
    answering = CountingServer(OPENAI_USAGE)
    read: list[str] = []

    async def _go() -> None:
        stream = await litellm.acompletion(**_fallback_call(first, answering))
        async for chunk in stream:
            read.append(chunk.choices[0].delta.content or "")

    with pytest.raises(Exception, match="mid-stream failure"):
        asyncio.run(_go())
    assert "".join(read) == "Hello"
    assert answering.bodies == []
    assert events_of(session, "post_call") == []
    (error,) = events_of(session, "llm_error")
    assert (error["error"]["partial_tokens_input"], error["error"]["partial_tokens_output"]) == (
        99,
        2,
    )


# ----- a litellm call inside another ------------------------------------------


def _nested_sync(usage: tuple[int, int]) -> Callable[[], None]:
    def _call() -> None:
        server = CountingServer(usage)
        stream = litellm.completion(
            model="openai/inner",
            messages=MESSAGES,
            stream=True,
            client=_client(server, False),
            **COMPAT,
        )
        assert "".join((c.choices[0].delta.content or "") for c in stream if c.choices) == "Hello"

    return _call


@pytest.mark.usefixtures("patched")
def test_a_litellm_call_made_while_the_outer_request_is_sent_has_a_slot_of_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Code litellm runs while sending the outer request (here the
    transport, as a callback would) makes a litellm stream call of its
    own: each call reports its own provider's counts."""
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    outer = CountingServer(OPENAI_USAGE, during=_nested_sync((31, 2)))
    stream = litellm.completion(
        model="openai/outer", messages=MESSAGES, stream=True, client=_client(outer, False), **COMPAT
    )
    assert "".join((c.choices[0].delta.content or "") for c in stream if c.choices) == "Hello"
    assert _post_calls_by_model(session) == {"outer": OPENAI_USAGE, "inner": (31, 2)}


@pytest.mark.usefixtures("patched")
def test_an_async_litellm_call_made_while_the_outer_request_is_sent_has_a_slot_of_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)

    async def _inner() -> None:
        server = CountingServer((31, 2))
        stream = await litellm.acompletion(
            model="openai/inner",
            messages=MESSAGES,
            stream=True,
            client=_client(server, True),
            **COMPAT,
        )
        assert await _drain(stream) == "Hello"

    outer = AsyncCountingServer(OPENAI_USAGE, during=_inner)

    async def _go() -> str:
        stream = await litellm.acompletion(
            model="openai/outer",
            messages=MESSAGES,
            stream=True,
            client=_client(outer, True),
            **COMPAT,
        )
        return await _drain(stream)

    assert asyncio.run(_go()) == "Hello"
    assert _post_calls_by_model(session) == {"outer": OPENAI_USAGE, "inner": (31, 2)}


@pytest.mark.usefixtures("patched")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_litellm_call_made_between_reads_of_another_has_a_slot_of_its_own(
    monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    """A tool the caller runs between two reads of a stream makes a litellm
    stream call of its own."""
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    kwargs = {"messages": MESSAGES, "stream": True, **COMPAT}
    if not is_async:
        outer = litellm.completion(
            model="openai/outer", client=_client(CountingServer(OPENAI_USAGE), False), **kwargs
        )
        text = []
        for chunk in outer:
            if chunk.choices and chunk.choices[0].delta.content == "Hel":
                _nested_sync((31, 2))()
            text.append(chunk.choices[0].delta.content or "" if chunk.choices else "")
    else:

        async def _go() -> list[str]:
            outer = await litellm.acompletion(
                model="openai/outer", client=_client(CountingServer(OPENAI_USAGE), True), **kwargs
            )
            read = []
            async for chunk in outer:
                if chunk.choices and chunk.choices[0].delta.content == "Hel":
                    inner = await litellm.acompletion(
                        model="openai/inner",
                        client=_client(CountingServer((31, 2)), True),
                        **kwargs,
                    )
                    assert await _drain(inner) == "Hello"
                read.append(chunk.choices[0].delta.content or "" if chunk.choices else "")
            return read

        text = asyncio.run(_go())
    assert "".join(text) == "Hello"
    assert _post_calls_by_model(session) == {"outer": OPENAI_USAGE, "inner": (31, 2)}


CONCURRENT_CALLS = 8


@pytest.mark.usefixtures("patched")
def test_concurrent_litellm_tasks_each_report_their_own_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)

    async def _one(i: int) -> None:
        stream = await litellm.acompletion(
            model=f"openai/m{i}",
            messages=MESSAGES,
            stream=True,
            client=_client(CountingServer((20 + i, 1 + i)), True),
            **COMPAT,
        )
        async for _chunk in stream:
            await asyncio.sleep(0)

    async def _all() -> None:
        await asyncio.gather(*(_one(i) for i in range(CONCURRENT_CALLS)))

    asyncio.run(_all())
    assert _post_calls_by_model(session) == {
        f"m{i}": (20 + i, 1 + i) for i in range(CONCURRENT_CALLS)
    }


@pytest.mark.usefixtures("patched")
def test_concurrent_litellm_threads_each_report_their_own_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    started = threading.Barrier(CONCURRENT_CALLS)

    def _one(i: int) -> None:
        stream = litellm.completion(
            model=f"openai/m{i}",
            messages=MESSAGES,
            stream=True,
            client=_client(CountingServer((20 + i, 1 + i)), False),
            **COMPAT,
        )
        started.wait()
        for _chunk in stream:
            pass

    with ThreadPoolExecutor(max_workers=CONCURRENT_CALLS) as pool:
        list(pool.map(_one, range(CONCURRENT_CALLS)))
    assert _post_calls_by_model(session) == {
        f"m{i}": (20 + i, 1 + i) for i in range(CONCURRENT_CALLS)
    }


# ----- what is stored ---------------------------------------------------------


def _compat_stream(is_async: bool, prompt: str) -> str:
    server = OpenAIServer()
    kwargs = {
        "model": "openai/my-model",
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "client": _client(server, is_async),
        **COMPAT,
    }
    if not is_async:
        return "".join(
            (c.choices[0].delta.content or "") for c in litellm.completion(**kwargs) if c.choices
        )

    async def _go() -> str:
        return await _drain(await litellm.acompletion(**kwargs))

    return asyncio.run(_go())


@pytest.mark.usefixtures("patched")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_the_stored_response_carries_the_usage_object_the_provider_returned(
    monkeypatch: pytest.MonkeyPatch, is_async: bool
) -> None:
    """On an OpenAI-compatible base litellm does not ask for usage, so the
    hook asks and takes the usage chunk out before litellm reads the
    stream: litellm's assembled response has no provider usage, and the
    stored response carries the usage object the provider returned, with
    the fields it returned."""
    session = make_session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    assert _compat_stream(is_async, "hi") == "Hello"
    (post_call,) = events_of(session, "post_call")
    assert post_call["content"]["response"]["usage"] == openai_usage_body()
    assert post_call["content"]["response"]["choices"][0]["message"]["content"] == "Hello"


@pytest.mark.usefixtures("patched")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize(
    ("stream_options", "extra_body"),
    [
        (None, None),
        ({"include_usage": True}, None),
        ({"include_usage": False}, None),
        (None, {"stream_options": {"include_usage": True}}),
        ({"include_usage": False}, {"stream_options": {"include_usage": True}}),
        ({"include_usage": True}, {"stream_options": {"include_usage": False}}),
        (None, {"stream_options": {"continuous_usage_stats": True}}),
    ],
    ids=[
        "none",
        "asked",
        "refused",
        "extra-asks",
        "refused-extra-asks",
        "asked-extra-refuses",
        "extra-other-keys",
    ],
)
def test_the_stored_response_carries_the_providers_counts_on_every_request(
    monkeypatch: pytest.MonkeyPatch,
    stream_options: dict[str, Any] | None,
    extra_body: dict[str, Any] | None,
    is_async: bool,
) -> None:
    """Whoever asked for usage and whatever litellm keeps of the usage
    chunk (litellm 1.83 discards one it does not show), the stored
    response's usage carries the provider's counts, as the ``post_call``
    does: litellm's own where it assembled them, the provider's object
    where it did not."""
    session = make_session(capture_prompts=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    kwargs: dict[str, Any] = {
        "model": "openai/my-model",
        "messages": MESSAGES,
        "stream": True,
        "client": _client(OpenAIServer(), is_async),
        **COMPAT,
    }
    if stream_options is not None:
        kwargs["stream_options"] = dict(stream_options)
    if extra_body is not None:
        kwargs["extra_body"] = {k: dict(v) for k, v in extra_body.items()}
    if is_async:

        async def _go() -> None:
            async for _chunk in await litellm.acompletion(**kwargs):
                pass

        asyncio.run(_go())
    else:
        for _chunk in litellm.completion(**kwargs):
            pass
    (post_call,) = events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == OPENAI_USAGE
    usage = post_call["content"]["response"]["usage"]
    assert (usage["prompt_tokens"], usage["completion_tokens"], usage["total_tokens"]) == (
        *OPENAI_USAGE,
        sum(OPENAI_USAGE),
    )


SECRET_PROMPT = "fd-hook-secret-prompt"


@pytest.mark.usefixtures("patched")
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_with_capture_off_nothing_is_stored_or_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, is_async: bool
) -> None:
    """The call is metered from the provider's counts and no event carries
    its prompt or response, nor does any sensor log line (the SDK's and
    litellm's own debug logs are theirs)."""
    session = make_session(capture_prompts=False)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    with caplog.at_level(logging.DEBUG, logger="flightdeck_sensor"):
        assert _compat_stream(is_async, SECRET_PROMPT) == "Hello"
    (post_call,) = events_of(session, "post_call")
    assert (post_call["tokens_input"], post_call["tokens_output"]) == OPENAI_USAGE
    assert post_call.get("content") is None
    queue = session.event_queue
    sent = json.dumps([c.args for c in queue.enqueue.call_args_list], default=repr)  # type: ignore[attr-defined]
    logged = "\n".join(
        f"{r.getMessage()} {r.exc_text or ''}"
        for r in caplog.records
        if r.name.startswith("flightdeck_sensor")
    )
    for text in (SECRET_PROMPT, "Hello"):
        assert text not in sent
        assert text not in logged


# ----- a direct legacy completions call ---------------------------------------


def _direct_legacy(is_async: bool) -> tuple[list[Any], OpenAIServer]:
    server = OpenAIServer()
    client = _client(server, is_async)
    kwargs = _request_kwargs(legacy=True)
    if not is_async:
        return list(client.completions.create(**kwargs)), server

    async def _go() -> list[Any]:
        return [c async for c in await client.completions.create(**kwargs)]

    return asyncio.run(_go()), server


@pytest.mark.parametrize("with_session", [True, False], ids=["session", "no-session"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_direct_legacy_completions_call_is_as_without_the_sensor(
    monkeypatch: pytest.MonkeyPatch, is_async: bool, with_session: bool
) -> None:
    """With no litellm call in flight the hook hands ``completions.create``
    the call as made: the same request, the same chunks, and no event
    (the sensor does not police or meter the legacy completions API)."""
    plain, plain_server = _direct_legacy(is_async)
    session = make_session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session if with_session else None)
    patch_litellm_functions(quiet=True)
    patch_openai_classes(quiet=True)
    try:
        hooked, hooked_server = _direct_legacy(is_async)
    finally:
        unpatch_litellm_functions(quiet=True)
        unpatch_openai_classes()
    assert hooked_server.bodies == plain_server.bodies
    assert [full_dump(c) for c in hooked] == [full_dump(c) for c in plain]
    assert [set_dump(c) for c in hooked] == [set_dump(c) for c in plain]
    assert session.event_queue.enqueue.call_args_list == []  # type: ignore[attr-defined]
