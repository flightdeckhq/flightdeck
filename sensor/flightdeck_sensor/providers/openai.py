"""OpenAI provider: token estimation and usage extraction.

Reimplements the patterns from tokencap -- this is a standalone
implementation with no dependency on tokencap.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from flightdeck_sensor.core.types import TokenUsage
from flightdeck_sensor.providers.protocol import PromptContent, ToolInvocation

_log = logging.getLogger("flightdeck_sensor.providers.openai")

_TOKENS_PER_MESSAGE = 4
_TOKENS_REPLY_PRIMING = 2
_CHARS_PER_TOKEN_ESTIMATE = 4


def _try_tiktoken_count(messages: list[Any], model: str) -> int | None:
    """Attempt to count tokens using tiktoken if installed.

    Returns ``None`` if tiktoken is unavailable or fails.
    """
    try:
        import tiktoken

        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("cl100k_base")

        total = 0
        for msg in messages:
            # Per-message overhead (role, content separators)
            total += _TOKENS_PER_MESSAGE
            if isinstance(msg, dict):
                for value in msg.values():
                    total += len(enc.encode(str(value)))
        total += _TOKENS_REPLY_PRIMING  # reply priming
        return total
    except Exception:
        return None


class OpenAIProvider:
    """Provider adapter for the OpenAI Python SDK.

    All methods are safe to call on the hot path.  None of them raise
    exceptions -- failures return zero/empty defaults.
    """

    def __init__(self, capture_prompts: bool = False) -> None:
        self._capture_prompts = capture_prompts

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> tuple[int, str]:
        """Estimate input tokens; returns ``(count, source)``.

        Source is ``"tiktoken"`` for the tokeniser path, ``"heuristic"``
        for the char/4 fallback, or ``"none"`` when extraction fails.
        """
        try:
            messages = request_kwargs.get("messages", [])
            model = request_kwargs.get("model", "")

            count = _try_tiktoken_count(messages, model)
            if count is not None:
                return count, "tiktoken"

            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE, "heuristic"
        except Exception:
            return 0, "none"

    def extract_response_metadata(self, response: Any) -> dict[str, Any] | None:
        """Pull rate-limit headers + processing-ms from raw-response paths.

        OpenAI surfaces these on ``response.headers`` for raw-response
        wrappers (``with_raw_response``); the parsed-response path may
        not. Best-effort: returns ``None`` when nothing useful is
        reachable.
        """
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
            if not headers:
                return None
            getter = getattr(headers, "get", None)
            if not callable(getter):
                return None
            mapping = {
                "x-ratelimit-remaining-tokens": "ratelimit_remaining_tokens",
                "x-ratelimit-remaining-requests": "ratelimit_remaining_requests",
                "x-ratelimit-limit-tokens": "ratelimit_limit_tokens",
                "openai-processing-ms": "processing_ms",
                "x-request-id": "request_id",
            }
            out: dict[str, Any] = {}
            for src, dst in mapping.items():
                val = getter(src)
                if val is None:
                    continue
                if dst.endswith(("_tokens", "_requests", "_ms")):
                    try:
                        out[dst] = int(val)
                    except (ValueError, TypeError):
                        out[dst] = val
                else:
                    out[dst] = val
            return out or None
        except Exception:
            return None

    def extract_output_dimensions(self, response: Any) -> dict[str, int] | None:
        """For embeddings.create() responses: return ``{count, dimension}``."""
        try:
            obj = response
            with contextlib.suppress(Exception):
                if hasattr(obj, "parse") and callable(obj.parse):
                    obj = obj.parse()
            data = getattr(obj, "data", None) or (
                obj.get("data") if isinstance(obj, dict) else None
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
        """Extract actual token counts from an OpenAI response.

        Handles three response shapes:

        * Chat completions -- ``usage.prompt_tokens`` /
          ``usage.completion_tokens``.
        * Responses API (``client.responses.create``) --
          ``usage.input_tokens`` / ``usage.output_tokens``. This is the
          new OpenAI API introduced in March 2025 and the recommended
          path for all new projects.
        * Embeddings (``client.embeddings.create``) --
          ``usage.prompt_tokens`` only (no completion counterpart);
          the chat path is re-used and returns ``(prompt_tokens, 0)``,
          which is semantically correct -- embeddings produce vectors,
          not output text.

        Chat-shape fields are read first so the hot path for
        ``chat.completions.create`` stays unchanged. The Responses API
        fields are only consulted when the chat fields are absent.
        Returns ``TokenUsage(0, 0)`` on any failure -- never raises.
        """
        try:
            obj = response
            # Handle raw response wrappers
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()

            usage = getattr(obj, "usage", None)
            if usage is None:
                return TokenUsage(input_tokens=0, output_tokens=0)

            prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "completion_tokens", 0) or 0

            # Responses API fallback: its usage object uses
            # input_tokens / output_tokens rather than
            # prompt_tokens / completion_tokens. Only consult these
            # when the chat fields were absent so a chat.completions
            # response with a zero prompt_tokens (unlikely but
            # possible) is never silently overwritten.
            if prompt_tokens == 0 and completion_tokens == 0:
                input_tokens = getattr(usage, "input_tokens", 0) or 0
                output_tokens = getattr(usage, "output_tokens", 0) or 0
                if input_tokens or output_tokens:
                    return TokenUsage(
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                    )

            return TokenUsage(
                input_tokens=prompt_tokens,
                output_tokens=completion_tokens,
            )
        except Exception:
            return TokenUsage(input_tokens=0, output_tokens=0)

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: Any = None,
    ) -> PromptContent | None:
        """Extract full prompt payload for storage.

        Returns ``None`` when capture_prompts is False. Never raises.
        OpenAI has no separate system field -- system role is in messages.

        Phase 4 polish: when ``event_type == EventType.EMBEDDINGS``
        the request shape is ``{"input": <str | list[str]>, "model":
        ...}`` -- there are no messages, system, tools, or generated
        response content (the response is just an array of vectors,
        which is opaque to operators and not stored). The captured
        ``PromptContent`` carries the input string/list under
        ``input`` and leaves the chat slots empty so the dashboard's
        ``EmbeddingsContentViewer`` can render it distinctly from a
        chat prompt.
        """
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime, timezone

            # Lazy import keeps the typing TYPE_CHECKING contract on
            # ``Provider.extract_content`` honest while letting the
            # runtime branch on the enum value.
            from flightdeck_sensor.core.types import EventType

            now_iso = datetime.now(timezone.utc).isoformat()
            model = request_kwargs.get("model", "")

            if event_type == EventType.EMBEDDINGS:
                # Capture both the input string/list and the raw
                # vectors. ``capture_prompts`` is the single gate;
                # operators get parity between "what did the model
                # see" (input) and "what did it return" (vectors).
                # The events.payload.output_dimensions field carries
                # the {count, dimension} summary so the dashboard can
                # render the shape chip without fetching this body.
                vectors: list[list[float]] | None = None
                try:
                    obj = response
                    with contextlib.suppress(Exception):
                        if hasattr(obj, "parse") and callable(obj.parse):
                            obj = obj.parse()
                    data = getattr(obj, "data", None) or (
                        obj.get("data") if isinstance(obj, dict) else None
                    )
                    if data:
                        vectors = []
                        for entry in data:
                            emb = getattr(entry, "embedding", None) or (
                                entry.get("embedding")
                                if isinstance(entry, dict)
                                else None
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
                    provider="openai",
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
                # Streaming responses surface a ``Stream`` /
                # ``AsyncStream`` whose ``__dict__`` carries the
                # underlying httpx response + async generator —
                # neither JSON-serialisable. Phase 4 polish: drop
                # any field that fails ``json.dumps`` so the wire
                # payload stays valid for stream calls. Pre-fix
                # the post_call drain rejected streams with
                # ``Object of type AsyncStream is not JSON
                # serializable`` (caught by Rule 40d smoke).
                import json as _json
                resp_dict = {}
                for k, v in dict(response.__dict__).items():
                    try:
                        _json.dumps(v)
                    except (TypeError, ValueError):
                        continue
                    resp_dict[k] = v
            else:
                resp_dict = {"raw": str(response)}

            return PromptContent(
                system=None,  # OpenAI embeds system in messages
                messages=request_kwargs.get("messages", []),
                tools=request_kwargs.get("tools"),
                response=resp_dict,
                provider="openai",
                model=model,
                session_id="",  # Filled by caller
                event_id="",  # Filled by caller
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
        """Parse OpenAI ``tool_calls`` from the response.

        Chat completions: ``response.choices[0].message.tool_calls``
        where each entry has ``type='function'`` and
        ``function.name`` / ``function.arguments`` (JSON string).
        Returns an empty list on any failure. Never raises.
        """
        try:
            import json as _json

            obj = response
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()

            choices = getattr(obj, "choices", None)
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
