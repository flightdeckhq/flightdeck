"""Claude Agent SDK interceptor.

The Python Claude Agent SDK runs the Claude Code CLI as a subprocess
that calls the model itself, so no provider patch sees its calls. This
interceptor wraps the SDK's internal ``InternalClient.process_query``
(the path every ``query()`` call takes, however the caller imported
``query``) and ``ClaudeSDKClient``, and reports each run from the
SDK's message stream (ARCHITECTURE.md, Sensor > Claude Agent SDK):

* each ``query()`` call, and each ``ClaudeSDKClient`` connection, is one
  session whose id is the Claude Code session id the ``init`` message
  reports, under a ``claude_agent_sdk`` agent;
* ``init`` -> ``session_start``; each assistant message (by message id)
  -> ``post_call`` plus one ``tool_call`` per ``tool_use`` block; the
  ``ResultMessage`` of a ``query()`` run, or the client's disconnect,
  -> ``session_end``.

It adds ``FLIGHTDECK_SDK_OBSERVED=1`` to the CLI's environment so a
Claude Code plugin the CLI loads stays silent for the run, and never
replaces the caller's hooks or ``can_use_tool``.

Failure-mode posture is fail-open (sensor rule 28): an error while
reporting is logged at debug level and never reaches the caller's
iteration.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from flightdeck_sensor.core.agent_id import derive_agent_id
from flightdeck_sensor.core.session import _sensor_version
from flightdeck_sensor.interceptor.platform import (
    PLATFORM_ANTHROPIC,
    PLATFORM_INVALID_HOST,
    PLATFORM_LOCALHOST,
    is_loopback_host,
    platform_for_host,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping

    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.claude_agent_sdk")

_PATCHED_SENTINEL = "_flightdeck_patched"

CLIENT_TYPE = "claude_agent_sdk"
# Set in the CLI's environment so the Claude Code plugin reports nothing
# for a run this interceptor reports.
SDK_OBSERVED_ENV = "FLIGHTDECK_SDK_OBSERVED"

# The API key source an ``init`` message reports when the CLI holds no
# API key: a Claude login, a bearer token or a cloud provider.
_NO_API_KEY_SOURCE = "none"
# Environment variables that point the CLI at a cloud provider, which
# bills per token, with the platform label each one means.
_CLOUD_ENV_VARS = (
    ("CLAUDE_CODE_USE_BEDROCK", "bedrock"),
    ("CLAUDE_CODE_USE_VERTEX", "vertex"),
    ("CLAUDE_CODE_USE_FOUNDRY", "foundry"),
)
_BILLING_MODES = frozenset({"metered", "subscription", "local"})
# The model Claude Code names on an assistant message it wrote itself
# (an API error or an interrupt) rather than one the model returned.
_SYNTHETIC_MODEL = "<synthetic>"

# ----------------------------------------------------------------------
# Lazy SDK import, so ``import flightdeck_sensor`` does not load the SDK.
# ----------------------------------------------------------------------

_sdk: Any = None
_internal_client: Any = None
_SDK_AVAILABLE: bool | None = None


def _ensure_imported() -> bool:
    global _sdk, _internal_client, _SDK_AVAILABLE
    if _SDK_AVAILABLE is not None:
        return _SDK_AVAILABLE
    try:
        import claude_agent_sdk
    except ImportError:
        _sdk = None
        _SDK_AVAILABLE = False
        return False
    _sdk = claude_agent_sdk
    _SDK_AVAILABLE = True
    # Private SDK API: when a release moves it, ``query()`` runs go
    # unobserved (with a warning at patch time) while ``ClaudeSDKClient``
    # is still reported.
    try:
        from claude_agent_sdk._internal.client import InternalClient
    except ImportError:
        _internal_client = None
    else:
        _internal_client = InternalClient
    return True


def _current_session() -> Session | None:
    import flightdeck_sensor

    return flightdeck_sensor._session


def observed_options(options: Any) -> Any:
    """``options`` with ``FLIGHTDECK_SDK_OBSERVED=1`` in its ``env``,
    the caller's own entries kept; a new ``ClaudeAgentOptions`` when
    ``options`` is None. Never mutates the caller's object."""
    if options is None:
        return _sdk.ClaudeAgentOptions(env={SDK_OBSERVED_ENV: "1"})
    env = dict(getattr(options, "env", None) or {})
    env[SDK_OBSERVED_ENV] = "1"
    return dataclasses.replace(options, env=env)


def _block_dict(block: Any) -> dict[str, Any]:
    """A content block as the Anthropic API spells it."""
    name = type(block).__name__
    kind = {
        "TextBlock": "text",
        "ThinkingBlock": "thinking",
        "ToolUseBlock": "tool_use",
        "ToolResultBlock": "tool_result",
        "ServerToolUseBlock": "server_tool_use",
        "ServerToolResultBlock": "server_tool_result",
    }.get(name, name)
    try:
        fields = dataclasses.asdict(block)
    except TypeError:
        fields = {}
    return {"type": kind, **fields}


def _usage_tokens(usage: Any) -> dict[str, Any]:
    """Token fields of a post_call from an Anthropic ``usage`` mapping:
    input counts the cache reads and writes, as the sensor's Anthropic
    provider does."""
    u = usage if isinstance(usage, dict) else {}

    def count(key: str) -> int:
        value = u.get(key)
        return value if isinstance(value, int) and value >= 0 else 0

    uncached = count("input_tokens")
    cache_read = count("cache_read_input_tokens")
    cache_creation = count("cache_creation_input_tokens")
    output = count("output_tokens")
    fields: dict[str, Any] = {
        "tokens_input": uncached + cache_read + cache_creation,
        "tokens_output": output,
        "tokens_total": uncached + cache_read + cache_creation + output,
        "tokens_cache_read": cache_read,
        "tokens_cache_creation": cache_creation,
    }
    split = u.get("cache_creation")
    one_hour = split.get("ephemeral_1h_input_tokens") if isinstance(split, dict) else None
    if isinstance(one_hour, int) and 0 <= one_hour <= cache_creation:
        fields["tokens_cache_creation_1h"] = one_hour
    return fields


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes"}


def run_env(options: Any) -> dict[str, str]:
    """The environment the CLI runs with: the process's, overlaid by
    the options' ``env`` (the SDK merges them the same way)."""
    env = dict(os.environ)
    extra = getattr(options, "env", None)
    if isinstance(extra, dict):
        env.update({str(k): str(v) for k, v in extra.items()})
    return env


def _platform(env: Mapping[str, str]) -> tuple[str, bool]:
    """The platform the CLI calls, and whether it is a cloud provider."""
    for name, label in _CLOUD_ENV_VARS:
        if _truthy(env.get(name)):
            return label, True
    base_url = (env.get("ANTHROPIC_BASE_URL") or "").strip()
    if not base_url:
        return PLATFORM_ANTHROPIC, False
    try:
        host = (urlsplit(base_url).hostname or "").rstrip(".")
    except ValueError:
        return PLATFORM_INVALID_HOST, False
    if is_loopback_host(host):
        return PLATFORM_LOCALHOST, False
    return platform_for_host(host), False


def billing_mode(env: Mapping[str, str], api_key_source: Any) -> str:
    """The run's billing mode, by the plugin's precedence: an explicit
    ``FLIGHTDECK_BILLING_MODE``; metered on a cloud provider or with a
    bearer token (``ANTHROPIC_AUTH_TOKEN``); a subscription when the CLI
    holds no API key (a Claude login); metered otherwise."""
    override = (env.get("FLIGHTDECK_BILLING_MODE") or "").strip().lower()
    if override in _BILLING_MODES:
        return override
    if _platform(env)[1] or (env.get("ANTHROPIC_AUTH_TOKEN") or "").strip():
        return "metered"
    return "subscription" if api_key_source == _NO_API_KEY_SOURCE else "metered"


class SdkRun:
    """The Flightdeck session of one SDK run, fed the run's messages.

    The session ends when the run does: the ``query()`` stream is
    exhausted or closed, or the client disconnects. A ``ResultMessage``
    ends one turn only; a run can have several.
    """

    def __init__(self, session: Session, *, env: Mapping[str, str]) -> None:
        self._session = session
        self._env = env
        self._platform = _platform(env)[0]
        cfg = session.config
        self._agent_id = str(
            derive_agent_id(
                agent_type=cfg.agent_type,
                user=cfg.user_name,
                hostname=cfg.hostname,
                client_type=CLIENT_TYPE,
                agent_name=cfg.agent_name,
            )
        )
        self.session_id: str | None = None
        self._ended = False
        self._billing_mode = "metered"
        self._framework = f"claude-agent-sdk/{getattr(_sdk, '__version__', '')}".rstrip("/")
        self._prompt: str | None = None
        self._tokens_used = 0
        self._last_result: Any = None
        # The assistant message being collected in each chain: the run's
        # own (key None) and each sub-agent's (its parent_tool_use_id).
        # A message is streamed as one AssistantMessage per content block
        # under one message id, and chains can interleave, so a message
        # is complete when its chain moves on, at a result, or at the end.
        self._pending: dict[str | None, dict[str, Any]] = {}
        # Message ids already reported, so a message is counted once.
        self._reported: set[str] = set()

    # -- feeding -----------------------------------------------------

    def set_prompt(self, prompt: Any) -> None:
        """The next turn's prompt, when it is a string."""
        self._prompt = prompt if isinstance(prompt, str) else None

    def on_message(self, message: Any) -> None:
        try:
            self._on_message(message)
        except Exception:
            _log.debug("claude_agent_sdk: reporting a message failed", exc_info=True)

    def _on_message(self, message: Any) -> None:
        kind = type(message).__name__
        if kind == "SystemMessage" and getattr(message, "subtype", None) == "init":
            self._start(getattr(message, "data", None) or {})
        elif kind == "AssistantMessage":
            self._assistant(message)
        elif kind == "UserMessage":
            # A tool result or a new prompt in a chain: the chain's
            # assistant message before it is complete.
            self._flush_chain(getattr(message, "parent_tool_use_id", None))
        elif kind == "ResultMessage":
            self._flush_all()
            self._last_result = message

    def end(self) -> None:
        """End the run's session, once; its state is the last result's."""
        try:
            self._flush_all()
            if self.session_id is None or self._ended:
                return
            self._ended = True
            result = self._last_result
            payload = self._payload("session_end")
            payload["close_reason"] = "normal_exit"
            if result is not None and getattr(result, "is_error", False):
                payload["state"] = "error"
                errors = getattr(result, "errors", None)
                message = getattr(result, "result", None) or (
                    ", ".join(map(str, errors)) if errors else ""
                )
                payload["error"] = {
                    "type": str(getattr(result, "subtype", "error")),
                    "message": str(message)[:1000],
                }
            self._post(payload)
        except Exception:
            _log.debug("claude_agent_sdk: ending a run failed", exc_info=True)

    # -- events ------------------------------------------------------

    def _start(self, data: dict[str, Any]) -> None:
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id or session_id == self.session_id:
            return
        if self.session_id is not None:
            # A new Claude Code session on the same client: the previous
            # one ends here.
            self.end()
        self.session_id = session_id
        self._ended = False
        self._tokens_used = 0
        self._last_result = None
        self._reported.clear()
        self._billing_mode = billing_mode(self._env, data.get("apiKeySource"))
        servers = data.get("mcp_servers")
        context: dict[str, Any] = {
            # The process's runtime context (os, user, git, ...), as a
            # sub-agent's session_start inherits it.
            **(self._session._context or {}),
            "claude_code_version": data.get("claude_code_version"),
            "model": data.get("model"),
            "permission_mode": data.get("permissionMode"),
            "working_dir": data.get("cwd"),
            "api_key_source": data.get("apiKeySource"),
            "mcp_servers": [s.get("name") for s in servers if isinstance(s, dict)]
            if isinstance(servers, list)
            else [],
            "supports_directives": False,
        }
        payload = self._payload("session_start")
        payload["sensor_version"] = _sensor_version()
        payload["capture_prompts"] = self._session.config.capture_prompts
        payload["model"] = data.get("model") if isinstance(data.get("model"), str) else None
        payload["context"] = {k: v for k, v in context.items() if v is not None}
        self._post(payload)

    def _assistant(self, message: Any) -> None:
        message_id = getattr(message, "message_id", None) or getattr(message, "uuid", None)
        if isinstance(message_id, str) and message_id in self._reported:
            _log.debug("claude_agent_sdk: message %s already reported", message_id)
            return
        chain = getattr(message, "parent_tool_use_id", None)
        pending = self._pending.get(chain)
        if pending is not None and pending["id"] != message_id:
            self._flush_chain(chain)
            pending = None
        if pending is None:
            pending = {
                "id": message_id,
                "model": None,
                "blocks": [],
                "usage": None,
                "stop_reason": None,
            }
            self._pending[chain] = pending
        pending["model"] = getattr(message, "model", None) or pending["model"]
        pending["blocks"].extend(getattr(message, "content", None) or [])
        if getattr(message, "usage", None):
            pending["usage"] = message.usage
        if getattr(message, "stop_reason", None):
            pending["stop_reason"] = message.stop_reason

    def _flush_all(self) -> None:
        for chain in list(self._pending):
            self._flush_chain(chain)

    def _flush_chain(self, chain: str | None) -> None:
        pending = self._pending.pop(chain, None)
        if pending is None or self.session_id is None or self._ended:
            return
        if isinstance(pending["id"], str):
            self._reported.add(pending["id"])
        if pending["model"] == _SYNTHETIC_MODEL:
            return
        tokens = _usage_tokens(pending["usage"])
        self._tokens_used += tokens["tokens_total"]
        model = pending["model"] if isinstance(pending["model"], str) else None
        payload = self._payload("post_call")
        payload.update(tokens)
        payload.update(
            {
                "model": model,
                "model_requested": model,
                "model_served": model,
                "provider": "anthropic",
                "billing_mode": self._billing_mode,
                "provider_metadata": {"platform": self._platform},
            }
        )
        if isinstance(pending["stop_reason"], str):
            payload["stop_reason"] = pending["stop_reason"]
        blocks = [_block_dict(b) for b in pending["blocks"]]
        if self._session.config.capture_prompts:
            payload["has_content"] = True
            payload["content"] = {
                "provider": "anthropic",
                "model": model or "",
                "system": None,
                "messages": [{"role": "user", "content": self._prompt}] if self._prompt else [],
                "tools": None,
                "response": {"id": pending["id"], "role": "assistant", "content": blocks},
                "input": None,
            }
            self._prompt = None
        post_call_id = payload["id"]
        self._post(payload)
        for block in blocks:
            if block.get("type") == "tool_use":
                self._tool_call(block, model, post_call_id)

    def _tool_call(self, block: dict[str, Any], model: str | None, origin: str) -> None:
        from flightdeck_sensor.interceptor.mcp import _build_tool_capture_content

        payload = self._payload("tool_call")
        payload["model"] = model
        payload["tool_name"] = block.get("name")
        payload["originating_event_id"] = origin
        if self._session.config.capture_prompts:
            content = _build_tool_capture_content(
                tool_input=block.get("input"),
                tool_output=None,
                server_name=model or "",
                session_id=self.session_id or "",
            )
            if content is not None:
                payload["has_content"] = True
                payload["content"] = content
        self._post(payload)

    # -- wire --------------------------------------------------------

    def _payload(self, event_type: str) -> dict[str, Any]:
        cfg = self._session.config
        return {
            "id": str(uuid.uuid4()),
            "session_id": self.session_id,
            "flavor": cfg.agent_flavor,
            "agent_type": cfg.agent_type,
            "agent_id": self._agent_id,
            "agent_name": cfg.agent_name,
            "client_type": CLIENT_TYPE,
            "user": cfg.user_name,
            "hostname": cfg.hostname,
            "event_type": event_type,
            "host": self._session._host,
            "framework": self._framework,
            "tokens_used_session": self._tokens_used,
            "token_limit_session": None,
            "timestamp": datetime.now(UTC).isoformat(),
            "model": None,
            "tokens_input": None,
            "tokens_output": None,
            "tokens_total": None,
            "tokens_cache_read": 0,
            "tokens_cache_creation": 0,
            "latency_ms": None,
            "tool_name": None,
            "tool_input": None,
            "tool_result": None,
            "has_content": False,
            "content": None,
        }

    def _post(self, payload: dict[str, Any]) -> None:
        if self._ended and payload["event_type"] != "session_end":
            return
        self._session.event_queue.enqueue(payload)


# ----------------------------------------------------------------------
# Patching.
# ----------------------------------------------------------------------

_originals: dict[str, Any] = {}


def patch_claude_agent_sdk(*, quiet: bool = False) -> None:
    """Wrap ``InternalClient.process_query`` and ``ClaudeSDKClient``.

    ``query()`` is a module-level function a caller may have imported
    before ``patch()`` ran, so the wrap sits on the internal class
    method every ``query()`` call goes through rather than on the
    function. Idempotent; a silent no-op when the SDK is not installed.
    """
    if not _ensure_imported():
        if not quiet:
            _log.debug("claude-agent-sdk not installed; patch skipped.")
        return
    client_cls = _sdk.ClaudeSDKClient
    if getattr(client_cls, _PATCHED_SENTINEL, False):
        return

    _patch_query_path()
    _patch_client(client_cls)
    setattr(client_cls, _PATCHED_SENTINEL, True)


def _patch_query_path() -> None:
    if _internal_client is None or not hasattr(_internal_client, "process_query"):
        _log.warning(
            "claude-agent-sdk %s has no InternalClient.process_query; query() runs "
            "are not reported (ClaudeSDKClient runs still are).",
            getattr(_sdk, "__version__", "?"),
        )
        return
    original_process_query = _internal_client.process_query
    _originals["process_query"] = original_process_query

    async def process_query(
        self: Any, prompt: Any, options: Any, transport: Any = None
    ) -> AsyncIterator[Any]:
        run, options = _observe(options, transport)
        if run is not None:
            run.set_prompt(prompt)
        try:
            async for message in original_process_query(self, prompt, options, transport):
                if run is not None:
                    run.on_message(message)
                yield message
        finally:
            if run is not None:
                run.end()

    _internal_client.process_query = process_query


def _observe(options: Any, transport: Any) -> tuple[SdkRun | None, Any]:
    """A run to report and the options to start it with, or ``(None,
    options)`` when there is no sensor session or setting up fails."""
    session = _current_session()
    if session is None:
        return None, options
    try:
        observed = observed_options(options)
        run = SdkRun(session, env=run_env(observed))
    except Exception:
        _log.debug("claude_agent_sdk: run not observed", exc_info=True)
        return None, options
    if transport is not None:
        # A custom transport is built before the options reach it, so
        # the variable that keeps a plugin silent never reaches the CLI.
        _log.warning(
            "claude_agent_sdk: a run with a custom transport is reported, but a "
            "Claude Code plugin in it may report it again; set %s=1 in the "
            "transport's environment to prevent that.",
            SDK_OBSERVED_ENV,
        )
    return run, observed


_CLIENT_METHODS = ("__init__", "connect", "query", "receive_messages", "disconnect")


def _patch_client(client_cls: Any) -> None:
    for name in _CLIENT_METHODS:
        _originals[f"client.{name}"] = getattr(client_cls, name)
    original_init = _originals["client.__init__"]
    original_connect = _originals["client.connect"]
    original_client_query = _originals["client.query"]
    original_receive = _originals["client.receive_messages"]
    original_disconnect = _originals["client.disconnect"]

    def client_init(self: Any, options: Any = None, transport: Any = None) -> None:
        run, options = _observe(options, transport)
        original_init(self, options, transport)
        self._flightdeck_run = run

    async def connect(self: Any, prompt: Any = None) -> None:
        run = getattr(self, "_flightdeck_run", None)
        if run is not None:
            run.set_prompt(prompt)
        await original_connect(self, prompt)

    async def client_query(self: Any, prompt: Any, session_id: str = "default") -> None:
        run = getattr(self, "_flightdeck_run", None)
        if run is not None:
            run.set_prompt(prompt)
        await original_client_query(self, prompt, session_id)

    async def receive_messages(self: Any) -> AsyncIterator[Any]:
        run = getattr(self, "_flightdeck_run", None)
        async for message in original_receive(self):
            if run is not None:
                run.on_message(message)
            yield message

    async def disconnect(self: Any) -> None:
        run = getattr(self, "_flightdeck_run", None)
        if run is not None:
            run.end()
        await original_disconnect(self)

    client_cls.__init__ = client_init
    client_cls.connect = connect
    client_cls.query = client_query
    client_cls.receive_messages = receive_messages
    client_cls.disconnect = disconnect


def unpatch_claude_agent_sdk() -> None:
    """Restore the SDK's own ``process_query`` and ``ClaudeSDKClient`` methods."""
    if not _SDK_AVAILABLE or not _originals:
        return
    client_cls = _sdk.ClaudeSDKClient
    if "process_query" in _originals:
        _internal_client.process_query = _originals.pop("process_query")
    for name in _CLIENT_METHODS:
        setattr(client_cls, name, _originals.pop(f"client.{name}"))
    if hasattr(client_cls, _PATCHED_SENTINEL):
        delattr(client_cls, _PATCHED_SENTINEL)
