"""flightdeck-sensor: in-process agent observability for Flightdeck.

Two-line integration::

    import flightdeck_sensor
    flightdeck_sensor.init(server="http://localhost:4000/ingest", token="tok_dev")
"""

from __future__ import annotations

import collections
import contextlib
import dataclasses
import functools
import importlib
import logging
import os
import socket
import sys
import threading
import uuid
from typing import TYPE_CHECKING, Any

from flightdeck_sensor import config as _env
from flightdeck_sensor.core import import_hook as _import_hook
from flightdeck_sensor.core.agent_id import derive_agent_id
from flightdeck_sensor.core.context import collect as _collect_context
from flightdeck_sensor.core.context import framework_label as _framework_label
from flightdeck_sensor.core.exceptions import (
    BudgetExceededError,
    ConfigurationError,
    DirectiveError,
    MCPPolicyBlocked,
)
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import (
    DirectiveParameter,
    DirectiveRegistration,
    SensorConfig,
    StatusResponse,
)

# The LangGraph interceptor module imports LangGraph only when it patches,
# so importing it here for init()'s node pattern costs nothing.
from flightdeck_sensor.interceptor.langgraph import (
    set_agent_node_pattern as _set_langgraph_agent_node_pattern,
)
from flightdeck_sensor.provider import Provider
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Callable
    from types import ModuleType

    # The names __getattr__ resolves on first access, typed for checkers;
    # at runtime they are imported only once their SDK is (see
    # _LAZY_EXPORTS).
    from flightdeck_sensor.interceptor.anthropic import SensorAnthropic as SensorAnthropic
    from flightdeck_sensor.interceptor.anthropic import (
        patch_anthropic_classes as patch_anthropic_classes,
    )
    from flightdeck_sensor.interceptor.anthropic import (
        unpatch_anthropic_classes as unpatch_anthropic_classes,
    )
    from flightdeck_sensor.interceptor.claude_agent_sdk import (
        patch_claude_agent_sdk as patch_claude_agent_sdk,
    )
    from flightdeck_sensor.interceptor.claude_agent_sdk import (
        unpatch_claude_agent_sdk as unpatch_claude_agent_sdk,
    )
    from flightdeck_sensor.interceptor.crewai import patch_crewai_classes as patch_crewai_classes
    from flightdeck_sensor.interceptor.crewai import (
        unpatch_crewai_classes as unpatch_crewai_classes,
    )
    from flightdeck_sensor.interceptor.langgraph import (
        patch_langgraph_classes as patch_langgraph_classes,
    )
    from flightdeck_sensor.interceptor.langgraph import (
        unpatch_langgraph_classes as unpatch_langgraph_classes,
    )
    from flightdeck_sensor.interceptor.litellm import SensorLitellm as SensorLitellm
    from flightdeck_sensor.interceptor.litellm import (
        patch_litellm_functions as patch_litellm_functions,
    )
    from flightdeck_sensor.interceptor.litellm import (
        unpatch_litellm_functions as unpatch_litellm_functions,
    )
    from flightdeck_sensor.interceptor.llama_index import (
        patch_llama_index as patch_llama_index,
    )
    from flightdeck_sensor.interceptor.llama_index import (
        unpatch_llama_index as unpatch_llama_index,
    )
    from flightdeck_sensor.interceptor.mcp import patch_mcp_classes as patch_mcp_classes
    from flightdeck_sensor.interceptor.mcp import unpatch_mcp_classes as unpatch_mcp_classes
    from flightdeck_sensor.interceptor.openai import SensorOpenAI as SensorOpenAI
    from flightdeck_sensor.interceptor.openai import (
        patch_openai_classes as patch_openai_classes,
    )
    from flightdeck_sensor.interceptor.openai import (
        unpatch_openai_classes as unpatch_openai_classes,
    )

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
    "Provider",
    "BudgetExceededError",
    "ConfigurationError",
    "DirectiveError",
    "MCPPolicyBlocked",
]

_log = logging.getLogger("flightdeck_sensor")

# Billing modes init(billing_mode=) / FLIGHTDECK_BILLING_MODE accept; the
# ingestion API rejects any other value on the wire.
_BILLING_MODES = frozenset({"metered", "subscription", "local"})

# Agent-type vocabulary lock. Any other value raises ConfigurationError
# at init time. See CHANGELOG.md for the v0.4.0 breaking change that
# narrowed this from {autonomous, supervised, batch, developer}.
_VALID_AGENT_TYPES = frozenset({"coding", "production"})

# Scattered ``"unknown"`` magic-string sentinel across init
# fallbacks and the worker's lazy-create path. Centralising as a named
# constant so the worker's UpsertSession ON CONFLICT CASE-upgrade
# (which matches exactly this string) and the sensor's fallbacks
# stay byte-identical. A typo (``"Unknown"`` etc.) elsewhere would
# silently break the upgrade path.
UNKNOWN_SENTINEL = "unknown"


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
        # pwd missing or UID unmapped (distroless, scratch, Windows):
        # fall through to the env-var probes below.
        pass
    for key in ("USER", "USERNAME", "LOGNAME"):
        v = os.environ.get(key)
        if v:
            return v
    return UNKNOWN_SENTINEL


# Global state -- protected by _lock.
# v1 design: process-wide singleton. Multi-session-in-one-process is a
# v2 concern; users who need isolated sessions should run separate
# processes (one sensor per process).
_lock = threading.Lock()
# Serialises every patch and unpatch of an SDK, whether patch(), unpatch()
# or the import hook runs it. The import hook never waits for it (see
# _patch_pending).
_patch_lock = threading.Lock()
_session: Session | None = None
_client: ControlPlaneClient | None = None

# Custom directive registry -- populated by @directive decorator
_directive_registry: dict[str, DirectiveRegistration] = {}


@dataclasses.dataclass(frozen=True)
class _SDKTarget:
    """One SDK ``patch()`` covers: the module whose import makes it
    patchable, and the interceptor module that patches it. The
    interceptor module imports the SDK itself, so it is imported only once
    the application has imported the SDK."""

    provider: Provider
    module: str
    interceptor: str
    patch: str
    unpatch: str

    @property
    def interceptor_module(self) -> str:
        return f"flightdeck_sensor.interceptor.{self.interceptor}"


# Every member of Provider, in the order patch() applies them. LangGraph is
# keyed on ``langgraph.graph``, the package StateGraph comes from:
# ``langgraph`` itself is a namespace package shared with LangGraph's other
# distributions, and a namespace package runs no code for the hook to see.
# LlamaIndex is keyed on ``llama_index.core`` for the same reason
# (``llama_index`` is a namespace package).
_SDK_TARGETS: tuple[_SDKTarget, ...] = (
    _SDKTarget(
        Provider.ANTHROPIC,
        "anthropic",
        "anthropic",
        "patch_anthropic_classes",
        "unpatch_anthropic_classes",
    ),
    _SDKTarget(
        Provider.OPENAI, "openai", "openai", "patch_openai_classes", "unpatch_openai_classes"
    ),
    _SDKTarget(
        Provider.LITELLM,
        "litellm",
        "litellm",
        "patch_litellm_functions",
        "unpatch_litellm_functions",
    ),
    _SDKTarget(Provider.MCP, "mcp", "mcp", "patch_mcp_classes", "unpatch_mcp_classes"),
    _SDKTarget(
        Provider.CREWAI,
        "crewai",
        "crewai",
        "patch_crewai_classes",
        "unpatch_crewai_classes",
    ),
    _SDKTarget(
        Provider.LANGGRAPH,
        "langgraph.graph",
        "langgraph",
        "patch_langgraph_classes",
        "unpatch_langgraph_classes",
    ),
    _SDKTarget(
        Provider.LLAMA_INDEX,
        "llama_index.core",
        "llama_index",
        "patch_llama_index",
        "unpatch_llama_index",
    ),
    _SDKTarget(
        Provider.CLAUDE_AGENT_SDK,
        "claude_agent_sdk",
        "claude_agent_sdk",
        "patch_claude_agent_sdk",
        "unpatch_claude_agent_sdk",
    ),
)

# SDKs the import hook saw imported and that are not patched yet, each
# with the quiet flag of the patch() call that asked for it: the hook
# queues them here and patches them only when it can take _patch_lock
# without waiting, otherwise the thread holding the lock patches them on
# release (see _patch_pending). deque append and popleft are atomic.
_pending: collections.deque[tuple[_SDKTarget, bool]] = collections.deque()

# Names importable from this package that live in an interceptor module.
# Resolved on first access (see __getattr__), so reading one imports its
# SDK, which the caller is about to use anyway.
_LAZY_EXPORTS: dict[str, str] = {
    "SensorAnthropic": "anthropic",
    "SensorOpenAI": "openai",
    "SensorLitellm": "litellm",
    **{t.patch: t.interceptor for t in _SDK_TARGETS},
    **{t.unpatch: t.interceptor for t in _SDK_TARGETS},
}


# ------------------------------------------------------------------
# Custom directive registration
# ------------------------------------------------------------------


def _compute_fingerprint(name: str, description: str, parameters: list[DirectiveParameter]) -> str:
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
       crash.
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
    langgraph_agent_node_pattern: str | None = None,
    mcp_block_on_uncertainty: bool = False,
    allow_insecure_transport: bool = False,
    billing_mode: str | None = None,
) -> None:
    """Initialize the sensor and start the run.

    ``token`` here is a Flightdeck **access token** (an ``ftd_...``
    opaque string minted via ``POST /v1/access-tokens``, or the
    literal ``tok_dev`` seed when the server is running with
    ``ENVIRONMENT=dev``). It is NOT an LLM token count -- the
    platform also tracks input/output token totals on runs, but
    those live under ``tokens_input`` / ``tokens_output`` fields
    and never flow through this parameter. The kwarg name (and the
    ``FLIGHTDECK_TOKEN`` env var) deliberately stayed as ``token``
    when access tokens were introduced so existing integrations
    don't break.

    ``api_url`` is the base URL for control-plane calls (directive
    registration, directive sync, policy prefetch).  When *None*,
    derived from *server* by replacing ``/ingest`` with ``/api``.
    Override via ``FLIGHTDECK_API_URL`` env var.

    ``limit`` sets a local WARN-only token threshold. Never blocks. Never
    degrades. Most restrictive threshold wins when both local and server
    policies are active.

    ``session_id`` is an optional caller-supplied run identifier.
    When provided (or when ``FLIGHTDECK_SESSION_ID`` is set, which
    takes precedence over the kwarg in line with ``FLIGHTDECK_SERVER``
    / ``AGENT_FLAVOR``), the sensor uses the caller's value verbatim
    instead of generating a UUID. If a run with that ID already
    exists in the control plane, the backend attaches this execution
    to the prior run; the sensor logs INFO on the first response
    that confirms attachment. Primary use case: orchestrators
    (Temporal workflows, Airflow DAGs) that re-run the same logical
    workflow and want a single correlatable run in the fleet view.

    ``agent_type`` selects the agent classification. Must
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
    - ``FLIGHTDECK_SESSION_ID`` -- run id hint (overrides *session_id*)
    - ``FLIGHTDECK_AGENT_TYPE`` / ``AGENT_TYPE`` -- overrides *agent_type*;
      must be ``coding`` or ``production``
    - ``FLIGHTDECK_AGENT_NAME`` / ``AGENT_FLAVOR`` -- overrides *agent_name*
      (``AGENT_FLAVOR`` retained for wire-level ``flavor`` field compatibility)
    - ``FLIGHTDECK_HOSTNAME`` -- overrides ``socket.gethostname()`` (useful
      for k8s pod grouping)
    - ``FLIGHTDECK_UNAVAILABLE_POLICY`` -- ``"continue"`` or ``"halt"``
    - ``FLIGHTDECK_CAPTURE_PROMPTS`` -- ``"true"`` to enable
    - ``FLIGHTDECK_ALLOW_INSECURE_TRANSPORT`` -- ``"true"`` to allow plain
      ``http://`` egress to a non-local control plane (overrides
      *allow_insecure_transport*)
    - ``FLIGHTDECK_BILLING_MODE`` -- ``metered``, ``subscription`` or
      ``local`` (overrides *billing_mode*)

    ``billing_mode`` says how this agent's LLM calls are paid for, which
    decides whether the dashboard counts them as spend. Left unset, every
    call is ``metered`` except calls to a model server on this machine
    (a loopback base URL), which are ``local``. Set it when the sensor
    cannot tell: ``local`` for a self-hosted server elsewhere on your
    network, ``subscription`` for a flat-rate plan. Case and surrounding
    whitespace are ignored; any other value raises
    :class:`ConfigurationError`.

    ``allow_insecure_transport`` opts in to plaintext ``http://`` egress
    for a **non-local** control-plane host. Off by default: the resolved
    ``server`` / ``api_url`` must use ``https://`` for any public host, or
    init raises. Local / loopback / private hosts (``localhost``,
    ``127.0.0.1``, RFC1918, ...) are always allowed over ``http``. A URL
    with any scheme other than ``http`` / ``https`` is rejected outright.

    ``langgraph_agent_node_pattern`` is an optional regex
    string that narrows which LangGraph nodes the sub-agent
    interceptor wraps. When unset, every node added via
    ``StateGraph.add_node`` gets wrapped (default-on, accepts false
    positives on data-transform nodes). When set, only nodes whose
    name matches the regex emit child sessions. Use this to
    filter out non-LLM nodes in graphs that mix data plumbing with
    agent execution.
    """
    global _session, _client

    with _lock:
        if _session is not None:
            if not quiet:
                _log.warning("flightdeck_sensor.init() called twice; ignoring")
            return

        # Env-var precedence is preserved (env wins over the kwarg,
        # matching every other init() knob), but a silent override of an
        # explicitly-passed value is the vulnerability — a stale/hostile
        # FLIGHTDECK_SERVER in the environment could redirect egress with
        # no signal. Warn (naming both values) when the environment
        # overrides a non-empty caller-supplied server with a different
        # value, then keep the env value.
        env_server = os.environ.get(_env.ENV_SERVER)
        if env_server is not None and server and env_server != server:
            _log.warning(
                "%s=%r overrides the server=%r passed to init(); using the "
                "environment value. Unset %s if this was not intended.",
                _env.ENV_SERVER,
                env_server,
                server,
                _env.ENV_SERVER,
            )
        resolved_server = os.environ.get(_env.ENV_SERVER, server)
        resolved_token = os.environ.get(_env.ENV_TOKEN, token)
        if not resolved_server:
            raise ConfigurationError("server URL is required")
        if not resolved_token:
            raise ConfigurationError("token is required")

        # Resolve the plaintext-transport opt-in. Env wins over the
        # kwarg (same precedence as every other flag); default False.
        resolved_allow_insecure = _env_bool(
            _env.ENV_ALLOW_INSECURE_TRANSPORT, allow_insecure_transport
        )

        # Normalize ``FLIGHTDECK_SERVER`` / ``server`` kwarg to
        # always carry the ``/ingest`` suffix. The Claude Code plugin
        # uses the same env var without the suffix (it appends
        # ``/ingest/v1/events`` itself), so a developer running both
        # tools on one machine would otherwise hit a silent 404 when
        # a sensor script inherited the plugin's env. ``/ingest`` is
        # added idempotently -- a URL that already contains it stays
        # unchanged.
        if "/ingest" not in resolved_server:
            resolved_server = resolved_server.rstrip("/") + "/ingest"

        # Same silent-override guard for the control-plane API URL.
        env_api_url = os.environ.get(_env.ENV_API_URL)
        if env_api_url and api_url and env_api_url != api_url:
            _log.warning(
                "%s=%r overrides the api_url=%r passed to init(); using the "
                "environment value. Unset %s if this was not intended.",
                _env.ENV_API_URL,
                env_api_url,
                api_url,
                _env.ENV_API_URL,
            )
        resolved_api_url = os.environ.get(_env.ENV_API_URL) or api_url
        if not resolved_api_url:
            resolved_api_url = resolved_server.rstrip("/").replace("/ingest", "/api")

        capture = _env_bool(_env.ENV_CAPTURE_PROMPTS, capture_prompts)
        resolved_billing_mode = (
            os.environ.get(_env.ENV_BILLING_MODE) or billing_mode or ""
        ).strip().lower() or None
        if resolved_billing_mode is not None and resolved_billing_mode not in _BILLING_MODES:
            raise ConfigurationError(
                f"billing_mode must be one of {sorted(_BILLING_MODES)}, "
                f"got {resolved_billing_mode!r}"
            )

        # session_id resolution follows the same env-wins pattern as
        # FLIGHTDECK_SERVER / AGENT_FLAVOR: env var overrides kwarg,
        # and a falsy env var falls through to the kwarg. An empty
        # string from either source is treated as "not provided" so a
        # misconfigured shell (FLIGHTDECK_SESSION_ID="") still auto-
        # generates a UUID rather than posting a session_start with a
        # blank session_id that the ingestion API rejects.
        resolved_session_id = os.environ.get(_env.ENV_SESSION_ID) or session_id or None
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
                "run ID will be generated instead.",
                resolved_session_id,
            )
            resolved_session_id = None
        if resolved_session_id:
            _log.warning(
                "Custom session_id provided: '%s'. This ID will be used "
                "as-is and will not be auto-generated. If a run with "
                "this ID already exists, the backend will attach this "
                "agent to it.",
                resolved_session_id,
            )

        # Resolve agent identity. Precedence is
        # kwarg > env > default, matching every other init() param.
        # ``FLIGHTDECK_AGENT_TYPE`` wins over the legacy ``AGENT_TYPE``
        # env var so operators migrating from v0.3.x can set either;
        # same pattern for ``FLIGHTDECK_AGENT_NAME`` / ``AGENT_FLAVOR``.
        resolved_agent_type = (
            agent_type
            or os.environ.get(_env.ENV_AGENT_TYPE)
            or os.environ.get(_env.ENV_AGENT_TYPE_LEGACY)
            or "production"
        )
        if resolved_agent_type not in _VALID_AGENT_TYPES:
            raise ConfigurationError(
                f"agent_type={resolved_agent_type!r} is not valid. "
                f"Must be one of {sorted(_VALID_AGENT_TYPES)}. "
                "Pre-v0.4.0 values ('autonomous', 'supervised', "
                "'batch', 'developer') are no longer accepted -- "
                "see CHANGELOG.md for the v0.4.0 migration."
            )

        resolved_hostname = os.environ.get(_env.ENV_HOSTNAME) or socket.gethostname()
        resolved_user = _resolve_user_name()
        resolved_agent_name = (
            agent_name
            or os.environ.get(_env.ENV_AGENT_NAME)
            or os.environ.get(_env.ENV_AGENT_FLAVOR_LEGACY)
            or f"{resolved_user}@{resolved_hostname}"
        )

        # Agent identity UUID. Deterministic function of the tuple --
        # same tuple on two processes = same agent_id. See
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
            "billing_mode": resolved_billing_mode,
            "allow_insecure_transport": resolved_allow_insecure,
            "unavailable_policy": os.environ.get(_env.ENV_UNAVAILABLE_POLICY, "continue"),
            # Legacy wire-level ``flavor`` field stays populated for
            # backward compat with every downstream surface that still
            # reads sessions.flavor (dashboard flavor facet, analytics
            # group_by=flavor, etc.). Default now mirrors agent_name so
            # the two fields agree for sensor-default deployments.
            "agent_flavor": os.environ.get(_env.ENV_AGENT_FLAVOR_LEGACY, resolved_agent_name),
            "agent_type": resolved_agent_type,
            "agent_id": resolved_agent_id,
            "agent_name": resolved_agent_name,
            "user_name": resolved_user,
            "hostname": resolved_hostname,
            "client_type": "flightdeck_sensor",
            "quiet": quiet,
            "limit": limit,
            "warn_at": warn_at,
            "mcp_block_on_uncertainty": mcp_block_on_uncertainty,
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

        # Derive the per-event ``framework`` field from the
        # FrameworkCollector's first detected entry. Without this
        # call ``Session.record_framework()`` has no caller, every
        # event's ``framework`` field is ``null``, and the dashboard's
        # FRAMEWORK facet, the analytics group_by=framework, and the
        # ``/v1/sessions?framework=`` filter all silently misbehave.
        # Strip the ``/<version>`` suffix so the per-event field uses
        # the bare analytics dimension (``langchain``); the versioned
        # form (``langchain/0.3.x``) stays in
        # ``context.frameworks[]`` for diagnostic detail.
        #
        # Design principle locked here for future phases: when a
        # higher-level framework is detected (LangChain, LangGraph,
        # CrewAI, etc.) it wins over the SDK transport that handled
        # the call. A LangChain pipeline routing through litellm
        # routing through OpenAI reports ``framework="langchain"``
        # because that's the user's mental model. MCP and every
        # later interceptor inherit this rule. A framework imported
        # after this point is picked up by the session when it builds
        # a later event (Session._detect_late_framework).
        frameworks = runtime_ctx.get("frameworks") or []
        if frameworks:
            bare = _framework_label(frameworks[0])
            if bare:
                _session.record_framework(bare)

        # Wire the LangGraph agent-node regex (if any) into the
        # langgraph interceptor's module state before patch_langgraph_classes
        # might run. Setting None clears any previously-set pattern, so
        # multi-test scenarios start clean.
        _set_langgraph_agent_node_pattern(langgraph_agent_node_pattern)

        _session.start()


def wrap(client: Any, quiet: bool = False) -> Any:
    """Wrap an Anthropic or OpenAI client for interception.

    Any Anthropic SDK client is accepted: ``Anthropic``, ``AsyncAnthropic``,
    ``AnthropicBedrock``, ``AnthropicVertex``, ``AnthropicFoundry``,
    ``AnthropicAWS``, ``AnthropicBedrockMantle`` and their async forms
    (everything deriving from ``anthropic._base_client.BaseClient``).

    ``init()`` must be called first.

    If :func:`patch` has already been called, the Anthropic resource
    classes (or the OpenAI client class) are already intercepted -- in
    that case ``wrap()`` is a no-op and returns the client unchanged.
    This avoids double-wrapping.
    """
    session = _require_session("wrap")

    # Detect Anthropic client
    if _is_anthropic(client):
        anthropic_interceptor = _interceptor("anthropic")
        # If the resource classes are already patched, every call on
        # the client is intercepted there; wrapping as well would be
        # harmless (the proxy calls the original methods) but pointless.
        if anthropic_interceptor.is_patched():
            return client
        return anthropic_interceptor.SensorAnthropic(client, session)

    # Detect OpenAI client
    if _is_openai(client):
        if hasattr(type(client), "_flightdeck_patched"):
            return client
        return _interceptor("openai").SensorOpenAI(client, session)

    if not quiet:
        _log.warning(
            "wrap(): unrecognised client type %s; returning unwrapped",
            type(client).__name__,
        )
    return client


def patch(
    quiet: bool = False,
    providers: list[str | Provider] | None = None,
) -> None:
    """Patch the Anthropic and OpenAI SDKs in place.

    After ``patch()``, every Anthropic SDK client (``Anthropic``,
    ``AsyncAnthropic``, ``AnthropicBedrock``, ``AnthropicVertex``,
    ``AnthropicFoundry``, ``AnthropicAWS``, ``AnthropicBedrockMantle``
    and their async forms) and every instance of ``openai.OpenAI`` and
    ``openai.AsyncOpenAI`` -- including instances constructed
    transparently by frameworks such as ``langchain-anthropic``,
    ``langchain-openai``, ``llama-index-llms-anthropic``, and
    ``llama-index-llms-openai`` -- posts pre/post events for every LLM
    call.

    For Anthropic the patch replaces ``create`` / ``stream`` / ``parse``
    on the SDK's ``Messages`` / ``AsyncMessages`` resource classes (top
    level and beta), which every client hands out, so the raw-response
    and streaming views are covered too. For OpenAI it
    replaces the ``chat`` / ``responses`` / ``embeddings``
    ``cached_property`` descriptors on the client classes with custom
    descriptors; on openai before 1.78, whose clients build those
    resources in the constructor, it installs a data descriptor for each
    that hands out the sensor proxy over the client's own resource.
    openai below 1.26 is left unpatched, with a warning. Each patched
    class is tagged with a ``_flightdeck_patched`` sentinel attribute. ``isinstance(x,
    anthropic.Anthropic)`` and captured references like ``from
    anthropic import Anthropic`` continue to work correctly because the
    class objects' identities are preserved.

    **Patched on import**: ``patch()`` never imports an SDK. An SDK the
    application has already imported is patched at once; one it has not
    is patched when the application first imports it, right after the
    SDK's own module code runs and before the ``import`` statement
    returns, so an SDK the application never uses is never loaded (and
    litellm never fetches its price list for it). A reload of a patched
    SDK is patched again. :func:`unpatch` stops this.

    **Idempotent**: calling ``patch()`` twice is a no-op on the second
    call -- a class is only patched if it does not already carry the
    ``_flightdeck_patched`` sentinel.

    **Limitation (OpenAI)**: instances constructed BEFORE ``patch()``
    was called that already accessed ``.chat`` once have the unwrapped
    resource cached in their ``__dict__`` and are not intercepted. New
    instances and new accesses on existing instances ARE intercepted.
    On openai before 1.78 a client built before ``patch()`` is
    intercepted from its next ``.chat`` / ``.responses`` /
    ``.embeddings`` access. Its client-level ``with_raw_response`` /
    ``with_streaming_response`` view is the exception: that SDK's
    constructor builds the view over whatever ``client.chat`` returned
    at that moment, so a client built before ``patch()`` or with no
    session active has an unmetered view, and a client built while a
    session was active keeps a view bound to that session. Anthropic
    clients built before ``patch()`` are intercepted from their next
    call on, because the patch lives on the resource class;
    the one exception is a raw or streaming view
    (``messages.with_raw_response`` / ``with_streaming_response``) first
    touched before ``patch()``, which binds the unpatched method when
    the SDK builds it and is not metered.

    ``init()`` must be called first.

    Args:
        providers: list of providers to patch. Accepts either
            :class:`Provider` enum members or raw strings; mixed lists
            also work for callers mid-migration (every member of
            :class:`Provider` IS a string, so equality holds across
            both forms). Default (``None``) patches every member of
            :class:`Provider`. The enum is the single source of truth
            for the valid set: adding a new interceptor means adding
            a new enum member and its entry in ``_SDK_TARGETS``. The current
            members are ``ANTHROPIC`` (anthropic SDK class patch),
            ``OPENAI`` (openai SDK class patch), ``LITELLM``
            (module-level ``litellm.completion`` / ``litellm.acompletion``
            / ``litellm.embedding`` / ``litellm.aembedding`` wrap,
            ``stream=True`` included; a litellm call served through the
            OpenAI SDK is reported once, by the litellm wrapper), ``MCP``
            (patches ``mcp.client.session.ClientSession`` so every framework
            that uses the official Python ``mcp`` SDK emits
            ``mcp_tool_call`` / ``mcp_*_list`` / ``mcp_resource_read``
            / ``mcp_prompt_get`` events), ``CREWAI`` (wraps
            ``crewai.Agent.execute_task`` / ``aexecute_task`` so each
            Crew member's turn lands as a child session) and
            ``LANGGRAPH`` (wraps the callable registered via
            ``StateGraph.add_node`` so each agent-bearing node run
            lands as a child session), ``LLAMA_INDEX`` (a span handler on
            LlamaIndex's instrumentation dispatcher, so each agent of an
            agent workflow run lands as a child session with its own
            model and tool calls) and ``CLAUDE_AGENT_SDK`` (wraps
            the SDK's ``query()`` path and ``ClaudeSDKClient`` so each
            Agent SDK run lands as its own ``claude_agent_sdk``
            session). Silent no-op when a target's
            SDK is not installed; raw strings outside the canonical
            set are silently ignored to preserve backward compat.

    Examples:
        Canonical, enum-based::

            from flightdeck_sensor import Provider, patch
            patch(providers=[Provider.ANTHROPIC, Provider.MCP])

        Backward-compat (strings still accepted)::

            patch(providers=["anthropic", "mcp"])

        Mixed (callers mid-migration)::

            patch(providers=[Provider.ANTHROPIC, "openai"])
    """
    _require_session("patch")
    if providers is None:
        targets: set[str] = {p.value for p in Provider}
    else:
        # Normalize Provider members → str. Members ARE str (StrEnum),
        # so this is a no-op equality-wise but it gives every
        # downstream branch a clean ``str``-typed lookup target and
        # keeps the unknown-string-silently-ignored behavior intact.
        targets = {t.value if isinstance(t, Provider) else t for t in providers}
    selected = [t for t in _SDK_TARGETS if t.provider.value in targets]

    with _patch_lock:
        # Watch first, then look: an SDK whose import finishes in between
        # is both reported by the hook and found imported, and patching it
        # twice is a no-op. Each interceptor module is watched too: when
        # importing it is what first imports its SDK, the SDK finishes
        # importing before the module that patches it has defined its
        # patch, so the SDK is patched once that module's import ends.
        callbacks: dict[str, Callable[[str], None]] = {}
        for t in selected:
            callbacks[t.module] = functools.partial(_patch_on_import, t, quiet)
            callbacks[t.interceptor_module] = functools.partial(
                _patch_on_interceptor_import, t, quiet
            )
        _import_hook.watch(callbacks)
        for target in selected:
            # An interceptor module another thread started importing
            # before the finder was installed has no end of import the
            # hook reports, and the SDK its import imports is too early
            # to patch when its own import ends: wait for that import, so
            # the SDK it imported is found imported here.
            _import_hook.wait_for(target.interceptor_module)
            if _import_hook.imported(target.module) is not None:
                _patch_sdk(target, quiet)
            elif not quiet:
                _log.debug("%s will be patched when it is imported", target.module)
    _patch_pending()


def unpatch() -> None:
    """Reverse all class-level patches applied by :func:`patch`.

    Idempotent: safe to call without a preceding ``patch()``. Restores
    the original ``cached_property`` descriptors and the original
    ``litellm.completion`` / ``litellm.acompletion`` module attributes,
    and removes every ``_flightdeck_patched`` sentinel. An SDK imported
    afterwards is no longer patched as it is imported. Never imports an
    SDK: only the ones the application has imported can be patched.

    OpenAI instances that have already accessed ``.chat`` after
    ``patch()`` was called keep the wrapped version cached in their
    ``__dict__`` until the instance is garbage collected -- a known
    limitation documented in :func:`unpatch_openai_classes`. Anthropic
    resources revert at once, views built while patched included
    (see :func:`unpatch_anthropic_classes`).
    """
    with _patch_lock:
        _import_hook.unwatch()
        _pending.clear()
        for target in _SDK_TARGETS:
            interceptor = sys.modules.get(target.interceptor_module)
            if interceptor is None or sys.modules.get(target.module) is None:
                continue  # never patched: patching imports the interceptor module
            getattr(interceptor, target.unpatch)()
    # An import that finished while the lock was held may have queued its
    # SDK; it is no longer watched, so this drops it.
    _patch_pending()


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
    """Detect any Anthropic SDK client (first-party, Bedrock, Vertex,
    Foundry, AWS, Mantle; sync or async) via the ``BaseClient`` reference
    captured at interceptor-module import time, which every SDK client
    class derives from. A client exists only once its SDK is imported,
    so with ``anthropic`` not imported the answer is no, and nothing is
    imported to give it.
    """
    if "anthropic" not in sys.modules:
        return False
    base_client = _interceptor("anthropic")._OrigBaseClient
    return base_client is not None and isinstance(client, base_client)


def _is_openai(client: Any) -> bool:
    """Detect an OpenAI / AsyncOpenAI client via captured references,
    without importing ``openai`` when the application has not."""
    if "openai" not in sys.modules:
        return False
    interceptor = _interceptor("openai")
    if interceptor._OrigOpenAI is None or interceptor._OrigAsyncOpenAI is None:
        return False
    return isinstance(client, (interceptor._OrigOpenAI, interceptor._OrigAsyncOpenAI))


def _interceptor(name: str) -> ModuleType:
    """The interceptor module ``flightdeck_sensor.interceptor.<name>``,
    which imports its SDK: call it only once the SDK is imported."""
    return importlib.import_module(f"flightdeck_sensor.interceptor.{name}")


def _patch_sdk(target: _SDKTarget, quiet: bool) -> None:
    """Patch one SDK the application has imported. Caller holds
    _patch_lock."""
    getattr(_interceptor(target.interceptor), target.patch)(quiet=quiet)


def _patch_on_import(target: _SDKTarget, quiet: bool, _module: str) -> None:
    """The import hook's callback: the application has just imported the
    SDK of ``target``. Runs inside that import, so it queues the patch and
    applies it only if the patch lock is free (see _patch_pending)."""
    _pending.append((target, quiet))
    _patch_pending()


def _patch_on_interceptor_import(target: _SDKTarget, quiet: bool, _module: str) -> None:
    """The import hook's callback for the interceptor module of
    ``target``, whose code has just finished: patch the SDK if the
    application has imported it. When importing the interceptor module
    (the sensor does on an emission path, the application may) is what
    first imports the SDK, the SDK's own callback ran while this module
    was still executing, too early to patch, and left it to this one.
    An SDK that is not imported is left alone, as patch() leaves it."""
    if _import_hook.executed(target.module):
        _pending.append((target, quiet))
        _patch_pending()


def _interceptor_executing(target: _SDKTarget) -> bool:
    """Whether the interceptor module of ``target`` is being imported and
    its code has not run to the end: importing it would hand back the
    module half-built, so its patch waits for the end of its import (see
    _patch_on_interceptor_import, and patch() for an import that started
    before the finder was there to report its end)."""
    return target.interceptor_module in sys.modules and not _import_hook.executed(
        target.interceptor_module
    )


def _patch_pending() -> None:
    """Patch the SDKs the import hook queued, unless another thread holds
    the patch lock, in which case that thread does it when it releases.

    The lock is never waited for: the hook runs inside an import, holding
    that module's import lock, and patch() may hold the patch lock while
    it waits for that very import to finish. Each holder therefore drains
    the queue after releasing the lock, and a callback that queues while
    the lock is held finds it free again or has its entry taken by the
    holder's drain. A patch() or reload running at the same time can queue
    an SDK twice; patching is idempotent. An SDK unpatch() stopped
    watching is dropped from the queue, and so is one whose interceptor
    module is still executing, which the end of that module's import
    queues again.
    """
    while _pending and _patch_lock.acquire(blocking=False):
        try:
            while True:
                try:
                    target, quiet = _pending.popleft()
                except IndexError:
                    break
                if not _import_hook.watching(target.module) or _interceptor_executing(target):
                    continue
                try:
                    _patch_sdk(target, quiet)
                except Exception:
                    _log.warning(
                        "flightdeck_sensor: patching %s failed; its calls are not metered",
                        target.module,
                        exc_info=True,
                    )
        finally:
            _patch_lock.release()


def __getattr__(name: str) -> Any:
    """Names that live in an interceptor module (``SensorLitellm``,
    ``patch_openai_classes``, ...), imported on first access so that
    ``import flightdeck_sensor`` loads no SDK."""
    interceptor = _LAZY_EXPORTS.get(name)
    if interceptor is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(_interceptor(interceptor), name)
