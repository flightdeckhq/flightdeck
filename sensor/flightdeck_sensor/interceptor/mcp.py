"""MCP interceptor: patches ``mcp.client.session.ClientSession``.

The official Python ``mcp`` SDK exposes every Model Context Protocol
operation as an async method on a single class, ``ClientSession``.
``ClientSession`` is constructed with a pair of ``anyio`` memory streams
produced by one of the transport helpers (``stdio_client``, ``sse_client``,
``streamable_http_client`` / ``streamablehttp_client``, ``websocket_client``);
the class itself is transport-agnostic. One class-level patch on its
methods therefore catches every transport simultaneously.

Every framework that wraps MCP routes traffic through this exact
``ClientSession`` (LangChain via ``langchain-mcp-adapters``, LlamaIndex
via ``llama-index-tools-mcp``, CrewAI via ``mcpadapt`` — see Phase 5
Step 2 inventory). Patching at the SDK seam is the single point that
covers every framework's MCP traffic.

Patch shape diverges from the descriptor-based Anthropic/OpenAI patches
intentionally. ``ClientSession`` methods are bound async instance methods
called repeatedly per session, not factory ``cached_property`` resources
materialised once. The descriptor pattern does not fit; we replace the
unbound methods on the class via ``setattr`` and stash originals on a
sentinel attribute for restoration on :func:`unpatch_mcp_classes`.

Six event types are emitted in this phase (Phase 5 D2(a)):

* ``MCP_TOOL_LIST``    — ``ClientSession.list_tools``
* ``MCP_TOOL_CALL``    — ``ClientSession.call_tool``
* ``MCP_RESOURCE_LIST``— ``ClientSession.list_resources``
* ``MCP_RESOURCE_READ``— ``ClientSession.read_resource``
* ``MCP_PROMPT_LIST``  — ``ClientSession.list_prompts``
* ``MCP_PROMPT_GET``   — ``ClientSession.get_prompt``

``ClientSession.initialize`` is patched too but does not emit a wire
event — it captures the server fingerprint (name, version, protocol
version, capabilities, instructions) onto the sensor's session via
:meth:`Session.record_mcp_server`, and stashes ``server_name`` /
``transport`` on the ClientSession instance so subsequent per-call
emissions can attribute server identity in O(1).

The protocol-plumbing surface (``complete``, ``send_ping``,
``send_progress_notification``, ``set_logging_level``,
``send_roots_list_changed``) is intentionally NOT patched in Phase 5.
Adding a future operation is a one-line change to ``_PATCH_TABLE``
plus one ``_emit_*`` function — the patch infrastructure is built for
extension. See Phase 5 D2(a).

Transport detection: each of the four transport context managers
(``stdio_client``, ``sse_client``, ``streamablehttp_client``,
``websocket_client``) is patched to mark the ``read`` stream object
with a ``_flightdeck_transport`` attribute. ``ClientSession.__init__``
is patched to read the marker off its ``read_stream`` argument and
copy the transport label onto ``self._flightdeck_mcp_transport``.
``_get_session_id`` returned by ``streamable_http_client``'s 3-tuple
is preserved unchanged. When no transport marker is present (e.g. a
caller constructs ClientSession with manually-built streams)
``transport`` is ``None``.
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable

from flightdeck_sensor.core.types import EventType, MCPServerFingerprint

if TYPE_CHECKING:
    from flightdeck_sensor.core.session import Session

_log = logging.getLogger("flightdeck_sensor.interceptor.mcp")


# ----------------------------------------------------------------------
# mcp SDK availability
# ----------------------------------------------------------------------

try:
    from mcp.client.session import ClientSession as _MCPClientSession
    from mcp.shared.exceptions import McpError as _MCPError

    _MCP_AVAILABLE = True
except ImportError:  # pragma: no cover - mcp not installed
    _MCPClientSession = None  # type: ignore[assignment,misc]
    _MCPError = None  # type: ignore[assignment,misc]
    _MCP_AVAILABLE = False


# Captured originals stashed on the ClientSession class so unpatch can
# restore them. Mirror the litellm interceptor's "stash on the patched
# object itself" pattern -- safe across module reloads and multiple
# patch / unpatch cycles.
_ORIG_ATTR_PREFIX = "_flightdeck_orig_"
_PATCHED_SENTINEL = "_flightdeck_patched"

# Stream marker attribute. Transport-client wrappers attach this onto
# the read stream they yield; the patched ClientSession.__init__ copies
# it onto the session instance for fast lookup at call time.
_TRANSPORT_MARKER = "_flightdeck_transport"

# Per-instance attributes set by patched initialize / __init__ so the
# call-time wrappers can attribute events without recomputing.
_INSTANCE_TRANSPORT_ATTR = "_flightdeck_mcp_transport"
_INSTANCE_SERVER_NAME_ATTR = "_flightdeck_mcp_server_name"

# Phase 5 (B-6) — content-overflow thresholds.
#
# Inline threshold (8 KiB): fields below this serialized size land
# inline in the event payload. Common-case MCP responses (small tool
# call results, short rendered prompts) stay inline so the timeline
# row renders without a follow-up fetch.
#
# Hard cap (2 MiB): fields above this size are dropped entirely with a
# ``_capped`` marker and only their byte count is recorded. An agent
# calling ``read_resource`` against a 500 MB log file shouldn't crash
# Flightdeck or bloat Postgres rows past TOAST sanity.
#
# Range between threshold and hard cap: full content is stripped from
# the inline payload, replaced with a ``{"_truncated": true, "size":
# N}`` marker, AND shipped to the event_content table via the
# existing has_content=true path (the same machinery LLM prompts use
# for the same problem class). The dashboard's MCPEventDetails reads
# the marker, surfaces a "Load full response" affordance, and fetches
# /v1/events/:id/content on click.
#
# Exact byte values, not bit-shifted, so a future operator reading the
# constants understands the threshold at a glance without arithmetic.
_MCP_INLINE_THRESHOLD_BYTES = 8 * 1024
_MCP_HARD_CAP_BYTES = 2 * 1024 * 1024


# ----------------------------------------------------------------------
# Sensor session lookup
# ----------------------------------------------------------------------


def _current_session() -> Session | None:
    """Lazy lookup of the active flightdeck-sensor session.

    Matches the helper in the Anthropic / OpenAI / litellm interceptors --
    imported at call time to avoid a circular import between the sensor
    package's ``__init__`` and the interceptor modules.
    """
    import flightdeck_sensor

    return flightdeck_sensor._session


# ----------------------------------------------------------------------
# Capability / result serialisers (capture_prompts gated)
# ----------------------------------------------------------------------


def _model_to_dict(obj: Any) -> Any:
    """Best-effort pydantic dump.

    The mcp SDK returns pydantic models for every result type. ``model_dump()``
    yields a JSON-serialisable dict. If the object is already a primitive (or
    raises during dump), we return it unchanged rather than silently dropping
    the field — the worker tolerates extra payload shape.
    """
    dump = getattr(obj, "model_dump", None)
    if callable(dump):
        try:
            return dump(mode="json")
        except Exception:  # pragma: no cover - defensive only
            return None
    return obj


def _capabilities_dict(capabilities: Any) -> dict[str, Any]:
    """Convert ``InitializeResult.capabilities`` to a JSON-safe dict.

    Returns an empty dict on any extraction failure so the worker still
    receives a valid (just empty) capabilities map.
    """
    if capabilities is None:
        return {}
    dumped = _model_to_dict(capabilities)
    if isinstance(dumped, dict):
        return dumped
    return {}


# ----------------------------------------------------------------------
# Phase 5 (B-6) — content-size gating helpers
# ----------------------------------------------------------------------


def _serialized_size_bytes(value: Any) -> int:
    """Estimate the wire size of ``value`` in UTF-8-encoded JSON bytes.

    The threshold check at emit time uses this estimate to decide
    inline vs event_content overflow. ``json.dumps`` covers the common
    case (dicts/lists/primitives the SDK already produced); on a
    serialisation failure we treat the field as "very large" so the
    overflow path runs and the operator sees a truncation marker
    rather than a silently-dropped field. ``default=str`` accepts
    pydantic model fragments / datetimes / AnyUrl instances cleanly.
    """
    if value is None:
        return 0
    try:
        return len(json.dumps(value, default=str).encode("utf-8"))
    except (TypeError, ValueError):  # pragma: no cover - defensive
        return _MCP_HARD_CAP_BYTES + 1


def _truncation_marker(size: int, *, capped: bool = False) -> dict[str, Any]:
    """Sentinel placed inline in the event payload when a content field
    is moved to event_content (or dropped entirely at the hard cap).

    The dashboard branches on ``_truncated`` to render the "Load full
    response" affordance; ``size`` shows the operator the original
    serialized byte count. ``_capped`` indicates the field was over
    the 2 MiB hard cap — no full content was preserved at all.
    """
    marker: dict[str, Any] = {"_truncated": True, "size": size}
    if capped:
        marker["_capped"] = True
    return marker


def _gate_mcp_field(value: Any) -> tuple[Any, Any, dict[str, Any] | None]:
    """Decide inline vs overflow for a single capture-gated MCP field.

    Returns ``(inline_value, overflow_value, marker)``:

    * ``inline_value``: what to put in the inline event payload extras.
      ``value`` itself when below threshold; the truncation marker
      (a small dict) when above; ``None`` when the input was ``None``.
    * ``overflow_value``: the full content destined for the
      event_content row, or ``None`` if the field stays inline / was
      dropped at the hard cap.
    * ``marker``: the raw marker dict when overflow happened, or
      ``None`` when the field stayed inline / was null. Surfaced
      separately so the caller can summarise overflow at the
      event level.

    The hard cap is enforced strictly: at >2 MiB we do NOT preserve
    the full content (the wire transfer would itself become a
    pathology). The marker carries ``_capped: True`` so the dashboard
    can render "content too large to capture" rather than offering a
    "Load full response" affordance that returns nothing.
    """
    if value is None:
        return None, None, None
    size = _serialized_size_bytes(value)
    if size <= _MCP_INLINE_THRESHOLD_BYTES:
        return value, None, None
    if size > _MCP_HARD_CAP_BYTES:
        marker = _truncation_marker(size, capped=True)
        return marker, None, marker
    marker = _truncation_marker(size)
    return marker, value, marker


def _build_overflow_event_content(
    *,
    arguments_overflow: Any,
    response_overflow: Any,
    server_name: str | None,
    session_id: str,
) -> dict[str, Any] | None:
    """Build the event_content-shaped wire dict for an MCP event whose
    capture-gated fields exceeded the inline threshold.

    Returns ``None`` when nothing overflowed (caller stays on the
    inline path). When overflow exists, populates the existing
    ``event_content`` columns the LLM path uses:

    * ``provider`` -- ``"mcp"``
    * ``model``    -- the connected MCP server name
    * ``input``    -- arguments dict (when overflowing); null otherwise
    * ``response`` -- the large content blob (result / content /
                      rendered messages depending on event type)
    * ``system`` / ``messages`` / ``tools`` -- LLM-only, always null /
      empty for MCP

    The shape matches what the worker's ``InsertEventContent`` already
    parses (workers/internal/writer/postgres.go), so no worker change
    is needed -- the existing has_content=true path runs and persists
    the row.
    """
    if arguments_overflow is None and response_overflow is None:
        return None
    return {
        "system": None,
        "messages": [],
        "tools": None,
        "response": response_overflow if response_overflow is not None else {},
        "input": arguments_overflow,
        "provider": "mcp",
        "model": server_name or "",
        "session_id": session_id,
        "event_id": "",
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


# ----------------------------------------------------------------------
# Error classification
# ----------------------------------------------------------------------


def _classify_mcp_error(exc: BaseException) -> dict[str, Any]:
    """Translate an MCP-side exception into the structured error payload.

    Mirrors the ``llm_error`` taxonomy shape so the dashboard can render
    failed MCP calls with the same accordion component that powers
    LLM_ERROR rendering. Fields:

    * ``error_type`` -- coarse category (timeout / not_found / invalid /
      api_error / other).
    * ``error_class`` -- the python exception class name, for diagnostic
      detail.
    * ``message`` -- the exception's ``str()``.
    * ``code`` -- JSON-RPC error code when the exception is an ``McpError``.
    * ``data`` -- the ``McpError.error.data`` blob when present.
    """
    error_class = type(exc).__name__
    message = str(exc)
    code: int | None = None
    data: Any = None

    if _MCPError is not None and isinstance(exc, _MCPError):
        err = getattr(exc, "error", None)
        if err is not None:
            code = getattr(err, "code", None)
            data = getattr(err, "data", None)

    if code == -32602:
        error_type = "invalid_params"
    elif code == -32600:
        error_type = "invalid_request"
    elif code == -32000:
        error_type = "connection_closed"
    elif code == -32601:
        error_type = "method_not_found"
    elif code == 408 or isinstance(exc, TimeoutError):
        error_type = "timeout"
    elif _MCPError is not None and isinstance(exc, _MCPError):
        error_type = "api_error"
    else:
        error_type = "other"

    payload: dict[str, Any] = {
        "error_type": error_type,
        "error_class": error_class,
        "message": message,
    }
    if code is not None:
        payload["code"] = code
    if data is not None:
        payload["data"] = data
    return payload


# ----------------------------------------------------------------------
# Per-method emit handlers — payload-extras builders
#
# Each handler maps (args, kwargs, result, error, capture_prompts)
# onto the event-payload extras dict. Adding a new patched method is
# one entry in _PATCH_TABLE plus one handler here. No call-site
# duplication of timing / wrapping plumbing — that lives in the
# generic _make_async_wrapper.
# ----------------------------------------------------------------------


def _common_extras(
    server_name: str | None,
    transport: str | None,
    latency_ms: int,
    error: BaseException | None,
) -> dict[str, Any]:
    """Fields every MCP event carries regardless of operation."""
    extras: dict[str, Any] = {
        "server_name": server_name,
        "transport": transport,
        "duration_ms": latency_ms,
    }
    if error is not None:
        extras["error"] = _classify_mcp_error(error)
    return extras


def _emit_tool_list(
    *,
    server_name: str | None,
    transport: str | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    result: Any,
    latency_ms: int,
    error: BaseException | None,
    capture_prompts: bool,
    session_id: str,
) -> dict[str, Any]:
    # ``session_id`` and ``capture_prompts`` are unused for list events
    # (no capture-gated content) but kept in the signature for ABI
    # parity with the gated handlers — the wrapper factory passes the
    # same kwargs to every entry in _PATCH_TABLE.
    del capture_prompts, session_id
    extras = _common_extras(server_name, transport, latency_ms, error)
    if result is not None and error is None:
        tools = getattr(result, "tools", None) or []
        extras["count"] = len(tools)
    elif error is None:
        extras["count"] = 0
    return extras


def _emit_tool_call(
    *,
    server_name: str | None,
    transport: str | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    result: Any,
    latency_ms: int,
    error: BaseException | None,
    capture_prompts: bool,
    session_id: str,
) -> dict[str, Any]:
    extras = _common_extras(server_name, transport, latency_ms, error)
    # call_tool(self, name, arguments=None, ...) — name is positional[0]
    # after self is stripped by the wrapper.
    tool_name = args[0] if args else kwargs.get("name")
    extras["tool_name"] = tool_name
    if capture_prompts:
        arguments = args[1] if len(args) > 1 else kwargs.get("arguments")
        result_dict = (
            _model_to_dict(result) if (result is not None and error is None) else None
        )
        # B-6 — gate each capture-on field independently. arguments
        # below 8 KiB stay inline alongside a small result; arguments
        # above 8 KiB get a marker inline and the full value goes to
        # event_content. Same for result. has_content fires when any
        # field overflowed.
        args_inline, args_overflow, args_marker = _gate_mcp_field(arguments)
        result_inline, result_overflow, result_marker = _gate_mcp_field(result_dict)
        if args_inline is not None or args_marker is not None:
            extras["arguments"] = args_inline
        if result_inline is not None or result_marker is not None:
            extras["result"] = result_inline
        overflow_content = _build_overflow_event_content(
            arguments_overflow=args_overflow,
            response_overflow=result_overflow,
            server_name=server_name,
            session_id=session_id,
        )
        if overflow_content is not None:
            extras["has_content"] = True
            extras["content"] = overflow_content
    return extras


def _emit_resource_list(
    *,
    server_name: str | None,
    transport: str | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    result: Any,
    latency_ms: int,
    error: BaseException | None,
    capture_prompts: bool,
    session_id: str,
) -> dict[str, Any]:
    del capture_prompts, session_id
    extras = _common_extras(server_name, transport, latency_ms, error)
    if result is not None and error is None:
        resources = getattr(result, "resources", None) or []
        extras["count"] = len(resources)
    elif error is None:
        extras["count"] = 0
    return extras


def _emit_resource_read(
    *,
    server_name: str | None,
    transport: str | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    result: Any,
    latency_ms: int,
    error: BaseException | None,
    capture_prompts: bool,
    session_id: str,
) -> dict[str, Any]:
    extras = _common_extras(server_name, transport, latency_ms, error)
    # read_resource(self, uri) — uri is positional[0].
    uri = args[0] if args else kwargs.get("uri")
    extras["resource_uri"] = str(uri) if uri is not None else None

    # content_bytes is non-sensitive (size, not contents) and emits
    # unconditionally per Phase 5 S-MCP-3 / S-MCP-8.
    if result is not None and error is None:
        contents_list = getattr(result, "contents", None) or []
        total_bytes = 0
        mime_type: str | None = None
        for piece in contents_list:
            text = getattr(piece, "text", None)
            blob = getattr(piece, "blob", None)
            if text is not None:
                with contextlib.suppress(Exception):  # pragma: no cover - defensive
                    total_bytes += len(text.encode("utf-8"))
            elif blob is not None:
                # blob is base64-encoded per the spec; decoded length is
                # the actual byte count. On a malformed blob we fall back
                # to the raw string length so callers still get a sane
                # size signal rather than a missing field.
                try:
                    import base64

                    total_bytes += len(base64.b64decode(blob))
                except Exception:  # pragma: no cover - defensive
                    total_bytes += len(blob) if isinstance(blob, (str, bytes)) else 0
            if mime_type is None:
                mime_type = getattr(piece, "mimeType", None)
        extras["content_bytes"] = total_bytes
        if capture_prompts:
            extras["mime_type"] = mime_type
            content_dict = _model_to_dict(result)
            # B-6 — gate the resource body. read_resource against a
            # multi-MB log file / PDF extract overflows to event_content
            # via the existing has_content=true path. The wire
            # ``content`` field shape is meaning-shifted by has_content:
            #   has_content=false: inline ReadResourceResult (worker's
            #     MCP-inline branch projects into events.payload).
            #   has_content=true:  event_content shape (worker's
            #     InsertEventContent persists the row).
            # The dashboard discriminates via has_content alone — when
            # true on an MCP event, the "Load full response" affordance
            # fetches /v1/events/:id/content. No inline marker on
            # ``content`` is needed (and would conflict with the wire-
            # shape doubling).
            _, content_overflow, _ = _gate_mcp_field(content_dict)
            if content_overflow is not None:
                overflow_content = _build_overflow_event_content(
                    arguments_overflow=None,
                    response_overflow=content_overflow,
                    server_name=server_name,
                    session_id=session_id,
                )
                if overflow_content is not None:
                    extras["has_content"] = True
                    extras["content"] = overflow_content
            else:
                # Below threshold — inline (or hard-cap dropped).
                # _gate_mcp_field returns (marker, None, marker) on hard
                # cap, in which case we record the marker inline and do
                # NOT set has_content (no full content was preserved).
                inline_value, _, _ = _gate_mcp_field(content_dict)
                extras["content"] = inline_value
    elif error is None:
        extras["content_bytes"] = 0
    return extras


def _emit_prompt_list(
    *,
    server_name: str | None,
    transport: str | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    result: Any,
    latency_ms: int,
    error: BaseException | None,
    capture_prompts: bool,
    session_id: str,
) -> dict[str, Any]:
    del capture_prompts, session_id
    extras = _common_extras(server_name, transport, latency_ms, error)
    if result is not None and error is None:
        prompts = getattr(result, "prompts", None) or []
        extras["count"] = len(prompts)
    elif error is None:
        extras["count"] = 0
    return extras


def _emit_prompt_get(
    *,
    server_name: str | None,
    transport: str | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    result: Any,
    latency_ms: int,
    error: BaseException | None,
    capture_prompts: bool,
    session_id: str,
) -> dict[str, Any]:
    extras = _common_extras(server_name, transport, latency_ms, error)
    # get_prompt(self, name, arguments=None) — name is positional[0].
    prompt_name = args[0] if args else kwargs.get("name")
    extras["prompt_name"] = prompt_name
    if capture_prompts:
        arguments = args[1] if len(args) > 1 else kwargs.get("arguments")
        rendered = None
        if result is not None and error is None:
            messages = getattr(result, "messages", None) or []
            rendered = [_model_to_dict(m) for m in messages]
        # B-6 — gate arguments and rendered independently. Multi-message
        # rendered prompts with embedded context routinely cross 10 KiB
        # in real templates.
        args_inline, args_overflow, args_marker = _gate_mcp_field(arguments)
        rendered_inline, rendered_overflow, rendered_marker = _gate_mcp_field(
            rendered,
        )
        if args_inline is not None or args_marker is not None:
            extras["arguments"] = args_inline
        if rendered_inline is not None or rendered_marker is not None:
            extras["rendered"] = rendered_inline
        overflow_content = _build_overflow_event_content(
            arguments_overflow=args_overflow,
            response_overflow=rendered_overflow,
            server_name=server_name,
            session_id=session_id,
        )
        if overflow_content is not None:
            extras["has_content"] = True
            extras["content"] = overflow_content
    return extras


# Type alias for per-method handlers. Keyword-only so adding a new
# argument later (e.g. a session reference for advanced handlers) is
# non-breaking for existing entries.
EmitHandler = Callable[..., dict[str, Any]]


# ----------------------------------------------------------------------
# Patch table: method name -> (event_type, emit_handler).
#
# Adding a new patched MCP operation in a future phase is exactly:
#   1. Add a new EventType enum value in core/types.py.
#   2. Write a new ``_emit_<op>`` handler above.
#   3. Add one line to this dict.
#
# That is the structural commitment from Phase 5 addition E. Any
# refactor that turns _PATCH_TABLE into per-method inline wrappers
# breaks the commitment and is out of bounds.
# ----------------------------------------------------------------------

_PATCH_TABLE: dict[str, tuple[EventType, EmitHandler]] = {
    "list_tools": (EventType.MCP_TOOL_LIST, _emit_tool_list),
    "call_tool": (EventType.MCP_TOOL_CALL, _emit_tool_call),
    "list_resources": (EventType.MCP_RESOURCE_LIST, _emit_resource_list),
    "read_resource": (EventType.MCP_RESOURCE_READ, _emit_resource_read),
    "list_prompts": (EventType.MCP_PROMPT_LIST, _emit_prompt_list),
    "get_prompt": (EventType.MCP_PROMPT_GET, _emit_prompt_get),
}


# ----------------------------------------------------------------------
# Wrapper factory
# ----------------------------------------------------------------------


def _make_async_wrapper(
    method_name: str,
    orig_method: Any,
    event_type: EventType,
    emit_handler: EmitHandler,
) -> Any:
    """Produce a patched async method for a single ClientSession op.

    The wrapper:

    1. Looks up the active sensor session. If none, runs the original
       method unwrapped — same fail-open behaviour as every other
       interceptor in the package.
    2. Times the call.
    3. Catches every exception (including ``McpError``) so an emit
       happens even on the failure path.
    4. Calls the per-op handler with the captured args / result /
       error / latency to produce the payload extras dict.
    5. Builds the canonical event payload via
       :meth:`Session._build_payload` and enqueues it.
    6. Re-raises any captured exception after the emit so user code
       sees the original failure.

    Wrapper failures (e.g. payload build raises) are logged and
    swallowed — they must never crash the user's MCP call.
    """

    async def _patched(self: Any, *args: Any, **kwargs: Any) -> Any:
        sensor_session = _current_session()
        if sensor_session is None:
            return await orig_method(self, *args, **kwargs)

        server_name = getattr(self, _INSTANCE_SERVER_NAME_ATTR, None)
        transport = getattr(self, _INSTANCE_TRANSPORT_ATTR, None)

        t0 = time.monotonic()
        result: Any = None
        error: BaseException | None = None
        try:
            result = await orig_method(self, *args, **kwargs)
        except BaseException as exc:
            error = exc
        latency_ms = int((time.monotonic() - t0) * 1000)

        try:
            extras = emit_handler(
                server_name=server_name,
                transport=transport,
                args=args,
                kwargs=kwargs,
                result=result,
                latency_ms=latency_ms,
                error=error,
                capture_prompts=sensor_session.config.capture_prompts,
                session_id=sensor_session.config.session_id,
            )
            payload = sensor_session._build_payload(event_type, **extras)
            sensor_session.event_queue.enqueue(payload)
        except Exception:
            _log.exception(
                "flightdeck_sensor: failed to emit %s event for ClientSession.%s",
                event_type.value,
                method_name,
            )

        if error is not None:
            raise error
        return result

    _patched.__name__ = method_name
    _patched.__qualname__ = f"ClientSession.{method_name}"
    _patched.__doc__ = (
        f"flightdeck-sensor patched {method_name}. Emits {event_type.value} "
        f"on completion or failure. Wraps the original "
        f"mcp.client.session.ClientSession.{method_name}."
    )
    return _patched


# ----------------------------------------------------------------------
# initialize wrapper -- fingerprint capture, no event emit
# ----------------------------------------------------------------------


def _make_initialize_wrapper(orig_initialize: Any) -> Any:
    """Produce a patched ClientSession.initialize that captures the
    server fingerprint onto the sensor session and stashes
    server_name + transport on the ClientSession instance.

    No event is emitted for initialize itself — the fingerprint lands
    on session_start via context.mcp_servers, and per-call MCP events
    attribute via the stashed instance attributes. See Phase 5 D2(a).
    """

    async def _patched_initialize(self: Any) -> Any:
        result = await orig_initialize(self)
        # Best-effort capture. A malformed InitializeResult (older mcp,
        # mocked tests, future SDK shape change) must never crash the
        # initialize call — the user's MCP session must continue to work.
        with contextlib.suppress(Exception):
            server_info = getattr(result, "serverInfo", None)
            name = getattr(server_info, "name", None) if server_info else None
            version = getattr(server_info, "version", None) if server_info else None
            # Preserve the SDK's ``str | int`` typing rather than coercing
            # to str — the dashboard handles both with a one-line type
            # guard. ``or ""`` on the str path is intentional: if the SDK
            # returns None / empty, we substitute an empty string to keep
            # the field non-null on the wire. Integer 0 is left intact.
            protocol_version_raw = getattr(result, "protocolVersion", "")
            protocol_version: str | int
            if isinstance(protocol_version_raw, int):
                protocol_version = protocol_version_raw
            else:
                protocol_version = str(protocol_version_raw or "")
            capabilities = _capabilities_dict(getattr(result, "capabilities", None))
            instructions = getattr(result, "instructions", None)
            transport = getattr(self, _INSTANCE_TRANSPORT_ATTR, None)

            if name:
                # Stash on the ClientSession instance for fast lookup
                # by per-method wrappers.
                with contextlib.suppress(Exception):
                    setattr(self, _INSTANCE_SERVER_NAME_ATTR, name)

                fingerprint = MCPServerFingerprint(
                    name=name,
                    transport=transport,
                    protocol_version=protocol_version,
                    version=version,
                    capabilities=capabilities,
                    instructions=instructions,
                )
                sensor_session = _current_session()
                if sensor_session is not None:
                    sensor_session.record_mcp_server(fingerprint)
        return result

    _patched_initialize.__name__ = "initialize"
    _patched_initialize.__qualname__ = "ClientSession.initialize"
    _patched_initialize.__doc__ = (
        "flightdeck-sensor patched initialize. Captures the server "
        "fingerprint (name, version, capabilities) onto the sensor "
        "session for emission on session_start, and stashes server_name "
        "+ transport on the ClientSession instance for per-call attribution."
    )
    return _patched_initialize


# ----------------------------------------------------------------------
# __init__ wrapper -- transport marker copy
# ----------------------------------------------------------------------


def _make_init_wrapper(orig_init: Any) -> Any:
    """Patch ClientSession.__init__ to copy the transport marker off
    the read stream onto the session instance.

    Stream marking happens in the patched transport context managers
    (stdio / sse / http / websocket). When a caller constructs
    ``ClientSession`` with hand-built streams that lack the marker,
    transport stays ``None`` and per-event ``transport`` lands as null —
    documented behaviour, not an error.
    """

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        orig_init(self, *args, **kwargs)
        # ClientSession.__init__(read_stream, write_stream, ...) — read
        # stream is positional arg 0 after self. We support both kwargs
        # and positional in case future SDK versions reorder.
        read_stream = args[0] if args else kwargs.get("read_stream")

        if read_stream is not None:
            transport = getattr(read_stream, _TRANSPORT_MARKER, None)
            if transport is not None:
                with contextlib.suppress(Exception):
                    setattr(self, _INSTANCE_TRANSPORT_ATTR, transport)

    _patched_init.__name__ = "__init__"
    _patched_init.__qualname__ = "ClientSession.__init__"
    return _patched_init


# ----------------------------------------------------------------------
# Transport client patches -- mark streams with a transport label
# ----------------------------------------------------------------------


def _wrap_transport_client(orig_factory: Any, transport_label: str) -> Any:
    """Wrap an async-context-manager transport factory so the streams it
    yields carry a ``_flightdeck_transport`` marker.

    Handles both 2-tuple yields (stdio / sse / websocket) and 3-tuple
    yields (streamable_http_client returns ``(read, write,
    _get_session_id)``). Stream marking is best-effort — if
    ``setattr`` raises (e.g. read-only proxy in a future SDK version)
    we log at debug and yield the unmarked tuple. The MCP call then
    lands with ``transport=null`` rather than crashing.
    """
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _wrapped(*args: Any, **kwargs: Any) -> Any:
        async with orig_factory(*args, **kwargs) as result:
            try:
                if isinstance(result, tuple) and len(result) >= 2:
                    read, write = result[0], result[1]
                    with contextlib.suppress(Exception):
                        setattr(read, _TRANSPORT_MARKER, transport_label)
                    with contextlib.suppress(Exception):
                        setattr(write, _TRANSPORT_MARKER, transport_label)
            except Exception:  # pragma: no cover - defensive
                _log.debug(
                    "flightdeck_sensor: failed to mark %s streams",
                    transport_label,
                    exc_info=True,
                )
            yield result

    _wrapped.__name__ = getattr(orig_factory, "__name__", "transport_client")
    _wrapped.__doc__ = getattr(orig_factory, "__doc__", None)
    return _wrapped


# Transport modules to patch. Tuples of (module path, attribute name,
# transport label). The aliasing on streamable_http (both
# ``streamable_http_client`` and ``streamablehttp_client`` exist on the
# same module — see Phase 5 Step 1 inventory) is handled by listing
# both. Patching either one alone would miss callers who imported the
# other.
_TRANSPORT_PATCHES: tuple[tuple[str, str, str], ...] = (
    ("mcp.client.stdio", "stdio_client", "stdio"),
    ("mcp.client.sse", "sse_client", "sse"),
    ("mcp.client.streamable_http", "streamable_http_client", "http"),
    ("mcp.client.streamable_http", "streamablehttp_client", "http"),
    ("mcp.client.websocket", "websocket_client", "websocket"),
)


def _patch_transport_modules(quiet: bool) -> None:
    """Wrap each transport client factory to mark streams with a label."""
    import importlib

    for module_path, attr_name, label in _TRANSPORT_PATCHES:
        try:
            module = importlib.import_module(module_path)
        except ImportError:  # pragma: no cover - older mcp without this transport
            if not quiet:
                _log.debug("mcp transport %s not present, skipping", module_path)
            continue

        orig = getattr(module, attr_name, None)
        if orig is None:  # pragma: no cover - alias absent on older mcp
            continue

        if getattr(module, f"{_PATCHED_SENTINEL}_{attr_name}", False):
            continue

        setattr(module, f"{_ORIG_ATTR_PREFIX}{attr_name}", orig)
        setattr(module, attr_name, _wrap_transport_client(orig, label))
        setattr(module, f"{_PATCHED_SENTINEL}_{attr_name}", True)


def _unpatch_transport_modules() -> None:
    """Restore the original transport client factories."""
    import importlib

    for module_path, attr_name, _label in _TRANSPORT_PATCHES:
        try:
            module = importlib.import_module(module_path)
        except ImportError:  # pragma: no cover
            continue

        orig = getattr(module, f"{_ORIG_ATTR_PREFIX}{attr_name}", None)
        if orig is None:
            continue
        setattr(module, attr_name, orig)
        with contextlib.suppress(AttributeError):
            delattr(module, f"{_ORIG_ATTR_PREFIX}{attr_name}")
        with contextlib.suppress(AttributeError):
            delattr(module, f"{_PATCHED_SENTINEL}_{attr_name}")


# ----------------------------------------------------------------------
# Class-level patch / unpatch
# ----------------------------------------------------------------------


def patch_mcp_classes(quiet: bool = False) -> None:
    """Install class-level patches on ``mcp.client.session.ClientSession``.

    Patches ``__init__``, ``initialize``, and the six event-emitting
    methods listed in :data:`_PATCH_TABLE`. Also wraps every transport
    client context manager so the streams they yield carry a
    ``_flightdeck_transport`` marker.

    Idempotent: a second call is a no-op. Silent no-op when the ``mcp``
    package is not installed.
    """
    if not _MCP_AVAILABLE:
        if not quiet:
            _log.debug("mcp not installed, skipping patch")
        return

    if getattr(_MCPClientSession, _PATCHED_SENTINEL, False):
        if not quiet:
            _log.debug("mcp ClientSession already patched, skipping")
        return

    # __init__ — transport marker copy.
    orig_init = _MCPClientSession.__init__
    setattr(_MCPClientSession, f"{_ORIG_ATTR_PREFIX}__init__", orig_init)
    _MCPClientSession.__init__ = _make_init_wrapper(orig_init)  # type: ignore[method-assign]

    # initialize — fingerprint capture.
    orig_initialize = _MCPClientSession.initialize
    setattr(_MCPClientSession, f"{_ORIG_ATTR_PREFIX}initialize", orig_initialize)
    _MCPClientSession.initialize = _make_initialize_wrapper(orig_initialize)  # type: ignore[method-assign]

    # Six event-emitting methods.
    for method_name, (event_type, emit_handler) in _PATCH_TABLE.items():
        orig_method = getattr(_MCPClientSession, method_name, None)
        if orig_method is None:  # pragma: no cover - older mcp without this op
            if not quiet:
                _log.debug(
                    "ClientSession.%s missing on installed mcp; skipping",
                    method_name,
                )
            continue
        setattr(
            _MCPClientSession,
            f"{_ORIG_ATTR_PREFIX}{method_name}",
            orig_method,
        )
        setattr(
            _MCPClientSession,
            method_name,
            _make_async_wrapper(method_name, orig_method, event_type, emit_handler),
        )

    _patch_transport_modules(quiet=quiet)

    setattr(_MCPClientSession, _PATCHED_SENTINEL, True)
    if not quiet:
        _log.info(
            "mcp.client.session.ClientSession patched (%d ops + initialize + 4 transports)",
            len(_PATCH_TABLE),
        )


def unpatch_mcp_classes(quiet: bool = False) -> None:
    """Restore the original ``ClientSession`` and transport client factories."""
    if not _MCP_AVAILABLE:
        return
    if not getattr(_MCPClientSession, _PATCHED_SENTINEL, False):
        if not quiet:
            _log.debug("mcp ClientSession not patched, skipping unpatch")
        return

    # __init__
    orig_init = getattr(_MCPClientSession, f"{_ORIG_ATTR_PREFIX}__init__", None)
    if orig_init is not None:
        _MCPClientSession.__init__ = orig_init  # type: ignore[method-assign]
        with contextlib.suppress(AttributeError):
            delattr(_MCPClientSession, f"{_ORIG_ATTR_PREFIX}__init__")

    # initialize
    orig_initialize = getattr(
        _MCPClientSession,
        f"{_ORIG_ATTR_PREFIX}initialize",
        None,
    )
    if orig_initialize is not None:
        _MCPClientSession.initialize = orig_initialize  # type: ignore[method-assign]
        with contextlib.suppress(AttributeError):
            delattr(_MCPClientSession, f"{_ORIG_ATTR_PREFIX}initialize")

    # Six event-emitting methods.
    for method_name in _PATCH_TABLE:
        orig = getattr(
            _MCPClientSession,
            f"{_ORIG_ATTR_PREFIX}{method_name}",
            None,
        )
        if orig is None:
            continue
        setattr(_MCPClientSession, method_name, orig)
        with contextlib.suppress(AttributeError):
            delattr(_MCPClientSession, f"{_ORIG_ATTR_PREFIX}{method_name}")

    _unpatch_transport_modules()

    with contextlib.suppress(AttributeError):
        delattr(_MCPClientSession, _PATCHED_SENTINEL)

    if not quiet:
        _log.info("mcp.client.session.ClientSession unpatched")


__all__ = [
    "patch_mcp_classes",
    "unpatch_mcp_classes",
]
