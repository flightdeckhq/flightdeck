"""Litellm provider: token estimation and usage extraction.

litellm (https://github.com/BerriAI/litellm) routes calls to many
underlying providers via a single ``completion()`` / ``acompletion()``
entry point and returns a ``ModelResponse`` whose shape mirrors the
OpenAI chat-completion schema. This adapter extracts model, usage, and
tool invocations from that shape.

It is deliberately NOT a subclass of :class:`OpenAIProvider` even
though the wire formats are nearly identical -- KI21's whole point is
that litellm-routed calls have distinct interception semantics
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

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> int:
        """Estimate input tokens using ``litellm.token_counter`` if
        available, else a char/4 heuristic.

        litellm.token_counter is model-aware and routes to the right
        tokenizer for every provider it knows about (Anthropic's
        claude-*, OpenAI's gpt-*, Google gemini-*, etc.), which is
        exactly the multi-provider surface we need.
        """
        try:
            import litellm as _litellm

            messages = request_kwargs.get("messages", [])
            model = request_kwargs.get("model", "")
            count: int = _litellm.token_counter(model=model, messages=messages)
            return count
        except Exception:
            _log.debug(
                "litellm.token_counter failed, falling back to char heuristic",
                exc_info=True,
            )

        try:
            messages = request_kwargs.get("messages", [])
            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE
        except Exception:
            return 0

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract token counts from a litellm ``ModelResponse``.

        ``response.usage.prompt_tokens`` / ``completion_tokens`` match
        the OpenAI chat-completion shape regardless of the underlying
        provider litellm routed the call to. Returns ``TokenUsage(0, 0)``
        on any failure -- never raises.
        """
        try:
            usage = getattr(response, "usage", None)
            if usage is None:
                return TokenUsage(input_tokens=0, output_tokens=0)
            prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "completion_tokens", 0) or 0
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

        Returns ``None`` when ``capture_prompts`` is False. litellm has
        no separate system field -- system role (when present) is in
        the messages list, same as OpenAI. Never raises.

        Phase 4 polish: when ``event_type == EventType.EMBEDDINGS``
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
                )

            resp_dict: dict[str, Any] = {}
            if hasattr(response, "model_dump"):
                resp_dict = response.model_dump()
            elif hasattr(response, "__dict__"):
                resp_dict = dict(response.__dict__)
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
