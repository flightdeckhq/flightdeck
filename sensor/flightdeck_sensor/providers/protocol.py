"""Provider protocol and shared content dataclass."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from flightdeck_sensor.core.types import EventType, TokenUsage


class Provider(Protocol):
    """Interface every LLM provider adapter must implement.

    All methods must be safe to call on the hot path. None of them
    may raise exceptions -- failures return zero/empty defaults.
    """

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> tuple[int, str]:
        """Estimate input token count before the call. Never raises.

        Returns ``(tokens, source)`` where source is one of
        ``"tiktoken"`` (exact tokeniser-based count), ``"heuristic"``
        (character-length fallback), or ``"none"`` (extraction
        failed; ``(0, "none")``). The source string lands on the
        pre_call event's ``estimated_via`` field so a large post-call
        delta can be attributed to estimator quality.
        """
        ...

    def extract_response_metadata(self, response: Any) -> dict[str, Any] | None:
        """Provider-specific response metadata (rate-limit headers,
        request id, processing-ms). Returns ``None`` when nothing
        useful is reachable. Never raises.

        Field names are normalised across providers (snake_case, no
        provider prefix) so the dashboard renders a single chip
        shape regardless of origin.
        """
        ...

    def extract_output_dimensions(self, response: Any) -> dict[str, int] | None:
        """For embeddings responses, return ``{"count": N, "dimension": D}``.

        Returns ``None`` for non-embeddings responses or when the
        shape cannot be parsed. Never raises.
        """
        ...

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from the provider response. Never raises."""
        ...

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: EventType | None = None,
    ) -> PromptContent | None:
        """Extract prompt content when capture_prompts is enabled.

        ``event_type`` defaults to ``None`` for backwards compatibility
        with callers that pre-date the event-type-aware extraction
        (treated as POST_CALL by every provider). When set to
        ``EventType.EMBEDDINGS`` the provider captures the embedding
        ``input`` parameter (string or list of strings) into the new
        ``PromptContent.input`` field instead of the chat-shaped
        ``messages`` / ``system`` slots.

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

    Phase 4 polish: ``input`` is the embeddings-shaped slot. Embedding
    calls (OpenAI ``embeddings.create``, ``litellm.embedding``,
    LangChain ``OpenAIEmbeddings.embed_*`` transitively) put the
    request's ``input`` parameter (a string or list of strings) here
    rather than into the chat-shaped ``messages`` slot. Dashboard
    branches on event_type to render via ``EmbeddingsContentViewer``
    instead of the chat ``PromptViewer``. Provider terminology is
    preserved here too: OpenAI's API parameter is called ``input``,
    not ``inputs``.
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
    input: str | list[str] | None = None
    embedding_output: list[list[float]] | None = None
