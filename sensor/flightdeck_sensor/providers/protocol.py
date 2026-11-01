"""Provider protocol and shared content dataclass."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from flightdeck_sensor.core.types import CallDetails, EventType, TokenUsage


class Provider(Protocol):
    """Interface every LLM provider adapter must implement.

    All methods must be safe to call on the hot path. None of them
    may raise exceptions -- failures return zero/empty defaults.
    """

    # The provider's wire name (``anthropic``, ``openai``, ``litellm``):
    # the ``provider`` field of the error events the adapter's calls
    # produce, and part of the key of the per-provider retry counter.
    name: str

    @property
    def vendor(self) -> str | None:
        """The model vendor the endpoint settles (``anthropic`` for
        Anthropic's clients, ``openai`` for the OpenAI SDK against
        OpenAI or Azure OpenAI), stamped as the event's ``provider``;
        ``None`` when the endpoint could serve any vendor's models (an
        OpenAI-compatible gateway, litellm), which leaves the worker to
        derive it from the model id."""
        ...

    @property
    def local(self) -> bool:
        """Whether the client talks to a model server on this machine,
        whose calls carry the ``local`` billing mode."""
        ...

    @property
    def inference_scope(self) -> str | None:
        """``global`` or ``regional`` for a cloud endpoint whose scope
        the client's configuration names (a Vertex AI region), else
        ``None``."""
        ...

    def call_details(self, response: Any) -> CallDetails | None:
        """What the response reports about the call beyond token counts
        (served model, service tier, speed, data residency, server-tool
        counters, a reported cost), or ``None``. Never raises."""
        ...

    def call_details_from_stream_chunk(self, chunk: Any) -> CallDetails | None:
        """The same, carried by one streamed chunk or event; the stream
        guard folds successive results with :meth:`CallDetails.merged`.
        Never raises."""
        ...

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

    def usage_from_stream_chunk(self, chunk: Any) -> TokenUsage | None:
        """Token usage carried by one streamed chunk or event, or ``None``
        when this chunk carries none.

        The stream guard merges successive non-None results field by
        field, the larger value winning (the counters are cumulative),
        which covers both cumulative deltas (Anthropic ``message_delta``)
        and a single final usage chunk (OpenAI). Never raises.
        """
        ...

    def usage_from_finished_stream(self, stream: Any) -> TokenUsage | None:
        """Usage the SDK stream object holds when the guard settles
        (Anthropic's helper accumulates it on
        ``current_message_snapshot.usage``), or ``None`` for raw streams.
        Called on every settle path, early exit included, so it must
        never read further from the stream. Never raises.
        """
        ...

    def stream_completed(self, stream: Any) -> bool | None:
        """Whether the SDK stream object knows its message is complete
        (Anthropic's helper snapshot carries ``stop_reason`` once
        ``message_delta`` arrived); ``None`` when the object cannot tell.
        Never reads from the stream. Never raises.
        """
        ...

    def final_message(self, stream: Any) -> Any | None:
        """The complete message of a helper stream (Anthropic's accumulated
        ``current_message_snapshot`` once ``stop_reason`` is set), or
        ``None`` for raw streams and for a helper that is not complete.
        May return an awaitable; the async guard awaits it and the sync
        guard discards it. Only called when ``stream_completed`` is true
        and must never read further from the stream. Never raises.
        """
        ...

    def stream_accumulator(
        self, stream: Any, request_kwargs: dict[str, Any]
    ) -> StreamAccumulator | None:
        """An assembler for a raw event stream (``create(stream=True)``):
        the guard feeds it every event it reads and, when the stream
        settles, takes the assembled message as the response, so content
        capture and tool-call extraction see what a non-streamed call
        returns. Built on the SDK's own accumulator, the one its helper
        streams use. ``None`` for a helper stream (which assembles its own
        message, see :meth:`final_message`), for a stream whose assembly
        nothing reads (capture off and no tool the model can call), and
        when the SDK's accumulator is unavailable. Never raises.
        """
        ...

    def text_from_stream_chunk(self, chunk: Any) -> str | None:
        """Text carried by one streamed event, for the guard's
        ``text_stream`` (Anthropic ``content_block_delta`` /
        ``text_delta``); ``None`` when the event carries none or the
        provider's streams have no text stream. Never raises.
        """
        ...

    def chunk_completes_stream(self, chunk: Any) -> bool:
        """Whether this streamed event ends the response (Anthropic
        ``message_stop`` or a ``message_delta`` with ``stop_reason``; an
        OpenAI chat chunk carrying ``usage``; a Responses terminal
        event), so a consumer that stops at it has read the whole
        response. Never raises.
        """
        ...

    def response_stop_reason(self, response: Any) -> str | None:
        """The provider's stop reason on a complete response (Anthropic
        ``stop_reason``; OpenAI chat and litellm ``finish_reason``, an
        OpenAI structured-output refusal as ``refusal``, the reason an
        OpenAI Responses call was left ``incomplete``), or ``None`` when
        the response carries none. The interceptor files an llm_error
        beside the post_call when the reason means the call did not
        succeed (a refusal, a content filter, a context-window overrun).
        Never raises.
        """
        ...

    def stop_reason_from_stream_chunk(self, chunk: Any) -> str | None:
        """The stop reason carried by one streamed event (Anthropic
        ``message_delta``; an OpenAI chat or litellm chunk carrying
        ``finish_reason``; an OpenAI ``response.incomplete`` event), or
        ``None`` for every other event. Lets a raw stream, which has no
        final message object, report the same outcome as a complete
        response. Never raises.
        """
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
    # The MCP server a provider-hosted MCP call went to (an OpenAI
    # Responses ``mcp_call`` item's ``server_label``); ``None`` for every
    # other tool call. Lands on the ``tool_call`` event as ``server_name``.
    server_name: str | None = None


class StreamAccumulator(Protocol):
    """Assembles one raw event stream into the message a non-streamed call
    returns (see :meth:`Provider.stream_accumulator`)."""

    def add(self, chunk: Any) -> None:
        """Fold one streamed event or chunk into the message. May raise;
        the guard then drops the accumulator and stores no response."""
        ...

    def message(self) -> Any | None:
        """The message assembled so far: the complete response once the
        stream has completed, a partial one before that, ``None`` when
        nothing has been assembled. Reads no further from the stream."""
        ...


@dataclass
class PromptContent:
    """Raw content extracted from a single LLM call.

    Provider terminology is preserved exactly -- no normalization.
    Anthropic uses 'system' as a separate field; OpenAI chat embeds it in
    messages.

    ``input`` holds a request's ``input`` parameter verbatim, the
    provider's own name for it. Embedding calls (OpenAI
    ``embeddings.create``, ``litellm.embedding``, LangChain
    ``OpenAIEmbeddings.embed_*`` transitively) put a string or list of
    strings here rather than into the chat-shaped ``messages`` slot, and
    the dashboard branches on event_type to render it via
    ``EmbeddingsContentViewer``. An OpenAI Responses call puts its
    ``input`` here too (a string or a list of input items), with its
    ``instructions`` in ``system``; ``messages`` stays empty because the
    Responses API has no messages parameter.
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
    input: str | list[Any] | None = None
    embedding_output: list[list[float]] | None = None


def finish_reason_of(obj: Any) -> str | None:
    """``choices[0].finish_reason`` of an OpenAI-shaped completion or
    stream chunk, or ``refusal`` when the message carries a
    structured-output refusal (``message.refusal``, which the model
    reports with ``finish_reason="stop"``); ``None`` when the object has
    no choices. Shared by the OpenAI adapter and the litellm adapter,
    whose ``ModelResponse`` mirrors the chat shape. Never raises."""
    try:
        choices = getattr(obj, "choices", None)
        if not isinstance(choices, list) or not choices:
            return None
        first = choices[0]
        refusal = getattr(getattr(first, "message", None), "refusal", None)
        if isinstance(refusal, str) and refusal:
            return "refusal"
        reason = getattr(first, "finish_reason", None)
        return reason if isinstance(reason, str) else None
    except Exception:
        return None
