"""flightdeck-sensor: in-process agent observability for Flightdeck.

Two-line integration::

    import flightdeck_sensor
    flightdeck_sensor.init(server="http://localhost:4000/ingest", token="tok_dev")
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

from flightdeck_sensor.core.exceptions import (
    BudgetExceededError,
    ConfigurationError,
    DirectiveError,
)
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import (
    SensorConfig,
    StatusResponse,
)
from flightdeck_sensor.interceptor.anthropic import GuardedAnthropic
from flightdeck_sensor.interceptor.openai import GuardedOpenAI
from flightdeck_sensor.transport.client import ControlPlaneClient

__all__ = [
    "init",
    "wrap",
    "patch",
    "unpatch",
    "get_status",
    "teardown",
    "BudgetExceededError",
    "ConfigurationError",
    "DirectiveError",
]

_log = logging.getLogger("flightdeck_sensor")

# Global state -- protected by _lock
_lock = threading.Lock()
_session: Session | None = None
_client: ControlPlaneClient | None = None
_original_inits: dict[str, Any] = {}


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------


def init(
    server: str,
    token: str,
    capture_prompts: bool = False,
    quiet: bool = False,
) -> None:
    """Initialize the sensor and start the session.

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

        capture = _env_bool("FLIGHTDECK_CAPTURE_PROMPTS", capture_prompts)
        config = SensorConfig(
            server=os.environ.get("FLIGHTDECK_SERVER", server),
            token=os.environ.get("FLIGHTDECK_TOKEN", token),
            capture_prompts=capture,
            unavailable_policy=os.environ.get(
                "FLIGHTDECK_UNAVAILABLE_POLICY", "continue"
            ),
            agent_flavor=os.environ.get("AGENT_FLAVOR", "unknown"),
            agent_type=os.environ.get("AGENT_TYPE", "autonomous"),
            quiet=quiet,
        )

        _client = ControlPlaneClient(
            server=config.server,
            token=config.token,
            unavailable_policy=config.unavailable_policy,
        )
        _session = Session(config=config, client=_client)
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

    if "anthropic" in targets:
        _patch_anthropic(session, quiet)

    if "openai" in targets:
        _patch_openai(session, quiet)


def unpatch() -> None:
    """Reverse all monkey-patches applied by :func:`patch`."""
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
