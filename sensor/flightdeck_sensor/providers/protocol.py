"""Provider protocol and shared content dataclass."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from flightdeck_sensor.core.types import TokenUsage


class Provider(Protocol):
    """Interface every LLM provider adapter must implement.

    All methods must be safe to call on the hot path. None of them
    may raise exceptions -- failures return zero/empty defaults.
    """

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> int:
        """Estimate input token count before the call. Never raises."""
        ...

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from the provider response. Never raises."""
        ...

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
    ) -> PromptContent | None:
        """Extract prompt content when capture_prompts is enabled.

        Returns None when capture is disabled or on any error.
        Never raises.
        """
        ...

    def get_model(self, request_kwargs: dict[str, Any]) -> str:
        """Extract the model name from request kwargs. Returns '' on failure."""
        ...


@dataclass
class PromptContent:
    """Raw content extracted from a single LLM call.

    Provider terminology is preserved exactly -- no normalization.
    Anthropic uses 'system' as a separate field; OpenAI embeds it in messages.
    """

    system: str | None
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None
    response: dict[str, Any]
    provider: str
    model: str
    session_id: str
    event_id: str
    captured_at: str
