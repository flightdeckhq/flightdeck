"""flightdeck-sensor: in-process agent observability for Flightdeck.

Two-line integration::

    import flightdeck_sensor
    flightdeck_sensor.init(server="http://localhost:4000/ingest", token="tok_dev")
"""

from __future__ import annotations

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
from flightdeck_sensor.interceptor.anthropic import GuardedAnthropic
from flightdeck_sensor.interceptor.openai import GuardedOpenAI
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

# Global state -- protected by _lock
_lock = threading.Lock()
_patch_lock = threading.Lock()
_session: Session | None = None
_client: ControlPlaneClient | None = None
_original_inits: dict[str, Any] = {}

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
    capture_prompts: bool = False,
    quiet: bool = False,
    limit: int | None = None,
    warn_at: float = 0.8,
) -> None:
    """Initialize the sensor and start the session.

    ``limit`` sets a local WARN-only token threshold. Never blocks. Never
    degrades. Most restrictive threshold wins when both local and server
    policies are active. See DECISIONS.md D035.

    Reads from environment (overrides parameters):

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

        capture = _env_bool("FLIGHTDECK_CAPTURE_PROMPTS", capture_prompts)
        config = SensorConfig(
            server=resolved_server,
            token=resolved_token,
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
            unavailable_policy=config.unavailable_policy,
        )
        _session = Session(config=config, client=_client)

        # Best-effort runtime context collection. Never raises -- if
        # any collector fails the agent continues with no context
        # attached. Set on the session BEFORE start() so the
        # session_start event payload includes it.
        runtime_ctx: dict[str, Any] = {}
        try:
            runtime_ctx = _collect_context()
        except Exception:
            pass
        _session.set_context(runtime_ctx)

        _session.start()


def wrap(client: Any, quiet: bool = False) -> Any:
    """Wrap an Anthropic or OpenAI client for interception.

    ``init()`` must be called first.
    """
    session = _require_session("wrap")

    # Detect Anthropic client
    if _is_anthropic(client):
        return GuardedAnthropic(client, session)

    # Detect OpenAI client
    if _is_openai(client):
        return GuardedOpenAI(client, session)

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
    """Monkey-patch SDK constructors so new clients are auto-wrapped.

    ``init()`` must be called first.

    Args:
        providers: list of provider names to patch. Default patches all
            available providers (``["anthropic", "openai"]``).
    """
    session = _require_session("patch")
    targets = providers or ["anthropic", "openai"]

    with _patch_lock:
        if "anthropic" in targets:
            _patch_anthropic(session, quiet)

        if "openai" in targets:
            _patch_openai(session, quiet)


def unpatch() -> None:
    """Reverse all monkey-patches applied by :func:`patch`."""
    with _patch_lock:
        for key, original in _original_inits.items():
            parts = key.rsplit(".", 1)
            if len(parts) == 2:
                mod_name, attr = parts
                try:
                    import importlib

                    mod = importlib.import_module(mod_name)
                    setattr(mod, attr, original)
                except (ImportError, AttributeError):
                    pass
        _original_inits.clear()


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
    try:
        import anthropic

        return isinstance(client, (anthropic.Anthropic, anthropic.AsyncAnthropic))
    except ImportError:
        return False


def _is_openai(client: Any) -> bool:
    try:
        import openai

        return isinstance(client, (openai.OpenAI, openai.AsyncOpenAI))
    except ImportError:
        return False


def _patch_anthropic(session: Session, quiet: bool) -> None:
    try:
        import anthropic
    except ImportError:
        if not quiet:
            _log.debug("anthropic not installed; skipping patch")
        return

    orig_sync = anthropic.Anthropic
    orig_async = anthropic.AsyncAnthropic

    _original_inits["anthropic.Anthropic"] = orig_sync
    _original_inits["anthropic.AsyncAnthropic"] = orig_async

    def _make_sync(*args: Any, **kwargs: Any) -> GuardedAnthropic:
        real = orig_sync(*args, **kwargs)
        return GuardedAnthropic(real, session)

    def _make_async(*args: Any, **kwargs: Any) -> GuardedAnthropic:
        real = orig_async(*args, **kwargs)
        return GuardedAnthropic(real, session)

    anthropic.Anthropic = _make_sync  # type: ignore[assignment,misc]
    anthropic.AsyncAnthropic = _make_async  # type: ignore[assignment,misc]

    if not quiet:
        _log.info("Patched anthropic.Anthropic and anthropic.AsyncAnthropic")


def _patch_openai(session: Session, quiet: bool) -> None:
    try:
        import openai
    except ImportError:
        if not quiet:
            _log.debug("openai not installed; skipping patch")
        return

    orig_sync = openai.OpenAI
    orig_async = openai.AsyncOpenAI

    _original_inits["openai.OpenAI"] = orig_sync
    _original_inits["openai.AsyncOpenAI"] = orig_async

    def _make_sync(*args: Any, **kwargs: Any) -> GuardedOpenAI:
        real = orig_sync(*args, **kwargs)
        return GuardedOpenAI(real, session)

    def _make_async(*args: Any, **kwargs: Any) -> GuardedOpenAI:
        real = orig_async(*args, **kwargs)
        return GuardedOpenAI(real, session)

    openai.OpenAI = _make_sync  # type: ignore[assignment,misc]
    openai.AsyncOpenAI = _make_async  # type: ignore[assignment,misc]

    if not quiet:
        _log.info("Patched openai.OpenAI and openai.AsyncOpenAI")
