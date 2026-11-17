"""google-genai interceptor: a class-level patch of the request methods of
``Models`` / ``AsyncModels``.

Every Gemini call the google-genai SDK makes goes through
``google.genai.models.Models`` (``client.models``) or ``AsyncModels``
(``client.aio.models``): a chat (``client.chats`` / ``client.aio.chats``)
calls their ``generate_content`` / ``generate_content_stream``, and a
client built with ``vertexai=True`` runs the same methods with Vertex AI's
converters. Frameworks that build their own client (Google ADK's Gemini
model, ``langchain-google-genai``, CrewAI's Gemini provider) reach the
same classes.

The public ``generate_content``, ``generate_content_stream`` and
``embed_content`` send each request through a private method,
``_generate_content``, ``_generate_content_stream`` and
``_embed_content``, one HTTP request each. A public call can make
several: automatic function calling (a Python function among the config's
``tools``, which the SDK runs itself and answers the model with) and
automatic continuation (a response the model stopped with
``finish_reason=CONTINUATION``) call the private method once per round,
and the public method returns only the last round's response, whose
usage counts that round alone. So the patch replaces the three private
methods on both classes: each request the provider bills is one
``pre_call``, one policy check and one ``post_call`` (``embeddings`` for
``_embed_content``), and a policy block or the kill switch stops the run
at its next request. The public methods, their signatures and their
argument checks stay the SDK's own.

A sync ``_generate_content_stream`` is a generator: the sensor's stands in
with the stream guard, which the SDK iterates as it iterates its own
generator; the request goes out at its first chunk. The async one awaits
the request and returns an async generator: the sensor's awaits the guard
open and returns it. Each call reads the session when its request goes
out (an async one when awaited), so a client kept across ``teardown()``
and a new ``init()`` reports to the new session, and with no session the
SDK gets the call untouched.

``count_tokens``, ``compute_tokens``, the image and video methods and the
``interactions``, ``agents``, ``live``, ``batches`` and ``caches``
surfaces are not patched.
"""

from __future__ import annotations

import functools
import logging
import types
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.platform import (
    PLATFORM_GEMINI_API,
    PLATFORM_VERTEX,
    endpoint_of_url,
)
from flightdeck_sensor.providers.google import GoogleProvider

if TYPE_CHECKING:
    from collections.abc import Callable

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.google_genai")

# The first release whose three public methods send their requests through
# the private methods patched here (``_embed_content`` arrived in 1.64.0);
# CI's SDK-floors lane runs the unit suite against it. An installed SDK
# without them is reported once, at import, rather than silently left
# unmetered.
_MIN_SDK_VERSION = "1.64.0"

_GENERATE = "_generate_content"
_STREAM = "_generate_content_stream"
_EMBED = "_embed_content"
_PATCHED_METHODS = (_GENERATE, _STREAM, _EMBED)

# Sentinel attribute on a patched class, holding the original methods so
# unpatch can restore them.
_PATCHED_SENTINEL = "_flightdeck_patched"

# Typed Any: the lanes that do not install google-genai type-check this
# module without it.
_models_module: Any
try:
    from google.genai import models as _imported_models

    _models_module = _imported_models
except ImportError:
    _models_module = None

_OrigModels: type | None = None
_OrigAsyncModels: type | None = None
_GOOGLE_GENAI_AVAILABLE = False
if _models_module is not None:
    # Read from each class's own namespace, where the patch installs.
    _missing = [
        f"{cls_name}.{name}"
        for cls_name in ("Models", "AsyncModels")
        for name in _PATCHED_METHODS
        if not callable(vars(getattr(_models_module, cls_name, object)).get(name))
    ]
    if _missing:
        try:
            from google.genai import version as _version_module

            _installed_version = getattr(_version_module, "__version__", "?")
        except ImportError:
            _installed_version = "?"
        _log.warning(
            "google-genai %s lacks the request methods the sensor patches (%s; needs "
            "google-genai>=%s): Gemini calls are not metered",
            _installed_version,
            ", ".join(_missing),
            _MIN_SDK_VERSION,
        )
    else:
        _OrigModels = _models_module.Models
        _OrigAsyncModels = _models_module.AsyncModels
        _GOOGLE_GENAI_AVAILABLE = True


def _current_session() -> Session | None:
    """The active session, looked up at call time (imported lazily: this
    module is imported by ``flightdeck_sensor``)."""
    import flightdeck_sensor

    return flightdeck_sensor._session


def _vertex_scope(api_client: Any) -> str | None:
    """``global`` or ``regional`` for a Vertex AI client, from the
    location it was configured with; ``None`` when it names none."""
    location = getattr(api_client, "location", None)
    if not isinstance(location, str) or not location:
        return None
    return "global" if location == "global" else "regional"


def _provider_for(api_client: Any, session: Session) -> GoogleProvider:
    """The provider for a call through ``api_client`` (the resource's
    ``_api_client``): the session's capture setting, and the endpoint its
    base URL names (``gemini-api`` for the Gemini API's host, ``vertex``
    for Vertex AI's, the host of a proxy or local server otherwise)."""
    vertex = bool(getattr(api_client, "vertexai", False))
    http_options = getattr(api_client, "_http_options", None)
    endpoint = endpoint_of_url(
        getattr(http_options, "base_url", None),
        PLATFORM_VERTEX if vertex else PLATFORM_GEMINI_API,
    )
    return GoogleProvider(
        capture_prompts=session.config.capture_prompts,
        platform=endpoint.platform,
        local=endpoint.local,
        inference_scope=_vertex_scope(api_client) if endpoint.platform == PLATFORM_VERTEX else None,
        api_client=api_client,
    )


def _installed(cls: type, name: str, method: Any) -> bool:
    """Whether ``method`` is still installed as ``name`` on ``cls`` or a
    base: once unpatched the original runs, also for a subclass that
    reaches the method through ``super()``."""
    return any(klass.__dict__.get(name) is method for klass in cls.__mro__)


def _sync_method(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
    event_type = EventType.EMBEDDINGS if name == _EMBED else EventType.POST_CALL

    @functools.wraps(original)
    def method(self: Any, **kwargs: Any) -> Any:
        session = _current_session()
        # No session, an outer interceptor already metering this call (see
        # base.outer_intercept), or the class unpatched: the SDK's own.
        if (
            session is None
            or base.outer_intercept_active()
            or not _installed(type(self), name, method)
        ):
            return original(self, **kwargs)
        provider = _provider_for(getattr(self, "_api_client", None), session)
        real = types.MethodType(original, self)
        if name == _STREAM:
            # Not opened: the SDK's generator sends its request at its
            # first chunk, which the guard reads when the SDK iterates it.
            return base.call_stream(real, kwargs, session, provider)
        return base.call(real, kwargs, session, provider, event_type=event_type)

    return method


def _async_method(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
    event_type = EventType.EMBEDDINGS if name == _EMBED else EventType.POST_CALL

    @functools.wraps(original)
    async def method(self: Any, **kwargs: Any) -> Any:
        # Read when awaited, the moment the request goes out.
        session = _current_session()
        if (
            session is None
            or base.outer_intercept_active()
            or not _installed(type(self), name, method)
        ):
            return await original(self, **kwargs)
        provider = _provider_for(getattr(self, "_api_client", None), session)
        real = types.MethodType(original, self)
        if name == _STREAM:
            # The SDK's own awaits the request and hands back the stream.
            return await base.call_stream_async(real, kwargs, session, provider).open()
        return await base.call_async(real, kwargs, session, provider, event_type=event_type)

    return method


def _targets() -> tuple[tuple[Any, bool], ...]:
    return ((_OrigModels, False), (_OrigAsyncModels, True))


def is_patched() -> bool:
    """Whether the patch is installed."""
    return _OrigModels is not None and _PATCHED_SENTINEL in _OrigModels.__dict__


def patch_google_genai(quiet: bool = False) -> None:
    """Replace ``_generate_content``, ``_generate_content_stream`` and
    ``_embed_content`` on ``Models`` and ``AsyncModels``. Idempotent; a
    silent no-op when google-genai is not installed (or predates the
    request methods, which import warned of). Clients that exist already
    are covered from their next call, since the methods live on the
    class."""
    if not _GOOGLE_GENAI_AVAILABLE:
        if not quiet:
            _log.debug("google-genai not available; skipping patch")
        return
    for cls, is_async in _targets():
        if cls is None or _PATCHED_SENTINEL in cls.__dict__:
            continue
        originals = {name: cls.__dict__[name] for name in _PATCHED_METHODS}
        wrapper = _async_method if is_async else _sync_method
        setattr(cls, _PATCHED_SENTINEL, originals)
        for name, original in originals.items():
            setattr(cls, name, wrapper(name, original))
        if not quiet:
            _log.info("Patched %s.%s", cls.__name__, " / ".join(originals))


def unpatch_google_genai() -> None:
    """Restore the original methods and remove the sentinel. Idempotent."""
    if not _GOOGLE_GENAI_AVAILABLE:
        return
    for cls, _is_async in _targets():
        originals = None if cls is None else cls.__dict__.get(_PATCHED_SENTINEL)
        if not isinstance(originals, dict):
            continue
        for name, original in originals.items():
            setattr(cls, name, original)
        delattr(cls, _PATCHED_SENTINEL)
