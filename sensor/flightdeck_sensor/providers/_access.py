"""Reads of SDK objects that hold across SDK releases, shared by the
provider adapters and the interceptors."""

from __future__ import annotations

from typing import Any

# The class names of the Anthropic and OpenAI SDKs' sentinels for an
# argument left out (``NOT_GIVEN``, ``omit``). The SDK sends no such
# argument to the provider, and the sentinel is not JSON.
_OMITTED_ARGUMENT_TYPES = frozenset({"NotGiven", "Omit"})


def given(value: Any) -> Any:
    """``value``, or None when it is the SDK's sentinel for an argument
    left out: a wrapper that passes one through (``tools=NOT_GIVEN`` for an
    agent with no tools) gave nothing, and the stored content says so."""
    return None if type(value).__name__ in _OMITTED_ARGUMENT_TYPES else value


def field(obj: Any, name: str) -> Any:
    """Attribute or dict key ``name`` of ``obj``; ``None`` when absent.

    The same data arrives in either shape. An SDK release that does not
    declare a field keeps it as a pydantic extra, and a nested extra
    stays a plain dict (anthropic 0.91 has no ``output_tokens_details``
    on its usage object, for one), and litellm hands back pydantic
    objects and plain dicts for the same Responses items."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def is_raw_stream(obj: Any, classes: tuple[type, ...]) -> bool:
    """Whether ``obj`` is one of the SDK's raw event streams ``classes``.

    The test is on the object's class, not ``isinstance``: anthropic 0.x
    overrides ``isinstance`` on ``Stream`` / ``AsyncStream`` so that a
    ``messages.stream()`` helper (``MessageStream`` /
    ``AsyncMessageStream``) also passes, with a ``DeprecationWarning``,
    though the helper is not a raw stream and keeps its own snapshot.
    openai has no such override; its checks go through here as well so
    every SDK's stream test means the same."""
    return bool(classes) and issubclass(type(obj), classes)
