"""flightdeck-sensor: in-process agent observability for Flightdeck.

Two-line integration::

    import flightdeck_sensor
    flightdeck_sensor.init(server="http://localhost:4000/ingest", token="tok_dev")
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
from typing import Any, Callable

from flightdeck_sensor.core.context import collect as _collect_context
from flightdeck_sensor.core.exceptions import (
    BudgetExceededError,
    ConfigurationError,
    DirectiveError,
)
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import (
    DirectiveParameter,
    DirectiveRegistration,
    SensorConfig,
    StatusResponse,
)
from flightdeck_sensor.interceptor.anthropic import (
    SensorAnthropic,
    _OrigAnthropic,
    _OrigAsyncAnthropic,
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.openai import (
    SensorOpenAI,
    _OrigAsyncOpenAI,
    _OrigOpenAI,
    patch_openai_classes,
    unpatch_openai_classes,
)
from flightdeck_sensor.transport.client import ControlPlaneClient

Parameter = DirectiveParameter

__all__ = [
    "init",
    "wrap",
    "patch",
    "unpatch",
    "get_status",
    "teardown",
    "directive",
    "Parameter",
    "BudgetExceededError",
    "ConfigurationError",
    "DirectiveError",
]

_log = logging.getLogger("flightdeck_sensor")

# Global state -- protected by _lock.
# v1 design: process-wide singleton. Multi-session-in-one-process is a
# v2 concern; users who need isolated sessions should run separate
# processes (one sensor per process). See DECISIONS.md D091.
_lock = threading.Lock()
_patch_lock = threading.Lock()
_session: Session | None = None
_client: ControlPlaneClient | None = None

# Custom directive registry -- populated by @directive decorator
_directive_registry: dict[str, DirectiveRegistration] = {}


# ------------------------------------------------------------------
# Custom directive registration
# ------------------------------------------------------------------


def _compute_fingerprint(
    name: str, description: str, parameters: list[DirectiveParameter]
) -> str:
    """Compute a deterministic SHA-256 fingerprint for a directive schema."""
    import base64
    import hashlib
    import json

    payload = json.dumps(
        {
            "name": name,
            "description": description,
            "parameters": [
                {
                    "name": p.name,
                    "type": p.type,
                    "description": p.description,
                    "options": p.options,
                    "required": p.required,
                    "default": p.default,
                }
                for p in parameters
            ],
        },
        sort_keys=True,
    )
    return base64.b64encode(hashlib.sha256(payload.encode()).digest()).decode()


def directive(
    name: str,
    description: str = "",
    parameters: list[Parameter] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator to register a function as a custom directive handler.

    Example::

        @flightdeck_sensor.directive("pause", description="Pause the agent")
        def handle_pause(ctx, duration=30):
            time.sleep(duration)

    .. warning:: The ``parameters`` schema you declare here is used to
       compute the directive fingerprint and to render the parameter
       form on the dashboard. **It is NOT enforced at execution
       time.** When the dashboard issues a directive, the
       ``parameters`` dict in the request body is passed straight
       through to your handler as ``**kwargs`` after only shape-level
       validation (``directive_name: str``, ``fingerprint: str``,
       ``parameters: dict``). The handler is responsible for
       validating its own inputs -- if you declare ``value: int`` in
       the schema, you should still defensively check ``isinstance(
       value, int)`` inside the handler. Type mismatches that crash
       the handler are caught by the runtime and logged, but bad
       input data may produce surprising side effects before the
       crash. Phase 4.5 audit Hat 4 finding.
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        params = parameters or []
        fp = _compute_fingerprint(name, description, params)
        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description=description,
            parameters=params,
            fingerprint=fp,
            handler=fn,
        )
        return fn

    return decorator


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------


def init(
    server: str,
    token: str,
    api_url: str | None = None,
    capture_prompts: bool = False,
    quiet: bool = False,
    limit: int | None = None,
    warn_at: float = 0.8,
) -> None:
    """Initialize the sensor and start the session.

    ``api_url`` is the base URL for control-plane calls (directive
    registration, directive sync, policy prefetch).  When *None*,
    derived from *server* by replacing ``/ingest`` with ``/api``.
    Override via ``FLIGHTDECK_API_URL`` env var.

    ``limit`` sets a local WARN-only token threshold. Never blocks. Never
    degrades. Most restrictive threshold wins when both local and server
    policies are active. See DECISIONS.md D035.

    Reads from environment (overrides parameters):

    - ``FLIGHTDECK_API_URL`` -- control-plane base URL (overrides *api_url*)
    - ``AGENT_FLAVOR`` -- persistent identity (default: ``"unknown"``)
    - ``AGENT_TYPE`` -- ``"autonomous"``, ``"supervised"``, or ``"batch"``
    - ``FLIGHTDECK_UNAVAILABLE_POLICY`` -- ``"continue"`` or ``"halt"``
    - ``FLIGHTDECK_CAPTURE_PROMPTS`` -- ``"true"`` to enable
    """
    global _session, _client

    with _lock:
        if _session is not None:
            if not quiet:
                _log.warning("flightdeck_sensor.init() called twice; ignoring")
            return

        resolved_server = os.environ.get("FLIGHTDECK_SERVER", server)
        resolved_token = os.environ.get("FLIGHTDECK_TOKEN", token)
        if not resolved_server:
            raise ConfigurationError("server URL is required")
        if not resolved_token:
            raise ConfigurationError("token is required")

        resolved_api_url = os.environ.get("FLIGHTDECK_API_URL") or api_url
        if not resolved_api_url:
            resolved_api_url = resolved_server.rstrip("/").replace(
                "/ingest", "/api"
            )

        capture = _env_bool("FLIGHTDECK_CAPTURE_PROMPTS", capture_prompts)
        config = SensorConfig(
            server=resolved_server,
            token=resolved_token,
            api_url=resolved_api_url,
            capture_prompts=capture,
            unavailable_policy=os.environ.get(
                "FLIGHTDECK_UNAVAILABLE_POLICY", "continue"
            ),
            agent_flavor=os.environ.get("AGENT_FLAVOR", "unknown"),
            agent_type=os.environ.get("AGENT_TYPE", "autonomous"),
            quiet=quiet,
            limit=limit,
            warn_at=warn_at,
        )

        _client = ControlPlaneClient(
            server=config.server,
            token=config.token,
            api_url=config.api_url,
            unavailable_policy=config.unavailable_policy,
        )
        _session = Session(config=config, client=_client)

        # Best-effort runtime context collection. Never raises -- if
        # any collector fails the agent continues with no context
        # attached. Set on the session BEFORE start() so the
        # session_start event payload includes it.
        runtime_ctx: dict[str, Any] = {}
        with contextlib.suppress(Exception):
            runtime_ctx = _collect_context()
        _session.set_context(runtime_ctx)

        _session.start()


def wrap(client: Any, quiet: bool = False) -> Any:
    """Wrap an Anthropic or OpenAI client for interception.

    ``init()`` must be called first.

    If :func:`patch` has already been called, the client's class has
    a class-level ``messages`` / ``chat`` descriptor installed and the
    client's resource access is already intercepted -- in that case
    ``wrap()`` is a no-op and returns the client unchanged. This
    avoids double-wrapping.
    """
    session = _require_session("wrap")

    # Detect Anthropic client
    if _is_anthropic(client):
        # If the class is already patched, the descriptor handles
        # interception transparently and wrapping again would produce
        # a SensorMessages-of-SensorMessages on first .messages access.
        if hasattr(type(client), "_flightdeck_patched"):
            return client
        return SensorAnthropic(client, session)

    # Detect OpenAI client
    if _is_openai(client):
        if hasattr(type(client), "_flightdeck_patched"):
            return client
        return SensorOpenAI(client, session)

    if not quiet:
        _log.warning(
            "wrap(): unrecognised client type %s; returning unwrapped",
            type(client).__name__,
        )
    return client


def patch(
    quiet: bool = False,
    providers: list[str] | None = None,
) -> None:
    """Class-level patch the Anthropic and OpenAI SDKs.

    After ``patch()``, every instance of ``anthropic.Anthropic``,
    ``anthropic.AsyncAnthropic``, ``openai.OpenAI``, and
    ``openai.AsyncOpenAI`` -- including instances constructed
    transparently by frameworks such as ``langchain-anthropic``,
    ``langchain-openai``, ``llama-index-llms-anthropic``, and
    ``llama-index-llms-openai`` -- will have its first ``.messages``
    or ``.chat`` access return a flightdeck-managed proxy that posts
    pre/post events for every LLM call.

    The patch mutates each class object in place by replacing the
    ``messages``/``chat`` ``cached_property`` descriptor with a custom
    descriptor and tagging the class with a ``_flightdeck_patched``
    sentinel attribute. ``isinstance(x, anthropic.Anthropic)`` and
    captured references like ``from anthropic import Anthropic``
    continue to work correctly because the class object's identity is
    preserved.

    **Idempotent**: calling ``patch()`` twice is a no-op on the second
    call -- the descriptor is only installed if the class does not
    already carry the ``_flightdeck_patched`` sentinel.

    **Limitation**: instances of these classes that were constructed
    BEFORE ``patch()`` was called and that already accessed
    ``.messages`` / ``.chat`` once will have the unwrapped resource
    cached in their ``__dict__`` and will not be intercepted. New
    instances and new accesses on existing instances ARE intercepted.

    ``init()`` must be called first.

    Args:
        providers: list of provider names to patch. Default patches all
            available providers (``["anthropic", "openai"]``).
    """
    _require_session("patch")
    targets = providers or ["anthropic", "openai"]

    with _patch_lock:
        if "anthropic" in targets:
            patch_anthropic_classes(quiet=quiet)
        if "openai" in targets:
            patch_openai_classes(quiet=quiet)


def unpatch() -> None:
    """Reverse all class-level patches applied by :func:`patch`.

    Idempotent: safe to call without a preceding ``patch()``. Restores
    the original ``cached_property`` descriptors and removes the
    ``_flightdeck_patched`` sentinels.

    Instances that have already accessed ``.messages`` / ``.chat``
    after ``patch()`` was called keep the wrapped version cached in
    their ``__dict__`` until the instance is garbage collected. This
    is a known limitation -- documented in
    :func:`unpatch_anthropic_classes` and
    :func:`unpatch_openai_classes`.
    """
    with _patch_lock:
        unpatch_anthropic_classes()
        unpatch_openai_classes()


def get_status() -> StatusResponse:
    """Return a snapshot of the current session status."""
    session = _require_session("get_status")
    return session.get_status()


def teardown() -> None:
    """End the session, close transport, and reset global state."""
    global _session, _client

    with _lock:
        if _session is not None:
            _session.end()
            _session = None
        if _client is not None:
            _client.close()
            _client = None

    unpatch()


# ------------------------------------------------------------------
# Internals
# ------------------------------------------------------------------


def _require_session(caller: str) -> Session:
    with _lock:
        if _session is None:
            raise ConfigurationError(
                f"{caller}() called before init(). Call flightdeck_sensor.init() first."
            )
        return _session


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key, "")
    if raw.lower() in ("true", "1", "yes"):
        return True
    if raw.lower() in ("false", "0", "no"):
        return False
    return default


def _is_anthropic(client: Any) -> bool:
    """Detect an Anthropic / AsyncAnthropic client via captured references.

    Uses the original class references captured at interceptor-module
    import time so that ``isinstance`` checks survive ``patch()``
    mutating the module attributes.
    """
    if _OrigAnthropic is None or _OrigAsyncAnthropic is None:
        return False
    return isinstance(client, (_OrigAnthropic, _OrigAsyncAnthropic))


def _is_openai(client: Any) -> bool:
    """Detect an OpenAI / AsyncOpenAI client via captured references."""
    if _OrigOpenAI is None or _OrigAsyncOpenAI is None:
        return False
    return isinstance(client, (_OrigOpenAI, _OrigAsyncOpenAI))
