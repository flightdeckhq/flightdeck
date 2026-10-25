"""Anthropic provider: token estimation and usage extraction.

Reimplements the patterns from tokencap -- this is a standalone
implementation with no dependency on tokencap.
"""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC
from typing import Any

from flightdeck_sensor.core.types import CallDetails, TokenUsage
from flightdeck_sensor.providers.protocol import PromptContent, ToolInvocation

_log = logging.getLogger("flightdeck_sensor.providers.anthropic")

# Model the SDK ``count_tokens`` call names when the request carries no
# ``model``. The endpoint rejects a retired id with 404, and the estimator
# swallows that and silently falls back to the char/4 heuristic, so this
# must be a model Anthropic still serves. Sonnet 4.6 is the served
# successor of the previous default (Sonnet 4, retired 2026-06-15) in the
# same tokenizer family, so estimates stay comparable; it is listed in the
# SDK's model literal and priced in pricing.yaml, both of which the unit
# tests check so a future retirement fails loudly instead of degrading
# every estimate.
DEFAULT_COUNT_TOKENS_MODEL = "claude-sonnet-4-6"
_CHARS_PER_TOKEN_ESTIMATE = 4


# Anthropic stream event discriminators, as the SDK names them.
_EVENT_MESSAGE_START = "message_start"
_EVENT_MESSAGE_DELTA = "message_delta"
_EVENT_MESSAGE_STOP = "message_stop"
_EVENT_CONTENT_BLOCK_DELTA = "content_block_delta"
_DELTA_TEXT = "text_delta"


class AnthropicProvider:
    """Provider adapter for the Anthropic Python SDK.

    All methods are safe to call on the hot path.  None of them raise
    exceptions -- failures return zero/empty defaults.
    """

    name = "anthropic"
    _client: Any = None

    def __init__(
        self,
        capture_prompts: bool = False,
        platform: str | None = None,
        *,
        local: bool = False,
        inference_scope: str | None = None,
    ) -> None:
        self._capture_prompts = capture_prompts
        # The platform the client talks to (anthropic, bedrock, vertex,
        # ...), reported under ``provider_metadata.platform`` on every
        # call. None when the caller attributed none, in which case the
        # metadata block stays headers-only.
        self._platform = platform
        self._local = local
        self._inference_scope = inference_scope

    @property
    def platform(self) -> str | None:
        return self._platform

    @property
    def vendor(self) -> str | None:
        # Every endpoint the Anthropic SDK talks to serves Claude models,
        # gateways and cloud platforms included.
        return "anthropic"

    @property
    def local(self) -> bool:
        return self._local

    @property
    def inference_scope(self) -> str | None:
        return self._inference_scope

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> tuple[int, str]:
        """Estimate input tokens; returns ``(count, source)``.

        Source is ``"tiktoken"`` for the SDK ``count_tokens`` path,
        ``"heuristic"`` for the char/4 fallback, or ``"none"`` when
        extraction fails.
        """
        try:
            import anthropic as _anthropic

            if AnthropicProvider._client is None:
                AnthropicProvider._client = _anthropic.Anthropic()
            count: int = AnthropicProvider._client.messages.count_tokens(
                model=request_kwargs.get("model", DEFAULT_COUNT_TOKENS_MODEL),
                messages=request_kwargs.get("messages", []),
                system=request_kwargs.get("system", ""),
                tools=request_kwargs.get("tools", []),
            ).input_tokens
            return count, "tiktoken"
        except Exception:
            _log.debug("SDK count_tokens failed, using char heuristic", exc_info=True)

        try:
            messages = request_kwargs.get("messages", [])
            system = request_kwargs.get("system", "")
            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(system) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE, "heuristic"
        except Exception:
            _log.debug("char estimation failed", exc_info=True)
            return 0, "none"

    def extract_response_metadata(self, response: Any) -> dict[str, Any] | None:
        """Pull rate-limit headers + request id from anthropic responses,
        plus the platform this provider was attributed to (see
        ``__init__``), which is reported whether or not the response
        exposes any header."""
        out: dict[str, Any] = {}
        if self._platform:
            out["platform"] = self._platform
        try:
            obj = response
            with contextlib.suppress(Exception):
                if hasattr(obj, "parse") and callable(obj.parse):
                    obj = obj.parse()
            headers: Any = None
            for attr in ("headers", "_headers", "response_headers"):
                headers = getattr(response, attr, None) or getattr(obj, attr, None)
                if headers:
                    break
            getter = getattr(headers, "get", None) if headers else None
            if not callable(getter):
                return out or None
            mapping = {
                "anthropic-ratelimit-tokens-remaining": "ratelimit_remaining_tokens",
                "anthropic-ratelimit-requests-remaining": "ratelimit_remaining_requests",
                "anthropic-ratelimit-tokens-limit": "ratelimit_limit_tokens",
                "request-id": "request_id",
                "x-request-id": "request_id",
            }
            for src, dst in mapping.items():
                val = getter(src)
                if val is None:
                    continue
                if dst.endswith(("_tokens", "_requests")):
                    try:
                        out[dst] = int(val)
                    except (ValueError, TypeError):
                        out[dst] = val
                else:
                    out[dst] = val
        except Exception:
            _log.debug("extract_response_metadata failed", exc_info=True)
        return out or None

    def extract_output_dimensions(self, response: Any) -> dict[str, int] | None:
        """Anthropic has no native embeddings API; return None."""
        return None

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from an Anthropic response.

        Handles both sync ``Message`` objects and raw response wrappers.
        Returns ``TokenUsage(0, 0)`` on any failure -- never raises.

        Cache tokens (``cache_read_input_tokens`` and
        ``cache_creation_input_tokens``) are included in the ``input_tokens``
        total so policy/budget arithmetic sees every billed input token, AND
        also reported as separate ``cache_read_tokens`` /
        ``cache_creation_tokens`` fields on :class:`TokenUsage` so cache
        economics are visible in analytics.
        """
        try:
            obj = response
            # Handle raw response wrappers
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()

            usage = getattr(obj, "usage", None)
            if usage is None:
                return TokenUsage()

            input_tokens = getattr(usage, "input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0
            cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
            cache_creation = getattr(usage, "cache_creation_input_tokens", 0) or 0

            return TokenUsage(
                input_tokens=input_tokens + cache_read + cache_creation,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read,
                cache_creation_tokens=cache_creation,
                reasoning_tokens=_thinking_tokens(usage),
                cache_creation_1h_tokens=_cache_creation_1h(usage),
            )
        except Exception:
            return TokenUsage()

    def usage_from_stream_chunk(self, chunk: Any) -> TokenUsage | None:
        """Usage carried by a streamed Anthropic event.

        ``message_start`` carries the input and cache counts (plus the
        first output token); every ``message_delta`` carries the
        cumulative output count and, on newer API versions, cumulative
        input counts. Both the raw ``Stream[RawMessageStreamEvent]`` and
        the ``messages.stream()`` helper yield these event types.
        """
        try:
            kind = getattr(chunk, "type", None)
            if kind == _EVENT_MESSAGE_START:
                usage = getattr(getattr(chunk, "message", None), "usage", None)
            elif kind == _EVENT_MESSAGE_DELTA:
                usage = getattr(chunk, "usage", None)
            else:
                return None
            if usage is None:
                return None
            output_tokens = getattr(usage, "output_tokens", None) or 0
            cache_read = getattr(usage, "cache_read_input_tokens", None)
            cache_creation = getattr(usage, "cache_creation_input_tokens", None)
            input_tokens = getattr(usage, "input_tokens", None)
            reasoning = _thinking_tokens(usage)
            if kind == _EVENT_MESSAGE_DELTA and (cache_read is None or cache_creation is None):
                # A delta that reports input_tokens without the cache
                # fields must not replace the message_start total, which
                # includes the cache reads; report the output count only.
                return TokenUsage(
                    input_tokens=0, output_tokens=output_tokens, reasoning_tokens=reasoning
                )
            return TokenUsage(
                input_tokens=(input_tokens or 0) + (cache_read or 0) + (cache_creation or 0),
                output_tokens=output_tokens,
                cache_read_tokens=cache_read or 0,
                cache_creation_tokens=cache_creation or 0,
                reasoning_tokens=reasoning,
                cache_creation_1h_tokens=_cache_creation_1h(usage),
            )
        except Exception:
            return None

    def call_details(self, response: Any) -> CallDetails | None:
        """Served model, service tier, speed, data residency and server-tool
        counters from a ``Message`` (or a raw wrapper around one)."""
        try:
            obj = response
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()
            return _details(getattr(obj, "model", None), getattr(obj, "usage", None))
        except Exception:
            return None

    def call_details_from_stream_chunk(self, chunk: Any) -> CallDetails | None:
        """``message_start`` names the served model and carries the usage
        object with tier, speed and residency; every ``message_delta``
        carries the cumulative usage, server-tool counters included."""
        try:
            kind = getattr(chunk, "type", None)
            if kind == _EVENT_MESSAGE_START:
                message = getattr(chunk, "message", None)
                return _details(getattr(message, "model", None), getattr(message, "usage", None))
            if kind == _EVENT_MESSAGE_DELTA:
                return _details(None, getattr(chunk, "usage", None))
            return None
        except Exception:
            return None

    @staticmethod
    def _snapshot(stream: Any) -> Any | None:
        """The helper stream's accumulated message snapshot, or ``None``
        for raw streams and before the first event (the SDK raises when
        the property is read before ``message_start``)."""
        try:
            return getattr(stream, "current_message_snapshot", None)
        except Exception:
            return None

    def usage_from_finished_stream(self, stream: Any) -> TokenUsage | None:
        """Usage accumulated on the helper stream's
        ``current_message_snapshot`` (sync and async alike). The SDK
        updates it as events arrive, so it is correct on early exit too and
        reading it never touches the network."""
        try:
            snapshot = self._snapshot(stream)
            if snapshot is None:
                return None
            usage = self.extract_usage(snapshot)
            return usage if usage.total > 0 else None
        except Exception:
            return None

    def stream_completed(self, stream: Any) -> bool | None:
        """True once the helper snapshot carries ``stop_reason`` (set by
        ``message_delta``); ``None`` for raw streams."""
        try:
            snapshot = self._snapshot(stream)
            if snapshot is None:
                return None
            return getattr(snapshot, "stop_reason", None) is not None
        except Exception:
            return None

    def final_message(self, stream: Any) -> Any | None:
        """The complete message of a helper stream, or ``None`` while it is
        still open. Once ``stop_reason`` is set the accumulated snapshot is
        the full message (content blocks are finalised before
        ``message_delta`` arrives), so it stands in for
        ``get_final_message()``, which would still read the trailing
        ``message_stop`` frame. Sync and async helpers alike."""
        try:
            if not self.stream_completed(stream):
                return None
            return self._snapshot(stream)
        except Exception:
            return None

    def text_from_stream_chunk(self, chunk: Any) -> str | None:
        """Text of a ``content_block_delta`` / ``text_delta`` event, else
        ``None``."""
        if getattr(chunk, "type", None) != _EVENT_CONTENT_BLOCK_DELTA:
            return None
        delta = getattr(chunk, "delta", None)
        if getattr(delta, "type", None) != _DELTA_TEXT:
            return None
        text = getattr(delta, "text", None)
        return text if isinstance(text, str) else None

    def chunk_completes_stream(self, chunk: Any) -> bool:
        """``message_stop``, or a ``message_delta`` carrying ``stop_reason``:
        after either the response is complete and only ``message_stop``
        can follow."""
        kind = getattr(chunk, "type", None)
        if kind == _EVENT_MESSAGE_STOP:
            return True
        if kind == _EVENT_MESSAGE_DELTA:
            return getattr(getattr(chunk, "delta", None), "stop_reason", None) is not None
        return False

    def response_stop_reason(self, response: Any) -> str | None:
        """``stop_reason`` of a complete response: a ``Message``, a
        raw-response wrapper (parsed first), or a helper stream whose
        accumulated snapshot carries it. ``None`` for a raw stream object
        and whenever the field is missing or not a string."""
        try:
            obj = response
            with contextlib.suppress(Exception):
                if hasattr(obj, "parse") and callable(obj.parse):
                    obj = obj.parse()
            snapshot = self._snapshot(obj)
            if snapshot is not None:
                obj = snapshot
            reason = getattr(obj, "stop_reason", None)
            return reason if isinstance(reason, str) else None
        except Exception:
            return None

    def stop_reason_from_stream_chunk(self, chunk: Any) -> str | None:
        """``stop_reason`` carried by a ``message_delta`` event, which is
        where a raw stream announces how the response ended; ``None`` for
        every other event."""
        try:
            if getattr(chunk, "type", None) != _EVENT_MESSAGE_DELTA:
                return None
            reason = getattr(getattr(chunk, "delta", None), "stop_reason", None)
            return reason if isinstance(reason, str) else None
        except Exception:
            return None

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: Any = None,
    ) -> PromptContent | None:
        """Extract full prompt payload for storage.

        Returns ``None`` when capture_prompts is False. Never raises.
        Preserves Anthropic terminology: ``system`` as a separate field.

        ``event_type`` is accepted for protocol symmetry with the
        OpenAI / litellm providers (per-event-type content
        extraction). Anthropic has no native embeddings API
        in this SDK -- users go via litellm → Voyage. So no
        EMBEDDINGS branch here; if a caller ever passes that
        event_type the chat-shaped extraction runs and ``messages``
        will be empty, which the dashboard's
        ``EmbeddingsContentViewer`` handles via the has_content=false
        branch.
        """
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime

            # A helper stream (``MessageStream`` / ``AsyncMessageStream``)
            # reaching this point was still open when the call settled:
            # the guard hands over the helper's final message once the
            # message is complete. Capture the helper's accumulated
            # snapshot instead, which never reads further from the
            # network; ``get_final_message()`` would drain the rest of
            # the stream and defeat the caller's early exit. The snapshot
            # is also the only JSON-safe shape here, because the stream
            # object's ``__dict__`` carries httpx state.
            snapshot = self._snapshot(response)
            if snapshot is not None:
                response = snapshot
            resp_dict: dict[str, Any] = {}
            if hasattr(response, "model_dump"):
                # ``warnings=False``: a structured-output ``ParsedMessage``
                # carries ``ParsedTextBlock`` content under the SDK's
                # content-block union, which pydantic's serializer flags
                # with UserWarnings in the caller's process; the dump is
                # fine for storage, so keep the caller's warning stream
                # clean. Objects whose model_dump takes no such argument
                # get the plain call.
                try:
                    resp_dict = response.model_dump(warnings=False)
                except TypeError:
                    resp_dict = response.model_dump()
            elif hasattr(response, "__dict__"):
                # Last-resort fallback: prune attributes whose values
                # are not JSON-serialisable so the wire payload stays
                # valid even on exotic response shapes.
                import json

                resp_dict = {}
                for k, v in dict(response.__dict__).items():
                    try:
                        json.dumps(v)
                    except (TypeError, ValueError):
                        continue
                    resp_dict[k] = v
            else:
                resp_dict = {"raw": str(response)}

            return PromptContent(
                system=request_kwargs.get("system"),
                messages=request_kwargs.get("messages", []),
                tools=request_kwargs.get("tools"),
                response=resp_dict,
                provider="anthropic",
                model=request_kwargs.get("model", ""),
                session_id="",  # Filled by caller
                event_id="",  # Filled by caller
                captured_at=datetime.now(UTC).isoformat(),
            )
        except Exception:
            _log.debug("extract_content failed", exc_info=True)
            return None

    def get_model(self, request_kwargs: dict[str, Any]) -> str:
        """Extract the model name from request kwargs."""
        try:
            model: str = request_kwargs["model"]
            return model
        except (KeyError, TypeError):
            return ""

    def extract_tool_invocations(self, response: Any) -> list[ToolInvocation]:
        """Parse Anthropic ``tool_use`` blocks from the response content.

        Anthropic returns a list of content blocks; tool invocations
        have ``type='tool_use'`` with ``name`` and ``input`` fields.
        Supports both sync ``Message`` objects (pydantic) and raw
        response wrappers via ``.parse()``. Returns an empty list on
        any failure. Never raises.
        """
        try:
            obj = response
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()

            content = getattr(obj, "content", None)
            if not content:
                return []

            invocations: list[ToolInvocation] = []
            for block in content:
                block_type = getattr(block, "type", None) or (
                    block.get("type") if isinstance(block, dict) else None
                )
                if block_type != "tool_use":
                    continue
                name = getattr(block, "name", None) or (
                    block.get("name") if isinstance(block, dict) else None
                )
                tool_input = getattr(block, "input", None) or (
                    block.get("input") if isinstance(block, dict) else None
                )
                tool_id = getattr(block, "id", None) or (
                    block.get("id") if isinstance(block, dict) else None
                )
                if not name:
                    continue
                invocations.append(
                    ToolInvocation(
                        name=str(name),
                        tool_input=dict(tool_input) if isinstance(tool_input, dict) else {},
                        tool_id=str(tool_id) if tool_id else None,
                    )
                )
            return invocations
        except Exception:
            _log.debug("extract_tool_invocations failed", exc_info=True)
            return []


def _count(value: Any) -> int | None:
    """A token or request count as reported, or ``None`` when the field
    is missing or not an integer (a MagicMock attribute, a string)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _thinking_tokens(usage: Any) -> int | None:
    """The thinking share of the output (``output_tokens_details
    .thinking_tokens``), or ``None`` when the response reports none."""
    return _count(getattr(getattr(usage, "output_tokens_details", None), "thinking_tokens", None))


def _cache_creation_1h(usage: Any) -> int | None:
    """The one-hour share of the cache writes (``cache_creation
    .ephemeral_1h_input_tokens``), or ``None`` when not reported."""
    return _count(
        getattr(getattr(usage, "cache_creation", None), "ephemeral_1h_input_tokens", None)
    )


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _details(model: Any, usage: Any) -> CallDetails | None:
    """The call details a message's model id and usage object carry, or
    ``None`` when they carry none."""
    tools: dict[str, int] = {}
    server_tool_use = getattr(usage, "server_tool_use", None) if usage is not None else None
    for field in ("web_search_requests", "web_fetch_requests"):
        count = _count(getattr(server_tool_use, field, None))
        if count:
            tools[field] = count
    details = CallDetails(
        model_served=_text(model),
        service_tier=_text(getattr(usage, "service_tier", None)),
        speed=_text(getattr(usage, "speed", None)),
        inference_geo=_text(getattr(usage, "inference_geo", None)),
        server_tool_use=tools or None,
    )
    return None if details == CallDetails() else details
