"""OpenAI client proxy: intercepts chat.completions.create().

Interception hierarchy::

    GuardedOpenAI (wraps openai.OpenAI or AsyncOpenAI)
      ├── @property chat      →  GuardedChat
      │   ├── @property completions  →  GuardedCompletions
      │   │   ├── create()           →  call(), call_async(), or call_stream()
      │   │   └── __getattr__        →  pass-through
      │   └── __getattr__    →  pass-through
      ├── with_options()     →  new GuardedOpenAI
      ├── with_raw_response  →  new GuardedOpenAI
      ├── with_streaming_response → new GuardedOpenAI
      └── __getattr__        →  pass-through

When ``stream=True``, injects ``stream_options={"include_usage": True}``
into kwargs so OpenAI returns token usage in the final streaming chunk.
"""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.openai import OpenAIProvider

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session


def _is_async_client(client: Any) -> bool:
    """Detect async OpenAI client without importing at module level."""
    try:
        from openai import AsyncOpenAI

        return isinstance(client, AsyncOpenAI)
    except ImportError:
        return False


class GuardedCompletions:
    """Proxy for ``chat.completions`` -- intercepts ``create()``."""

    def __init__(
        self,
        real_completions: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_completions
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept chat.completions.create().

        When ``stream=True``, injects ``stream_options`` so OpenAI includes
        token usage in the final streaming chunk.
        """
        if kwargs.get("stream"):
            call_kwargs = _inject_stream_options(kwargs)
            return base.call_stream(
                self._real.create,
                call_kwargs,
                self._session,
                self._provider,
            )

        real_fn = self._real.create
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class GuardedChat:
    """Proxy for ``client.chat`` -- intercepts ``.completions``."""

    def __init__(
        self,
        real_chat: Any,
        session: Session,
        provider: OpenAIProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_chat
        self._session = session
        self._provider = provider
        self._is_async = is_async

    @property
    def completions(self) -> GuardedCompletions:
        """Return a :class:`GuardedCompletions` proxy."""
        return GuardedCompletions(
            self._real.completions,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class GuardedOpenAI:
    """Proxy for ``openai.OpenAI`` or ``openai.AsyncOpenAI``.

    ``.chat`` is a ``@property`` -- this is how interception works.
    ``__getattr__`` delegates everything else to the wrapped client.
    """

    def __init__(
        self,
        client: Any,
        session: Session,
        provider: OpenAIProvider | None = None,
    ) -> None:
        self._client = client
        self._session = session
        self._is_async = _is_async_client(client)
        self._provider = provider or OpenAIProvider(
            capture_prompts=session.config.capture_prompts,
        )

    @property
    def chat(self) -> GuardedChat:
        """Return a :class:`GuardedChat` proxy that intercepts completions."""
        return GuardedChat(
            self._client.chat,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def with_options(self, **kwargs: Any) -> GuardedOpenAI:
        """Return a new GuardedOpenAI wrapping a client with updated options."""
        new_client = self._client.with_options(**kwargs)
        return GuardedOpenAI(new_client, self._session, self._provider)

    @property
    def with_raw_response(self) -> GuardedOpenAI:
        """Return a new GuardedOpenAI wrapping the raw response client."""
        return GuardedOpenAI(
            self._client.with_raw_response,
            self._session,
            self._provider,
        )

    @property
    def with_streaming_response(self) -> GuardedOpenAI:
        """Return a new GuardedOpenAI wrapping the streaming response client."""
        return GuardedOpenAI(
            self._client.with_streaming_response,
            self._session,
            self._provider,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def _inject_stream_options(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Inject ``stream_options={"include_usage": True}`` into a copy of kwargs.

    OpenAI does not return token usage in streaming responses by default.
    This option causes the final chunk to include a ``usage`` field.
    """
    result = copy.copy(kwargs)
    existing = result.get("stream_options")
    if isinstance(existing, dict):
        existing = {**existing, "include_usage": True}
        result["stream_options"] = existing
    else:
        result["stream_options"] = {"include_usage": True}
    return result
