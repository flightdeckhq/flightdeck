"""Anthropic provider: token estimation and usage extraction.

Reimplements the patterns from tokencap -- this is a standalone
implementation with no dependency on tokencap.
"""

from __future__ import annotations

import contextlib
import logging
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.core.types import TokenUsage

if TYPE_CHECKING:
    from flightdeck_sensor.providers.protocol import PromptContent

_log = logging.getLogger("flightdeck_sensor.providers.anthropic")

_DEFAULT_COUNT_TOKENS_MODEL = "claude-sonnet-4-20250514"
_CHARS_PER_TOKEN_ESTIMATE = 4


class AnthropicProvider:
    """Provider adapter for the Anthropic Python SDK.

    All methods are safe to call on the hot path.  None of them raise
    exceptions -- failures return zero/empty defaults.
    """

    _client: Any = None

    def __init__(self, capture_prompts: bool = False) -> None:
        self._capture_prompts = capture_prompts

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> int:
        """Estimate input tokens before the call.

        Attempts the Anthropic SDK ``count_tokens`` method first for
        accurate counts.  Falls back to ``len(str(...)) // 4`` when the
        SDK is not installed or ``count_tokens`` fails for any reason.
        Never raises.
        """
        try:
            import anthropic as _anthropic

            if AnthropicProvider._client is None:
                AnthropicProvider._client = _anthropic.Anthropic()
            count: int = AnthropicProvider._client.messages.count_tokens(
                model=request_kwargs.get("model", _DEFAULT_COUNT_TOKENS_MODEL),
                messages=request_kwargs.get("messages", []),
                system=request_kwargs.get("system", ""),
                tools=request_kwargs.get("tools", []),
            ).input_tokens
            return count
        except Exception:
            _log.debug("SDK count_tokens failed, using char heuristic", exc_info=True)

        # Fallback: character-based heuristic
        try:
            messages = request_kwargs.get("messages", [])
            system = request_kwargs.get("system", "")
            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(system) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE
        except Exception:
            _log.debug("char estimation failed", exc_info=True)
            return 0

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from an Anthropic response.

        Handles both sync ``Message`` objects and raw response wrappers.
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

            input_tokens = getattr(usage, "input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0

            # Include cache tokens in input count for accurate totals
            cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
            cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0

            return TokenUsage(
                input_tokens=input_tokens + cache_read + cache_write,
                output_tokens=output_tokens,
            )
        except Exception:
            return TokenUsage(input_tokens=0, output_tokens=0)

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
    ) -> PromptContent | None:
        """Extract prompt content for storage.

        Returns ``None`` in Phase 1 -- prompt capture is not implemented
        until Phase 5.
        """
        return None

    def get_model(self, request_kwargs: dict[str, Any]) -> str:
        """Extract the model name from request kwargs."""
        try:
            model: str = request_kwargs["model"]
            return model
        except (KeyError, TypeError):
            return ""
