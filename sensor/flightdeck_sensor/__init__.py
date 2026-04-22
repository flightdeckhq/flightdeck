"""flightdeck-sensor: in-process agent observability for Flightdeck.

Two-line integration::

    import flightdeck_sensor
    flightdeck_sensor.init(server="http://localhost:4000/ingest", token="tok_dev")
"""

from __future__ import annotations

import contextlib
import logging
import os
import socket
import threading
import uuid
from typing import Any, Callable

from flightdeck_sensor.core.agent_id import derive_agent_id
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
from flightdeck_sensor.interceptor.litellm import (
    SensorLitellm,  # noqa: F401  # re-exported for flightdeck_sensor.SensorLitellm
    patch_litellm_functions,
    unpatch_litellm_functions,
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

# D114 / D115 vocabulary lock. Any other value raises ConfigurationError
# at init time. See CHANGELOG.md for the v0.4.0 Phase 1 breaking change
# that narrowed this from {autonomous, supervised, batch, developer}.
_VALID_AGENT_TYPES = frozenset({"coding", "production"})


def _resolve_user_name() -> str:
    """Resolve the current OS user, never raising.

    Uses ``pwd.getpwuid(os.getuid()).pw_name`` on POSIX, falling back
    to ``os.environ['USER']`` / ``os.environ['USERNAME']`` / the
    string ``"unknown"`` on platforms or containers where the
    primary probe raises (e.g. scratch UIDs inside distroless
    images). Never raises -- the agent_id derivation must always
    produce a value so the sensor boots.
    """
    try:
        import pwd

        return pwd.getpwuid(os.getuid()).pw_name
    except Exception:
        pass
    for key in ("USER", "USERNAME", "LOGNAME"):
        v = os.environ.get(key)
        if v:
            return v
    return "unknown"


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
    session_id: str | None = None,
    agent_type: str | None = None,
    agent_name: str | None = None,
) -> None:
    """Initialize the sensor and start the session.

    ``token`` here is a Flightdeck **access token** (an ``ftd_...``
    opaque string minted via ``POST /v1/access-tokens``, or the
    literal ``tok_dev`` seed when the server is running with
    ``ENVIRONMENT=dev``). It is NOT an LLM token count -- the
    platform also tracks input/output token totals on sessions, but
    those live under ``tokens_input`` / ``tokens_output`` fields
    and never flow through this parameter. The kwarg name (and the
    ``FLIGHTDECK_TOKEN`` env var) deliberately stayed as ``token``
    after the D096 rename so existing integrations don't break.

    ``api_url`` is the base URL for control-plane calls (directive
    registration, directive sync, policy prefetch).  When *None*,
    derived from *server* by replacing ``/ingest`` with ``/api``.
    Override via ``FLIGHTDECK_API_URL`` env var.

    ``limit`` sets a local WARN-only token threshold. Never blocks. Never
    degrades. Most restrictive threshold wins when both local and server
    policies are active. See DECISIONS.md D035.

    ``session_id`` is an optional caller-supplied identifier. When
    provided (or when ``FLIGHTDECK_SESSION_ID`` is set, which takes
    precedence over the kwarg in line with ``FLIGHTDECK_SERVER`` /
    ``AGENT_FLAVOR``), the sensor uses the caller's value verbatim
    instead of generating a UUID. If a session with that ID already
    exists in the control plane, the backend attaches this execution
    to the prior session; the sensor logs INFO on the first response
    that confirms attachment. Primary use case: orchestrators
    (Temporal workflows, Airflow DAGs) that re-run the same logical
    workflow and want a single correlatable session in the fleet view.
    See DECISIONS.md D094.

    ``agent_type`` selects the D114 / D115 agent classification. Must
    be one of ``"coding"`` or ``"production"`` -- any other value
    raises :class:`ConfigurationError` at init time. Default
    ``"production"`` because the Python sensor runs inside production
    agents; developer-driven smoke (playground, CI runners) flips the
    kwarg or the ``FLIGHTDECK_AGENT_TYPE`` env var to ``"coding"``.
    The pre-v0.4.0 values (``"autonomous"``, ``"supervised"``,
    ``"batch"``) are NO LONGER accepted -- this is a deliberate
    breaking change recorded in CHANGELOG.md.

    ``agent_name`` is the human-readable label that renders on the
    Fleet page. Defaults to ``"{user}@{hostname}"`` -- use the kwarg
    or ``FLIGHTDECK_AGENT_NAME`` env var to override (e.g. a
    Kubernetes deployment name, a CI job id, etc.). Override via
    env var when the running process cannot know its own label at
    code time.

    Reads from environment (overrides parameters):

    - ``FLIGHTDECK_API_URL`` -- control-plane base URL (overrides *api_url*)
    - ``FLIGHTDECK_SESSION_ID`` -- session id hint (overrides *session_id*)
    - ``FLIGHTDECK_AGENT_TYPE`` / ``AGENT_TYPE`` -- overrides *agent_type*; must be ``coding`` or ``production``
    - ``FLIGHTDECK_AGENT_NAME`` / ``AGENT_FLAVOR`` -- overrides *agent_name* (``AGENT_FLAVOR`` retained for wire-level ``flavor`` field compatibility)
    - ``FLIGHTDECK_HOSTNAME`` -- overrides ``socket.gethostname()`` (useful for k8s pod grouping)
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

        # KI20: normalize ``FLIGHTDECK_SERVER`` / ``server`` kwarg to
        # always carry the ``/ingest`` suffix. The Claude Code plugin
        # uses the same env var without the suffix (it appends
        # ``/ingest/v1/events`` itself), so a developer running both
        # tools on one machine would otherwise hit a silent 404 when
        # a sensor script inherited the plugin's env. ``/ingest`` is
        # added idempotently -- a URL that already contains it stays
        # unchanged.
        if "/ingest" not in resolved_server:
            resolved_server = resolved_server.rstrip("/") + "/ingest"

        resolved_api_url = os.environ.get("FLIGHTDECK_API_URL") or api_url
        if not resolved_api_url:
            resolved_api_url = resolved_server.rstrip("/").replace(
                "/ingest", "/api"
            )

        capture = _env_bool("FLIGHTDECK_CAPTURE_PROMPTS", capture_prompts)

        # session_id resolution follows the same env-wins pattern as
        # FLIGHTDECK_SERVER / AGENT_FLAVOR: env var overrides kwarg,
        # and a falsy env var falls through to the kwarg. An empty
        # string from either source is treated as "not provided" so a
        # misconfigured shell (FLIGHTDECK_SESSION_ID="") still auto-
        # generates a UUID rather than posting a session_start with a
        # blank session_id that the ingestion API rejects.
        resolved_session_id = (
            os.environ.get("FLIGHTDECK_SESSION_ID") or session_id or None
        )
        if resolved_session_id and not _is_valid_uuid(resolved_session_id):
            # The sessions table column is UUID-typed; accepting a
            # non-UUID here would trip Postgres at worker time and
            # drop every event for this agent. Warn loudly and fall
            # back to auto-generation so the agent still boots. The
            # common source of this is orchestrators (Temporal
            # workflow_id, Airflow dag_run_id) that are strings, not
            # UUIDs -- callers need to hash them into a UUID before
            # passing, e.g. uuid.uuid5(NAMESPACE_URL, workflow_id).
            _log.warning(
                "Custom session_id '%s' is not a valid UUID. A random "
                "session ID will be generated instead.",
                resolved_session_id,
            )
            resolved_session_id = None
        if resolved_session_id:
            _log.warning(
                "Custom session_id provided: '%s'. This ID will be used "
                "as-is and will not be auto-generated. If a session with "
                "this ID already exists, the backend will attach this "
                "agent to it.",
                resolved_session_id,
            )

        # D115: resolve agent identity. Precedence is
        # kwarg > env > default, matching every other init() param.
        # ``FLIGHTDECK_AGENT_TYPE`` wins over the legacy ``AGENT_TYPE``
        # env var so operators migrating from v0.3.x can set either;
        # same pattern for ``FLIGHTDECK_AGENT_NAME`` / ``AGENT_FLAVOR``.
        resolved_agent_type = (
            agent_type
            or os.environ.get("FLIGHTDECK_AGENT_TYPE")
            or os.environ.get("AGENT_TYPE")
            or "production"
        )
        if resolved_agent_type not in _VALID_AGENT_TYPES:
            raise ConfigurationError(
                f"agent_type={resolved_agent_type!r} is not valid. "
                f"Must be one of {sorted(_VALID_AGENT_TYPES)}. "
                "Pre-v0.4.0 values ('autonomous', 'supervised', "
                "'batch', 'developer') are no longer accepted -- "
                "see CHANGELOG.md for the v0.4.0 Phase 1 migration."
            )

        resolved_hostname = (
            os.environ.get("FLIGHTDECK_HOSTNAME") or socket.gethostname()
        )
        resolved_user = _resolve_user_name()
        resolved_agent_name = (
            agent_name
            or os.environ.get("FLIGHTDECK_AGENT_NAME")
            or os.environ.get("AGENT_FLAVOR")
            or f"{resolved_user}@{resolved_hostname}"
        )

        # Agent identity UUID. Deterministic function of the tuple --
        # same tuple on two processes = same agent_id. See D115 and
        # flightdeck_sensor.core.agent_id.
        resolved_agent_id = str(
            derive_agent_id(
                agent_type=resolved_agent_type,
                user=resolved_user,
                hostname=resolved_hostname,
                client_type="flightdeck_sensor",
                agent_name=resolved_agent_name,
            )
        )

        config_kwargs: dict[str, Any] = {
            "server": resolved_server,
            "token": resolved_token,
            "api_url": resolved_api_url,
            "capture_prompts": capture,
            "unavailable_policy": os.environ.get(
                "FLIGHTDECK_UNAVAILABLE_POLICY", "continue"
            ),
            # Legacy wire-level ``flavor`` field stays populated for
            # backward compat with every downstream surface that still
            # reads sessions.flavor (dashboard flavor facet, analytics
            # group_by=flavor, etc.). Default now mirrors agent_name so
            # the two fields agree for sensor-default deployments.
            "agent_flavor": os.environ.get(
                "AGENT_FLAVOR", resolved_agent_name
            ),
            "agent_type": resolved_agent_type,
            "agent_id": resolved_agent_id,
            "agent_name": resolved_agent_name,
            "user_name": resolved_user,
            "hostname": resolved_hostname,
            "client_type": "flightdeck_sensor",
            "quiet": quiet,
            "limit": limit,
            "warn_at": warn_at,
        }
        # Only pass session_id when the caller asked for a specific
        # value; otherwise let SensorConfig's default_factory generate
        # a fresh UUID as before. Passing session_id=None would
        # overwrite the factory output with None.
        if resolved_session_id:
            config_kwargs["session_id"] = resolved_session_id
        config = SensorConfig(**config_kwargs)

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
            available providers (``["anthropic", "openai", "litellm"]``).
            litellm joins the patch set as the third interceptor (KI21).
            Its patch mutates module-level ``litellm.completion`` /
            ``litellm.acompletion`` rather than SDK classes; streaming
            is not yet supported and raises NotImplementedError (KI26).
    """
    _require_session("patch")
    targets = providers or ["anthropic", "openai", "litellm"]

    with _patch_lock:
        if "anthropic" in targets:
            patch_anthropic_classes(quiet=quiet)
        if "openai" in targets:
            patch_openai_classes(quiet=quiet)
        if "litellm" in targets:
            patch_litellm_functions(quiet=quiet)


def unpatch() -> None:
    """Reverse all class-level patches applied by :func:`patch`.

    Idempotent: safe to call without a preceding ``patch()``. Restores
    the original ``cached_property`` descriptors and the original
    ``litellm.completion`` / ``litellm.acompletion`` module attributes,
    and removes every ``_flightdeck_patched`` sentinel.

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
        unpatch_litellm_functions()


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


def _is_valid_uuid(value: str) -> bool:
    """Return True when *value* parses as a canonical UUID string.

    The sessions table uses Postgres ``UUID`` which accepts any valid
    UUID (any version), so the check is deliberately permissive about
    version -- only the string shape matters. ``uuid.UUID(value)``
    already validates hex chars, hyphen placement, and length; any
    failure raises ``ValueError`` which we swallow and return False.
    """
    try:
        uuid.UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


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
