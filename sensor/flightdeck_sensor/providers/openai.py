"""OpenAI provider: token estimation and usage extraction.

Reimplements the patterns from tokencap -- this is a standalone
implementation with no dependency on tokencap.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from flightdeck_sensor.core.types import TokenUsage
from flightdeck_sensor.providers.protocol import PromptContent

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

        Handles both sync ``ChatCompletion`` objects and raw wrappers.
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
    ) -> PromptContent | None:
        """Extract full prompt payload for storage.

        Returns ``None`` when capture_prompts is False. Never raises.
        OpenAI has no separate system field -- system role is in messages.
        """
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime, timezone

            resp_dict: dict[str, Any] = {}
            if hasattr(response, "model_dump"):
                resp_dict = response.model_dump()
            elif hasattr(response, "__dict__"):
                resp_dict = dict(response.__dict__)
            else:
                resp_dict = {"raw": str(response)}

            return PromptContent(
                system=None,  # OpenAI embeds system in messages
                messages=request_kwargs.get("messages", []),
                tools=request_kwargs.get("tools"),
                response=resp_dict,
                provider="openai",
                model=request_kwargs.get("model", ""),
                session_id="",  # Filled by caller
                event_id="",  # Filled by caller
                captured_at=datetime.now(timezone.utc).isoformat(),
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
