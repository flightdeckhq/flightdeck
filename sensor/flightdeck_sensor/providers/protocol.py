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

    def extract_tool_invocations(self, response: Any) -> list[ToolInvocation]:
        """Return the tool invocations the model emitted in ``response``.

        Anthropic: ``response.content`` items with ``type='tool_use'``.
        OpenAI: ``response.choices[0].message.tool_calls``.
        Returns an empty list when the response has no tool calls or
        the response shape cannot be parsed. Never raises.
        """
        ...


@dataclass
class ToolInvocation:
    """A single tool/function call emitted by the model in a response.

    The sensor's interceptor emits one ``tool_call`` event per entry
    so the fleet view can track tool usage separately from the LLM
    call itself. Provider terminology preserved: OpenAI tool_calls
    and Anthropic tool_use blocks both map onto this shape.
    """

    name: str
    tool_input: dict[str, Any]
    tool_id: str | None = None


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
