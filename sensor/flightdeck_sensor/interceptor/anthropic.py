"""Anthropic client proxy: intercepts messages.create() and messages.stream().

Interception hierarchy::

    GuardedAnthropic (wraps anthropic.Anthropic or AsyncAnthropic)
      ├── @property messages  →  GuardedMessages
      │   ├── create()        →  call() or call_async()
      │   ├── stream()        →  call_stream()
      │   └── __getattr__     →  pass-through
      ├── with_options()      →  new GuardedAnthropic
      ├── with_raw_response   →  new GuardedAnthropic
      ├── with_streaming_response → new GuardedAnthropic
      └── __getattr__         →  pass-through
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session


def _is_async_client(client: Any) -> bool:
    """Detect async Anthropic client via isinstance without importing at module level."""
    try:
        from anthropic import AsyncAnthropic

        return isinstance(client, AsyncAnthropic)
    except ImportError:
        return False


class GuardedMessages:
    """Proxy for the ``messages`` resource on an Anthropic client.

    Intercepts ``create()`` and ``stream()`` -- everything else passes through.
    """

    def __init__(
        self,
        real_messages: Any,
        session: Session,
        provider: AnthropicProvider,
        *,
        is_async: bool = False,
    ) -> None:
        self._real = real_messages
        self._session = session
        self._provider = provider
        self._is_async = is_async

    def create(self, **kwargs: Any) -> Any:
        """Intercept messages.create() -- sync or async depending on client type."""
        real_fn = self._real.create
        if self._is_async:
            return base.call_async(real_fn, kwargs, self._session, self._provider)
        return base.call(real_fn, kwargs, self._session, self._provider)

    def stream(self, **kwargs: Any) -> base.GuardedStream:
        """Intercept messages.stream() -- returns a GuardedStream context manager."""
        return base.call_stream(self._real.stream, kwargs, self._session, self._provider)

    def __getattr__(self, name: str) -> Any:
        # Pass through: batch, count_tokens, etc.
        return getattr(self._real, name)


class GuardedAnthropic:
    """Proxy for ``anthropic.Anthropic`` or ``anthropic.AsyncAnthropic``.

    ``.messages`` is a ``@property`` -- this is how interception works.
    ``__getattr__`` delegates everything else (api_key, base_url, etc.)
    to the wrapped client untracked.
    """

    def __init__(
        self,
        client: Any,
        session: Session,
        provider: AnthropicProvider | None = None,
    ) -> None:
        self._client = client
        self._session = session
        self._is_async = _is_async_client(client)
        self._provider = provider or AnthropicProvider(
            capture_prompts=session.config.capture_prompts,
        )

    @property
    def messages(self) -> GuardedMessages:
        """Return a :class:`GuardedMessages` proxy that intercepts create/stream."""
        return GuardedMessages(
            self._client.messages,
            self._session,
            self._provider,
            is_async=self._is_async,
        )

    def with_options(self, **kwargs: Any) -> GuardedAnthropic:
        """Return a new GuardedAnthropic wrapping a client with updated options."""
        new_client = self._client.with_options(**kwargs)
        return GuardedAnthropic(new_client, self._session, self._provider)

    @property
    def with_raw_response(self) -> GuardedAnthropic:
        """Return a new GuardedAnthropic wrapping the raw response client."""
        return GuardedAnthropic(
            self._client.with_raw_response,
            self._session,
            self._provider,
        )

    @property
    def with_streaming_response(self) -> GuardedAnthropic:
        """Return a new GuardedAnthropic wrapping the streaming response client."""
        return GuardedAnthropic(
            self._client.with_streaming_response,
            self._session,
            self._provider,
        )

    def __getattr__(self, name: str) -> Any:
        # Pass through: api_key, base_url, _client, etc.
        return getattr(self._client, name)
