"""Tests for the class-level SDK patching path.

Covers the Phase 4.5+ Phase 2 work that replaced the closure-based
module-attribute replacement with class-level descriptor patching.
The previous implementation had zero unit-test coverage of patch()
and shipped a live TypeError crash on every patched-then-constructed
client (Finding 2 of the empirical investigation).

Tests in this file:

* ``test_patch_then_construct_does_not_crash``: regression guard for
  Finding 2. The pre-fix code crashed because the post-patch
  ``isinstance(client, AsyncAnthropic)`` resolved AsyncAnthropic to a
  function thunk and ``isinstance(x, function)`` raises TypeError.
* ``test_isinstance_after_patch_works``: ``isinstance(x, anthropic.
  Anthropic)`` and ``isinstance(x, _OrigAnthropic)`` both succeed
  after patch() because we mutate the class in place rather than
  replacing the module attribute.
* ``test_patch_is_idempotent``: a second patch() call is a no-op and
  the descriptor is not double-installed.
* ``test_patch_unpatch_patch_cycle``: patch -> unpatch -> patch again
  works correctly.
* ``test_unpatch_without_patch_is_noop``: calling unpatch() without
  a preceding patch() does nothing and does not raise.
* ``test_descriptor_caches_on_instance``: the descriptor populates
  ``instance.__dict__`` so subsequent accesses bypass it (matching
  cached_property behavior).
* ``test_async_streaming_raises_not_implemented``: SensorMessages
  and SensorCompletions reject async streaming with a clear error
  rather than silently dispatching to the sync path.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

import anthropic
import openai

import flightdeck_sensor
from flightdeck_sensor.interceptor.anthropic import (
    SensorAnthropic,
    SensorBeta,
    SensorMessages,
    _OrigAnthropic,
    _OrigAsyncAnthropic,
    _AnthropicMessagesDescriptor,
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.litellm import (
    SensorLitellm,
    patch_litellm_functions,
    unpatch_litellm_functions,
)
from flightdeck_sensor.interceptor.openai import (
    SensorChat,
    SensorCompletions,
    SensorOpenAI,
    _OpenAIChatDescriptor,
    _OrigOpenAI,
    _OrigAsyncOpenAI,
    patch_openai_classes,
    unpatch_openai_classes,
)


# ----------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------


@pytest.fixture
def sensor_init() -> Any:
    """Initialize a flightdeck session and tear it down after the test.

    Patches are also unpatched on teardown so test order does not leak
    state across tests.
    """
    flightdeck_sensor.init(
        server="http://localhost:4000/ingest",
        token="tok-test",
        quiet=True,
    )
    yield
    try:
        flightdeck_sensor.teardown()
    except Exception:
        pass
    # Defensive: in case teardown failed mid-way leave classes clean.
    unpatch_anthropic_classes()
    unpatch_openai_classes()
    unpatch_litellm_functions()


# ----------------------------------------------------------------------
# Finding 2 regression -- the live patch() crash
# ----------------------------------------------------------------------


def test_patch_then_construct_anthropic_does_not_crash(sensor_init: Any) -> None:
    """Regression guard for Phase 4.5 audit Finding 2.

    Pre-fix, calling patch() then constructing any Anthropic client
    crashed inside _is_async_client because the post-patch
    ``isinstance(client, AsyncAnthropic)`` resolved AsyncAnthropic to
    a function thunk. Now _is_async_client uses _OrigAsyncAnthropic
    captured at module import time, which is immune to patching.
    """
    flightdeck_sensor.patch(quiet=True)
    # The crash was here pre-fix.
    client = anthropic.Anthropic(api_key="test-key")
    assert client is not None


def test_patch_then_construct_openai_does_not_crash(sensor_init: Any) -> None:
    """Same regression guard for the OpenAI side of Finding 2."""
    flightdeck_sensor.patch(quiet=True)
    client = openai.OpenAI(api_key="test-key")
    assert client is not None


# ----------------------------------------------------------------------
# isinstance preservation
# ----------------------------------------------------------------------


def test_isinstance_after_patch_works_via_module_attr(sensor_init: Any) -> None:
    """``isinstance(x, anthropic.Anthropic)`` works after patch().

    Class-level patching mutates the class object in place; the module
    attribute still points at the same class. Compare to the old
    closure-based approach where ``anthropic.Anthropic`` became a
    function and ``isinstance`` raised TypeError.
    """
    flightdeck_sensor.patch(quiet=True)
    client = anthropic.Anthropic(api_key="test-key")
    assert isinstance(client, anthropic.Anthropic)
    assert isinstance(client, _OrigAnthropic)


def test_isinstance_after_patch_works_for_openai(sensor_init: Any) -> None:
    flightdeck_sensor.patch(quiet=True)
    client = openai.OpenAI(api_key="test-key")
    assert isinstance(client, openai.OpenAI)
    assert isinstance(client, _OrigOpenAI)


def test_captured_reference_still_works_after_patch(sensor_init: Any) -> None:
    """``from anthropic import Anthropic`` captured BEFORE patch still works.

    This is the main reason class-level patching is the right design
    in the first place. The captured reference points at the same
    class object that the patch mutates -- so subsequent uses of the
    captured reference go through the patched descriptor.
    """
    captured_ref = anthropic.Anthropic
    flightdeck_sensor.patch(quiet=True)
    # Captured ref is still the same class object as the (mutated) module attr.
    assert captured_ref is anthropic.Anthropic
    client = captured_ref(api_key="test-key")
    assert isinstance(client, anthropic.Anthropic)


# ----------------------------------------------------------------------
# Idempotency
# ----------------------------------------------------------------------


def test_patch_is_idempotent_anthropic(sensor_init: Any) -> None:
    """A second patch() call must not double-install the descriptor."""
    flightdeck_sensor.patch(quiet=True)
    descriptor_after_first = anthropic.Anthropic.__dict__["messages"]
    assert isinstance(descriptor_after_first, _AnthropicMessagesDescriptor)

    flightdeck_sensor.patch(quiet=True)
    descriptor_after_second = anthropic.Anthropic.__dict__["messages"]
    # SAME descriptor object -- not a new one wrapping the first.
    assert descriptor_after_second is descriptor_after_first


def test_patch_is_idempotent_openai(sensor_init: Any) -> None:
    flightdeck_sensor.patch(quiet=True)
    descriptor_after_first = openai.OpenAI.__dict__["chat"]
    assert isinstance(descriptor_after_first, _OpenAIChatDescriptor)

    flightdeck_sensor.patch(quiet=True)
    descriptor_after_second = openai.OpenAI.__dict__["chat"]
    assert descriptor_after_second is descriptor_after_first


def test_double_patch_does_not_corrupt_unpatch(sensor_init: Any) -> None:
    """After patch+patch, unpatch must still restore the real original.

    The pre-fix closure-based code corrupted ``_original_inits`` on the
    second patch call (it stored the first thunk as the "original"),
    so unpatch left the first thunk in place permanently. The new
    code stores the original on ``cls._flightdeck_patched`` and the
    second patch call short-circuits before overwriting it.
    """
    original_descriptor_type = type(anthropic.Anthropic.__dict__["messages"]).__name__
    assert original_descriptor_type == "cached_property"

    flightdeck_sensor.patch(quiet=True)
    flightdeck_sensor.patch(quiet=True)  # second call -- must not corrupt sentinel
    flightdeck_sensor.unpatch()

    descriptor_after_unpatch = anthropic.Anthropic.__dict__["messages"]
    assert type(descriptor_after_unpatch).__name__ == "cached_property"


# ----------------------------------------------------------------------
# patch -> unpatch -> patch cycle
# ----------------------------------------------------------------------


def test_patch_unpatch_patch_cycle_anthropic(sensor_init: Any) -> None:
    """patch -> unpatch -> patch again works correctly."""
    flightdeck_sensor.patch(quiet=True)
    assert hasattr(anthropic.Anthropic, "_flightdeck_patched")

    flightdeck_sensor.unpatch()
    assert not hasattr(anthropic.Anthropic, "_flightdeck_patched")

    flightdeck_sensor.patch(quiet=True)
    assert hasattr(anthropic.Anthropic, "_flightdeck_patched")

    # And the descriptor is the new one, not a stale reference.
    desc = anthropic.Anthropic.__dict__["messages"]
    assert isinstance(desc, _AnthropicMessagesDescriptor)


def test_patch_unpatch_patch_cycle_openai(sensor_init: Any) -> None:
    flightdeck_sensor.patch(quiet=True)
    assert hasattr(openai.OpenAI, "_flightdeck_patched")
    flightdeck_sensor.unpatch()
    assert not hasattr(openai.OpenAI, "_flightdeck_patched")
    flightdeck_sensor.patch(quiet=True)
    assert hasattr(openai.OpenAI, "_flightdeck_patched")


# ----------------------------------------------------------------------
# unpatch without patch is a no-op
# ----------------------------------------------------------------------


def test_unpatch_without_patch_is_noop(sensor_init: Any) -> None:
    """Calling unpatch() with no preceding patch() must not raise."""
    # Must not raise:
    flightdeck_sensor.unpatch()
    # Calling it twice is also fine:
    flightdeck_sensor.unpatch()
    # Classes remain unpatched:
    assert not hasattr(anthropic.Anthropic, "_flightdeck_patched")
    assert not hasattr(openai.OpenAI, "_flightdeck_patched")


def test_teardown_without_patch_is_noop() -> None:
    """teardown() must work even if patch() was never called."""
    flightdeck_sensor.init(
        server="http://localhost:4000/ingest",
        token="tok-test",
        quiet=True,
    )
    try:
        flightdeck_sensor.teardown()  # must not raise
    finally:
        # In case teardown failed, clean up so other tests are unaffected.
        unpatch_anthropic_classes()
        unpatch_openai_classes()


# ----------------------------------------------------------------------
# Descriptor caches on instance
# ----------------------------------------------------------------------


def test_descriptor_caches_messages_on_instance(sensor_init: Any) -> None:
    """First .messages access populates instance.__dict__ with the wrapped value.

    Matches the cached_property protocol: subsequent accesses go
    through ``instance.__dict__`` and bypass the descriptor entirely.
    """
    flightdeck_sensor.patch(quiet=True)
    client = anthropic.Anthropic(api_key="test-key")
    assert "messages" not in vars(client)

    msgs = client.messages
    assert isinstance(msgs, SensorMessages)
    assert "messages" in vars(client)
    assert vars(client)["messages"] is msgs

    # Second access returns the cached object, not a new one.
    msgs_again = client.messages
    assert msgs_again is msgs


def test_descriptor_caches_chat_on_instance(sensor_init: Any) -> None:
    flightdeck_sensor.patch(quiet=True)
    client = openai.OpenAI(api_key="test-key")
    assert "chat" not in vars(client)

    chat = client.chat
    assert isinstance(chat, SensorChat)
    assert "chat" in vars(client)
    assert vars(client)["chat"] is chat

    chat_again = client.chat
    assert chat_again is chat


# ----------------------------------------------------------------------
# wrap() short-circuits when class is patched
# ----------------------------------------------------------------------


def test_wrap_is_noop_when_patched(sensor_init: Any) -> None:
    """wrap(client) returns the client unchanged when patch() is active.

    Otherwise calling wrap() after patch() would produce a
    SensorAnthropic that on .messages access wraps an already-wrapped
    SensorMessages -- a double-wrap that would post duplicate events.
    """
    flightdeck_sensor.patch(quiet=True)
    client = anthropic.Anthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(client)
    # wrap() returns the original client unchanged because the class
    # is already patched -- the descriptor handles interception.
    assert wrapped is client


def test_wrap_still_wraps_when_not_patched(sensor_init: Any) -> None:
    """wrap() without patch() returns a SensorAnthropic / SensorOpenAI."""
    # No patch() call here.
    a_client = anthropic.Anthropic(api_key="test-key")
    a_wrapped = flightdeck_sensor.wrap(a_client)
    assert isinstance(a_wrapped, SensorAnthropic)

    o_client = openai.OpenAI(api_key="test-key")
    o_wrapped = flightdeck_sensor.wrap(o_client)
    assert isinstance(o_wrapped, SensorOpenAI)


# ----------------------------------------------------------------------
# KI17: SensorBeta gives wrap() parity with patch() for beta.messages
# ----------------------------------------------------------------------


def test_wrap_intercepts_beta_messages_via_sensor_beta(sensor_init: Any) -> None:
    """wrap() returns a SensorAnthropic whose .beta is a SensorBeta whose
    .messages is a SensorMessages. KI17 fix -- previously the chain was
    SensorAnthropic.beta.messages, where .beta passed through to the raw
    Beta resource and bypassed sensor interception entirely.
    """
    client = anthropic.Anthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(client)
    assert isinstance(wrapped, SensorAnthropic)
    assert isinstance(wrapped.beta, SensorBeta)
    assert isinstance(wrapped.beta.messages, SensorMessages)


def test_sensor_beta_messages_uses_sync_path_for_sync_client(
    sensor_init: Any,
) -> None:
    """A wrapped sync Anthropic client produces a SensorBeta and a
    SensorMessages whose ``is_async`` is False, so beta.messages.create
    routes through ``base.call`` (sync) not ``base.call_async``.
    """
    client = anthropic.Anthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(client)
    sm = wrapped.beta.messages
    assert sm._is_async is False  # pyright: ignore[reportPrivateUsage]


def test_sensor_beta_messages_uses_async_path_for_async_client(
    sensor_init: Any,
) -> None:
    """The same chain on an AsyncAnthropic produces a SensorMessages
    with ``is_async`` True so async beta calls reach ``base.call_async``.
    """
    client = anthropic.AsyncAnthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(client)
    assert isinstance(wrapped, SensorAnthropic)
    sm = wrapped.beta.messages
    assert sm._is_async is True  # pyright: ignore[reportPrivateUsage]


def test_sensor_beta_passes_through_unknown_attrs(sensor_init: Any) -> None:
    """SensorBeta proxies any non-messages attribute to the raw Beta.
    The Anthropic SDK exposes other namespaces under client.beta (e.g.
    ``models``); we don't intercept those, but they must remain
    accessible through the wrapped client.
    """
    client = anthropic.Anthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(client)
    raw_beta = client.beta
    sb = wrapped.beta
    # __getattr__ pass-through: sb.<X> for any X that exists on raw_beta
    # returns the same object the raw beta would have returned.
    if hasattr(raw_beta, "models"):
        assert sb.models is raw_beta.models


def test_sensor_beta_messages_create_routes_through_intercept(
    sensor_init: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: SensorBeta.messages.create() reaches base.call().
    Patching the call hook to a sentinel proves the intercept fires
    and receives the correct real_fn (the underlying client's
    beta.messages.create) and the original kwargs.
    """
    from flightdeck_sensor.interceptor import anthropic as _anthropic_mod
    from flightdeck_sensor.interceptor import base as _base_mod

    client = anthropic.Anthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(client)
    sentinel = object()
    captured: dict[str, Any] = {}

    def fake_call(real_fn: Any, kwargs: dict[str, Any], _s: Any, _p: Any) -> Any:
        captured["real_fn"] = real_fn
        captured["kwargs"] = kwargs
        return sentinel

    # SensorMessages.create resolves base.call via the module reference
    # imported at the top of interceptor/anthropic.py. Patch on that
    # imported module reference, not just the source module.
    monkeypatch.setattr(_base_mod, "call", fake_call)
    monkeypatch.setattr(_anthropic_mod.base, "call", fake_call)

    sm = wrapped.beta.messages
    result = sm.create(
        model="claude-sonnet-4-6",
        max_tokens=10,
        messages=[{"role": "user", "content": "hi"}],
    )
    assert result is sentinel
    # The captured real_fn is the bound `create` method on the raw
    # beta.messages resource. Bound methods are not identity-stable
    # across attribute lookups, so compare by qualified name + the
    # underlying function instead.
    real_fn = captured["real_fn"]
    assert getattr(real_fn, "__self__", None) is client.beta.messages
    assert getattr(real_fn, "__func__", None) is type(client.beta.messages).create
    assert captured["kwargs"]["model"] == "claude-sonnet-4-6"


# ----------------------------------------------------------------------
# Async streaming: Phase 4 lifted the prior ``NotImplementedError``.
# Both SDKs now route async streaming through ``GuardedAsyncStream``
# which implements the awaitable CM protocol. The smoke tests exercise
# a real provider; here we assert at the type level that the dispatch
# returns the guarded wrapper rather than raising.
# ----------------------------------------------------------------------


def test_async_anthropic_streaming_returns_guarded_async_stream(sensor_init: Any) -> None:
    """SensorMessages.stream on an async client returns a GuardedAsyncStream.

    Phase 4 lifted the prior NotImplementedError; async streaming now
    produces a :class:`base.GuardedAsyncStream` with the same TTFT +
    chunk + abort measurement policy as the sync wrapper.
    """
    from flightdeck_sensor.interceptor import base
    async_client = anthropic.AsyncAnthropic(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(async_client)
    assert isinstance(wrapped, SensorAnthropic)
    guarded = wrapped.messages.stream(
        model="claude-sonnet-4-6", messages=[],
    )
    assert isinstance(guarded, base.GuardedAsyncStream)


def test_async_openai_streaming_returns_guarded_async_stream(sensor_init: Any) -> None:
    """SensorCompletions.create(stream=True) on async client returns the async wrapper."""
    from flightdeck_sensor.interceptor import base
    async_client = openai.AsyncOpenAI(api_key="test-key")
    wrapped = flightdeck_sensor.wrap(async_client)
    assert isinstance(wrapped, SensorOpenAI)
    guarded = wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[],
        stream=True,
    )
    assert isinstance(guarded, base.GuardedAsyncStream)


# ----------------------------------------------------------------------
# No-session-then-init: descriptor must NOT cache the raw resource
# when the session is unset, so a later init() does pick up wrapping
# ----------------------------------------------------------------------


def test_descriptor_no_session_then_init_anthropic() -> None:
    """Descriptor returns raw on no-session, then wraps after init().

    Scenario: a user imports their framework (which constructs an
    Anthropic client and accesses .messages once during validation /
    eager init) BEFORE calling flightdeck_sensor.init(). The
    descriptor's first __get__ runs with _session is None. It MUST
    return the raw resource without populating the instance cache,
    otherwise the cached unwrapped resource would shadow the
    descriptor on every subsequent access -- including all the calls
    that happen AFTER init() runs and the user actually wants
    observability.

    Verification: patch() with no init() yet -> first .messages
    access returns a raw Messages and instance.__dict__ stays
    EMPTY. Then init() -> next .messages access goes through the
    descriptor again and returns a SensorMessages.
    """
    # Patch the classes WITHOUT calling init() first.
    # This is allowed: patch_anthropic_classes is callable directly
    # and doesn't require a session. (The public flightdeck_sensor.
    # patch() requires init() because it asserts session presence,
    # so we use the lower-level helper to set up the no-session
    # scenario explicitly.)
    assert flightdeck_sensor._session is None
    patch_anthropic_classes(quiet=True)
    try:
        client = anthropic.Anthropic(api_key="test-key")
        # First access -- session is None, should return raw and NOT
        # populate the instance cache.
        msgs1 = client.messages
        assert not isinstance(msgs1, SensorMessages), (
            "descriptor should return raw when session is None"
        )
        assert "messages" not in vars(client), (
            "descriptor must NOT populate instance.__dict__ when session "
            "is None, otherwise the cached raw resource would shadow the "
            "descriptor and a subsequent init() would never wrap"
        )

        # Now init() and access again -- the descriptor must run again
        # and produce a wrapped SensorMessages.
        flightdeck_sensor.init(
            server="http://localhost:4000/ingest",
            token="tok-test",
            quiet=True,
        )
        msgs2 = client.messages
        assert isinstance(msgs2, SensorMessages), (
            "after init(), the descriptor must wrap on next access"
        )
        # And NOW it should be cached.
        assert "messages" in vars(client)
        assert vars(client)["messages"] is msgs2
    finally:
        try:
            flightdeck_sensor.teardown()
        except Exception:
            pass
        unpatch_anthropic_classes()
        unpatch_openai_classes()


def test_descriptor_no_session_then_init_openai() -> None:
    """Symmetric test for the OpenAI ``chat`` descriptor."""
    assert flightdeck_sensor._session is None
    patch_openai_classes(quiet=True)
    try:
        client = openai.OpenAI(api_key="test-key")
        chat1 = client.chat
        assert not isinstance(chat1, SensorChat), (
            "descriptor should return raw when session is None"
        )
        assert "chat" not in vars(client)

        flightdeck_sensor.init(
            server="http://localhost:4000/ingest",
            token="tok-test",
            quiet=True,
        )
        chat2 = client.chat
        assert isinstance(chat2, SensorChat)
        assert "chat" in vars(client)
        assert vars(client)["chat"] is chat2
    finally:
        try:
            flightdeck_sensor.teardown()
        except Exception:
            pass
        unpatch_anthropic_classes()
        unpatch_openai_classes()


# ----------------------------------------------------------------------
# litellm interceptor tests (KI21)
# ----------------------------------------------------------------------
#
# litellm exposes two module-level entry points (completion /
# acompletion) rather than a class with cached-property resources.
# patch_litellm_functions() swaps these two attributes in place. The
# tests below mock the underlying ``litellm.completion`` call with a
# MagicMock so no real API call is made -- the sensor still exercises
# pre-call token estimation, post-call usage extraction, and event
# emission around the mocked call. Two different model strings are
# covered (claude-* and gpt-*) to confirm the interceptor is
# provider-agnostic and does not hard-code either side.


import litellm as _litellm


def _make_mock_litellm_response(
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    model: str = "claude-haiku-4-5-20251001",
) -> MagicMock:
    """Build a MagicMock that quacks like a litellm ``ModelResponse``.

    Minimum shape needed for the sensor's LitellmProvider:
    ``.model``, ``.usage.prompt_tokens``, ``.usage.completion_tokens``,
    ``.choices[0].message`` (for tool-invocation extraction; empty
    message is fine when the test doesn't exercise tool calls).
    """
    response = MagicMock()
    response.model = model
    response.usage = MagicMock()
    response.usage.prompt_tokens = prompt_tokens
    response.usage.completion_tokens = completion_tokens
    response.usage.total_tokens = prompt_tokens + completion_tokens
    # No tool calls by default.
    message = MagicMock()
    message.tool_calls = None
    choice = MagicMock()
    choice.message = message
    response.choices = [choice]
    return response


def test_patch_litellm_is_idempotent(sensor_init: Any) -> None:
    """A second patch() call is a no-op on the litellm side.

    The idempotency check uses the ``_flightdeck_patched`` sentinel on
    the litellm module. Verifies it survives two patch calls without
    double-wrapping (which would shadow the orig_completion reference
    and break unpatch).
    """
    flightdeck_sensor.patch(quiet=True)
    first = _litellm.completion
    flightdeck_sensor.patch(quiet=True)
    second = _litellm.completion
    assert first is second, (
        "second patch() must not re-wrap litellm.completion"
    )
    assert getattr(_litellm, "_flightdeck_patched", False) is True


def test_litellm_completion_intercepted_sync(
    sensor_init: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After patch(), calling litellm.completion routes through
    base.call which estimates tokens, runs the underlying function,
    and emits a post-call event with the reconciled token counts.

    Uses MagicMock to replace the original completion so no real API
    call is made. The test asserts the mock is invoked with the user
    kwargs (``model``, ``messages``) AND returns the mocked response
    unchanged -- i.e. the sensor is transparent to the caller.
    """
    mock_completion = MagicMock(
        return_value=_make_mock_litellm_response(
            prompt_tokens=12, completion_tokens=8,
            model="claude-haiku-4-5-20251001",
        ),
    )
    # Replace BEFORE patching so the patch captures our mock as the
    # "original" to call through.
    monkeypatch.setattr(_litellm, "completion", mock_completion)
    flightdeck_sensor.patch(quiet=True)

    response = _litellm.completion(
        model="claude-haiku-4-5-20251001",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=5,
    )

    mock_completion.assert_called_once()
    call_kwargs = mock_completion.call_args.kwargs
    assert call_kwargs["model"] == "claude-haiku-4-5-20251001"
    assert call_kwargs["messages"] == [{"role": "user", "content": "hi"}]
    assert response.usage.prompt_tokens == 12
    assert response.usage.completion_tokens == 8


@pytest.mark.asyncio
async def test_litellm_acompletion_intercepted_async(
    sensor_init: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Async variant of the sync-intercept test.

    litellm.acompletion is a coroutine function; the patched wrapper
    awaits the original and feeds the response through the same
    LitellmProvider.extract_usage path as the sync test. The test
    checks the mock was awaited with the expected kwargs and the
    response passes through.
    """
    from unittest.mock import AsyncMock

    mock_acompletion = AsyncMock(
        return_value=_make_mock_litellm_response(
            prompt_tokens=15, completion_tokens=9,
            model="gpt-4o",
        ),
    )
    monkeypatch.setattr(_litellm, "acompletion", mock_acompletion)
    flightdeck_sensor.patch(quiet=True)

    response = await _litellm.acompletion(
        model="gpt-4o",
        messages=[{"role": "user", "content": "hi"}],
    )

    mock_acompletion.assert_awaited_once()
    call_kwargs = mock_acompletion.call_args.kwargs
    assert call_kwargs["model"] == "gpt-4o"
    assert response.usage.prompt_tokens == 15


def test_litellm_exception_propagates(
    sensor_init: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the underlying litellm call raises, the exception
    propagates out of the patched wrapper.

    base.call catches user exceptions to emit a post-call failure
    event but re-raises afterwards so the caller's error-handling
    code path still runs. The patched wrapper must not swallow the
    exception.
    """
    class _SimulatedProviderError(RuntimeError):
        pass

    def _raise(**kwargs: Any) -> Any:
        raise _SimulatedProviderError("upstream provider 500")

    monkeypatch.setattr(_litellm, "completion", _raise)
    flightdeck_sensor.patch(quiet=True)

    with pytest.raises(_SimulatedProviderError):
        _litellm.completion(
            model="claude-haiku-4-5-20251001",
            messages=[{"role": "user", "content": "hi"}],
        )


def test_litellm_two_providers_agnostic(
    sensor_init: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The interceptor handles any ``model`` string litellm routes to.

    Runs the same patched call twice with model strings representing
    two different underlying providers (Anthropic via litellm,
    OpenAI via litellm). Both succeed, both return the mocked
    response, no hard-coded provider-specific branch fails.
    """
    mock_completion = MagicMock(
        side_effect=[
            _make_mock_litellm_response(model="claude-haiku-4-5-20251001"),
            _make_mock_litellm_response(model="gpt-4o"),
        ],
    )
    monkeypatch.setattr(_litellm, "completion", mock_completion)
    flightdeck_sensor.patch(quiet=True)

    r1 = _litellm.completion(
        model="claude-haiku-4-5-20251001",
        messages=[{"role": "user", "content": "hi"}],
    )
    r2 = _litellm.completion(
        model="gpt-4o",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert r1.model == "claude-haiku-4-5-20251001"
    assert r2.model == "gpt-4o"
    assert mock_completion.call_count == 2


def test_litellm_streaming_raises_not_implemented(
    sensor_init: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """stream=True raises NotImplementedError with KI26 reference.

    Streaming support is deferred; KI21's scope is non-streaming sync
    and async only. The error message points users to KI26 so they
    can find the tracking issue rather than hit an opaque crash.
    """
    monkeypatch.setattr(_litellm, "completion", MagicMock())
    flightdeck_sensor.patch(quiet=True)

    with pytest.raises(NotImplementedError) as exc_info:
        _litellm.completion(
            model="claude-haiku-4-5-20251001",
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
        )
    assert "KI26" in str(exc_info.value)
    assert "stream" in str(exc_info.value).lower()


def test_unpatch_litellm_without_patch_is_noop(sensor_init: Any) -> None:
    """Calling unpatch_litellm_functions() without a prior patch is a
    silent no-op -- does not raise, does not touch litellm module
    attributes.
    """
    orig_completion = _litellm.completion
    unpatch_litellm_functions(quiet=True)
    assert _litellm.completion is orig_completion


def test_litellm_patch_unpatch_patch_cycle(sensor_init: Any) -> None:
    """patch -> unpatch -> patch restores and re-installs cleanly."""
    orig_completion = _litellm.completion
    flightdeck_sensor.patch(quiet=True)
    assert _litellm.completion is not orig_completion
    unpatch_litellm_functions()
    assert _litellm.completion is orig_completion
    flightdeck_sensor.patch(quiet=True)
    assert _litellm.completion is not orig_completion


def test_sensor_litellm_per_instance_wrap(
    sensor_init: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SensorLitellm wraps a single callsite without module patching.

    Verifies the programmatic wrapping path: construct SensorLitellm
    directly, call .completion(...), confirm base.call runs and the
    response passes through. module-level litellm.completion is NOT
    patched in this test -- SensorLitellm works standalone.
    """
    mock_response = _make_mock_litellm_response(
        prompt_tokens=7, completion_tokens=3,
    )
    # SensorLitellm's __init__ captures _OrigCompletion at module
    # import time. Replace that captured reference via the module's
    # attribute so the wrapper invokes our mock.
    from flightdeck_sensor.interceptor import litellm as _litellm_interceptor

    monkeypatch.setattr(
        _litellm_interceptor, "_OrigCompletion",
        MagicMock(return_value=mock_response),
    )
    session = flightdeck_sensor._session
    assert session is not None

    wrapped = SensorLitellm(session)
    response = wrapped.completion(
        model="claude-haiku-4-5-20251001",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert response is mock_response


def test_sensor_litellm_streaming_raises_not_implemented(
    sensor_init: Any,
) -> None:
    """SensorLitellm's per-instance path also rejects stream=True
    with the same KI26 message as the patched path. Ensures the two
    intercept paths present a consistent streaming contract.
    """
    session = flightdeck_sensor._session
    assert session is not None
    wrapped = SensorLitellm(session)
    with pytest.raises(NotImplementedError) as exc_info:
        wrapped.completion(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
        )
    assert "KI26" in str(exc_info.value)
