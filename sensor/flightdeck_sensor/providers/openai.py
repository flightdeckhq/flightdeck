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

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> int:
        """Estimate input tokens using tiktoken if available, else char//4.

        tiktoken gives accurate counts for OpenAI models.  The character
        heuristic is a conservative fallback.
        """
        try:
            messages = request_kwargs.get("messages", [])
            model = request_kwargs.get("model", "")

            # Try tiktoken first
            count = _try_tiktoken_count(messages, model)
            if count is not None:
                return count

            # Fallback: character-based heuristic
            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE
        except Exception:
            return 0

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
                # Embedding response is an opaque vector array; per
                # the Phase 4 polish V-pass decision, response stays
                # an empty dict because vectors aren't useful in a
                # "what did the model see" content panel and would
                # bloat event_content rows. Token accounting lives
                # on the event row's ``tokens_input`` field; no
                # duplication needed.
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
