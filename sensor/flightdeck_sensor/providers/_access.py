"""Reads of SDK objects that hold across SDK releases, shared by the
provider adapters and the interceptors."""

from __future__ import annotations

import base64
import binascii
import inspect
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

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


class UnreadableResponse:
    """Stands in for the message of a raw-response wrapper the sensor could
    not read: its ``parse()`` raised (a body that is not the JSON the SDK
    expects) or is a coroutine, which only the caller's own ``await`` may
    run. It carries nothing, so usage falls back to the pre-call estimate
    and the model to the requested one. As stored content it is an object
    JSON cannot write, so the event is sent without its content, with the
    transport's warning, once per event type, that the provider's response
    body did not parse (``transport/body_limit.py``)."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "<unreadable response>"


UNREADABLE = UnreadableResponse()


class NoMessage:
    """Stands in for a stream the finalizer dropped before its settle, which
    left no message: it has no attributes, and content capture stores an
    empty response for it."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "<no message>"


DROPPED_STREAM = NoMessage()


class ParsedRawResponse:
    """A raw-response wrapper read once: the message its ``parse()``
    returned, which every reader of the call takes (usage, model, content,
    stop reason, tool calls), plus the wrapper's HTTP headers for
    ``provider_metadata``. ``parsed`` is ``None`` when the caller never
    parsed a body the sensor may not read itself (the streaming view), and
    :data:`UNREADABLE` when the parse failed; either way usage falls back
    to the pre-call estimate."""

    def __init__(self, parsed: Any, headers: Any) -> None:
        self._parsed = parsed
        self.headers = headers

    def parse(self) -> Any:
        return self._parsed

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._parsed, name)


def response_message(response: Any) -> Any:
    """The message ``response`` stands for, which every reader takes: the
    parsed message of a raw-response wrapper (anything with a ``parse()``
    method, a :class:`ParsedRawResponse` included), else ``response``
    itself. A wrapper whose ``parse()`` raises, or is a coroutine, gives
    :data:`UNREADABLE`.

    The SDKs cache a successful parse per target type, so the caller's
    own ``parse()`` returns the same object and nothing the caller can
    observe changes; a failed parse is not cached, so the caller's own
    ``parse()`` raises the same exception when the caller makes it. Never
    raises."""
    try:
        parse = getattr(response, "parse", None)
    except Exception:
        return response
    if not callable(parse):
        return response
    if inspect.iscoroutinefunction(parse):
        return UNREADABLE
    try:
        message = parse()
    except Exception:
        return UNREADABLE
    if inspect.isawaitable(message):
        if inspect.iscoroutine(message):
            message.close()
        return UNREADABLE
    return message


def read_once(response: Any) -> Any:
    """``response`` as the readers of one call take it: a raw-response
    wrapper is parsed once, into a :class:`ParsedRawResponse` holding the
    message and the wrapper's headers, so usage, model, content, stop
    reason, tool calls and metadata all read the same message; anything
    else (a message, a stream, a :class:`ParsedRawResponse`) as it is.

    A raw-response wrapper here is an object whose class defines
    ``parse()``, as the SDKs' ``LegacyAPIResponse`` / ``APIResponse`` /
    ``AsyncAPIResponse`` do; no message or stream class of the SDKs the
    sensor reads does, and an object that answers every attribute (a
    mock) is not taken for one. Never raises."""
    if isinstance(response, ParsedRawResponse):
        return response
    try:
        defines_parse = callable(getattr(type(response), "parse", None))
    except Exception:
        defines_parse = False
    if not defines_parse:
        return response
    message = response_message(response)
    try:
        headers = getattr(response, "headers", None)
    except Exception:
        headers = None
    return ParsedRawResponse(message, headers)


def stored_response(message: Any, is_stream: Callable[[Any], bool]) -> Any:
    """What content capture stores as the response for ``message``, the
    value :func:`response_message` gave: a message dumped as the plain
    call's is (its pydantic ``model_dump``); an empty response (``{}``)
    for no message (``None``, :data:`DROPPED_STREAM`) and for a stream that
    assembled none (``is_stream``); anything else as it is, which the
    transport sends when JSON can write it and otherwise sends the event
    without its content, with a warning naming the object's type
    (:data:`UNREADABLE` among them). Never an object's attributes or its
    string form, which the provider never returned. Raises what the dump
    raises."""
    if message is None or message is DROPPED_STREAM or is_stream(message):
        return {}
    dump = None if isinstance(message, type) else getattr(message, "model_dump", None)
    if callable(dump):
        # ``warnings=False``: the SDKs' generic ``Parsed*`` models trip
        # pydantic's serializer warnings on every dump, which would surface
        # as UserWarnings in the agent's process. A model_dump that takes no
        # such argument gets the plain call.
        try:
            return dump(warnings=False)
        except TypeError:
            return dump()
    return message


# Bytes per value of an embedding the API returns base64-encoded: the
# vector's float32 values, little-endian, back to back (the OpenAI SDK
# decodes it with ``numpy.frombuffer(..., dtype="float32")``, or
# ``array.array("f", ...)`` without numpy).
_FLOAT32_BYTES = 4


def vector_dimension(embedding: Any) -> int | None:
    """The number of values in one returned embedding: the length of a
    list of floats, or for the base64 string a call with
    ``encoding_format="base64"`` gets, the number of float32 values it
    decodes to, decoded as the OpenAI SDK decodes it (``b64decode``
    without validation, so characters outside the alphabet are skipped
    and bad padding raises). ``None`` where the SDK's own decoding would
    raise (bad padding, a length that is not whole float32 values), for
    no values at all, and for any other shape. Never raises."""
    if isinstance(embedding, str):
        try:
            raw = base64.b64decode(embedding)
        except (binascii.Error, ValueError):
            return None
        if len(raw) % _FLOAT32_BYTES:
            return None
        return len(raw) // _FLOAT32_BYTES or None
    try:
        return len(embedding) if embedding else None
    except TypeError:
        return None


def stored_vector(embedding: Any) -> Any:
    """One returned embedding as content capture stores it: as the
    provider returned it, a list of floats or a base64 string (never the
    string's characters as a list)."""
    return embedding if isinstance(embedding, str) else list(embedding)
