"""Litellm provider: token estimation and usage extraction.

litellm (https://github.com/BerriAI/litellm) routes calls to many
underlying providers via a single ``completion()`` / ``acompletion()``
entry point and returns a ``ModelResponse`` whose shape mirrors the
OpenAI chat-completion schema. This adapter extracts model, usage, and
tool invocations from that shape.

It is deliberately NOT a subclass of :class:`OpenAIProvider` even
though the wire formats are nearly identical -- the whole point of the
litellm interceptor is that litellm-routed calls have distinct
interception semantics
(different entry point, different underlying transports), so keeping
the adapter separate makes the boundary explicit for future readers.

All methods are safe to call on the hot path. None raise -- failures
return zero/empty defaults. See :class:`AnthropicProvider` /
:class:`OpenAIProvider` for the protocol and error-handling pattern.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from flightdeck_sensor.core.types import TokenUsage
from flightdeck_sensor.providers.protocol import PromptContent, ToolInvocation

_log = logging.getLogger("flightdeck_sensor.providers.litellm")

_CHARS_PER_TOKEN_ESTIMATE = 4


def _assembled_response(stream: Any) -> dict[str, Any] | None:
    """``litellm.stream_chunk_builder`` over the chunks the wrapper kept,
    dumped to a plain dict with ``usage`` included; ``None`` when there
    are no chunks or the builder raises."""
    chunks = getattr(stream, "chunks", None)
    if not isinstance(chunks, list) or not chunks:
        return None
    try:
        import litellm as _litellm

        built = _litellm.stream_chunk_builder(chunks)
        if built is None or not hasattr(built, "model_dump"):
            return None
        dumped: dict[str, Any] = built.model_dump()
        usage = getattr(built, "usage", None)
        if "usage" not in dumped and usage is not None and hasattr(usage, "model_dump"):
            dumped["usage"] = usage.model_dump()
        return dumped
    except Exception:
        _log.debug("stream_chunk_builder failed; storing the assembled text", exc_info=True)
        return None


def _stream_text(stream: Any) -> str | None:
    """The response text of a streamed call, assembled from the chunks
    litellm's wrapper keeps (``chunks``), or ``None`` when it kept none.
    Text deltas only; streamed tool calls are not assembled."""
    chunks = getattr(stream, "chunks", None)
    if not isinstance(chunks, list):
        return None
    pieces: list[str] = []
    for chunk in chunks:
        for choice in getattr(chunk, "choices", None) or []:
            delta = getattr(choice, "delta", None)
            content = getattr(delta, "content", None) if delta is not None else None
            if isinstance(content, str):
                pieces.append(content)
    return "".join(pieces) if pieces else None


def _stream_response_summary(stream: Any) -> dict[str, Any]:
    """What a streamed call stores as its captured ``response``: the
    response litellm's own ``stream_chunk_builder`` assembles from the
    chunks the wrapper kept (the assistant message, ``model`` and
    ``usage``, the shape a non-streamed litellm response has), or, when
    the builder cannot be used, the id, model, finish reason and the
    text assembled here.

    Never the wrapper's ``__dict__``: that carries the request's messages
    a second time, ``_hidden_params`` (the caller's ``api_base``
    verbatim, so a userinfo password or a query token), the provider's
    response headers (``Set-Cookie``, organisation and project headers),
    ``stream_options``, the logging object and the SDK stream. A denylist
    would leak whatever a litellm upgrade adds, so only the assembled
    response is read."""
    built = _assembled_response(stream)
    if built is not None:
        return built
    finish_reason = getattr(stream, "received_finish_reason", None)
    summary: dict[str, Any] = {
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": _stream_text(stream)},
                "finish_reason": finish_reason if isinstance(finish_reason, str) else None,
            }
        ]
    }
    response_id = getattr(stream, "response_id", None)
    if isinstance(response_id, str):
        summary["id"] = response_id
    model = getattr(stream, "model", None)
    if isinstance(model, str):
        summary["model"] = model
    return summary


def _count(value: Any) -> int | None:
    """A provider-supplied counter, or ``None`` when it is not a real
    integer (absent, ``None``, a bool, or some object standing in for the
    usage): the sensor never guesses a cache count."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _cache_breakdown(usage: Any) -> tuple[int, int]:
    """``(cache_read, cache_creation)`` from a litellm ``Usage``: the
    ``prompt_tokens_details`` wrapper first, then the Anthropic-named
    attributes litellm sets on older shapes. Zeros when absent."""
    details = getattr(usage, "prompt_tokens_details", None)
    cache_read = _count(getattr(details, "cached_tokens", None))
    cache_creation = _count(getattr(details, "cache_creation_tokens", None))
    if cache_read is None:
        cache_read = _count(getattr(usage, "cache_read_input_tokens", None))
    if cache_creation is None:
        cache_creation = _count(getattr(usage, "cache_creation_input_tokens", None))
    return cache_read or 0, cache_creation or 0


class LitellmProvider:
    """Provider adapter for litellm's completion / acompletion surface.

    Response shape is OpenAI-compatible (``.usage.prompt_tokens`` /
    ``.usage.completion_tokens`` / ``.choices[0].message.tool_calls``),
    so extraction mirrors :class:`OpenAIProvider`. Token estimation
    delegates to ``litellm.token_counter()`` which is model-aware
    across every provider litellm supports, with a char heuristic
    fallback when the call fails.
    """

    def __init__(self, capture_prompts: bool = False) -> None:
        self._capture_prompts = capture_prompts

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> tuple[int, str]:
        """Estimate input tokens; returns ``(count, source)``.

        litellm.token_counter is model-aware across every provider it
        supports. Source is ``"tiktoken"`` for that path, ``"heuristic"``
        for the char/4 fallback, or ``"none"`` when extraction fails.
        """
        try:
            import litellm as _litellm

            messages = request_kwargs.get("messages", [])
            model = request_kwargs.get("model", "")
            count: int = _litellm.token_counter(model=model, messages=messages)
            return count, "tiktoken"
        except Exception:
            _log.debug(
                "litellm.token_counter failed, falling back to char heuristic",
                exc_info=True,
            )

        try:
            messages = request_kwargs.get("messages", [])
            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE, "heuristic"
        except Exception:
            return 0, "none"

    def extract_response_metadata(self, response: Any) -> dict[str, Any] | None:
        """litellm normalises away most provider-specific headers; expose
        what is reachable on the ModelResponse object."""
        try:
            request_id = getattr(response, "id", None) or getattr(
                response,
                "_request_id",
                None,
            )
            model = getattr(response, "model", None)
            out: dict[str, Any] = {}
            if request_id:
                out["request_id"] = str(request_id)
            if model:
                out["model_info"] = str(model)
            return out or None
        except Exception:
            return None

    def extract_output_dimensions(self, response: Any) -> dict[str, int] | None:
        """For litellm.embedding() responses: return ``{count, dimension}``.

        Shape mirrors OpenAI: ``response.data[i].embedding``.
        """
        try:
            data = getattr(response, "data", None) or (
                response.get("data") if isinstance(response, dict) else None
            )
            if not data:
                return None
            count = len(data)
            first = data[0]
            embedding = getattr(first, "embedding", None) or (
                first.get("embedding") if isinstance(first, dict) else None
            )
            if not embedding:
                return None
            return {"count": count, "dimension": len(embedding)}
        except Exception:
            return None

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract token counts from a litellm ``ModelResponse``.

        ``response.usage.prompt_tokens`` / ``completion_tokens`` match
        the OpenAI chat-completion shape regardless of the underlying
        provider litellm routed the call to, and ``prompt_tokens``
        already includes any cached or cache-written tokens (litellm sums
        Anthropic's three input counters into it). The cache breakdown
        litellm exposes under ``usage.prompt_tokens_details``
        (``cached_tokens``, ``cache_creation_tokens``), or as the
        Anthropic-named ``cache_read_input_tokens`` /
        ``cache_creation_input_tokens`` attributes on older shapes, is
        surfaced on the separate cache fields without being added to
        the input sum again. Returns ``TokenUsage(0, 0)`` on any failure
        -- never raises.
        """
        try:
            usage = getattr(response, "usage", None)
            if usage is None:
                return TokenUsage(input_tokens=0, output_tokens=0)
            prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "completion_tokens", 0) or 0
            cache_read, cache_creation = _cache_breakdown(usage)
            return TokenUsage(
                input_tokens=prompt_tokens,
                output_tokens=completion_tokens,
                cache_read_tokens=cache_read,
                cache_creation_tokens=cache_creation,
            )
        except Exception:
            return TokenUsage(input_tokens=0, output_tokens=0)

    def usage_from_stream_chunk(self, chunk: Any) -> TokenUsage | None:
        """Usage on litellm's trailing streaming chunk (present when the
        request asked for ``stream_options.include_usage``, which the
        litellm interceptor always does); same fields as a response."""
        try:
            if getattr(chunk, "usage", None) is None:
                return None
            result = self.extract_usage(chunk)
            return result if result.total > 0 else None
        except Exception:
            return None

    def usage_from_finished_stream(self, stream: Any) -> TokenUsage | None:
        """litellm stream wrappers report nothing after the fact."""
        return None

    def stream_completed(self, stream: Any) -> bool | None:
        """litellm stream wrappers do not track completion."""
        return None

    def final_message(self, stream: Any) -> Any | None:
        """litellm stream wrappers assemble no final message."""
        return None

    def text_from_stream_chunk(self, chunk: Any) -> str | None:
        """litellm stream wrappers have no ``text_stream``."""
        return None

    def chunk_completes_stream(self, chunk: Any) -> bool:
        """A chunk carrying ``usage``, the last one (litellm mirrors the
        OpenAI chat chunk shape, where the usage chunk follows the
        ``finish_reason`` chunk)."""
        try:
            return getattr(chunk, "usage", None) is not None
        except Exception:
            return False

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: Any = None,
    ) -> PromptContent | None:
        """Extract full prompt payload for storage.

        Returns ``None`` when ``capture_prompts`` is False. litellm has
        no separate system field -- system role (when present) is in
        the messages list, same as OpenAI. Never raises.

        When ``event_type == EventType.EMBEDDINGS``
        the request is ``litellm.embedding(model=..., input=<str |
        list[str]>)``; capture the input parameter into
        ``PromptContent.input`` and leave the chat-shaped slots
        empty. Mirrors the OpenAI provider's embeddings branch --
        the dashboard renders both via ``EmbeddingsContentViewer``.
        """
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime, timezone

            from flightdeck_sensor.core.types import EventType

            now_iso = datetime.now(timezone.utc).isoformat()
            model = request_kwargs.get("model", "")

            if event_type == EventType.EMBEDDINGS:
                vectors: list[list[float]] | None = None
                try:
                    data = getattr(response, "data", None) or (
                        response.get("data") if isinstance(response, dict) else None
                    )
                    if data:
                        vectors = []
                        for entry in data:
                            emb = getattr(entry, "embedding", None) or (
                                entry.get("embedding") if isinstance(entry, dict) else None
                            )
                            if emb is not None:
                                vectors.append(list(emb))
                except Exception:
                    vectors = None
                return PromptContent(
                    system=None,
                    messages=[],
                    tools=None,
                    response={},
                    provider="litellm",
                    model=model,
                    session_id="",
                    event_id="",
                    captured_at=now_iso,
                    input=request_kwargs.get("input"),
                    embedding_output=vectors,
                )

            resp_dict: dict[str, Any] = {}
            if hasattr(response, "model_dump"):
                resp_dict = response.model_dump()
            elif hasattr(response, "__dict__"):
                # A streamed call settles with litellm's
                # ``CustomStreamWrapper`` as the response. Only the
                # allowlisted response fields are stored (see
                # _stream_response_summary); the wrapper's own state is
                # never dumped.
                resp_dict = _stream_response_summary(response)
            else:
                resp_dict = {"raw": str(response)}

            return PromptContent(
                system=None,
                messages=request_kwargs.get("messages", []),
                tools=request_kwargs.get("tools"),
                response=resp_dict,
                provider="litellm",
                model=model,
                session_id="",
                event_id="",
                captured_at=now_iso,
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
        """Parse tool_calls from a litellm ``ModelResponse``.

        litellm normalises every underlying provider's tool-call shape
        into OpenAI's ``choices[0].message.tool_calls`` format, each
        entry with ``function.name`` + ``function.arguments`` (JSON
        string). Returns an empty list on any failure. Never raises.
        """
        try:
            import json as _json

            choices = getattr(response, "choices", None)
            if not choices:
                return []
            first = choices[0]
            message = getattr(first, "message", None) or (
                first.get("message") if isinstance(first, dict) else None
            )
            if message is None:
                return []
            tool_calls = getattr(message, "tool_calls", None) or (
                message.get("tool_calls") if isinstance(message, dict) else None
            )
            if not tool_calls:
                return []

            invocations: list[ToolInvocation] = []
            for tc in tool_calls:
                fn = getattr(tc, "function", None) or (
                    tc.get("function") if isinstance(tc, dict) else None
                )
                if fn is None:
                    continue
                name = getattr(fn, "name", None) or (
                    fn.get("name") if isinstance(fn, dict) else None
                )
                args_raw = getattr(fn, "arguments", None) or (
                    fn.get("arguments") if isinstance(fn, dict) else None
                )
                tool_id = getattr(tc, "id", None) or (
                    tc.get("id") if isinstance(tc, dict) else None
                )
                if not name:
                    continue
                parsed_input: dict[str, Any] = {}
                if isinstance(args_raw, dict):
                    parsed_input = args_raw
                elif isinstance(args_raw, str) and args_raw:
                    with contextlib.suppress(Exception):
                        decoded = _json.loads(args_raw)
                        if isinstance(decoded, dict):
                            parsed_input = decoded
                invocations.append(
                    ToolInvocation(
                        name=str(name),
                        tool_input=parsed_input,
                        tool_id=str(tool_id) if tool_id else None,
                    )
                )
            return invocations
        except Exception:
            _log.debug("extract_tool_invocations failed", exc_info=True)
            return []
